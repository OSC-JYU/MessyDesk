// The job queue: a SQLite table (same schema and file as before), claimed by consumers over HTTP.
//
// Jobs live in a per-service queue named after the service id (`md-sharp`) or its batch twin
// (`md-sharp_batch`). Consumers claim from both, plain queue first. A claim takes a lease; a job
// whose lease runs out can be claimed again. Failures are retried with exponential backoff up to
// max_attempts, and a batch whose jobs keep failing is aborted automatically.
//
// Paused and cancelled batches are remembered in the `batch_state` table, so a restart does not
// forget them (plan/decisions.md D8; the old backend kept them in memory).
//
// This module knows nothing about the graph: callers build complete messages and react to the
// `batch_aborted` result of fail().

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

export interface QueueOptions {
    dbPath: string;
    maxAttempts: number;
    leaseSeconds: number;
    keepFailedMinutes: number;
    sweeperEnabled: boolean;
    sweeperIntervalSeconds: number;
    sweeperDoneCancelledMinutes: number;
    batchAbortConsecutive: number;
    batchAbortPercent: number;
}

export interface ClaimedJob {
    id: number;
    queue: string;
    payload: any;
    attempts: number;
    max_attempts: number;
}

export interface FailResult {
    ok: true;
    permanent: boolean;
    cancelled?: boolean;
    batch_aborted?: boolean;
    abort_reason?: string;
    batch_rid?: string;
    userId?: string | null;
    abort_detail?: Record<string, unknown>;
}

const JOB_STATUSES = new Set(['queued', 'running', 'done', 'failed', 'cancelled']);

export function isThumbnailPayload(payload: any): boolean {
    const serviceId = String(payload?.service?.id || payload?.id || '').toLowerCase();
    const topicId = String(payload?.topic?.id || '').toLowerCase();
    const taskId = String(payload?.task?.id || '').toLowerCase();
    const role = String(payload?.role || '').toLowerCase();
    return serviceId === 'md-thumbnailer' || topicId === 'md-thumbnailer'
        || (serviceId === 'md-poppler' && taskId === 'thumbnail')
        || role === 'thumbnail' || role === 'thumbnails';
}

export class JobQueue {
    private db: DatabaseSync | null = null;
    private readonly opts: QueueOptions;
    private sweeperTimer: NodeJS.Timeout | null = null;
    private sweeperRunning = false;

    constructor(opts: QueueOptions) {
        this.opts = opts;
    }

