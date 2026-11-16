// A user's API key through the real routes: header in, only a ref in the queue, key out to the
// consumer that claimed the job, gone once the run has ended. Nothing stored or logged holds it.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, registerErrorLogging } from '../../src/platform/http/server.ts';
import { registerAuth } from '../../src/platform/http/auth.ts';
import { processingRoutes } from '../../src/modules/processing/routes.ts';
import { ProcessingService } from '../../src/modules/processing/processing.ts';
import { JobQueue } from '../../src/modules/queue/queue.ts';
import { Publisher } from '../../src/modules/queue/publisher.ts';
import { SecretVault } from '../../src/modules/secrets/vault.ts';

const KEY = 'sk-route-SECRET-5566778899';
const TOPIC = 'md-llm-openai';
const SERVICE = { Authorization: 'Bearer service-token' };

async function setup() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secret-routes-'));
    const logs: string[] = [];
    const logger: any = { info: (...a: unknown[]) => logs.push(JSON.stringify(a)), warn: (...a: unknown[]) => logs.push(JSON.stringify(a)), error: (...a: unknown[]) => logs.push(JSON.stringify(a)) };
    const queue = new JobQueue({
        dbPath: path.join(dir, 'queue.sqlite'), maxAttempts: 3, leaseSeconds: 60, keepFailedMinutes: 10, sweeperEnabled: false,
        sweeperIntervalSeconds: 60, sweeperDoneCancelledMinutes: 10, batchAbortConsecutive: 5, batchAbortPercent: 50,
    });
    queue.open();
    const vault = new SecretVault({ idleMs: 60_000 });
    const service = { id: TOPIC, external_tasks: 'prompts', api_key_source: 'user', models: { m: { name: 'M' } }, tasks: {} };
    const processing = new ProcessingService({
        db: {} as any, store: {} as any, layout: {} as any, access: {} as any, secrets: vault,
        files: { metadata: async () => ({ '@rid': '#12:3', label: 'a.txt', type: 'text', extension: 'txt' }) } as any,
        nodes: { createProcess: async () => ({ '@rid': '#5:7', path: path.join(dir, 'process', 'out') }) } as any,
        registry: { get: () => service } as any,
        publisher: new Publisher(queue, async () => null, logger, false),
        batches: {} as any, sse: { send: () => {} } as any, solr: {} as any, apiUrl: 'http://x', log: (m) => logs.push(m),
    });
    const server = await createServer(0, dir);
    await registerAuth(server, {
        development: false, devUser: '', serviceToken: 'service-token', legacyMail: false, logger,
        lookup: async (mail) => ({ rid: mail, id: mail, access: 'user' }),
    });
    registerErrorLogging(server, logger);
    server.route(processingRoutes({
        processing, queue, batches: {} as any, sse: { send: () => {} } as any, access: {} as any, results: {} as any,
        tokenBudget: { check: async () => null } as any, secrets: vault,
    } as any));
    return { dir, logs, queue, vault, server };
}

const run = { id: 'u-summary', model: 'm', params: { temperature: 0.2 }, system_params: { prompts: { content: 'Summarise.' } } };
const start = (server: any, headers: Record<string, string>) => server.inject({ method: 'POST', url: `/api/queue/${TOPIC}/files/12:3`, headers: { mail: '#9:1', ...headers }, payload: run });

function everythingOnDisk(dir: string): string {
    const parts: Buffer[] = [];
    for (const name of fs.readdirSync(dir, { recursive: true }) as string[]) {
        const file = path.join(dir, name);
        if (fs.statSync(file).isFile()) parts.push(fs.readFileSync(file));
    }
    return Buffer.concat(parts).toString('latin1');
}

