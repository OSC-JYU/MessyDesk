import path from 'path';
import fs from 'fs-extra';
import { DatabaseSync } from 'node:sqlite';

import Graph from './graph.mjs';
import media from './media.mjs';
import { createProcessQueueMessage } from './messageFactory.mjs';
import { DATA_DIR } from './env.mjs';

const LOG_QUEUE_CONTEXT = ['1', 'true', 'yes', 'on'].includes(
  String(process.env.LOG_QUEUE_CONTEXT || '').trim().toLowerCase()
);
const QUEUE_DB_PATH = process.env.QUEUE_DB_PATH || path.join(DATA_DIR, 'queue.sqlite');
const QUEUE_DB_KEEP_FAILED_MINUTES = Number(process.env.QUEUE_DB_KEEP_FAILED_MINUTES || 1440);
const QUEUE_DB_SWEEPER_ENABLED = !['0', 'false', 'no', 'off'].includes(
  String(process.env.QUEUE_DB_SWEEPER_ENABLED || 'true').trim().toLowerCase()
);
const QUEUE_DB_SWEEPER_INTERVAL_SECONDS = Number(process.env.QUEUE_DB_SWEEPER_INTERVAL_SECONDS || 300);
const QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES = Number(process.env.QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES || 60);

function isThumbnailPayload(payload) {
  const serviceId = String(payload?.service?.id || payload?.id || '').toLowerCase();
  const topicId = String(payload?.topic?.id || '').toLowerCase();
  const taskId = String(payload?.task?.id || '').toLowerCase();
  const role = String(payload?.role || '').toLowerCase();
  return serviceId === 'md-thumbnailer'
    || topicId === 'md-thumbnailer'
    || (serviceId === 'md-poppler' && taskId === 'thumbnail')
    || role === 'thumbnail'
    || role === 'thumbnails';
}

const queueDb = {};

queueDb.pausedBatches = new Set();
queueDb.cancelledBatches = new Set();
queueDb._queueContextSampledTopics = new Set();
queueDb._sweeperTimer = null;
queueDb._sweeperRunning = false;
queueDb._sweeperSummary = {
  enabled: QUEUE_DB_SWEEPER_ENABLED,
  interval_seconds: QUEUE_DB_SWEEPER_INTERVAL_SECONDS,
  done_cancelled_minutes: QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES,
  keep_failed_minutes: QUEUE_DB_KEEP_FAILED_MINUTES,
  running: false,
  started_at: null,
  last_run_started_at: null,
  last_run_finished_at: null,
  last_deleted_done_cancelled: 0,
  last_deleted_failed: 0,
  last_deleted_total: 0,
  last_error: null,
  total_runs: 0,
  total_deleted_done_cancelled: 0,
  total_deleted_failed: 0,
  total_deleted: 0,
};

queueDb._openDb = function() {
  if (this.db) return this.db;

  fs.ensureDirSync(path.dirname(QUEUE_DB_PATH));
  const db = new DatabaseSync(QUEUE_DB_PATH);
  db.exec('PRAGMA journal_mode = WAL;');
  db.exec('PRAGMA busy_timeout = 5000;');
  db.exec('PRAGMA synchronous = NORMAL;');

  db.exec(`
    CREATE TABLE IF NOT EXISTS queue_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      queue TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      process_rid TEXT,
      set_process_rid TEXT,
      status TEXT NOT NULL DEFAULT 'queued',
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

    CREATE INDEX IF NOT EXISTS idx_queue_claim
      ON queue_jobs(queue, status, next_retry_at, created_at);

    CREATE INDEX IF NOT EXISTS idx_queue_process
      ON queue_jobs(process_rid, set_process_rid, status);

    CREATE INDEX IF NOT EXISTS idx_queue_cleanup
      ON queue_jobs(status, updated_at);
  `);

  this.db = db;
  return db;
};

queueDb.init = async function() {
  this._openDb();
  console.log('QUEUE-DB: sqlite queue ready at', QUEUE_DB_PATH);
  this.startSweeper();
};

queueDb.connect = async function() {
  this._openDb();
};

