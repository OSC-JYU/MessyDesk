# Queue System

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

Jobs are retried on failure up to `max_attempts` (default 3). The queue stores `next_retry_at` to implement exponential backoff.

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
| `LOG_QUEUE_CONTEXT` | `false` | Log first message per topic for debugging |