test('the key travels by header, waits in memory and is traded for the ref by the consumer', async () => {
    const { dir, logs, queue, server } = await setup();
    const started = await start(server, { 'x-md-api-key': KEY });
    assert.equal(started.statusCode, 200, started.payload);

    const claimed = await server.inject({ method: 'POST', url: '/api/queue/claim', headers: SERVICE, payload: { topic: TOPIC, adapter_id: 'a1' } });
    const job = JSON.parse(claimed.payload).job;
    const ref = job.payload.task.secret_ref;
    assert.ok(ref);
    assert.ok(!claimed.payload.includes(KEY));
    // while the job exists: the queue file holds the ref (so the scan does cover it) and not the key
    const onDisk = everythingOnDisk(dir);
    assert.ok(onDisk.includes(ref), 'the scan did not see the queued job');
    assert.ok(!onDisk.includes(KEY), 'the key is on disk');

    const secret = (user: string, topic = TOPIC) => server.inject({ method: 'POST', url: '/api/queue/secret', headers: SERVICE, payload: { ref, user, topic } });
    const granted = await secret('#9:1');
    assert.equal(granted.statusCode, 200);
    assert.equal(JSON.parse(granted.payload).key, KEY);
    assert.match(String(granted.headers['cache-control']), /no-store/);
    assert.equal((await secret('#9:2')).statusCode, 404);
    assert.equal((await secret('#9:1', 'md-llm-azure')).statusCode, 404);
    // a user session is not a consumer
    assert.equal((await server.inject({ method: 'POST', url: '/api/queue/secret', headers: { mail: '#9:1' }, payload: { ref, user: '#9:1', topic: TOPIC } })).statusCode, 401);

    const completed = await server.inject({ method: 'POST', url: `/api/queue/${job.id}/complete`, headers: SERVICE, payload: { adapter_id: 'a1' } });
    assert.equal(completed.statusCode, 200);
    assert.equal((await secret('#9:1')).statusCode, 404);

    queue.close();
    assert.ok(!everythingOnDisk(dir).includes(KEY), 'the key is on disk');
    assert.ok(!logs.join('\n').includes(KEY), 'the key is in a log');
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a run on a "user" service without a key is refused, and a failing job keeps the key for its retry', async () => {
    const { dir, queue, server } = await setup();
    const refused = await start(server, {});
    assert.equal(refused.statusCode, 400);
    assert.match(refused.payload, /own API key/);
    // a malformed key is told apart from a missing one
    const bad = await start(server, { 'x-md-api-key': 'x'.repeat(7001) });
    assert.equal(bad.statusCode, 400);
    assert.match(bad.payload, /longer than 7000/);
    // a long JWT-style token works
    const jwt = `eyJ${'a'.repeat(1200)}.${'b'.repeat(1800)}.${'c'.repeat(400)}`;
    assert.equal((await start(server, { 'x-md-api-key': jwt })).statusCode, 200);
    const claimedJwt = JSON.parse((await server.inject({ method: 'POST', url: '/api/queue/claim', headers: SERVICE, payload: { topic: TOPIC, adapter_id: 'a0' } })).payload).job;
    const jwtRef = claimedJwt.payload.task.secret_ref;
    const fetched = await server.inject({ method: 'POST', url: '/api/queue/secret', headers: SERVICE, payload: { ref: jwtRef, user: '#9:1', topic: TOPIC } });
    assert.equal(JSON.parse(fetched.payload).key, jwt);
    queue.complete(claimedJwt.id, 'a0');

    await start(server, { 'x-md-api-key': KEY });
    const job = JSON.parse((await server.inject({ method: 'POST', url: '/api/queue/claim', headers: SERVICE, payload: { topic: TOPIC, adapter_id: 'a1' } })).payload).job;
    const ref = job.payload.task.secret_ref;
    const failed = await server.inject({ method: 'POST', url: `/api/queue/${job.id}/fail`, headers: SERVICE, payload: { adapter_id: 'a1', error: 'overloaded' } });
    assert.equal(JSON.parse(failed.payload).permanent, false);
    const again = await server.inject({ method: 'POST', url: '/api/queue/secret', headers: SERVICE, payload: { ref, user: '#9:1', topic: TOPIC } });
    assert.equal(JSON.parse(again.payload).key, KEY);
    queue.close();
    fs.rmSync(dir, { recursive: true, force: true });
});

test('cancelling a single job drops its key', async () => {
    const { dir, queue, server } = await setup();
    await start(server, { 'x-md-api-key': KEY });
    const job = JSON.parse((await server.inject({ method: 'POST', url: '/api/queue/claim', headers: SERVICE, payload: { topic: TOPIC, adapter_id: 'a1' } })).payload).job;
    const ref = job.payload.task.secret_ref;
    const cancelled = await server.inject({ method: 'POST', url: `/api/batches/job_${job.id}/cancel`, headers: { mail: '#9:1' } });
    assert.equal(cancelled.statusCode, 200, cancelled.payload);
    const after = await server.inject({ method: 'POST', url: '/api/queue/secret', headers: SERVICE, payload: { ref, user: '#9:1', topic: TOPIC } });
    assert.equal(after.statusCode, 404);
    queue.close();
    fs.rmSync(dir, { recursive: true, force: true });
});