queueDb.close = async function() {
  this.stopSweeper();
  if (this.db) {
    this.db.close();
    this.db = null;
  }
};

queueDb._runSweeperOnce = async function() {
  if (this._sweeperRunning) return;
  this._sweeperRunning = true;
  this._sweeperSummary.running = true;
  this._sweeperSummary.last_run_started_at = new Date().toISOString();

  try {
    const doneCancelledMinutes = Number(QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES);
    let deletedDoneCancelled = 0;
    let deletedFailed = 0;

    if (Number.isFinite(doneCancelledMinutes) && doneCancelledMinutes > 0) {
      const result = await this.cleanupOlderThan({
        olderThanMinutes: doneCancelledMinutes,
        statuses: ['done', 'cancelled'],
      });
      deletedDoneCancelled = Number(result?.deleted || 0);
    }

    const keepFailedMinutes = Number(QUEUE_DB_KEEP_FAILED_MINUTES);
    if (Number.isFinite(keepFailedMinutes) && keepFailedMinutes > 0) {
      const failedResult = await this.cleanupOlderThan({
        olderThanMinutes: keepFailedMinutes,
        statuses: ['failed'],
      });
      deletedFailed = Number(failedResult?.deleted || 0);
    }

    const totalDeleted = deletedDoneCancelled + deletedFailed;
    this._sweeperSummary.last_deleted_done_cancelled = deletedDoneCancelled;
    this._sweeperSummary.last_deleted_failed = deletedFailed;
    this._sweeperSummary.last_deleted_total = totalDeleted;
    this._sweeperSummary.total_runs += 1;
    this._sweeperSummary.total_deleted_done_cancelled += deletedDoneCancelled;
    this._sweeperSummary.total_deleted_failed += deletedFailed;
    this._sweeperSummary.total_deleted += totalDeleted;
    this._sweeperSummary.last_error = null;

    if (totalDeleted > 0) {
      console.log('QUEUE-DB sweeper cleanup', {
        deleted_done_cancelled: deletedDoneCancelled,
        deleted_failed: deletedFailed,
      });
    }
  } catch (error) {
    this._sweeperSummary.last_error = String(error?.message || error);
    console.warn('QUEUE-DB sweeper failed', error?.message || error);
  } finally {
    this._sweeperRunning = false;
    this._sweeperSummary.running = false;
    this._sweeperSummary.last_run_finished_at = new Date().toISOString();
  }
};

queueDb.startSweeper = function() {
  this._sweeperSummary.enabled = QUEUE_DB_SWEEPER_ENABLED;
  this._sweeperSummary.interval_seconds = QUEUE_DB_SWEEPER_INTERVAL_SECONDS;
  this._sweeperSummary.done_cancelled_minutes = QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES;
  this._sweeperSummary.keep_failed_minutes = QUEUE_DB_KEEP_FAILED_MINUTES;

  if (!QUEUE_DB_SWEEPER_ENABLED) {
    console.log('QUEUE-DB sweeper disabled by QUEUE_DB_SWEEPER_ENABLED');
    return;
  }

  if (this._sweeperTimer) return;

  const intervalSeconds = Number(QUEUE_DB_SWEEPER_INTERVAL_SECONDS);
  const validIntervalSeconds = Number.isFinite(intervalSeconds) && intervalSeconds > 0
    ? intervalSeconds
    : 300;

  this._sweeperTimer = setInterval(() => {
    this._runSweeperOnce();
  }, validIntervalSeconds * 1000);

  this._sweeperSummary.started_at = new Date().toISOString();
  this._sweeperSummary.interval_seconds = validIntervalSeconds;

  console.log('QUEUE-DB sweeper started', {
    interval_seconds: validIntervalSeconds,
    done_cancelled_minutes: QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES,
    keep_failed_minutes: QUEUE_DB_KEEP_FAILED_MINUTES,
  });

  // Kick once at startup to trim stale rows from previous runs.
  this._runSweeperOnce();
};

queueDb.stopSweeper = function() {
  if (this._sweeperTimer) {
    clearInterval(this._sweeperTimer);
    this._sweeperTimer = null;
  }
  this._sweeperSummary.running = false;
};

