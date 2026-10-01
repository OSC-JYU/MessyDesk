// Low-level graph writes shared by all modules: create a vertex, set one attribute, connect two
// vertices. Every module's repository uses these instead of building statements itself.

import type { ArcadeClient } from '../platform/arcade/client.ts';
import { toRid, uuidv7 } from '../platform/ids.ts';

const MAX_STR_LENGTH = 2048;
const IDENTIFIER = /^[A-Za-z_][A-Za-z0-9_]*$/;

export class ValidationError extends Error {}

export function assertIdentifier(name: string): string {
    if (!IDENTIFIER.test(name)) throw new ValidationError(`Invalid attribute name: ${name}`);
    return name;
}

export const EDGE = {
    BELONGS_TO: 'BELONGS_TO',
    DERIVED_FROM: 'DERIVED_FROM',
    HAS_OWNER: 'HAS_OWNER',
    HAS_PROCESS: 'HAS_PROCESS',
} as const;
export type EdgeName = (typeof EDGE)[keyof typeof EDGE];

export class GraphStore {
    readonly db: ArcadeClient;

    constructor(db: ArcadeClient) {
        this.db = db;
    }

    /**
     * Creates a vertex the way the old `graph.create` did, which shapes what the API returns:
     * falsy values are left out, arrays are stored as string lists, every vertex gets a `uuid`
     * and `active: true`, and strings longer than 2048 characters are refused.
     */
    async createVertex<T = any>(type: string, data: Record<string, unknown> = {}): Promise<T> {
        assertIdentifier(type);
        const content: Record<string, unknown> = {};
        const timestamps: string[] = [];
        const input = { ...data };
        if (!input.uuid) input.uuid = uuidv7();
        for (const [key, value] of Object.entries(input)) {
            assertIdentifier(key);
            if (!value) continue;
            if (Array.isArray(value)) {
                if (value.length) content[key] = value.map((v) => String(v));
            } else if (typeof value === 'string') {
                if (value.length > MAX_STR_LENGTH) throw new ValidationError('Too long data!');
                if (value === '[TIMESTAMP]') timestamps.push(key);
                else content[key] = value;
            } else if (key === 'position') {
                const pos = value as { x?: unknown; y?: unknown };
                if (typeof pos.x !== 'number' || typeof pos.y !== 'number') throw new ValidationError('Position must be an object with x and y values!');
                content[key] = { x: pos.x, y: pos.y };
            } else {
                content[key] = value;
            }
        }
        if (!data.active) content.active = true;
        const created = await this.db.first<T>(`CREATE VERTEX ${type} CONTENT :content`, { content });
        if (!created) throw new Error(`Could not create ${type}`);
        const rid = (created as any)['@rid'];
        for (const key of timestamps) {
            await this.db.sql(`UPDATE ${toRid(rid)} SET ${key} = date()`);
            (created as any)[key] = new Date().toISOString();
        }
        return created;
    }

    /**
     * Creates a vertex with exactly the given content (no filtering), as the old code did for
     * File nodes (`CREATE VERTEX File CONTENT {json}`).
     */
    async createVertexRaw<T = any>(type: string, content: Record<string, unknown>): Promise<T> {
        assertIdentifier(type);
        const created = await this.db.first<T>(`CREATE VERTEX ${type} CONTENT :content`, { content });
        if (!created) throw new Error(`Could not create ${type}`);
        return created;
    }

    /** Sets one attribute; `null` stores null, `undefined` removes the attribute. */
    async setAttribute(rid: string, key: string, value: unknown): Promise<void> {
        const clean = toRid(rid);
        assertIdentifier(key);
        if (value === undefined) {
            await this.db.sql(`UPDATE ${clean} REMOVE ${key}`);
            return;
        }
        const stored = Array.isArray(value) ? value.map((v) => String(v)) : value;
        await this.db.sql(`UPDATE ${clean} SET ${key} = :value`, { value: stored });
    }

    async setAttributes(rid: string, patch: Record<string, unknown>): Promise<void> {
        const entries = Object.entries(patch);
        if (!entries.length) return;
        const clean = toRid(rid);
        const params: Record<string, unknown> = {};
        const sets = entries.map(([key, value], i) => {
            assertIdentifier(key);
            params[`v${i}`] = Array.isArray(value) ? value.map((v) => String(v)) : value;
            return `${key} = :v${i}`;
        });
        await this.db.sql(`UPDATE ${clean} SET ${sets.join(', ')}`, params);
    }

    async removeAttribute(rid: string, key: string): Promise<void> {
        await this.db.sql(`UPDATE ${toRid(rid)} REMOVE ${assertIdentifier(key)}`);
    }

    async connect(from: string, edge: EdgeName, to: string): Promise<void> {
        await this.db.sql(`CREATE EDGE ${edge} FROM ${toRid(from)} TO ${toRid(to)} IF NOT EXISTS`);
    }

    /**
     * Lineage edge from an output to its source. The edge carries the process context
     * (process_rid, process_id, cruncher, task) so lineage queries need no traversal.
     */
    async connectDerivedFrom(target: string, source: string, processRid?: string | null): Promise<void> {
        const t = toRid(target);
        const s = toRid(source);
        await this.connect(t, EDGE.DERIVED_FROM, s);
        if (!processRid) return;
        const p = toRid(processRid);
        let processId: string = p;
        let cruncher = '';
        let task = '';
        const proc = await this.db.first(`SELECT uuid, service_id, service, label, task FROM ${p}`).catch(() => null);
        if (proc) {
            if (proc.uuid) processId = proc.uuid;
            cruncher = proc.service_id || proc.service || proc.label || '';
            task = proc.task || '';
        }
        await this.db.sql(
            `UPDATE DERIVED_FROM SET process_rid = :processRid, process_id = :processId, cruncher = :cruncher, task = :task WHERE @out = ${t} AND @in = ${s}`,
            { processRid: p, processId, cruncher: String(cruncher), task: String(task) },
        );
    }

    async getNode<T = any>(rid: string): Promise<T | null> {
        return this.db.first<T>(`SELECT FROM ${toRid(rid)}`).catch((error) => {
            if (/404|not found/i.test(String(error?.message))) return null;
            throw error;
        });
    }

    /** The project a node belongs to, following DERIVED_FROM/BELONGS_TO up to 40 levels. */
    async projectRidOf(rid: string): Promise<string | null> {
        const row = await this.db.first(
            `MATCH {type:Project, as:project}<--{as:node, where:(@rid = :rid), while:($depth < 40)} RETURN project.@rid AS rid LIMIT 1`,
            { rid: toRid(rid) },
        );
        return row?.rid ?? null;
    }
}
