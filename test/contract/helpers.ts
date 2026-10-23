// Shared helpers for the HTTP contract tests.
//
// The same suite runs against the old backend (reference) and the new one:
//   BASE_URL=http://localhost:8300 TARGET=old npm run test:contract
//   BASE_URL=http://localhost:8200 TARGET=new SERVICE_TOKEN=... npm run test:contract
//
// TARGET=old skips the tests for behaviour that was deliberately changed (see plan/decisions.md);
// TARGET=new skips the tests that pin behaviour of routes that were dropped.

import { randomUUID } from 'node:crypto';

export const BASE_URL = (process.env.BASE_URL || 'http://localhost:8200').replace(/\/$/, '');
export const TARGET = (process.env.TARGET || 'new') as 'old' | 'new';
export const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';
export const ADMIN = process.env.ADMIN_USER || 'local.user@localhost';
export const OTHER = process.env.OTHER_USER || 'contract.other@example.com';

/** Skip options for node:test: `{ skip: onlyNew }` runs only against the new backend. */
export const onlyNew = TARGET !== 'new' ? 'changed in the rewrite (plan/decisions.md)' : false;
export const onlyOld = TARGET !== 'old' ? 'route dropped in the rewrite (plan/decisions.md)' : false;

export interface Res<T = any> {
    status: number;
    headers: Headers;
    body: T;
    text: string;
}

export interface CallOptions {
    user?: string | null;
    service?: boolean;
    body?: unknown;
    form?: FormData;
    headers?: Record<string, string>;
    raw?: boolean;
}

export function stripHash(rid: string): string {
    return String(rid).replace('#', '');
}

export async function call<T = any>(method: string, path: string, opts: CallOptions = {}): Promise<Res<T>> {
    const headers: Record<string, string> = { ...(opts.headers || {}) };
    const user = opts.user === undefined ? ADMIN : opts.user;
    if (opts.service) {
        if (SERVICE_TOKEN) headers.authorization = `Bearer ${SERVICE_TOKEN}`;
        // Old backend (and the legacy fallback) authenticates consumers with this header.
        if (TARGET === 'old' || !SERVICE_TOKEN) headers.mail = ADMIN;
    } else if (user) {
        headers.mail = user;
    }
    let body: BodyInit | undefined;
    if (opts.form) {
        body = opts.form;
    } else if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
    }
    const response = await fetch(BASE_URL + path, { method, headers, body, redirect: 'manual' });
    const text = opts.raw ? '' : await response.text();
    let parsed: any = text;
    if (!opts.raw && (response.headers.get('content-type') || '').includes('json')) {
        try { parsed = JSON.parse(text); } catch { parsed = text; }
    }
    return { status: response.status, headers: response.headers, body: parsed, text };
}

export const get = <T = any>(path: string, opts?: CallOptions) => call<T>('GET', path, opts);
export const post = <T = any>(path: string, body?: unknown, opts: CallOptions = {}) => call<T>('POST', path, { ...opts, body });
export const put = <T = any>(path: string, body?: unknown, opts: CallOptions = {}) => call<T>('PUT', path, { ...opts, body });
export const del = <T = any>(path: string, opts?: CallOptions) => call<T>('DELETE', path, opts);

export function uniq(prefix: string): string {
    return `${prefix} ${randomUUID().slice(0, 8)}`;
}

/** Makes sure the second (non-admin) user exists. */
export async function ensureOtherUser(): Promise<string> {
    const me = await get('/api/me', { user: OTHER });
    if (me.status === 200) return me.body.rid;
    const created = await post('/api/users', { id: OTHER, label: 'Contract other' });
    if (created.status >= 400) throw new Error('could not create other user: ' + created.text);
    const again = await get('/api/me', { user: OTHER });
    return again.body.rid;
}

export async function createProject(label = uniq('Contract desk'), user = ADMIN): Promise<any> {
    const res = await post('/api/projects', { label, description: 'contract test', position: { x: 1, y: 2 } }, { user });
    if (res.status !== 200) throw new Error('createProject failed: ' + res.status + ' ' + res.text);
    return res.body;
}

export async function createSet(projectRid: string, label = 'Contract set', user = ADMIN): Promise<any> {
    const res = await post(`/api/projects/${stripHash(projectRid)}/sets`, { label, description: 'set' }, { user });
    if (res.status !== 200) throw new Error('createSet failed: ' + res.status + ' ' + res.text);
    return res.body;
}

export function fileForm(files: Array<{ name: string; type: string; content: string | Uint8Array }>, extra: Record<string, string> = {}): FormData {
    const form = new FormData();
    for (const f of files) {
        form.append('file', new Blob([f.content as BlobPart], { type: f.type }), f.name);
    }
    for (const [k, v] of Object.entries(extra)) form.append(k, v);
    return form;
}

export async function upload(projectRid: string, files: Array<{ name: string; type: string; content: string | Uint8Array }>, setRid?: string, user = ADMIN, query = ''): Promise<Res> {
    const path = `/api/projects/${stripHash(projectRid)}/upload${setRid ? '/' + stripHash(setRid) : ''}${query}`;
    return call('POST', path, { user, form: fileForm(files) });
}