queueDb.getSweeperSummary = function() {
  return {
    ...this._sweeperSummary,
    running: this._sweeperRunning,
    has_timer: Boolean(this._sweeperTimer),
    now: new Date().toISOString(),
  };
};

queueDb._toRidString = function(value) {
  if (!value) return null;
  return String(value);
};

queueDb._extractProcessRid = function(message) {
  return this._toRidString(message?.process?.['@rid']);
};

queueDb._extractSetProcessRid = function(message) {
  return this._toRidString(message?.set_process || message?.set_process_rid);
};

queueDb.publish = async function(topic, data) {
  try {
    const enriched = await createProcessQueueMessage(data, {
      resolveProjectRidForNode: (rid) => Graph.getProjectRidForNode(rid)
    });

    if (
      LOG_QUEUE_CONTEXT &&
      enriched &&
      typeof enriched === 'object' &&
      !Array.isArray(enriched) &&
      !this._queueContextSampledTopics.has(topic)
    ) {
      this._queueContextSampledTopics.add(topic);
      console.log('queue_context_sample', {
        topic,
        project_rid: enriched.project_rid || null,
        set_rid: enriched.set_rid || null,
        set_process: enriched.set_process || null,
        file_rid: enriched.file?.['@rid'] || null,
      });
    }

    const payloadJson = typeof enriched === 'string' ? enriched : JSON.stringify(enriched);
    const parsed = typeof enriched === 'string' ? JSON.parse(enriched) : enriched;

    const now = new Date().toISOString();
    const db = this._openDb();
    db.prepare(`
      INSERT INTO queue_jobs (
        queue,
        payload_json,
        process_rid,
        set_process_rid,
        status,
        attempts,
        max_attempts,
        next_retry_at,
        created_at,
        updated_at
      ) VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
    `).run(
      topic,
      payloadJson,
      this._extractProcessRid(parsed),
      this._extractSetProcessRid(parsed),
      Number(parsed?.queue_options?.max_attempts || process.env.QUEUE_DB_MAX_ATTEMPTS || 3),
      now,
      now,
      now
    );
  } catch (e) {
    console.log(`ERROR: Could not add topic ${topic} to db queue!\n`, e);
  }
};

queueDb.getQueueStatus = async function(topic) {
  const db = this._openDb();
  const rows = db.prepare(`
    SELECT queue, status, COUNT(*) AS count
    FROM queue_jobs
    WHERE queue = ? OR queue = ?
    GROUP BY queue, status
  `).all(topic, `${topic}_batch`);

  const status = {};
  for (const row of rows) {
    if (!status[row.queue]) {
      status[row.queue] = { queue: row.queue, queued: 0, running: 0, done: 0, failed: 0, cancelled: 0 };
    }
    status[row.queue][row.status] = Number(row.count || 0);
  }
  return status;
};

queueDb.drainQueue = async function(topic, process_rid) {
  const db = this._openDb();
  const result = db.prepare(`
    DELETE FROM queue_jobs
    WHERE (queue = ? OR queue = ?)
      AND status = 'queued'
      AND (? IS NULL OR process_rid = ? OR set_process_rid = ?)
  `).run(topic, `${topic}_batch`, process_rid || null, process_rid || null, process_rid || null);

  return Number(result.changes || 0);
};

queueDb.drainQueueByProcess = async function(process_rid) {
  const db = this._openDb();
  const result = db.prepare(`
    DELETE FROM queue_jobs
    WHERE status = 'queued'
      AND (process_rid = ? OR set_process_rid = ?)
  `).run(process_rid, process_rid);

  return Number(result.changes || 0);
};

queueDb._hasActiveBatchJobs = function(process_rid) {
  const db = this._openDb();
  const row = db.prepare(`
    SELECT COUNT(*) AS count
    FROM queue_jobs
    WHERE set_process_rid = ?
      AND status IN ('queued', 'running')
  `).get(process_rid);
  return Number(row?.count || 0) > 0;
};

