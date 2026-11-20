// Per-run secrets (a user's API key for an external LLM provider), held in memory only.
//
// A key is never written anywhere: not to the database, the job queue, params.json, message.json,
// the logs or a file. A run's task carries only an opaque `secret_ref`, useless without this
// vault. The consumer that claims a job trades the ref for the key (POST /api/queue/secret). The
// entry is dropped when its run ends or is cancelled, and in any case after `idleMs` without use.
// A restart forgets every key; the affected jobs then fail with a clear message and the user
// starts the run again.

import crypto from 'node:crypto';
import util from 'node:util';

interface Entry {
    secret: string;
    userId: string;
    topic: string;
    expires: number;
    scope: string | null;
}

export interface SecretOwner {
    userId: string;
    topic: string;
}

export class SecretVault {
    // Real private fields: they do not show up in util.inspect, JSON.stringify or a log call.
    readonly #entries = new Map<string, Entry>();
    readonly #idleMs: number;
    readonly #now: () => number;
    #timer: NodeJS.Timeout | null = null;

    constructor(options: { idleMs: number; now?: () => number }) {
        this.#idleMs = options.idleMs;
        this.#now = options.now ?? Date.now;
    }

    /** Keeps the secret for its owner and returns the ref that stands for it. */
    put(secret: string, owner: SecretOwner): string {
        const ref = crypto.randomBytes(24).toString('base64url');
        this.#entries.set(ref, { secret, userId: owner.userId, topic: owner.topic, expires: this.#now() + this.#idleMs, scope: null });
        return ref;
    }

    /** Ties a ref to a run (its process rid), so that the run's end can release it. */
    bind(ref: string, scope: string): void {
        const entry = this.#entries.get(ref);
        if (entry) entry.scope = scope;
    }

    /** The secret, only for the user and service it was given for. Each use extends its life. */
    get(ref: string, owner: SecretOwner): string | null {
        const entry = this.#entries.get(ref);
        if (!entry) return null;
        if (entry.expires <= this.#now()) {
            this.#entries.delete(ref);
            return null;
        }
        if (entry.userId !== owner.userId || entry.topic !== owner.topic) return null;
        entry.expires = this.#now() + this.#idleMs;
        return entry.secret;
    }

    release(ref: string | null | undefined): void {
        if (ref) this.#entries.delete(ref);
    }

    /** Drops every secret of a run. */
    releaseScope(scope: string | null | undefined): void {
        if (!scope) return;
        for (const [ref, entry] of this.#entries) if (entry.scope === scope) this.#entries.delete(ref);
    }

    sweep(): void {
        const now = this.#now();
        for (const [ref, entry] of this.#entries) if (entry.expires <= now) this.#entries.delete(ref);
    }

    /** Drops expired entries every minute. */
    start(): void {
        if (this.#timer) return;
        this.#timer = setInterval(() => this.sweep(), 60_000);
        this.#timer.unref();
    }

    stop(): void {
        if (this.#timer) clearInterval(this.#timer);
        this.#timer = null;
        this.#entries.clear();
    }

    get size(): number {
        return this.#entries.size;
    }

    toJSON(): string {
        return '[SecretVault]';
    }

    [util.inspect.custom](): string {
        return '[SecretVault]';
    }
}

/** The header the UI sends the key in. The request body, which is stored, never carries it. */
export const API_KEY_HEADER = 'x-md-api-key';

/**
 * Longest key accepted. Tokens can be JWTs of a few thousand characters (CSC Aitta's are); a header
 * line over 8 kB is refused by common proxies, so stay under it.
 */
export const MAX_API_KEY_LENGTH = 7000;

export class InvalidApiKeyError extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'InvalidApiKeyError';
    }
}

/** A key from the request header, trimmed; null when there is none. Throws when it cannot be a key. */
export function apiKeyFromHeader(value: string | string[] | undefined): string | null {
    const raw = Array.isArray(value) ? value[0] : value;
    const key = String(raw ?? '').trim();
    if (!key) return null;
    if (key.length > MAX_API_KEY_LENGTH) throw new InvalidApiKeyError(`The API key is longer than ${MAX_API_KEY_LENGTH} characters`);
    // eslint-disable-next-line no-control-regex
    if (/[\s\u0000-\u001f]/.test(key)) throw new InvalidApiKeyError('The API key contains spaces or line breaks');
    return key;
}
