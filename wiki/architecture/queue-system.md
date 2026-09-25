# Queue System

MessyDesk is a multi-user application. **All processing requests must be routed through the queue system** — never executed inline in the request handler. Inline processing (e.g. image resizing, OCR, AI inference) would block the server process and degrade performance for all connected users when processing volumes are high. The queue delegates CPU-intensive work to external consumer processes that can be scaled independently.

MessyDesk uses a SQLite-based queue for all job processing. The queue is managed exclusively by the backend process; consumers access it via HTTP API.

## Implementation

**[verified]** from `src/queue.mjs` (branch: `sqlite-queue`):

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

**[verified]** from `src/queue.mjs` `_openDb()`.

### Pragmas

```sql
PRAGMA journal_mode = WAL;
PRAGMA busy_timeout = 5000;
PRAGMA synchronous = NORMAL;
```

## Queue API

The backend exposes the following internal methods (called by route handlers):

| Method | Purpose |
|--------|---------|
| `queue.init()` | Open/create SQLite database |
| `queue.publish(topic, data)` | Enqueue a job (enriches message via `createProcessQueueMessage`) |
| `queue.getQueueStatus(topic)` | Count jobs by status for a topic |
| `queue.drainQueue(topic, process_rid)` | Delete queued jobs for a topic/process |
| `queue.drainQueueByProcess(process_rid)` | Delete queued jobs by process RID |
| `queue.flushQueue(topic)` | Delete all jobs for a topic |
| `queue.cleanupOlderThan(options)` | Delete stale jobs by age/status (`dry_run` supported) |
| `queue.createSetProcessNodesAndPublish(msg)` | Create process node + publish (batch-aware) |
| `queue.pauseBatch(process_rid)` | Mark batch paused + drain queued messages |
| `queue.resumeBatch(process_rid)` | Clear pause state |
| `queue.cancelBatch(process_rid)` | Mark cancelled + drain queued messages |
| `queue.claim(topic, adapterId)` | Atomic claim of next available job (consumer-facing) |
| `queue.heartbeat(jobId, adapterId)` | Extend lease for a running job |
| `queue.complete(jobId, adapterId)` | Mark job done |
| `queue.fail(jobId, error, adapterId)` | Retry (with backoff) or mark permanently failed |
| `queue.getActiveJobs()` | List active/queued jobs grouped by batch |

**[verified]** from `src/queue.mjs`.

## Consumer HTTP API

Consumers access the queue via HTTP endpoints exposed by the backend (`src/routes/queues.mjs`):

| Endpoint | Method | Purpose |
|----------|--------|---------|
| `/api/queue/claim` | POST | Claim next available job for a topic. Body: `{ topic, adapter_id }`. Returns `{ job }` or `{ job: null }` |
| `/api/queue/{job_id}/heartbeat` | POST | Extend lease. Body: `{ adapter_id }` |
| `/api/queue/{job_id}/complete` | POST | Mark job done. Body: `{ adapter_id }` |
| `/api/queue/{job_id}/fail` | POST | Report failure. Body: `{ adapter_id, error }`. Triggers retry or marks failed |
| `/api/queue/jobs/active` | GET | List all active/queued jobs (for UI hydration) |
| `/api/queue/{topic}/status` | GET | Query queue state counts by status |
| `/api/queue/cleanup` | POST | Cleanup jobs older than threshold. Body: `{ older_than_minutes, statuses?, dry_run? }` |
| `/api/queue/sweeper/summary` | GET | Return in-memory sweeper summary (last run, totals, last error) |

**[verified]** — Implemented in `src/routes/queues.mjs`.

### Claim Response Shape

```json
{
  "job": {
    "id": 42,
    "queue": "md-imaginary_batch",
    "payload": { /* original message */ },
    "attempts": 1,
    "max_attempts": 3
  }
}
```

If no work is available: `{ "job": null }`

## Deletion Guard

When a user attempts to delete a graph node (`DELETE /api/graph/vertices/{rid}`), the backend checks for active queue jobs referencing that RID (as `process_rid` or `set_process_rid`). If found, deletion is blocked with HTTP 409 Conflict.

**[verified]** from `src/routes/graph.mjs`.

## Retry Logic

**[verified]** from `src/queue.mjs`:

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
- The user receives a WebSocket notification with `abort_reason` (`failure_threshold` or `consecutive_failures`)

Per-message overrides: `queue_options.abort_consecutive` and `queue_options.abort_percent`.

## Batch-Aware Publishing

**[verified]** from `queue.createSetProcessNodesAndPublish()`:

Before publishing a batch file message:
1. Checks parent SetProcess status (`paused`, `cancelling`, `cancelled`, `done` → skip)
2. If no Process node exists, creates one via `Graph.createProcessNode_queue()`
3. Writes `message.json` to process directory
4. Publishes to `{service_id}_batch` queue

## Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `QUEUE_DB_PATH` | `data/{db_name}/queue.sqlite` | Database file path |
| `QUEUE_DB_MAX_ATTEMPTS` | `3` | Max retry attempts per job |
| `QUEUE_BATCH_ABORT_CONSECUTIVE` | `5` | Max consecutive permanent failures before auto-abort |
| `QUEUE_BATCH_ABORT_PERCENT` | `50` | Max failure percentage before auto-abort |
| `QUEUE_DB_KEEP_FAILED_MINUTES` | `1440` | Keep failed jobs for this many minutes before cleanup |
| `QUEUE_DB_SWEEPER_ENABLED` | `true` | Enable/disable background queue cleanup sweeper |
| `QUEUE_DB_SWEEPER_INTERVAL_SECONDS` | `300` | Sweeper run interval in seconds |
| `QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES` | `60` | Remove `done`/`cancelled` jobs older than this many minutes |
| `LOG_QUEUE_CONTEXT` | `false` | Log first message per topic for debugging |

## Automatic Cleanup Sweeper

**[verified]** from `src/queue.mjs`:

The backend starts a periodic sweeper when `queue.init()` runs.

On each sweep:

1. Deletes `done` and `cancelled` jobs older than `QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES`.
2. Deletes `failed` jobs older than `QUEUE_DB_KEEP_FAILED_MINUTES`.

The sweep interval is configured by `QUEUE_DB_SWEEPER_INTERVAL_SECONDS`.

### Sweeper Summary Endpoint

`GET /api/queue/sweeper/summary` returns runtime sweeper stats, including:

- `enabled`, `running`, `has_timer`
- `interval_seconds`, `done_cancelled_minutes`, `keep_failed_minutes`
- `started_at`, `last_run_started_at`, `last_run_finished_at`
- `last_deleted_done_cancelled`, `last_deleted_failed`, `last_deleted_total`
- `total_runs`, `total_deleted_done_cancelled`, `total_deleted_failed`, `total_deleted`
- `last_error`, `now`

### Retention Notes

- Single-file jobs are deleted immediately on `complete()` (no batch history needed).
- Batch jobs are cleaned when the batch has no active jobs (`queued`/`running`) and by the periodic sweeper.
- Failed rows are retained for diagnostics according to `QUEUE_DB_KEEP_FAILED_MINUTES`.
