# Queue System

MessyDesk is a multi-user application. **All processing requests must be routed through the queue system** — never executed inline in the request handler. Inline processing (e.g. image resizing, OCR, AI inference) would block the server process and degrade performance for all connected users when processing volumes are high. The queue delegates CPU-intensive work to external consumer processes that can be scaled independently.

MessyDesk uses a SQLite-based queue for all job processing. The queue is managed exclusively by the backend process; consumers access it via HTTP API.

## Implementation

**[verified]** from `src/modules/queue/queue.ts`:

The queue is stored in a SQLite file at `data/{db_name}/queue.sqlite` with WAL mode for concurrent read/write.

### Schema

```sql
CREATE TABLE queue_jobs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    queue TEXT NOT NULL,
    payload_json TEXT NOT NULL,
    process_rid TEXT,
    set_process_rid TEXT,
    status TEXT NOT NULL DEFAULT 'queued',  -- queued|running|done|failed|cancelled
    attempts INTEGER NOT NULL DEFAULT 0,
    max_attempts INTEGER NOT NULL DEFAULT 3,
    claimed_by TEXT,
    claimed_at TEXT,
    lease_until TEXT,
    next_retry_at TEXT NOT NULL,
    last_error TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    completed_at TEXT
);

CREATE INDEX idx_queue_claim
    ON queue_jobs(queue, status, next_retry_at, created_at);
CREATE INDEX idx_queue_process
    ON queue_jobs(process_rid, set_process_rid, status);
CREATE INDEX idx_queue_cleanup
    ON queue_jobs(status, updated_at);
```

**[verified]** from `src/modules/queue/queue.ts` `_openDb()`.

### Batch state

```sql
CREATE TABLE batch_state (
    process_rid TEXT PRIMARY KEY,
    state TEXT NOT NULL,          -- paused | cancelled
    updated_at TEXT NOT NULL
);
```

Paused and cancelled batches are kept here so a restart does not forget them (the old backend
kept them in memory). `claim()` skips jobs of paused batches and finalises jobs of cancelled ones;
`fail()` of a cancelled batch's job does not retry. The old backend ignores this table, so a
rollback keeps working.

### Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

## Queue API

`JobQueue` (`src/modules/queue/queue.ts`) knows nothing about the graph:

| Method | Purpose |
|--------|---------|
| `open()` / `close()` | Open (creating tables) / close the SQLite file |
| `publish(queue, message)` | Enqueue a job; `queue_options.max_attempts` overrides the default |
| `claim(topic, adapterId)` | Claim the oldest due job from `<topic>`, then `<topic>_batch` |
| `heartbeat(jobId, adapterId)` | Extend the lease of a running job |
| `complete(jobId, adapterId)` | Mark done (single jobs are deleted right away) |
| `fail(jobId, error, adapterId)` | Retry with backoff, or fail permanently and maybe auto-abort the batch |
| `pauseBatch` / `resumeBatch` / `cancelBatch(processRid)` | Batch control (queued jobs are deleted) |
| `cancelJob`, `dismiss`, `flush`, `activeJobs(userRid)`, `ownerOf(rid)` | Jobs panel and admin |
| `hasActiveJobsFor(rid)` | Deletion guard |

`Publisher` (`src/modules/queue/publisher.ts`) wraps `publish`: it fills in `project_rid` (from
the file, the process, or a graph lookup) and `set_rid` for set processing, so consumers always get
the access context. Building messages and creating Process/SetProcess nodes is done by
`ProcessingService` before publishing.

## Consumer HTTP API

