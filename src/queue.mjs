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

const queueDb = {};

queueDb.pausedBatches = new Set();
queueDb.cancelledBatches = new Set();
queueDb._queueContextSampledTopics = new Set();

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
};

queueDb.connect = async function() {
  this._openDb();
};

queueDb.close = async function() {
  if (this.db) {
    this.db.close();
    this.db = null;
  }
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
      Number(process.env.QUEUE_DB_MAX_ATTEMPTS || 3),
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

queueDb.flushQueue = async function(topic) {
  const db = this._openDb();
  const result = db.prepare(`
    DELETE FROM queue_jobs
    WHERE queue = ? OR queue = ?
  `).run(topic, `${topic}_batch`);

  return { deleted: Number(result.changes || 0) };
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
  return { status: 'cancelled', process_rid, deleted };
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

  const result = db.prepare(`
    UPDATE queue_jobs
    SET status = 'done',
        lease_until = NULL,
        completed_at = ?,
        updated_at = ?
    WHERE id = ? AND status = 'running' AND claimed_by = ?
  `).run(now, now, jobId, adapterId);

  return Number(result.changes || 0) > 0;
};

queueDb.fail = function(jobId, errorMessage, adapterId) {
  const db = this._openDb();
  const now = new Date().toISOString();

  // Get current state
  const row = db.prepare(`
    SELECT attempts, max_attempts FROM queue_jobs
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
          updated_at = ?
      WHERE id = ?
    `).run(String(errorMessage || 'processing failed'), now, jobId);
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

  return true;
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
    const key = row.set_process_rid || row.process_rid || `job_${row.id}`;
    if (!batches[key]) {
      batches[key] = {
        rid: key,
        set_process: row.set_process_rid,
        process_rid: row.process_rid,
        queue: row.queue,
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
