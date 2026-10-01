# Proposal: Per-Service Retry Limits and Batch Auto-Abort

Status: **implemented**

## Problem

The queue system has a global `QUEUE_DB_MAX_ATTEMPTS` (default 3) applied to all jobs. There is no mechanism to:

1. Configure retry limits per service (e.g. thumbnail failures rarely recover on retry, but OCR timeouts might).
2. Automatically abort a batch when too many jobs fail (currently a 1000-file batch continues even if 999 fail).

## Design Decisions

Decided during grilling session (2026-08-14).

### Per-Message Retry Override

Allow messages to carry `queue_options.max_attempts` that overrides the global default.

**Publish path** (`queue.publish()`):
```js
const maxAttempts = Number(
  parsed?.queue_options?.max_attempts
  || process.env.QUEUE_DB_MAX_ATTEMPTS
  || 3
);
```

Services set this in their descriptor or task params. The backend passes it through when building queue messages.

### Batch Auto-Abort

When a job is permanently failed (attempts exhausted), `queue.fail()` checks whether the batch should be auto-aborted using a **combination trigger** — whichever fires first:

1. **Consecutive permanent failures** — abort after N consecutive permanent failures in the same batch (detects systematic issues like service down). Default: 5.
2. **Failure percentage** — abort after X% of total batch jobs have permanently failed. Default: 50%.

#### Configuration

| Variable | Default | Purpose |
|----------|---------|---------|
| `QUEUE_BATCH_ABORT_CONSECUTIVE` | `5` | Max consecutive permanent failures before auto-abort |
| `QUEUE_BATCH_ABORT_PERCENT` | `50` | Max failure percentage before auto-abort |

These can also be overridden per-message via `queue_options.abort_consecutive` and `queue_options.abort_percent`.

## Implementation Sketch

### In `queue.fail()` — after marking a job permanently failed:

```js
// Check batch abort conditions
const batchRid = row.set_process_rid;
if (batchRid) {
  const stats = db.prepare(`
    SELECT
      COUNT(*) FILTER (WHERE status = 'failed') AS failed_count,
      COUNT(*) AS total_count
    FROM queue_jobs
    WHERE set_process_rid = ?
      AND status IN ('done', 'failed', 'cancelled')
  `).get(batchRid);

  const failPercent = (stats.failed_count / stats.total_count) * 100;
  const maxPercent = Number(queueOptions?.abort_percent
    || process.env.QUEUE_BATCH_ABORT_PERCENT || 50);

  if (failPercent >= maxPercent) {
    await this.cancelBatch(batchRid);
    return true;
  }

  // Check consecutive failures
  const consecutive = db.prepare(`
    SELECT COUNT(*) AS streak FROM (
      SELECT status FROM queue_jobs
      WHERE set_process_rid = ?
        AND status IN ('done', 'failed')
      ORDER BY completed_at DESC
      LIMIT ?
    ) WHERE status = 'failed'
  `).get(batchRid, maxConsecutive);

  if (consecutive.streak >= maxConsecutive) {
    await this.cancelBatch(batchRid);
  }
}
```

**Note:** The consecutive-failure query checks the last N completed/failed jobs ordered by completion time. If all N are failures, it triggers abort.

### Schema Changes

Add `completed_at` population to `queue.complete()` and `queue.fail()` (permanent failure case) so the consecutive query can order by completion time. The column already exists in the schema but is only set by `complete()`.

### SSE Notification

When auto-abort fires, emit an SSE event so the UI can show the reason:
```json
{ "event": "batch_aborted", "process_rid": "...", "reason": "consecutive_failures" }
```
or
```json
{ "event": "batch_aborted", "process_rid": "...", "reason": "failure_threshold", "failed_percent": 62 }
```

## Files to Change

| File | Change |
|------|--------|
| `src/queue.mjs` | Add abort check in `fail()`, read `queue_options` from payload |
| `src/queue.mjs` | Set `completed_at` on permanent failure |
| `src/queue.mjs` `publish()` | Read `max_attempts` from `parsed.queue_options` |
| `wiki/architecture/queue-system.md` | Document new config variables and abort behavior |
| `wiki/environment-variables.md` | Add `QUEUE_BATCH_ABORT_*` variables |

## Not in Scope

- UI controls for configuring retry/abort thresholds (use env vars or message overrides).
- Per-service descriptor fields for retry config (can be added later if needed).