queueDb._cleanupBatchTerminalRows = function(process_rid, keepFailedMinutes = QUEUE_DB_KEEP_FAILED_MINUTES) {
  const db = this._openDb();
  const sanitizedKeepFailedMinutes = Number.isFinite(Number(keepFailedMinutes))
    ? Number(keepFailedMinutes)
    : QUEUE_DB_KEEP_FAILED_MINUTES;

  const doneCancelledResult = db.prepare(`
    DELETE FROM queue_jobs
    WHERE set_process_rid = ?
      AND status IN ('done', 'cancelled')
  `).run(process_rid);

  let failedDeleted = 0;
  if (sanitizedKeepFailedMinutes <= 0) {
    const failedResult = db.prepare(`
      DELETE FROM queue_jobs
      WHERE set_process_rid = ?
        AND status = 'failed'
    `).run(process_rid);
    failedDeleted = Number(failedResult.changes || 0);
  } else {
    const failedCutoffIso = new Date(Date.now() - sanitizedKeepFailedMinutes * 60 * 1000).toISOString();
    const failedResult = db.prepare(`
      DELETE FROM queue_jobs
      WHERE set_process_rid = ?
        AND status = 'failed'
        AND updated_at < ?
    `).run(process_rid, failedCutoffIso);
    failedDeleted = Number(failedResult.changes || 0);
  }

  return {
    done_cancelled_deleted: Number(doneCancelledResult.changes || 0),
    failed_deleted: failedDeleted,
    keep_failed_minutes: sanitizedKeepFailedMinutes,
  };
};

queueDb.flushQueue = async function(topic) {
  const db = this._openDb();
  const result = db.prepare(`
    DELETE FROM queue_jobs
    WHERE queue = ? OR queue = ?
  `).run(topic, `${topic}_batch`);

  return { deleted: Number(result.changes || 0) };
};

queueDb.cleanupOlderThan = async function({ olderThanMinutes, statuses = ['done', 'failed', 'cancelled'], dryRun = false }) {
  const minutes = Number(olderThanMinutes);
  if (!Number.isFinite(minutes) || minutes <= 0) {
    throw new Error('olderThanMinutes must be a positive number');
  }

  const allowedStatuses = new Set(['queued', 'running', 'done', 'failed', 'cancelled']);
  const normalizedStatuses = (Array.isArray(statuses) ? statuses : [statuses])
    .map((status) => String(status || '').trim().toLowerCase())
    .filter((status) => allowedStatuses.has(status));

  if (normalizedStatuses.length === 0) {
    throw new Error('statuses must include at least one valid queue status');
  }

  // Running jobs must never be hard-deleted through cleanup.
  if (normalizedStatuses.includes('running')) {
    throw new Error('cleanup does not allow status "running"');
  }

  const cutoffIso = new Date(Date.now() - (minutes * 60 * 1000)).toISOString();
  const db = this._openDb();
  const placeholders = normalizedStatuses.map(() => '?').join(', ');

  if (dryRun) {
    const row = db.prepare(`
      SELECT COUNT(*) AS count
      FROM queue_jobs
      WHERE status IN (${placeholders})
        AND updated_at < ?
    `).get(...normalizedStatuses, cutoffIso);

    return {
      dry_run: true,
      older_than_minutes: minutes,
      statuses: normalizedStatuses,
      cutoff: cutoffIso,
      count: Number(row?.count || 0),
    };
  }

  const result = db.prepare(`
    DELETE FROM queue_jobs
    WHERE status IN (${placeholders})
      AND updated_at < ?
  `).run(...normalizedStatuses, cutoffIso);

  return {
    dry_run: false,
    older_than_minutes: minutes,
    statuses: normalizedStatuses,
    cutoff: cutoffIso,
    deleted: Number(result.changes || 0),
  };
};

queueDb.writeToDB = async function() {
  return true;
};