// A 1x1 PNG.
export const PNG_1x1 = Uint8Array.from(Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'));

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function waitFor<T>(fn: () => Promise<T | null | undefined | false>, timeoutMs = 10000, stepMs = 200): Promise<T> {
    const started = Date.now();
    for (;;) {
        const value = await fn();
        if (value) return value;
        if (Date.now() - started > timeoutMs) throw new Error('waitFor timed out');
        await sleep(stepMs);
    }
}

/** Listens to the SSE stream of one user and collects parsed `data` payloads. */
export class SseListener {
    events: any[] = [];
    private controller = new AbortController();
    private ready: Promise<void>;

    constructor(user = ADMIN) {
        this.ready = this.start(user);
    }

    private async start(user: string): Promise<void> {
        const response = await fetch(BASE_URL + '/events', { headers: { mail: user }, signal: this.controller.signal });
        const reader = response.body!.getReader();
        const decoder = new TextDecoder();
        let buffer = '';
        let opened!: () => void;
        const openedPromise = new Promise<void>((resolve) => { opened = resolve; });
        (async () => {
            try {
                for (;;) {
                    const { done, value } = await reader.read();
                    if (done) break;
                    buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, '\n');
                    let idx;
                    while ((idx = buffer.indexOf('\n\n')) >= 0) {
                        const chunk = buffer.slice(0, idx);
                        buffer = buffer.slice(idx + 2);
                        const dataLines = chunk.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trim());
                        if (!dataLines.length) continue;
                        try { this.events.push(JSON.parse(dataLines.join('\n'))); } catch { this.events.push(dataLines.join('\n')); }
                        opened();
                    }
                }
            } catch { /* aborted */ }
        })();
        await openedPromise;
    }

    async open(): Promise<this> {
        await this.ready;
        return this;
    }

    async waitFor(pred: (e: any) => boolean, timeoutMs = 10000): Promise<any> {
        return waitFor(async () => this.events.find(pred), timeoutMs);
    }

    close(): void {
        this.controller.abort();
    }
}

/** Fake consumer: registers a service, claims jobs and answers through the callback routes. */
export class FakeConsumer {
    adapterId = randomUUID();
    descriptor: any;
    constructor(descriptor: any) {
        this.descriptor = descriptor;
    }

    get topic(): string {
        return this.descriptor.id;
    }

    async register(): Promise<void> {
        const reg = await post('/api/services/register', { source: 'contract-test', service: this.descriptor }, { service: true });
        if (reg.status !== 200) throw new Error('register failed: ' + reg.status + ' ' + reg.text);
        const ad = await post(`/api/services/${this.topic}/adapter/${this.adapterId}`, { control_url: 'http://localhost:1' }, { service: true });
        if (ad.status !== 200) throw new Error('adapter failed: ' + ad.status + ' ' + ad.text);
    }

    async unregister(): Promise<void> {
        await del(`/api/services/${this.topic}/adapter/${this.adapterId}`, { service: true });
    }

    async claim(): Promise<any | null> {
        const res = await post('/api/queue/claim', { topic: this.topic, adapter_id: this.adapterId }, { service: true });
        if (res.status !== 200) throw new Error('claim failed: ' + res.status + ' ' + res.text);
        return res.body.job;
    }

    async claimWait(pred: (job: any) => boolean = () => true, timeoutMs = 10000): Promise<any> {
        return waitFor(async () => {
            const job = await this.claim();
            if (job && !pred(job)) {
                await this.complete(job.id);
                return null;
            }
            return job;
        }, timeoutMs);
    }

    async drain(): Promise<void> {
        for (;;) {
            const job = await this.claim();
            if (!job) return;
            await this.complete(job.id);
        }
    }

    complete(jobId: number) {
        return post(`/api/queue/${jobId}/complete`, { adapter_id: this.adapterId }, { service: true });
    }

    fail(jobId: number, error = 'boom') {
        return post(`/api/queue/${jobId}/fail`, { adapter_id: this.adapterId, error }, { service: true });
    }

    heartbeat(jobId: number) {
        return post(`/api/queue/${jobId}/heartbeat`, { adapter_id: this.adapterId }, { service: true });
    }

    /** Sends one output file like the `elg` adapter (`sendFile`/`sendTextFile`). */
    sendFile(msg: any, content: string | Uint8Array, out: { label: string; type: string; extension: string }, extra: Record<string, unknown> = {}) {
        const message = { ...msg, ...extra, file: { ...msg.file, ...out } };
        const form = new FormData();
        form.append('content', new Blob([content as BlobPart]), out.label);
        form.append('message', new Blob([JSON.stringify(message)], { type: 'application/json' }), 'message.json');
        return call('POST', '/api/nomad/process/files', { service: true, form });
    }

    done(msg: any) {
        return post('/api/nomad/process/files/done', msg, { service: true });
    }

    error(msg: any, error: unknown = { message: 'failed', code: 'E_TEST' }) {
        return post('/api/nomad/process/files/error', { error, message: msg }, { service: true });
    }
}

export function sampleDescriptor(id: string, extra: Record<string, unknown> = {}): any {
    return {
        id,
        name: id,
        adapter: 'elg',
        category: 'preparation',
        supported_types: ['text', 'image'],
        supported_formats: ['txt', 'png', 'jpg'],
        tasks: {
            upper: { name: 'Upper case', description: 'upper', behaviour: 'one-to-one', params: {} },
            pages: { name: 'Split', behaviour: 'one-to-many', output_set: 'Pages', params: {} },
            combine: { name: 'Combine', behaviour: 'many-to-one', params: {} },
        },
        ...extra,
    };
}
