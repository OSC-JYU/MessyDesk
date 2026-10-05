// Progress of a batch, stored on its SetProcess (or Process) node: status, counters, timing, ETA.

import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import type { GraphStore } from '../../shared/graph-store.ts';

function round(value: number, decimals = 2): number {
    const f = 10 ** decimals;
    return Math.round(value * f) / f;
}

export class BatchState {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;

    constructor(db: ArcadeClient, store: GraphStore) {
        this.db = db;
        this.store = store;
    }

    async get(processRid: string): Promise<any | null> {
        const rid = tryRid(processRid);
        if (!rid) return null;
        return await this.db.first('SELECT FROM SetProcess WHERE @rid = :rid LIMIT 1', { rid })
            || await this.db.first('SELECT FROM Process WHERE @rid = :rid LIMIT 1', { rid });
    }

    static status(batch: any): string | undefined {
        return batch?.status || batch?.state;
    }

    async update(processRid: string, patch: Record<string, unknown>): Promise<any | null> {
        const node = await this.get(processRid);
        if (!node) return null;
        await this.store.setAttributes(node['@rid'], patch);
        return { ...node, ...patch };
    }

    init(processRid: string, attrs: Record<string, unknown> = {}): Promise<any | null> {
        const now = new Date().toISOString();
        return this.update(processRid, {
            status: 'running',
            processed_files: 0,
            failed_files: 0,
            total_time_sec: 0,
            avg_sec_per_file: 0,
            eta_sec: null,
            started_at: now,
            updated_at: now,
            ...attrs,
        });
    }

    /** One more input processed; marks the batch done when all are. */
    async incrementProcessed(processRid: string, responseTime: unknown, totalFiles: unknown): Promise<any | null> {
        const batch = await this.get(processRid);
        if (!batch) return null;
        const now = new Date().toISOString();
        const delta = Number(responseTime || 0);
        // The counters are incremented in the database, not read-modified-written here: parallel
        // callbacks lost most updates that way (2 842 of 10 000 counted with 16 consumers, so the
        // batch never reached "done"; perf/results/upload-and-batch.md). A conflicting update is retried
        // by the client and re-evaluates the increment.
        const counted = await this.db.first(
            `UPDATE ${toRid(batch['@rid'])} SET processed_files = ifnull(processed_files, 0) + 1, total_time_sec = ifnull(total_time_sec, 0) + :delta, updated_at = :now RETURN AFTER`,
            { delta: Number.isFinite(delta) ? delta : 0, now },
        );
        const processed = Number(counted?.processed_files || 0);
        const total = Number(totalFiles || counted?.total_files || batch.total_files || 0);
        const totalTime = Number(counted?.total_time_sec || 0);
        const avg = processed > 0 ? round(totalTime / processed, 3) : 0;
        const remaining = total > 0 ? Math.max(total - processed, 0) : 0;
        const patch: Record<string, unknown> = {
            total_files: total || batch.total_files || 0,
            total_time_sec: round(totalTime, 3),
            avg_sec_per_file: avg,
            eta_sec: total > 0 && avg > 0 ? Math.round(remaining * avg) : null,
        };
        if (total > 0 && processed >= total) {
            patch.status = 'done';
            patch.finished_at = now;
            patch.eta_sec = 0;
        }
        await this.store.setAttributes(batch['@rid'], patch);
        return { ...batch, ...counted, ...patch, processed_files: processed, failed_files: Number(counted?.failed_files || 0), updated_at: now };
    }

    async incrementFailed(processRid: string): Promise<any | null> {
        const batch = await this.get(processRid);
        if (!batch) return null;
        const counted = await this.db.first(
            `UPDATE ${toRid(batch['@rid'])} SET failed_files = ifnull(failed_files, 0) + 1, updated_at = :now RETURN AFTER`,
            { now: new Date().toISOString() },
        );
        return { ...batch, ...counted };
    }

    /** Input files that already have an output in this batch (for resume). */
    async processedInputs(processRid: string): Promise<string[]> {
        const rows = await this.db.rows('SELECT DISTINCT @in AS rid FROM DERIVED_FROM WHERE process_rid = :rid', { rid: toRid(processRid) });
        return rows.map((r) => r.rid).filter(Boolean);
    }

    /** An existing output of a process for a given source (guards grouped many-to-one retries). */
    async outputFor(processRid: string, sourceRid: string, outputSet: string | null): Promise<any | null> {
        const rows = (await this.db.edgesOf('in', 'DERIVED_FROM', [toRid(sourceRid)], [], 'process_rid = :p', { p: toRid(processRid) })).slice(0, 10);
        for (const row of rows) {
            const node = await this.store.getNode(row.target);
            if (!node || node['@type'] !== 'File') continue;
            if (outputSet && tryRid(node.set) !== toRid(outputSet)) continue;
            return node;
        }
        return null;
    }

    /** The process that produced a set (from the set's DERIVED_FROM edge). */
    async processOfSet(setRid: string): Promise<any | null> {
        const row = (await this.db.edgesOf('out', 'DERIVED_FROM', [toRid(setRid)], ['process_rid'], 'process_rid IS NOT NULL'))[0];
        if (!row?.process_rid) return null;
        return this.store.getNode(row.process_rid);
    }
}
