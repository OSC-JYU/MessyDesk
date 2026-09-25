# Proposal: Replace NATS with SQLite Queue and Simplify Batch Processing

**Status**: Draft  
**Date**: 2026-08-13

## Motivation

1. Traffic is low — NATS JetStream is operationally heavy for the actual message volume.
2. Current batch processing creates one Process node and one queue message per file, which is complex to orchestrate, cancel, and reason about.
3. SQLite queue already exists and provides retry logic, inspectable state, and no extra infrastructure.
4. Removing NATS eliminates a Docker dependency and simplifies deployment.

## Current State (Problems)

- Backend creates N Process nodes + N queue messages for a set of N files.
- Each message processed independently — no holistic batch awareness in the consumer.
- Cancellation requires checking SetProcess status before each output materialization (backend side).
- NATS mode has no retry; failed messages are lost.
- NATS server must be running for the backend to start.

## Proposed Design

### Core Change: One Batch Message Per Job

When batch processing is requested, the backend sends **one message** to the SQLite queue containing:

```json
{
    "type": "batch",
    "service": { "id": "md-imaginary" },
    "task": { "id": "resize", "params": { "width": 400 } },
    "set_rid": "#13:0",
    "output_set": "#15:0",
    "set_process": "#16:0",
    "project_rid": "#11:0",
    "userId": "user@email.com",
    "files": ["#12:0", "#12:1", "#12:2", ...],
    "total_files": 50
}
```

The **adapter** (consumer) is now responsible for:
1. Fetching files one-by-one from the backend (or reading from disk)
2. Calling the service for each file
3. Sending each result back via callback
4. Reporting progress (current_file / total_files)
5. Handling per-file errors without aborting the whole batch

### Single-file messages remain unchanged

For one-off processing (user processes a single file), the message format stays as-is. The adapter detects `type: "batch"` vs `type: "single"` (or absence of `files` array) and routes accordingly.

### Multi-Instance Scaling: Partition Splits

When multiple service instances are available, the backend **splits the batch** at message creation time.

#### Option A: Pre-split into N messages (Recommended)

If 2 instances are registered, the backend publishes 2 messages:

```json
{
    "type": "batch",
    "partition": { "index": 0, "total": 2 },
    "files": ["#12:0", "#12:1", "#12:2", ...],   // first half
    "total_files": 50,
    ...
}
```
```json
{
    "type": "batch",
    "partition": { "index": 1, "total": 2 },
    "files": ["#12:25", "#12:26", ...],           // second half
    "total_files": 50,
    ...
}
```

Each consumer claims one message (SQLite lease mechanism ensures no duplication). Each processes its partition independently.

**Advantages**:
- No coordination between consumers needed
- SQLite lease prevents double-processing
- If one consumer dies, its partition is retried after lease expires
- Simple to implement — splitting is just array slicing

**Disadvantages**:
- Partition count decided at publish time (must know instance count)
- Uneven work if files vary in processing time

#### Option B: Dynamic claiming (Alternative)

Single batch message, but adapter processes files via a shared claim cursor:

```json
{
    "type": "batch",
    "files": ["#12:0", "#12:1", ...],
    "total_files": 50,
    ...
}
```

A second table `batch_file_claims` tracks which files are claimed:

```sql
CREATE TABLE batch_file_claims (
    batch_job_id INTEGER,
    file_index INTEGER,
    claimed_by TEXT,
    status TEXT DEFAULT 'pending',  -- pending|processing|done|failed
    PRIMARY KEY (batch_job_id, file_index)
);
```

Each consumer atomically claims the next unclaimed file index, processes it, marks done.

**Advantages**:
- Perfect load balancing (fastest consumer does more work)
- Instance count doesn't need to be known at publish time
- Natural work stealing

**Disadvantages**:
- More complex than Option A
- Requires additional `batch_file_claims` table and per-file claim HTTP calls
- More HTTP round-trips (one claim per file vs one claim per partition)

### Recommendation: Option A (Pre-split)

Given low traffic and the desire for simplicity:

