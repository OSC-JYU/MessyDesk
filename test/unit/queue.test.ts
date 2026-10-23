// The SQLite job queue: claiming, leases, retries, batch control and auto-abort.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { JobQueue } from '../../src/modules/queue/queue.ts';

function makeQueue(overrides: Partial<ConstructorParameters<typeof JobQueue>[0]> = {}) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mdq-'));
    return new JobQueue({
        dbPath: path.join(dir, 'queue.sqlite'),
        maxAttempts: 3,
        leaseSeconds: 120,
        keepFailedMinutes: 1440,
        sweeperEnabled: false,
        sweeperIntervalSeconds: 300,
        sweeperDoneCancelledMinutes: 60,
        batchAbortConsecutive: 5,
        batchAbortPercent: 50,
        ...overrides,
    });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('claim takes the plain queue before the batch queue, once', () => {
    const q = makeQueue();
    q.publish('svc_batch', { n: 1 });
    q.publish('svc', { n: 2 });
    const first = q.claim('svc', 'a')!;
    assert.equal(first.queue, 'svc');
    assert.deepEqual(first.payload, { n: 2 });
    assert.equal(first.attempts, 1);
    const second = q.claim('svc', 'b')!;
    assert.equal(second.queue, 'svc_batch');
    assert.equal(q.claim('svc', 'c'), null);
    assert.equal(q.complete(first.id, 'b'), false, 'only the claiming adapter completes');
    assert.equal(q.complete(first.id, 'a'), true);
    assert.equal(q.heartbeat(second.id, 'b'), true);
    q.close();
});

test('failures retry with backoff, then fail permanently', async () => {
    const q = makeQueue({ maxAttempts: 2 });
    q.publish('svc', { n: 1 });
    let job = q.claim('svc', 'a')!;
    assert.deepEqual(q.fail(job.id, 'x', 'a'), { ok: true, permanent: false });
    assert.equal(q.claim('svc', 'a'), null, 'backing off');
    await sleep(600);
    job = q.claim('svc', 'a')!;
    assert.equal(job.attempts, 2);
    assert.deepEqual(q.fail(job.id, 'y', 'a'), { ok: true, permanent: true });
    assert.equal(q.claim('svc', 'a'), null);
    q.close();
});

test('per-message max_attempts override', () => {
    const q = makeQueue();
    q.publish('svc', { queue_options: { max_attempts: 1 } });
    const job = q.claim('svc', 'a')!;
    assert.equal(job.max_attempts, 1);
    assert.equal((q.fail(job.id, 'x', 'a') as any).permanent, true);
    q.close();
});

test('pause and cancel survive a reopen of the queue file', () => {
    const q = makeQueue();
    for (let i = 0; i < 3; i += 1) q.publish('svc_batch', { set_process: '#1:1', process: { '@rid': '#1:1' }, userId: '#9:9' });
    const running = q.claim('svc', 'a')!;
    assert.equal(q.pauseBatch('#1:1').deleted, 2);
    q.close();
    // Reopen: the cancel state must still be known (it was in memory before).
    q.cancelBatch('#1:1');
    q.close();
    const result = q.fail(running.id, 'late', 'a');
    assert.deepEqual(result, { ok: true, permanent: false, cancelled: true });
    q.close();
});

test('active jobs are grouped per batch, filtered per user, without thumbnails', () => {
    const q = makeQueue();
    q.publish('svc_batch', { set_process: '#1:1', process: { '@rid': '#1:1' }, userId: '#9:9', service: { id: 'svc' } });
    q.publish('svc_batch', { set_process: '#1:1', process: { '@rid': '#1:1' }, userId: '#9:9', service: { id: 'svc' } });
    q.publish('md-thumbnailer', { userId: '#9:9', service: { id: 'md-thumbnailer' } });
    q.publish('other', { userId: '#8:8', service: { id: 'other' } });
    const mine = q.activeJobs('#9:9');
    assert.equal(mine.length, 1);
    assert.equal(mine[0].rid, '#1:1');
    assert.equal(mine[0].total_files, 2);
    assert.equal(mine[0].service_id, 'svc');
    assert.equal(q.activeJobs(null).length, 2);
    assert.equal(q.ownerOf('#1:1'), '#9:9');
    q.close();
});

test('a batch is aborted after consecutive permanent failures', () => {
    const q = makeQueue({ maxAttempts: 1, batchAbortConsecutive: 2, batchAbortPercent: 101 });
    for (let i = 0; i < 4; i += 1) q.publish('svc_batch', { set_process: '#2:2', process: { '@rid': '#2:2' }, userId: '#9:9' });
    const a = q.claim('svc', 'x')!;
    assert.equal((q.fail(a.id, 'e', 'x') as any).batch_aborted, undefined);
    const b = q.claim('svc', 'x')!;
    const result = q.fail(b.id, 'e', 'x') as any;
    assert.equal(result.batch_aborted, true);
    assert.equal(result.abort_reason, 'consecutive_failures');
    assert.equal(result.userId, '#9:9');
    assert.equal(q.claim('svc', 'x'), null, 'remaining jobs were cancelled');
    q.close();
});

test('flush and dismiss', () => {
    const q = makeQueue();
    q.publish('svc', { a: 1 });
    q.publish('svc_batch', { a: 2 });
    assert.deepEqual(q.flush('svc'), { deleted: 2 });
    const id = q.publish('svc', { a: 3 });
    assert.equal(q.dismiss(`job_${id}`), true);
    assert.equal(q.claim('svc', 'x'), null);
    q.close();
});
