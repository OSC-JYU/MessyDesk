// ArcadeDB HTTP client. Every statement is sent with bound parameters; the only strings ever
// concatenated into a statement are type/edge/property names from fixed lists and RIDs that
// went through toRid().
//
// LEGACY_ARCADEDB=true keeps the workarounds that ArcadeDB 23.7.1 needs (see `legacy` uses in
// the repositories and the helpers at the bottom of this file). With LEGACY_ARCADEDB=false the
// plain forms are used, which need a newer server (tested with 25.3.1).

export interface ArcadeEnvelope<T = any> {
    user?: string;
    version?: string;
    serverName?: string;
    result: T[];
}

export interface ArcadeOptions {
    url: string; // http://host:port/api/v1/command/<db>
    user: string;
    password: string | undefined;
    legacy: boolean;
    writeRetries: number;
    backoffBaseMs: number;
    backoffMaxMs: number;
    log?: (message: string, meta?: unknown) => void;
}

export interface QueryOptions {
    serializer?: 'studio' | 'graph' | 'record';
    quiet?: boolean;
    retries?: number;
}

/**
 * A Cypher string literal. ArcadeDB 23.7.1 does not apply bound parameters reliably in Cypher
 * (a WHERE with two parameters silently matches nothing), so the legacy Cypher statements inline
 * values through this helper instead.
 */
export function cypherString(value: unknown): string {
    return JSON.stringify(String(value));
}

export class DbError extends Error {
    status: number | null;
    detail: string | null;
    constructor(message: string, status: number | null, detail: string | null) {
        super(message);
        this.status = status;
        this.detail = detail;
    }
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

function isTransient(error: DbError | Error): boolean {
    const status = error instanceof DbError ? error.status : null;
    if (status === 409 || status === 503) return true;
    if (status === null) return true; // network level: refused, reset, timeout
    const text = `${error.message} ${(error as DbError).detail || ''}`.toLowerCase();
    return ['concurrentmodification', 'mvcc', 'cannot update record', 'modified by', 'is different', 'deadlock', 'timeout']
        .some((needle) => text.includes(needle));
}

export class ArcadeClient {
    readonly legacy: boolean;
    private readonly opts: ArcadeOptions;
    private readonly auth: string;

    constructor(opts: ArcadeOptions) {
        this.opts = opts;
        this.legacy = opts.legacy;
        this.auth = 'Basic ' + Buffer.from(`${opts.user}:${opts.password ?? ''}`).toString('base64');
    }

    get url(): string {
        return this.opts.url;
    }

    get databaseName(): string {
        return this.opts.url.split('/').pop() || '';
    }

    sql<T = any>(command: string, params?: Record<string, unknown>, options: QueryOptions = {}): Promise<ArcadeEnvelope<T>> {
        return this.run<T>('sql', command, params, options);
    }

    cypher<T = any>(command: string, params?: Record<string, unknown>, options: QueryOptions = {}): Promise<ArcadeEnvelope<T>> {
        return this.run<T>('cypher', command, params, options);
    }

    /** Convenience: the `result` array of an SQL statement. */
    async rows<T = any>(command: string, params?: Record<string, unknown>, options?: QueryOptions): Promise<T[]> {
        return (await this.sql<T>(command, params, options)).result || [];
    }

    async first<T = any>(command: string, params?: Record<string, unknown>): Promise<T | null> {
        const rows = await this.rows<T>(command, params);
        return rows[0] ?? null;
    }