- Backend knows registered adapter count at publish time (adapter heartbeats already exist)
- Array slicing is trivial
- No shared state between consumers
- If only 1 instance: 1 message, no splitting (degenerates to simple case)
- If instance count changes: next batch uses new count (doesn't affect in-flight)

## Backend Changes Required

| Area | Change |
|------|--------|
| `src/queue.mjs` | Remove entirely. Replace with `queue-db.mjs` as sole queue implementation. |
| `src/queue-db.mjs` | Promote to primary. Add `partition` support, pause/resume status tracking, `resume_from_index`. |
| `src/index.mjs` | Remove NATS init. Remove `nats.listenDBQueue()`. Init SQLite queue instead. |
| `src/routes/queues.mjs` | Batch dispatch: create 1 SetProcess + N partition messages (N = adapter count). Add `/api/queue/{job_id}/pause`, `/resume`, `/cancel`, `/api/queue/jobs/active`. |
| `src/graph.mjs` | `createQueueMessages()`: stop creating per-file Process nodes at queue time. Process nodes created by callback instead. |
| `src/routes/events.mjs` | Centralize SSE event emission. All batch events go through a single `emitBatchEvent(userId, event)` function. |
| `docker-compose.yml` | Remove `nats-jetstreams` service. |
| `src/env.mjs` | Remove `NATS_URL`, `NATS_URL_STATUS`. |

## Consumer Changes Required

| Area | Change |
|------|--------|
| `src/index.mjs` | Remove NATS consumption. Replace with HTTP poll loop against `/api/queue/claim`. |
| `src/index-db.mjs` | Remove (SQLite access moves to backend). |
| Adapter `process_msg` | Add batch-aware wrapper: iterate `files[]`, fetch each, call service, callback per file. |
| Progress reporting | After each file: `POST /api/nomad/process/files` with `current_file` / `total_files`. |
| Error per file | On failure: report error for that file, continue to next (don't abort batch). |
| Heartbeat | Periodic `POST /api/queue/{job_id}/heartbeat` to extend lease while processing. |

## Process Node Lifecycle Change

**Current**: Backend creates Process nodes before queuing (one per file).  
**Proposed**: Backend creates only SetProcess at queue time. Individual Process nodes created by the callback handler when results arrive.

This eliminates the problem of having N `queued` Process nodes sitting in the graph with nothing happening to them, and simplifies cancellation (just mark the queue job as cancelled; no per-file cleanup needed).

## Cancellation

- Cancel = mark SQLite job status as `cancelled`
- Consumer checks job status before processing next file in batch
- If cancelled: stop iterating, send `done` callback with partial completion count
- No zombie Process nodes (they were never created)

## Pause and Resume

### Pause

1. UI calls `POST /api/queue/{job_id}/pause`
2. Backend marks job status as `paused` in SQLite
3. Backend sends pause signal to consumer: `POST {adapter_url}/jobs/{job_id}/pause`
   - Consumer has a lightweight HTTP server (already exists in `server.mjs`) that accepts control signals
   - Consumer sets internal `paused = true` flag
   - Consumer finishes current file (does not abort mid-file), then stops iterating
   - Consumer does NOT release the lease — it holds the job in paused state
4. Backend sends SSE event `{ command: "process_update", set_process: rid, status: "paused", batch: {...} }` to UI
5. Consumer continues heartbeat while paused (keeps lease alive)

### Resume

1. UI calls `POST /api/queue/{job_id}/resume`
2. Backend marks job status as `running` in SQLite
3. Backend updates the job payload with `resume_from_index` (index of next unprocessed file)
4. Backend sends resume signal to consumer: `POST {adapter_url}/jobs/{job_id}/resume`
   - Consumer sets `paused = false`, resumes iteration from `resume_from_index`
5. Backend sends SSE event `{ command: "process_update", set_process: rid, status: "running", batch: {...} }` to UI

### Deleting a paused job (cascade from graph)

If the user deletes the SetProcess (cruncher) node from the graph while the batch is paused:
1. `deleteNode()` cascade detects the SetProcess being deleted
2. Backend looks up any SQLite queue job with matching `set_process` RID
3. If found and status is `paused`: delete the job row from SQLite
4. If found and status is `running`: this case is blocked by the UI (see below)

**Invariant**: A cruncher/SetProcess node cannot be deleted from the graph while its batch job is `running` or `queued`. Only `paused`, `done`, `failed`, or `cancelled` jobs allow node deletion. The backend enforces this with a check in `deleteNode()` — returns 409 Conflict if the job is active.

### Why signal consumer directly?

The consumer holds the lease and is mid-batch. It cannot re-claim its own job. The backend must tell it to continue. This is simpler than releasing and re-queuing because:
- No risk of another consumer picking up a partially-processed batch
- Consumer already knows the service URL, has context loaded
- Resume is instant (no claim polling delay)

### Consumer control server

Consumer's `server.mjs` adds:

| Endpoint | Purpose |
|----------|---------|
| `POST /jobs/{job_id}/pause` | Set paused flag; consumer stops after current file |
| `POST /jobs/{job_id}/resume` | Clear paused flag; consumer resumes iteration |
| `POST /jobs/{job_id}/cancel` | Set cancelled flag; consumer stops and releases job |
| `GET /health` | Existing health check |

The consumer registers its control URL with the backend during adapter registration (already heartbeats every 30s). Backend knows where to send signals.

## Decision: Consumers access queue via HTTP API

Consumers do **not** have direct SQLite access. The backend exposes queue operations as HTTP endpoints:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/queue/claim` | Claim next available job for a topic |
| `POST /api/queue/{job_id}/heartbeat` | Extend lease |
| `POST /api/queue/{job_id}/complete` | Mark job done |
| `POST /api/queue/{job_id}/fail` | Report failure (triggers retry or mark failed) |
| `POST /api/queue/{job_id}/pause` | Pause job (signals consumer, updates status) |
| `POST /api/queue/{job_id}/resume` | Resume job (signals consumer, updates status) |
| `POST /api/queue/{job_id}/cancel` | Cancel job (signals consumer, updates status) |
| `GET /api/queue/{topic}/status` | Query queue state |
| `GET /api/queue/jobs/active` | List all active/paused jobs (for UI progress display) |

This means the SQLite file is owned exclusively by the backend process. Consumers are pure HTTP clients — they poll `/api/queue/claim`, process the job, and report back. No shared filesystem or database access required.

## SSE Event Contract (Backend → UI)

All batch-related events are sent via the existing `/events` SSE endpoint. Events are JSON with a `command` field:

| Command | When sent | Payload |
|---------|-----------|---------|
| `batch_started` | Job claimed by consumer | `{ set_process, service_id, total_files, status: "running" }` |
| `batch_progress` | After each file processed | `{ set_process, processed_files, total_files, failed_files, current_file_label, avg_sec_per_file, eta_sec }` |
| `batch_paused` | Consumer confirms pause | `{ set_process, processed_files, total_files, status: "paused" }` |
| `batch_resumed` | Consumer confirms resume | `{ set_process, processed_files, total_files, status: "running" }` |
| `batch_completed` | All files done | `{ set_process, processed_files, total_files, failed_files, total_time_sec, status: "done" }` |
| `batch_cancelled` | Consumer confirms cancel | `{ set_process, processed_files, total_files, status: "cancelled" }` |
| `batch_error` | Per-file error (non-fatal) | `{ set_process, file_rid, error_message, processed_files, total_files }` |
| `batch_failed` | Job failed entirely (max retries) | `{ set_process, error_message, status: "failed" }` |

**Design rule**: The backend is the single source of SSE events. Consumers report progress via callbacks (`POST /api/nomad/process/files`); the backend translates these into SSE events. Consumers never push events to the UI directly.

**Consumer loop becomes:**
```
while not stopped:
    job = POST /api/queue/claim { topic }
    if no job: backoff, continue
    
    start heartbeat timer → POST /api/queue/{job_id}/heartbeat
    
    if job.type == "batch":
        for file_rid in job.files:
            fetch file, call service, POST result callback
    else:
        fetch file, call service, POST result callback
    
    POST /api/queue/{job_id}/complete
```

## Open Questions

1. **How does the adapter know the service URL changed (e.g., new Nomad allocation)?**
   - Currently resolved at startup. If service restarts, adapter has stale URL.
   - With SQLite: same problem. Periodic re-resolution is sufficient.

3. **Should partition count be configurable per-service?**
   - Could be a field in service descriptor: `"max_parallel": 2`
   - Default: number of registered adapters (current heartbeat count)

4. **What about the ArcadeDB event listener (`nats.listenDBQueue`)?**
   - This was for ArcadeDB change events. If not actually used for critical logic, remove.
   - If needed: replace with polling or ArcadeDB webhook (if supported).

## Migration Path

1. Make SQLite queue the default (`index-db.mjs` becomes `index.mjs`)
2. Add batch-aware processing loop to consumer
3. Add partition splitting to backend publish
4. Remove NATS code and Docker service
5. Remove per-file Process node pre-creation
6. Update SetProcess lifecycle (created at publish, completed at final callback)

## Risks

- **Backend is single point of failure for queue**: All queue operations go through the backend HTTP API. If backend is down, consumers idle. Acceptable for low-traffic use; backend already must be up for callbacks.
- **SQLite write contention**: Mitigated by low traffic. If scaling is needed later, PostgreSQL is a drop-in replacement for the queue table.
- **Adapter crash mid-batch**: Lease expires → job requeued → entire partition retried. Some files may be processed twice (idempotency concern for stateful services). Output deduplication needed at callback handler.
- **Claim polling overhead**: Each consumer polls `/api/queue/claim` periodically. With exponential backoff (100ms → 2s), this is negligible at low traffic.