queueDb.createSetProcessNodesAndPublish = async function(msg) {
  const batchRid = msg?.set_process || msg?.set_process_rid;

  if (batchRid) {
    const batchNode = await Graph.getBatchProcess(batchRid);
    const batchStatus = batchNode?.status || batchNode?.state || 'running';

    if (batchStatus === 'paused' || batchStatus === 'cancelling' || batchStatus === 'cancelled' || batchStatus === 'done') {
      return;
    }

    if (!msg.process || !msg.process['@rid']) {
      msg.process = { '@rid': batchRid };
    }

    await this.publish(`${msg.service.id}_batch`, JSON.stringify(msg));
    return;
  }

  const processNode = await Graph.createProcessNode_queue(msg);
  await media.createProcessDir(processNode.path);
  await media.writeJSON(msg, 'message.json', path.join(path.dirname(processNode.path)));
  msg.process = processNode;

  await this.publish(`${msg.service.id}_batch`, JSON.stringify(msg));
};

queueDb.cancelBatch = async function(process_rid) {
  this.cancelledBatches.add(process_rid);
  this.pausedBatches.delete(process_rid);
  const deleted = await this.drainQueueByProcess(process_rid);
  let cleaned = null;
  if (!this._hasActiveBatchJobs(process_rid)) {
    cleaned = this._cleanupBatchTerminalRows(process_rid);
  }
  return { status: 'cancelled', process_rid, deleted, cleaned };
};

queueDb.cancelJob = function(jobId) {
  const db = this._openDb();
  const now = new Date().toISOString();
  const result = db.prepare(`
    UPDATE queue_jobs
    SET status = 'cancelled',
        lease_until = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE id = ? AND status IN ('queued', 'running')
  `).run(now, now, jobId);
  return Number(result.changes || 0) > 0;
};

queueDb.getJobById = function(jobId) {
  const db = this._openDb();
  const row = db.prepare(`
    SELECT id, queue, payload_json, process_rid, set_process_rid, status,
           attempts, claimed_by, created_at, updated_at, completed_at
    FROM queue_jobs
    WHERE id = ?
  `).get(jobId);
  if (!row) return null;
  return {
    id: row.id,
    queue: row.queue,
    process_rid: row.process_rid,
    set_process_rid: row.set_process_rid,
    status: row.status,
    attempts: row.attempts,
    created_at: row.created_at,
    updated_at: row.updated_at,
    completed_at: row.completed_at,
  };
};

queueDb.pauseBatch = async function(process_rid) {
  this.pausedBatches.add(process_rid);
  const deleted = await this.drainQueueByProcess(process_rid);
  return { status: 'paused', process_rid, deleted };
};

queueDb.resumeBatch = async function(process_rid) {
  this.pausedBatches.delete(process_rid);
  this.cancelledBatches.delete(process_rid);
  return { status: 'running', process_rid };
};

// --- Consumer-facing operations ---

const DEFAULT_LEASE_SECONDS = Number(process.env.QUEUE_DB_LEASE_SECONDS || 120);

queueDb.claim = function(topic, adapterId) {
  const db = this._openDb();
  const now = new Date().toISOString();
  const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_SECONDS * 1000).toISOString();

  // Claim from both <topic> and <topic>_batch queues
  const queues = [topic, `${topic}_batch`];

  for (const queueName of queues) {
    db.exec('BEGIN IMMEDIATE');
    try {
      const row = db.prepare(`
        SELECT id, payload_json, attempts, max_attempts, queue
        FROM queue_jobs
        WHERE queue = ?
          AND (
            (status = 'queued' AND next_retry_at <= ?)
            OR (status = 'running' AND lease_until < ?)
          )
        ORDER BY created_at ASC
        LIMIT 1
      `).get(queueName, now, now);

      if (!row) {
        db.exec('COMMIT');
        continue;
      }

      db.prepare(`
        UPDATE queue_jobs
        SET status = 'running',
            claimed_by = ?,
            claimed_at = ?,
            lease_until = ?,
            attempts = attempts + 1,
            updated_at = ?
        WHERE id = ?
      `).run(adapterId, now, leaseUntil, now, row.id);

      db.exec('COMMIT');

      return {
        id: row.id,
        queue: row.queue,
        payload: JSON.parse(row.payload_json),
        attempts: Number(row.attempts || 0) + 1,
        max_attempts: Number(row.max_attempts || 3),
      };
    } catch (error) {
      try { db.exec('ROLLBACK'); } catch (_) { /* ignore */ }
      throw error;
    }
  }

  return null; // no work available
};

