// ArcadeDB access for the performance tools: the backend's own client and schema setup, plus
// sqlscript batches for fast direct loading.

import { ArcadeClient } from '../../src/platform/arcade/client.ts';
import { ensureDatabase, ensureSchema } from '../../src/platform/arcade/schema.ts';

export interface PerfDbOptions {
    host: string; // http://localhost:2481
    database: string;
    user: string;
    password: string;
    legacy: boolean;
}

export function perfDbOptionsFromEnv(): PerfDbOptions {
    return {
        host: process.env.PERF_DB_HOST || 'http://localhost:2481',
        database: process.env.PERF_DB_NAME || 'messydesk_perf',
        user: process.env.PERF_DB_USER || 'root',
        password: process.env.PERF_DB_PASSWORD || 'perf_master',
        legacy: process.env.LEGACY_ARCADEDB === 'true',
    };
}

export function client(opts: PerfDbOptions): ArcadeClient {
    return new ArcadeClient({
        url: `${opts.host}/api/v1/command/${opts.database}`,
        user: opts.user,
        password: opts.password,
        legacy: opts.legacy,
        writeRetries: 3,
        backoffBaseMs: 200,
        backoffMaxMs: 2000,
        log: (m) => console.error(m),
    });
}

/** Creates the database (if missing) with exactly the backend's schema. */
export async function prepareDatabase(db: ArcadeClient): Promise<void> {
    const log = (m: string) => console.error(m);
    await ensureDatabase(db, log);
    await ensureSchema(db, log);
}

export async function dropDatabase(opts: PerfDbOptions): Promise<void> {
    const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    await fetch(`${opts.host}/api/v1/server`, {
        method: 'POST',
        headers: { authorization: auth, 'content-type': 'application/json' },
        body: JSON.stringify({ command: `drop database ${opts.database}` }),
    });
}

/**
 * Runs several statements in one request and one transaction (language sqlscript), optionally
 * returning an expression after the commit. A conflicting transaction is retried by resending
 * the whole script: `COMMIT RETRY` is not used because on 25.3.1 it re-runs the block with the
 * LET variables of the failed attempt, which created edges to wrong records.
 */
export async function sqlScript(opts: PerfDbOptions, statements: string[], returnExpr?: string): Promise<any> {
    const auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password}`).toString('base64');
    const lines = ['BEGIN;', ...statements.map((s) => (s.endsWith(';') ? s : s + ';')), 'COMMIT;'];
    if (returnExpr) lines.push(`RETURN ${returnExpr};`);
    const command = lines.join('\n');
    for (let attempt = 1; ; attempt += 1) {
        const response = await fetch(`${opts.host}/api/v1/command/${opts.database}`, {
            method: 'POST',
            headers: { authorization: auth, 'content-type': 'application/json' },
            body: JSON.stringify({ language: 'sqlscript', command }),
        });
        const text = await response.text();
        if (response.ok) return text ? JSON.parse(text) : null;
        const conflict = /concurrent modification|please retry/i.test(text);
        if (attempt >= 20 || !(conflict || response.status === 409 || response.status === 503)) {
            throw new Error(`sqlscript failed (${response.status}): ${text.slice(0, 500)}`);
        }
        await new Promise((r) => setTimeout(r, Math.random() * 200 * attempt));
    }
}

/** A JSON object literal for CONTENT / SET clauses. */
export function json(value: unknown): string {
    return JSON.stringify(value);
}

/** A quoted SQL string literal. */
export function str(value: unknown): string {
    return JSON.stringify(String(value));
}