    open(): DatabaseSync {
        if (this.db) return this.db;
        fs.mkdirSync(path.dirname(this.opts.dbPath), { recursive: true });
        const db = new DatabaseSync(this.opts.dbPath);
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
            CREATE INDEX IF NOT EXISTS idx_queue_claim ON queue_jobs(queue, status, next_retry_at, created_at);
            CREATE INDEX IF NOT EXISTS idx_queue_process ON queue_jobs(process_rid, set_process_rid, status);
            CREATE INDEX IF NOT EXISTS idx_queue_cleanup ON queue_jobs(status, updated_at);
            CREATE TABLE IF NOT EXISTS batch_state (
                process_rid TEXT PRIMARY KEY,
                state TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        `);
        this.db = db;
        return db;
    }

    close(): void {
        this.stopSweeper();
        this.db?.close();
        this.db = null;
    }

    // ---- paused / cancelled batches ------------------------------------------------------

    private setBatchState(processRid: string, state: 'paused' | 'cancelled' | null): void {
        const db = this.open();
        if (state === null) db.prepare('DELETE FROM batch_state WHERE process_rid = ?').run(processRid);
        else db.prepare('INSERT INTO batch_state (process_rid, state, updated_at) VALUES (?, ?, ?) ON CONFLICT(process_rid) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at')
            .run(processRid, state, new Date().toISOString());
    }

    private batchState(...rids: Array<string | null | undefined>): string | null {
        const db = this.open();
        for (const rid of rids) {
            if (!rid) continue;
            const row = db.prepare('SELECT state FROM batch_state WHERE process_rid = ?').get(rid) as { state: string } | undefined;
            if (row) return row.state;
        }
        return null;
    }

    isCancelled(...rids: Array<string | null | undefined>): boolean {
        return this.batchState(...rids) === 'cancelled';
    }

    // ---- publishing ----------------------------------------------------------------------

    publish(queue: string, message: any): number {
        const payload = typeof message === 'string' ? JSON.parse(message) : message;
        const now = new Date().toISOString();
        const processRid = payload?.process?.['@rid'] ? String(payload.process['@rid']) : null;
        const setProcess = payload?.set_process || payload?.set_process_rid;
        const result = this.open().prepare(`
            INSERT INTO queue_jobs (queue, payload_json, process_rid, set_process_rid, status, attempts, max_attempts, next_retry_at, created_at, updated_at)
            VALUES (?, ?, ?, ?, 'queued', 0, ?, ?, ?, ?)
        `).run(
            queue,
            JSON.stringify(payload),
            processRid,
            setProcess ? String(setProcess) : null,
            Number(payload?.queue_options?.max_attempts || this.opts.maxAttempts || 3),
            now, now, now,
        );
        return Number(result.lastInsertRowid);
    }

    // ---- consumer side -------------------------------------------------------------------

    claim(topic: string, adapterId: string): ClaimedJob | null {
        const db = this.open();
        const now = new Date().toISOString();
        const leaseUntil = new Date(Date.now() + this.opts.leaseSeconds * 1000).toISOString();
        for (const queueName of [topic, `${topic}_batch`]) {
            db.exec('BEGIN IMMEDIATE');
            try {
                const candidates = db.prepare(`
                    SELECT id, payload_json, attempts, max_attempts, queue, process_rid, set_process_rid
                    FROM queue_jobs
                    WHERE queue = ? AND ((status = 'queued' AND next_retry_at <= ?) OR (status = 'running' AND lease_until < ?))
                    ORDER BY created_at ASC LIMIT 50
                `).all(queueName, now, now) as any[];
                let row: any = null;
                for (const candidate of candidates) {
                    const state = this.batchState(candidate.process_rid, candidate.set_process_rid);
                    if (state === 'cancelled') {
                        // Requeued after its batch was cancelled: finalize instead of running it.
                        db.prepare(`UPDATE queue_jobs SET status = 'cancelled', lease_until = NULL, claimed_by = NULL, claimed_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
                            .run(now, now, candidate.id);
                        continue;
                    }
                    if (state === 'paused') continue;
                    row = candidate;
                    break;
                }
                if (!row) {
                    db.exec('COMMIT');
                    continue;
                }
                db.prepare(`UPDATE queue_jobs SET status = 'running', claimed_by = ?, claimed_at = ?, lease_until = ?, attempts = attempts + 1, updated_at = ? WHERE id = ?`)
                    .run(adapterId, now, leaseUntil, now, row.id);
                db.exec('COMMIT');
                return {
                    id: row.id,
                    queue: row.queue,
                    payload: JSON.parse(row.payload_json),
                    attempts: Number(row.attempts || 0) + 1,
                    max_attempts: Number(row.max_attempts || 3),
                };
            } catch (error) {
                try { db.exec('ROLLBACK'); } catch { /* ignore */ }
                throw error;
            }
        }
        return null;
    }

    heartbeat(jobId: number, adapterId: string): boolean {
        const leaseUntil = new Date(Date.now() + this.opts.leaseSeconds * 1000).toISOString();
        const result = this.open().prepare(`UPDATE queue_jobs SET lease_until = ?, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?`)
            .run(leaseUntil, new Date().toISOString(), jobId, adapterId);
        return Number(result.changes) > 0;
    }

    complete(jobId: number, adapterId: string): boolean {
        const db = this.open();
        const now = new Date().toISOString();
        const job = db.prepare(`SELECT set_process_rid FROM queue_jobs WHERE id = ? AND status = 'running' AND claimed_by = ?`).get(jobId, adapterId) as any;
        if (!job) return false;
        const result = db.prepare(`UPDATE queue_jobs SET status = 'done', lease_until = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status = 'running' AND claimed_by = ?`)
            .run(now, now, jobId, adapterId);
        if (Number(result.changes) <= 0) return false;
        if (!job.set_process_rid) {
            // Single jobs need no history for the batch failure statistics.
            db.prepare('DELETE FROM queue_jobs WHERE id = ?').run(jobId);
            return true;
        }
        if (!this.hasActiveBatchJobs(job.set_process_rid)) this.cleanupBatchTerminalRows(job.set_process_rid);
        return true;
    }

    fail(jobId: number, errorMessage: string, adapterId: string): FailResult | false {
        const db = this.open();
        const now = new Date().toISOString();
        const row = db.prepare(`SELECT attempts, max_attempts, process_rid, set_process_rid, payload_json FROM queue_jobs WHERE id = ? AND status = 'running' AND claimed_by = ?`)
            .get(jobId, adapterId) as any;
        if (!row) return false;
        if (this.isCancelled(row.process_rid, row.set_process_rid)) {
            db.prepare(`UPDATE queue_jobs SET status = 'cancelled', lease_until = NULL, claimed_by = NULL, claimed_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
                .run(now, now, jobId);
            return { ok: true, permanent: false, cancelled: true };
        }
        const attempts = Number(row.attempts || 0);
        const maxAttempts = Number(row.max_attempts || 3);
        const message = String(errorMessage || 'processing failed');
        if (attempts < maxAttempts) {
            const backoffMs = Math.min(500 * 2 ** Math.max(0, attempts - 1), 30000);
            db.prepare(`UPDATE queue_jobs SET status = 'queued', lease_until = NULL, claimed_by = NULL, claimed_at = NULL, next_retry_at = ?, last_error = ?, updated_at = ? WHERE id = ?`)
                .run(new Date(Date.now() + backoffMs).toISOString(), message, now, jobId);
            return { ok: true, permanent: false };
        }
        db.prepare(`UPDATE queue_jobs SET status = 'failed', lease_until = NULL, claimed_by = NULL, claimed_at = NULL, last_error = ?, completed_at = ?, updated_at = ? WHERE id = ?`)
            .run(message, now, now, jobId);
        const batchRid = row.set_process_rid;
        if (batchRid) {
            const abort = this.checkBatchAutoAbort(batchRid, row.payload_json);
            if (abort) {
                let userId: string | null = null;
                try { userId = JSON.parse(row.payload_json || '{}').userId ?? null; } catch { /* ignore */ }
                return { ok: true, permanent: true, batch_aborted: true, abort_reason: abort.reason, batch_rid: batchRid, userId, abort_detail: abort };
            }
        }
        return { ok: true, permanent: true };
    }

    private checkBatchAutoAbort(batchRid: string, payloadJson: string): { reason: string; [k: string]: unknown } | null {
        const db = this.open();
        let options: any = {};
        try { options = JSON.parse(payloadJson || '{}')?.queue_options || {}; } catch { /* ignore */ }
        const maxConsecutive = Number(options.abort_consecutive || this.opts.batchAbortConsecutive || 5);
        const maxPercent = Number(options.abort_percent || this.opts.batchAbortPercent || 50);
        const stats = db.prepare(`
            SELECT SUM(CASE WHEN status = 'failed' THEN 1 ELSE 0 END) AS failed_count, COUNT(*) AS total_count
            FROM queue_jobs WHERE set_process_rid = ? AND status IN ('done', 'failed', 'cancelled')
        `).get(batchRid) as any;
        if (stats && stats.total_count > 0) {
            const failPercent = (stats.failed_count / stats.total_count) * 100;
            if (failPercent >= maxPercent) {
                this.cancelBatch(batchRid);
                return { reason: 'failure_threshold', failed_percent: Math.round(failPercent) };
            }
        }
        const recent = db.prepare(`
            SELECT status FROM queue_jobs WHERE set_process_rid = ? AND status IN ('done', 'failed') AND completed_at IS NOT NULL
            ORDER BY completed_at DESC LIMIT ?
        `).all(batchRid, maxConsecutive) as any[];
        if (recent.length >= maxConsecutive && recent.every((r) => r.status === 'failed')) {
            this.cancelBatch(batchRid);
            return { reason: 'consecutive_failures', count: maxConsecutive };
        }
        return null;
    }

    // ---- batch control -------------------------------------------------------------------

    private hasActiveBatchJobs(processRid: string): boolean {
        const row = this.open().prepare(`SELECT COUNT(*) AS count FROM queue_jobs WHERE set_process_rid = ? AND status IN ('queued', 'running')`).get(processRid) as any;
        return Number(row?.count || 0) > 0;
    }

    hasActiveJobsFor(rid: string): boolean {
        const row = this.open().prepare(`SELECT id FROM queue_jobs WHERE (process_rid = ? OR set_process_rid = ?) AND status IN ('queued', 'running') LIMIT 1`).get(rid, rid);
        return Boolean(row);
    }

    private cleanupBatchTerminalRows(processRid: string): void {
        const db = this.open();
        db.prepare(`DELETE FROM queue_jobs WHERE set_process_rid = ? AND status IN ('done', 'cancelled')`).run(processRid);
        if (this.opts.keepFailedMinutes <= 0) {
            db.prepare(`DELETE FROM queue_jobs WHERE set_process_rid = ? AND status = 'failed'`).run(processRid);
        } else {
            const cutoff = new Date(Date.now() - this.opts.keepFailedMinutes * 60000).toISOString();
            db.prepare(`DELETE FROM queue_jobs WHERE set_process_rid = ? AND status = 'failed' AND updated_at < ?`).run(processRid, cutoff);
        }
    }

    /** Deletes queued (not running) jobs of a process or batch. */
    drainByProcess(processRid: string): number {
        const result = this.open().prepare(`DELETE FROM queue_jobs WHERE status = 'queued' AND (process_rid = ? OR set_process_rid = ?)`).run(processRid, processRid);
        return Number(result.changes || 0);
    }

    pauseBatch(processRid: string): { status: string; process_rid: string; deleted: number } {
        this.setBatchState(processRid, 'paused');
        return { status: 'paused', process_rid: processRid, deleted: this.drainByProcess(processRid) };
    }

    resumeBatch(processRid: string): { status: string; process_rid: string } {
        this.setBatchState(processRid, null);
        return { status: 'running', process_rid: processRid };
    }

    cancelBatch(processRid: string): { status: string; process_rid: string; deleted: number; cleaned: unknown } {
        this.setBatchState(processRid, 'cancelled');
        const deleted = this.drainByProcess(processRid);
        let cleaned = null;
        if (!this.hasActiveBatchJobs(processRid)) {
            this.cleanupBatchTerminalRows(processRid);
            cleaned = true;
        }
        return { status: 'cancelled', process_rid: processRid, deleted, cleaned };
    }

    cancelJob(jobId: number): boolean {
        const now = new Date().toISOString();
        const result = this.open().prepare(`UPDATE queue_jobs SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued', 'running')`)
            .run(now, now, jobId);
        return Number(result.changes) > 0;
    }

    getJob(jobId: number): any | null {
        const row = this.open().prepare(`SELECT id, queue, payload_json, process_rid, set_process_rid, status, attempts, created_at, updated_at, completed_at FROM queue_jobs WHERE id = ?`).get(jobId) as any;
        if (!row) return null;
        const { payload_json: _payload, ...rest } = row;
        return rest;
    }

    /** Deletes every job of a topic and its batch twin. */
    flush(topic: string): { deleted: number } {
        const result = this.open().prepare('DELETE FROM queue_jobs WHERE queue = ? OR queue = ?').run(topic, `${topic}_batch`);
        return { deleted: Number(result.changes || 0) };
    }

    /**
     * Active (queued/running) jobs grouped by batch for the jobs panel. Internal thumbnail jobs
     * are hidden. `userRid` limits the list to that user's jobs (null = everyone, for admins).
     */
    activeJobs(userRid: string | null): any[] {
        const db = this.open();
        const rows = db.prepare(`
            SELECT id, queue, payload_json, process_rid, set_process_rid, status, attempts, claimed_by, created_at, updated_at
            FROM queue_jobs WHERE status IN ('queued', 'running') ORDER BY created_at ASC LIMIT 200
        `).all() as any[];
        const batches: Record<string, any> = {};
        for (const row of rows) {
            if (this.isCancelled(row.process_rid, row.set_process_rid)) {
                const now = new Date().toISOString();
                db.prepare(`UPDATE queue_jobs SET status = 'cancelled', lease_until = NULL, claimed_by = NULL, claimed_at = NULL, completed_at = ?, updated_at = ? WHERE id = ?`)
                    .run(now, now, row.id);
                continue;
            }
            let payload: any = null;
            try { payload = JSON.parse(row.payload_json); } catch { /* ignore */ }
            if (payload && isThumbnailPayload(payload)) continue;
            if (userRid && payload?.userId !== userRid) continue;
            let serviceId = payload?.service?.id || payload?.topic?.id || row.queue || '';
            serviceId = String(serviceId).replace(/_batch$/, '');
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
    }

    /** The user that started a job or batch, from its payload. */
    ownerOf(rid: string): string | null {
        const jobMatch = /^job_(\d+)$/.exec(rid);
        const row = jobMatch
            ? this.open().prepare('SELECT payload_json FROM queue_jobs WHERE id = ?').get(Number(jobMatch[1])) as any
            : this.open().prepare('SELECT payload_json FROM queue_jobs WHERE process_rid = ? OR set_process_rid = ? LIMIT 1').get(rid, rid) as any;
        if (!row) return null;
        try { return JSON.parse(row.payload_json).userId ?? null; } catch { return null; }
    }

    dismiss(rid: string): boolean {
        const now = new Date().toISOString();
        const jobMatch = /^job_(\d+)$/.exec(rid);
        if (jobMatch) return this.cancelJob(Number(jobMatch[1]));
        const result = this.open().prepare(`UPDATE queue_jobs SET status = 'cancelled', lease_until = NULL, completed_at = ?, updated_at = ? WHERE (process_rid = ? OR set_process_rid = ?) AND status IN ('queued', 'running')`)
            .run(now, now, rid, rid);
        return Number(result.changes) > 0;
    }

    // ---- sweeper -------------------------------------------------------------------------

    cleanupOlderThan(minutes: number, statuses: string[]): number {
        const valid = statuses.map((s) => s.toLowerCase()).filter((s) => JOB_STATUSES.has(s) && s !== 'running');
        if (!valid.length || !(minutes > 0)) return 0;
        const cutoff = new Date(Date.now() - minutes * 60000).toISOString();
        const result = this.open().prepare(`DELETE FROM queue_jobs WHERE status IN (${valid.map(() => '?').join(', ')}) AND updated_at < ?`).run(...valid, cutoff);
        return Number(result.changes || 0);
    }

    private sweepOnce(log: (m: string) => void): void {
        if (this.sweeperRunning) return;
        this.sweeperRunning = true;
        try {
            const doneCancelled = this.cleanupOlderThan(this.opts.sweeperDoneCancelledMinutes, ['done', 'cancelled']);
            const failed = this.cleanupOlderThan(this.opts.keepFailedMinutes, ['failed']);
            // Batch states nobody refers to any more.
            this.open().prepare(`DELETE FROM batch_state WHERE updated_at < ? AND process_rid NOT IN (SELECT DISTINCT set_process_rid FROM queue_jobs WHERE set_process_rid IS NOT NULL)`)
                .run(new Date(Date.now() - 7 * 24 * 3600 * 1000).toISOString());
            if (doneCancelled + failed > 0) log(`Queue sweeper removed ${doneCancelled} done/cancelled and ${failed} failed jobs`);
        } catch (error) {
            log(`Queue sweeper failed: ${(error as Error).message}`);
        } finally {
            this.sweeperRunning = false;
        }
    }

    startSweeper(log: (m: string) => void): void {
        if (!this.opts.sweeperEnabled || this.sweeperTimer) return;
        const seconds = this.opts.sweeperIntervalSeconds > 0 ? this.opts.sweeperIntervalSeconds : 300;
        this.sweeperTimer = setInterval(() => this.sweepOnce(log), seconds * 1000);
        this.sweeperTimer.unref();
        this.sweepOnce(log);
    }

    stopSweeper(): void {
        if (this.sweeperTimer) clearInterval(this.sweeperTimer);
        this.sweeperTimer = null;
    }
}