queueDb.heartbeat = function(jobId, adapterId) {
  const db = this._openDb();
  const leaseUntil = new Date(Date.now() + DEFAULT_LEASE_SECONDS * 1000).toISOString();
  const now = new Date().toISOString();

  const result = db.prepare(`
    UPDATE queue_jobs
    SET lease_until = ?, updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).run(leaseUntil, now, jobId, adapterId);

  return Number(result.changes || 0) > 0;
};

queueDb.complete = function(jobId, adapterId) {
  const db = this._openDb();
  const now = new Date().toISOString();

  const job = db.prepare(`
    SELECT set_process_rid
    FROM queue_jobs
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).get(jobId, adapterId);
  if (!job) return false;

  const result = db.prepare(`
    UPDATE queue_jobs
    SET status = 'done',
        lease_until = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).run(now, now, jobId, adapterId);

  if (Number(result.changes || 0) <= 0) {
    return false;
  }

  if (!job.set_process_rid) {
    // Single-file jobs do not need history for batch failure calculations.
    db.prepare('DELETE FROM queue_jobs WHERE id = ?').run(jobId);
    return true;
  }

  if (!this._hasActiveBatchJobs(job.set_process_rid)) {
    this._cleanupBatchTerminalRows(job.set_process_rid);
  }

  return true;
};

queueDb.fail = async function(jobId, errorMessage, adapterId) {
  const db = this._openDb();
  const now = new Date().toISOString();

  // Get current state
  const row = db.prepare(`
    SELECT attempts, max_attempts, set_process_rid, payload_json FROM queue_jobs
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).get(jobId, adapterId);

  if (!row) return false;

  const attempts = Number(row.attempts || 0);
  const maxAttempts = Number(row.max_attempts || 3);

  if (attempts >= maxAttempts) {
    // Permanently failed
    db.prepare(`
      UPDATE queue_jobs
      SET status = 'failed',
          lease_until = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          last_error = ?,
          completed_at = ?,
          updated_at = ?
      WHERE id = ?
    `).run(String(errorMessage || 'processing failed'), now, now, jobId);

    // Check batch auto-abort conditions
    const batchRid = row.set_process_rid;
    if (batchRid) {
      const abortResult = await this._checkBatchAutoAbort(batchRid, row.payload_json);
      if (abortResult) {
        // Extract userId from payload for notification
        let userId = null;
        try { userId = JSON.parse(row.payload_json || '{}').userId; } catch { /* ignore */ }
        return { ok: true, permanent: true, batch_aborted: true, abort_reason: abortResult.reason, batch_rid: batchRid, userId, abort_detail: abortResult };
      }
    }

    return { ok: true, permanent: true };
  } else {
    // Requeue with backoff
    const backoffMs = Math.min(500 * Math.pow(2, Math.max(0, attempts - 1)), 30000);
    const retryAt = new Date(Date.now() + backoffMs).toISOString();

    db.prepare(`
      UPDATE queue_jobs
      SET status = 'queued',
          lease_until = NULL,
          claimed_by = NULL,
          claimed_at = NULL,
          next_retry_at = ?,
          last_error = ?,
          updated_at = ?
      WHERE id = ?
    `).run(retryAt, String(errorMessage || 'processing failed'), now, jobId);
  }

  return { ok: true, permanent: false };
};

