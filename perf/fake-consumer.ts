// A consumer that answers instantly, so batch tests measure the backend, ArcadeDB and the queue
// instead of OCR or ML speed (plan section 6). Speaks the same HTTP protocol as MD-consumers:
// register, claim, result callback (/api/nomad/process/files), complete.
//
// Used as a library by the scenario drivers; `node dist/perf/fake-consumer.js --topic md-perf
// --workers 4` also runs it standalone until stopped.

import { randomUUID } from 'node:crypto';
import { parseArgs } from 'node:util';
import { call, percentiles, post, sleep } from './lib/http.ts';

export function perfDescriptor(id: string): any {
    return {
        id,
        name: id,
        adapter: 'elg',
        category: 'preparation',
        supported_types: ['text', 'image'],
        supported_formats: ['txt', 'png', 'jpg'],
        tasks: {
            upper: { name: 'Perf one-to-one', description: 'perf', behaviour: 'one-to-one', params: {} },
            pages: { name: 'Perf one-to-many', behaviour: 'one-to-many', output_set: 'Pages', params: {} },
            combine: { name: 'Perf many-to-one', behaviour: 'many-to-one', params: {} },
        },
    };
}

export interface ConsumerStats {
    claimed: number;
    callbacks: number;
    errors: number;
    claimMs: number[];
    callbackMs: number[];
    completeMs: number[];
}

export class FakeConsumer {
    readonly adapterId = randomUUID();
    readonly topic: string;
    readonly stats: ConsumerStats = { claimed: 0, callbacks: 0, errors: 0, claimMs: [], callbackMs: [], completeMs: [] };
    private stopped = false;

    constructor(topic: string) {
        this.topic = topic;
    }

    async register(): Promise<void> {
        const reg = await post('/api/services/register', { source: 'perf', service: perfDescriptor(this.topic) }, { service: true });
        if (reg.status !== 200) throw new Error(`register failed: ${reg.status} ${reg.text}`);
        const ad = await post(`/api/services/${this.topic}/adapter/${this.adapterId}`, { control_url: 'http://localhost:1' }, { service: true });
        if (ad.status !== 200) throw new Error(`adapter failed: ${ad.status} ${ad.text}`);
    }

    async unregister(): Promise<void> {
        await call('DELETE', `/api/services/${this.topic}/adapter/${this.adapterId}`, { service: true });
    }

    stop(): void {
        this.stopped = true;
    }

    /** One output per input, like a one-to-one text service. */
    private async answer(job: any): Promise<void> {
        const msg = job.payload;
        const label = `${msg.file?.label || 'file'}.txt`;
        const message = { ...msg, response: { time: 0.01 }, file: { ...msg.file, label, type: 'text', extension: 'txt' } };
        const form = new FormData();
        form.append('content', new Blob([`perf output of ${msg.file?.label}`]), label);
        form.append('message', new Blob([JSON.stringify(message)], { type: 'application/json' }), 'message.json');
        const res = await call('POST', '/api/nomad/process/files', { service: true, form });
        this.stats.callbackMs.push(res.ms);
        if (res.status !== 200) {
            this.stats.errors += 1;
            throw new Error(`callback ${res.status}: ${res.text.slice(0, 200)}`);
        }
        this.stats.callbacks += 1;
    }

    /** Claims and answers jobs until stopped, or until idle for `idleMs` (0 = never). */
    async work(idleMs = 0): Promise<void> {
        let idleSince = Date.now();
        while (!this.stopped) {
            const res = await post('/api/queue/claim', { topic: this.topic, adapter_id: this.adapterId }, { service: true });
            this.stats.claimMs.push(res.ms);
            const job = res.status === 200 ? res.body?.job : null;
            if (!job) {
                if (idleMs && Date.now() - idleSince > idleMs) return;
                await sleep(100);
                continue;
            }
            idleSince = Date.now();
            this.stats.claimed += 1;
            try {
                await this.answer(job);
                const done = await post(`/api/queue/${job.id}/complete`, { adapter_id: this.adapterId }, { service: true });
                this.stats.completeMs.push(done.ms);
            } catch {
                await post(`/api/queue/${job.id}/fail`, { adapter_id: this.adapterId, error: 'perf callback failed' }, { service: true });
            }
        }
    }
}

/** Runs `workers` consumers (one adapter each) on a topic until idle; returns merged stats. */
export async function runWorkers(topic: string, workers: number, idleMs: number): Promise<ConsumerStats> {
    const consumers = Array.from({ length: workers }, () => new FakeConsumer(topic));
    for (const c of consumers) await c.register();
    try {
        await Promise.all(consumers.map((c) => c.work(idleMs)));
    } finally {
        for (const c of consumers) await c.unregister();
    }
    const merged: ConsumerStats = { claimed: 0, callbacks: 0, errors: 0, claimMs: [], callbackMs: [], completeMs: [] };
    for (const c of consumers) {
        merged.claimed += c.stats.claimed;
        merged.callbacks += c.stats.callbacks;
        merged.errors += c.stats.errors;
        merged.claimMs.push(...c.stats.claimMs);
        merged.callbackMs.push(...c.stats.callbackMs);
        merged.completeMs.push(...c.stats.completeMs);
    }
    return merged;
}

if (import.meta.url === `file://${process.argv[1]}`) {
    const { values } = parseArgs({ options: { topic: { type: 'string', default: 'md-perf' }, workers: { type: 'string', default: '1' }, idle: { type: 'string', default: '0' } } });
    const stats = await runWorkers(String(values.topic), Number(values.workers), Number(values.idle));
    console.log(JSON.stringify({ claimed: stats.claimed, callbacks: stats.callbacks, errors: stats.errors, callback: percentiles(stats.callbackMs) }));
}