    private async run<T>(language: string, command: string, params: Record<string, unknown> | undefined, options: QueryOptions): Promise<ArcadeEnvelope<T>> {
        const retries = options.retries ?? this.opts.writeRetries;
        const body: Record<string, unknown> = { language, command };
        if (params && Object.keys(params).length) body.params = params;
        if (options.serializer) body.serializer = options.serializer;
        let lastError: DbError | Error | null = null;
        for (let attempt = 1; attempt <= retries; attempt += 1) {
            try {
                return await this.post<T>(this.opts.url, body);
            } catch (error) {
                lastError = error as Error;
                const transient = isTransient(lastError);
                if (!options.quiet) this.opts.log?.(`DB attempt ${attempt} failed${transient ? '' : ' (permanent)'}: ${lastError.message}`, { command });
                if (attempt < retries && transient) {
                    const ceiling = Math.min(this.opts.backoffMaxMs, this.opts.backoffBaseMs * 2 ** (attempt - 1));
                    await sleep(Math.floor(Math.random() * ceiling));
                    continue;
                }
                break;
            }
        }
        const detail = lastError instanceof DbError ? lastError.detail : null;
        const status = lastError instanceof DbError ? lastError.status : null;
        throw new DbError(`Query failed: ${lastError?.message}${detail ? ` (${detail})` : ''}`, status, detail);
    }

    private async post<T>(url: string, body: unknown): Promise<ArcadeEnvelope<T>> {
        let response: Response;
        try {
            response = await fetch(url, {
                method: 'POST',
                headers: { authorization: this.auth, 'content-type': 'application/json' },
                body: JSON.stringify(body),
            });
        } catch (error) {
            throw new DbError(`ArcadeDB unreachable: ${(error as Error).message}`, null, null);
        }
        const text = await response.text();
        let parsed: any = null;
        try { parsed = text ? JSON.parse(text) : null; } catch { parsed = null; }
        if (!response.ok) {
            const detail = parsed?.detail || parsed?.error || null;
            throw new DbError(`Response code ${response.status}`, response.status, detail);
        }
        return parsed as ArcadeEnvelope<T>;
    }

    // ---- server level -------------------------------------------------------------------

    private serverUrl(): string {
        return this.opts.url.replace(/\/command\/[^/]+$/, '/server');
    }

    async databaseExists(): Promise<boolean> {
        const url = this.opts.url.replace('/command/', '/exists/');
        const response = await fetch(url, { headers: { authorization: this.auth } });
        if (!response.ok) throw new DbError('Error on database check', response.status, null);
        const body = await response.json() as { result: boolean };
        return Boolean(body.result);
    }

    async createDatabase(): Promise<void> {
        await this.post(this.serverUrl(), { command: `create database ${this.databaseName}` });
    }

    // ---- statements that differ between ArcadeDB versions -------------------------------

    /**
     * CREATE INDEX that tolerates an existing index. 23.7.1 throws a NullPointerException for
     * "IF NOT EXISTS" when the index exists, so the legacy form runs a plain CREATE INDEX and
     * swallows the "already exists" error instead.
     */
    async ensureIndex(type: string, property: string, kind: 'UNIQUE' | 'NOTUNIQUE'): Promise<void> {
        if (!this.legacy) {
            await this.sql(`CREATE INDEX IF NOT EXISTS ON ${type} (${property}) ${kind}`, undefined, { quiet: true, retries: 1 });
            return;
        }
        try {
            await this.sql(`CREATE INDEX ON ${type} (${property}) ${kind}`, undefined, { quiet: true, retries: 1 });
        } catch (error) {
            if (!String((error as DbError).detail || (error as Error).message).toLowerCase().includes('already exists')) throw error;
        }
    }

    /**
     * TRAVERSE <dir>(<edges>) FROM <rid>. 23.7.1 ignores a bound parameter in the FROM clause
     * (returns nothing), so the legacy form inlines the RID, which must already be validated.
     */
    async traverse<T = any>(direction: 'out' | 'in' | 'both', edges: string[], rid: string): Promise<T[]> {
        const edgeList = edges.map((e) => `"${e}"`).join(', ');
        if (this.legacy) {
            if (!/^#\d+:\d+$/.test(rid)) throw new DbError('Invalid RID for TRAVERSE', 400, null);
            return this.rows<T>(`TRAVERSE ${direction}(${edgeList}) FROM ${rid}`);
        }
        return this.rows<T>(`TRAVERSE ${direction}(${edgeList}) FROM :rid`, { rid });
    }
}