queueDb._checkBatchAutoAbort = async function(batchRid, payloadJson) {
  const db = this._openDb();

  // Read per-message overrides if available
  let queueOptions = {};
  try {
    const parsed = JSON.parse(payloadJson || '{}');
    queueOptions = parsed?.queue_options || {};
  } catch { /* ignore */ }

  const maxConsecutive = Number(
    queueOptions.abort_consecutive
    || process.env.QUEUE_BATCH_ABORT_CONSECUTIVE
    || 5
  );
  const maxPercent = Number(
    queueOptions.abort_percent
    || process.env.QUEUE_BATCH_ABORT_PERCENT
    || 50
  );

  // Check failure percentage
  const stats = db.prepare(`
    SELECT
      SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count,
      COUNT(*) AS total_count
    FROM queue_jobs
    WHERE set_process_rid = ?
      AND status IN ('done', 'failed', 'cancelled')
  `).get(batchRid);

  if (stats && stats.total_count > 0) {
    const failPercent = (stats.failed_count / stats.total_count) * 100;
    if (failPercent >= maxPercent) {
      await this.cancelBatch(batchRid);
      return { reason: 'failure_threshold', failed_percent: Math.round(failPercent) };
    }
  }

  // Check consecutive failures (last N completed/failed jobs)
  const recentRows = db.prepare(`
    SELECT status FROM queue_jobs
    WHERE set_process_rid = ?
      AND status IN ('done', 'failed')
      AND completed_at IS NOT NULL
    ORDER BY completed_at DESC
    LIMIT ?
  `).all(batchRid, maxConsecutive);

  if (recentRows.length >= maxConsecutive && recentRows.every(r => r.status === 'failed')) {
    await this.cancelBatch(batchRid);
    return { reason: 'consecutive_failures', count: maxConsecutive };
  }

  return null;
};

queueDb.getActiveJobs = function() {
  const db = this._openDb();
  const rows = db.prepare(`
    SELECT id, queue, payload_json, process_rid, set_process_rid, status,
           attempts, claimed_by, created_at, updated_at
    FROM queue_jobs
    WHERE status IN ('queued', 'running')
    ORDER BY created_at ASC
    LIMIT 200
  `).all();

  // Group by set_process_rid to return batch-level summaries
  const batches = {};
  for (const row of rows) {
    // Filter out internal thumbnail jobs from active job list
    try {
      const payload = JSON.parse(row.payload_json);
      if (isThumbnailPayload(payload)) continue;
    } catch { /* ignore parse errors */ }

    let serviceId = row.queue || '';
    try {
      const payload = JSON.parse(row.payload_json);
      serviceId = payload?.service?.id || payload?.topic?.id || serviceId;
    } catch { /* ignore */ }
    // Strip _batch suffix for display
    serviceId = serviceId.replace(/_batch$/, '');

    const key = row.set_process_rid || row.process_rid || `job_${row.id}`;
    if (!batches[key]) {
      batches[key] = {
        rid: key,
        set_process: row.set_process_rid,
        process_rid: row.process_rid,
        queue: row.queue,
        service_id: serviceId,
        status: 'running',
        total_files: 0,
        processed_files: 0,
        queued_files: 0,
        running_files: 0,
      };
    }
    batches[key].total_files += 1;
    if (row.status === 'queued') batches[key].queued_files += 1;
    if (row.status === 'running') batches[key].running_files += 1;
  }

  return Object.values(batches);
};

queueDb.dismissJob = function(rid) {
  const db = this._openDb();
  const now = new Date().toISOString();

  // Handle job_N format (individual queue job)
  const jobIdMatch = /^job_(\d+)$/.exec(rid);
  if (jobIdMatch) {
    const jobId = Number(jobIdMatch[1]);
    const result = db.prepare(`
      UPDATE queue_jobs
      SET status = 'cancelled',
          lease_until = NULL,
          completed_at = ?,
          updated_at = ?
      WHERE id = ? AND status IN ('queued', 'running')
    `).run(now, now, jobId);
    return Number(result.changes || 0) > 0;
  }

  // Handle OrientDB RID format – clear all active jobs for a process/batch
  const result = db.prepare(`
    UPDATE queue_jobs
    SET status = 'cancelled',
        lease_until = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE (process_rid = ? OR set_process_rid = ?)
      AND status IN ('queued', 'running')
  `).run(now, now, rid, rid);
  return Number(result.changes || 0) > 0;
};

queueDb.listConsumers = async function() {
  return [];
};

queueDb.listenDBQueue = async function() {
  return;
};

queueDb.ensureProcessConsumersForService = async function() {
  return;
};

queueDb.reconcileProcessConsumers = async function() {
  return { scanned: 0, removed: 0, skipped: 0 };
};

export default queueDb;
