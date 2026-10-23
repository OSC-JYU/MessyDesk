// HTTP access to a running backend for the load drivers: the user `mail` header (proxy auth) and
// the consumer service token, like the contract tests.

export const BASE_URL = (process.env.BASE_URL || 'http://localhost:8200').replace(/\/$/, '');
export const SERVICE_TOKEN = process.env.SERVICE_TOKEN || '';
export const USER = process.env.PERF_USER || 'local.user@localhost';

export interface Res<T = any> {
    status: number;
    body: T;
    text: string;
    ms: number;
}

export interface CallOptions {
    body?: unknown;
    form?: FormData;
    service?: boolean;
    user?: string;
}

export async function call<T = any>(method: string, path: string, opts: CallOptions = {}): Promise<Res<T>> {
    const headers: Record<string, string> = {};
    if (opts.service) {
        if (SERVICE_TOKEN) headers.authorization = `Bearer ${SERVICE_TOKEN}`;
        else headers.mail = USER;
    } else {
        headers.mail = opts.user || USER;
    }
    let body: any;
    if (opts.form) body = opts.form;
    else if (opts.body !== undefined) {
        headers['content-type'] = 'application/json';
        body = JSON.stringify(opts.body);
    }
    const started = performance.now();
    const response = await fetch(BASE_URL + path, { method, headers, body });
    const text = await response.text();
    const ms = performance.now() - started;
    let parsed: any = text;
    try { parsed = text ? JSON.parse(text) : null; } catch { /* plain text */ }
    return { status: response.status, body: parsed, text, ms };
}

export const get = <T = any>(path: string, opts?: CallOptions) => call<T>('GET', path, opts);
export const post = <T = any>(path: string, body?: unknown, opts: CallOptions = {}) => call<T>('POST', path, { ...opts, body });

export function rid(value: string): string {
    return String(value).replace('#', '');
}

export function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** p50/p95/p99/max of a list of milliseconds. */
export function percentiles(values: number[]): { n: number; p50: number; p95: number; p99: number; max: number } {
    const sorted = [...values].sort((a, b) => a - b);
    const at = (q: number) => (sorted.length ? Math.round(sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))]) : 0);
    return { n: sorted.length, p50: at(0.5), p95: at(0.95), p99: at(0.99), max: Math.round(sorted.at(-1) ?? 0) };
}

/** A tiny valid JPEG (1x1), so uploads go through the image path (metadata, thumbnails). */
export const JPEG_1x1 = Buffer.from(
    '/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAAMCAgICAgMCAgIDAwMDBAYEBAQEBAgGBgUGCQgKCgkICQkKDA8MCgsOCwkJDRENDg8QEBEQCgwSExIQEw8QEBD/yQALCAABAAEBAREA/8wABgAQEAX/2gAIAQEAAD8A0s8g/9k=',
    'base64',
);