Consumers access the queue via HTTP endpoints exposed by the backend (`src/modules/processing/routes.ts`). They need the `service` credential (see [backend structure](backend-structure.md#authentication)):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/queue/claim` | POST | Claim next available job for a topic. Body: `{ topic, adapter_id }`. Returns `{ job }` or `{ job: null }` |
| `/api/queue/{job_id}/heartbeat` | POST | Extend lease. Body: `{ adapter_id }` |
| `/api/queue/{job_id}/complete` | POST | Mark job done. Body: `{ adapter_id }` |
| `/api/queue/{job_id}/fail` | POST | Report failure. Body: `{ adapter_id, error }`. Triggers retry or marks failed |

For the UI (user auth): `GET /api/queue/jobs/active` (the caller's active jobs grouped by batch;
admins see all), `POST /api/queue/jobs/{rid}/dismiss`, `GET /api/queue/{topic}/flush` (admin).
The status, cleanup and sweeper-summary routes of the old backend were removed.

**[verified]** — Implemented in `src/modules/processing/routes.ts`.

### Claim Response Shape

```json
{
  "job": {
    "id": 42,
    "queue": "md-sharp_batch",
    "payload": { /* original message */ },
    "attempts": 1,
    "max_attempts": 3
  }
}
```

If no work is available: `{ "job": null }`

## Deletion Guard

When a user attempts to delete a graph node (`DELETE /api/graph/vertices/{rid}`), the backend checks for active queue jobs referencing that RID (as `process_rid` or `set_process_rid`). If found, deletion is blocked with HTTP 409 Conflict.

**[verified]** from `src/modules/graph/routes.ts`.

## Retry Logic

**[verified]** from `src/modules/queue/queue.ts`:

Jobs are retried on failure up to `max_attempts` (default 3, configurable per-message via `queue_options.max_attempts`). The queue stores `next_retry_at` to implement exponential backoff (500ms × 2^(attempts-1), capped at 30s).

When a job permanently fails (attempts exhausted), `completed_at` is set so that consecutive-failure ordering works correctly.

### Per-Message Retry Override

Messages can carry `queue_options.max_attempts` in their payload to override the global default. This is read by `queue.publish()` when inserting the job.

## Batch Auto-Abort

When a batch job permanently fails, the queue checks whether the batch should be auto-aborted. Two conditions are evaluated (whichever fires first):

1. **Failure percentage** — if X% of completed batch jobs have permanently failed, abort the batch. Default: 50%.
2. **Consecutive permanent failures** — if the last N completed/failed jobs in the batch are all failures, abort the batch. Default: 5.

When auto-abort fires:
- Remaining queued jobs are cancelled via `cancelBatch()`
- The batch SetProcess node is marked `cancelled` in the graph DB
- The user receives an SSE `process_finished` event with `abort_reason` (`failure_threshold` or `consecutive_failures`)

Per-message overrides: `queue_options.abort_consecutive` and `queue_options.abort_percent`.

## Batch-Aware Publishing

**[verified]** from `ProcessingService.dispatchBatchFiles`:

One job per input file goes to `<service>_batch`, each with the SetProcess as `process` and
`set_process`, `current_file`/`total_files`, `set_rid` and `output_set`. Before each publish the
SetProcess status is checked; `paused`, `cancelling`, `cancelled` or `done` stops the dispatch.
Tag syncs to Solr (`update_tags`) are the one job without a set that still goes to `md-solr_batch`,
with its own Process node.

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `QUEUE_DB_PATH` | `data/{db_name}/queue.sqlite` | Database file path |
| `QUEUE_DB_MAX_ATTEMPTS` | `3` | Max retry attempts per job |
| `QUEUE_DB_LEASE_SECONDS` | `120` | Lease of a claimed job; a job whose lease ran out can be claimed again |
| `QUEUE_BATCH_ABORT_CONSECUTIVE` | `5` | Max consecutive permanent failures before auto-abort |
| `QUEUE_BATCH_ABORT_PERCENT` | `50` | Max failure percentage before auto-abort |
| `QUEUE_DB_KEEP_FAILED_MINUTES` | `1440` | Keep failed jobs for this many minutes before cleanup |
| `QUEUE_DB_SWEEPER_ENABLED` | `true` | Enable/disable background queue cleanup sweeper |
| `QUEUE_DB_SWEEPER_INTERVAL_SECONDS` | `300` | Sweeper run interval in seconds |
| `QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES` | `60` | Remove `done`/`cancelled` jobs older than this many minutes |
| `LOG_QUEUE_CONTEXT` | `false` | Log first message per topic for debugging |

## Automatic Cleanup Sweeper

**[verified]** from `src/modules/queue/queue.ts`:

`main.ts` starts the sweeper after opening the queue (and runs it once at startup).

On each sweep:

1. Deletes `done` and `cancelled` jobs older than `QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES`.
2. Deletes `failed` jobs older than `QUEUE_DB_KEEP_FAILED_MINUTES`.

The sweep interval is configured by `QUEUE_DB_SWEEPER_INTERVAL_SECONDS`.

### Retention Notes

- Single-file jobs are deleted immediately on `complete()` (no batch history needed).
- Batch jobs are cleaned when the batch has no active jobs (`queued`/`running`) and by the periodic sweeper.
- Failed rows are retained for diagnostics according to `QUEUE_DB_KEEP_FAILED_MINUTES`.
- `batch_state` rows older than a week whose batch has no jobs left are removed.
