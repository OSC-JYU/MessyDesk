import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    get, post, call, OTHER, TARGET, onlyNew, ensureOtherUser, uniq, stripHash, waitFor, sleep,
    createProject, createSet, upload, PNG_1x1, SseListener, FakeConsumer, sampleDescriptor,
} from './helpers.ts';

function topicName(): string {
    return 'md-contract-' + uniq('t').split(' ')[1];
}

async function setupService(extra: Record<string, unknown> = {}) {
    const consumer = new FakeConsumer(sampleDescriptor(topicName(), extra));
    await consumer.register();
    return consumer;
}

test('service registration, adapters and listing', async () => {
    const consumer = await setupService();
    const services = await get('/api/services');
    assert.equal(services.status, 200);
    const svc = services.body[consumer.topic];
    assert.ok(svc, 'registered service listed under its id');
    assert.deepEqual(svc.consumers, [consumer.adapterId]);
    assert.equal(svc.tasks.upper.behaviour, 'one-to-one');
    assert.equal(svc.registration.source, 'contract-test');

    const one = await get(`/api/services/${consumer.topic}`);
    assert.equal(one.status, 200);
    assert.equal(one.body.id, consumer.topic);

    const again = await post(`/api/services/${consumer.topic}/adapter/${consumer.adapterId}`, {}, { service: true });
    assert.equal(again.status, 200);
    assert.deepEqual(again.body, { status: 'consumer already exists', name: consumer.topic });

    const unknown = await post(`/api/services/md-no-such-service/adapter/x`, {}, { service: true });
    assert.equal(unknown.status, 404);

    const invalid = await post('/api/services/register', { service: { id: 'x', tasks: { a: { behaviour: 'weird' } } } }, { service: true });
    assert.equal(invalid.status, 400);

    await consumer.unregister();
    const after = await get('/api/services');
    assert.deepEqual(after.body[consumer.topic].consumers, []);
});

test('services offered for a file, a set, and filters', async () => {
    const consumer = await setupService();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'a.txt', type: 'text/plain', content: 'a' }])).body;
        const res = await get(`/api/services/files/${stripHash(file['@rid'])}?filter=`);
        assert.equal(res.status, 200);
        assert.ok(Array.isArray(res.body.for_type));
        assert.ok(Array.isArray(res.body.filters));
        const svc = res.body.for_format.find((s: any) => s.id === consumer.topic);
        assert.ok(svc);
        assert.deepEqual(Object.keys(svc.tasks).sort(), ['pages', 'upper'], 'many-to-one tasks need a set');

        const set = await createSet(project['@rid']);
        await upload(project['@rid'], [{ name: 'b.txt', type: 'text/plain', content: 'b' }], set['@rid']);
        const forSet = await get(`/api/services/files/${stripHash(set['@rid'])}`);
        const setSvc = forSet.body.for_format.find((s: any) => s.id === consumer.topic);
        assert.deepEqual(Object.keys(setSvc.tasks).sort(), ['combine', 'pages', 'upper']);
        const setFilter = forSet.body.filters.find((f: any) => f.id === 'mdf-set-filter' || f.name);
        assert.ok(setFilter);
    } finally {
        await consumer.unregister();
    }
});

test('single file, one-to-one: queue message, result callback, SSE', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const me = await get('/api/me');
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'in.txt', type: 'text/plain', content: 'make me loud' }])).body;
        const res = await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper', params: { x: 1 }, name: 'ignored name' });
        assert.equal(res.status, 200);
        assert.equal(res.body, stripHash(file['@rid']));

        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === file['@rid']);
        assert.equal(added.node['@type'], 'Process');

        const job = await consumer.claimWait();
        assert.equal(job.queue, consumer.topic);
        assert.equal(job.attempts, 1);
        assert.equal(job.max_attempts, 3);
        const msg = job.payload;
        assert.equal(msg.service.id, consumer.topic);
        assert.equal(msg.task.id, 'upper');
        assert.equal(msg.task.name, 'Upper case', 'task name comes from the descriptor');
        assert.deepEqual(msg.task.params, { x: 1 });
        assert.equal(msg.file['@rid'], file['@rid']);
        assert.equal(msg.file.project_rid, project['@rid']);
        assert.equal(msg.file.path, file.path);
        assert.equal(msg.process['@rid'], added.node['@rid']);
        assert.ok(msg.process.path.endsWith('/files'));
        assert.equal(msg.process.file_rid, file['@rid']);
        assert.equal(msg.output_set, null);
        assert.equal(msg.userId, me.body.rid);
        assert.equal(msg.project_rid, project['@rid']);

        const sent = await consumer.sendFile(msg, 'MAKE ME LOUD', { label: 'in.txt.upper.txt', type: 'text', extension: 'txt' }, { response: { time: 0.5 } });
        assert.equal(sent.status, 200);
        assert.deepEqual(sent.body, { success: true, message: 'Files processed successfully' });
        assert.equal((await consumer.complete(job.id)).status, 200);

        const out = await sse.waitFor((e) => e.command === 'add' && e.input === msg.process['@rid'] && e.node?.['@type'] === 'File');
        assert.equal(out.type, 'text');
        assert.deepEqual(out.process, { '@rid': msg.process['@rid'], status: 'finished' });
        assert.equal(out.node.label, 'in.txt.upper.txt');

        const outRid = stripHash(out.node['@rid']);
        assert.equal((await get(`/api/files/${outRid}`)).text, 'MAKE ME LOUD');
        const anc = await get(`/api/files/${outRid}/ancestors`);
        assert.deepEqual(anc.body.map((a: any) => a['@rid']), [file['@rid']]);

        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        const procNode = graph.body.nodes.find((n: any) => n.data.id === msg.process['@rid']);
        assert.ok(procNode, 'process node appears in the desk graph');
        assert.equal(procNode.data.type, 'Process');
        assert.equal(procNode.data.task, 'upper');
        assert.equal(procNode.data.service, consumer.topic);
        assert.ok(graph.body.edges.find((e: any) => e.data.source === file['@rid'] && e.data.target === msg.process['@rid']));
        assert.ok(graph.body.edges.find((e: any) => e.data.source === msg.process['@rid'] && e.data.target === out.node['@rid']));

        const noJob = await consumer.claim();
        assert.equal(noJob, null);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('unknown task and unknown service are rejected', async () => {
    const consumer = await setupService();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'u.txt', type: 'text/plain', content: 'u' }])).body;
        const badTask = await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'nope' });
        assert.ok(badTask.status >= 400);
        const badService = await post(`/api/queue/md-no-such-service/files/${stripHash(file['@rid'])}`, { id: 'x' });
        assert.ok(badService.status >= 400);
    } finally {
        await consumer.unregister();
    }
});

test('single file, one-to-many: output set, files into it, done', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'doc.txt', type: 'text/plain', content: 'p1 p2' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'pages', params: {} });
        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === file['@rid']);
        assert.ok(added.output, 'output set sent with the process');
        assert.equal(added.output['@type'], 'Set');
        assert.equal(added.output.label, 'Pages');
        assert.equal(added.set_process, added.node['@rid']);

        const job = await consumer.claimWait();
        const msg = job.payload;
        assert.equal(msg.output_set, added.output['@rid']);
        assert.equal(msg.set_node['@rid'], added.output['@rid']);

        await consumer.sendFile(msg, 'p1', { label: 'page1.txt', type: 'text', extension: 'txt' }, { file_total: 2, file_count: 1 });
        await consumer.sendFile(msg, 'p2', { label: 'page2.txt', type: 'text', extension: 'txt' }, { file_total: 2, file_count: 2 });
        const done = await consumer.done({ ...msg, response: { time: 1 } });
        assert.equal(done.status, 200);
        assert.deepEqual(done.body, []);
        await consumer.complete(job.id);

        const fin = await sse.waitFor((e) => e.command === 'process_finished' && e.process?.['@rid'] === msg.process['@rid']);
        assert.equal(fin.process.status, 'done');

        const files = await get(`/api/sets/${stripHash(msg.output_set)}/files`);
        assert.equal(files.body.file_count, 2);
        assert.deepEqual(files.body.files.map((f: any) => f.label), ['page1.txt', 'page2.txt']);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

async function setWithFiles(n: number, user?: string) {
    const project = await createProject(undefined, user);
    const set = await createSet(project['@rid'], 'Batch input', user);
    const files = [];
    for (let i = 1; i <= n; i += 1) files.push({ name: `f${i}.txt`, type: 'text/plain', content: `file ${i}` });
    const up = await upload(project['@rid'], files, set['@rid'], user);
    assert.equal(up.status, 200);
    return { project, set };
}

test('set batch, one-to-one: per-file jobs, progress, finish, set lock', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const { project, set } = await setWithFiles(2);
        const res = await post(`/api/queue/${consumer.topic}/sets/${stripHash(set['@rid'])}`, { id: 'upper', params: {} });
        assert.equal(res.status, 200);
        assert.equal(res.body, set['@rid']);

        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === set['@rid']);
        const batchRid = added.node['@rid'];
        assert.equal(added.node['@type'], 'SetProcess');
        assert.equal(added.output['@type'], 'Set');

        const batch = await get(`/api/batches/${stripHash(batchRid)}`);
        assert.equal(batch.status, 200);
        assert.equal(batch.body.status, 'running');
        assert.equal(batch.body.total_files, 2);
        assert.equal(batch.body.topic, consumer.topic);
        assert.equal(batch.body.input_set, set['@rid']);
        assert.equal(batch.body.output_set, added.output['@rid']);

        const active = await get('/api/queue/jobs/active');
        const entry = active.body.find((j: any) => j.rid === batchRid);
        assert.ok(entry);
        assert.equal(entry.set_process, batchRid);
        assert.equal(entry.service_id, consumer.topic);
        assert.equal(entry.total_files, 2);
        assert.equal(entry.queued_files, 2);

        const jobs = [await consumer.claimWait(), await consumer.claimWait()];
        for (const job of jobs) {
            assert.equal(job.queue, consumer.topic + '_batch');
            const msg = job.payload;
            assert.equal(msg.set_process, batchRid);
            assert.equal(msg.process['@rid'], batchRid);
            assert.equal(msg.output_set, added.output['@rid']);
            assert.equal(msg.set_rid, set['@rid']);
            assert.equal(msg.total_files, 2);
            assert.equal(msg.project_rid, project['@rid']);
        }
        assert.deepEqual(jobs.map((j) => j.payload.current_file).sort(), [1, 2]);

        for (const job of jobs) {
            const msg = job.payload;
            await consumer.sendFile(msg, msg.file.label.toUpperCase(), { label: msg.file.label + '.up.txt', type: 'text', extension: 'txt' }, { response: { time: 0.2 } });
            await consumer.complete(job.id);
        }
        const fin = await sse.waitFor((e) => e.command === 'process_finished' && e.process?.['@rid'] === batchRid);
        assert.equal(fin.process.status, 'done');
        assert.equal(fin.set['@rid'], added.output['@rid']);
        assert.equal(fin.set.count, 2);
        assert.equal(fin.batch.status, 'done');
        assert.equal(fin.batch.processed_files, 2);
        assert.equal(fin.batch.total_files, 2);

        const after = await get(`/api/batches/${stripHash(batchRid)}`);
        assert.equal(after.body.status, 'done');
        assert.equal(after.body.processed_files, 2);

        const locked = await upload(project['@rid'], [{ name: 'late.txt', type: 'text/plain', content: 'late' }], set['@rid']);
        assert.equal(locked.status, 409);

        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        assert.equal(graph.body.nodes.find((n: any) => n.data.id === set['@rid']).data.processed, true);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('set batch, many-to-one: one message per file with group counters', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const { set } = await setWithFiles(2);
        const res = await post(`/api/queue/${consumer.topic}/sets/${stripHash(set['@rid'])}`, { id: 'combine', params: {} });
        assert.equal(res.status, 200);
        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === set['@rid']);
        const jobs = [await consumer.claimWait(), await consumer.claimWait()];
        const msgs = jobs.map((j) => j.payload).sort((a, b) => a.current_file - b.current_file);
        for (const [i, msg] of msgs.entries()) {
            assert.equal(msg.behaviour, 'many-to-one');
            assert.equal(msg.set_process, added.node['@rid']);
            assert.equal(msg.input_set, set['@rid']);
            assert.equal(msg.output_set, added.output['@rid']);
            assert.equal(msg.total_files, 2);
            assert.equal(msg.current_file, i + 1);
            assert.equal(msg.batch_total_files, 2);
            assert.equal(msg.batch_current_file, i + 1);
        }
        for (const job of jobs) await consumer.complete(job.id);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('failed job is retried with backoff, then fails permanently', async () => {
    const consumer = await setupService();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'r.txt', type: 'text/plain', content: 'r' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper' });
        let job = await consumer.claimWait();
        const first = await consumer.fail(job.id, 'transient');
        assert.deepEqual(first.body, { ok: true, permanent: false, batch_aborted: false });
        assert.equal(await consumer.claim(), null, 'not claimable during backoff');
        job = await consumer.claimWait(undefined, 5000);
        assert.equal(job.attempts, 2);
        assert.equal((await consumer.heartbeat(job.id)).status, 200);
        await consumer.fail(job.id, 'again');
        job = await consumer.claimWait(undefined, 5000);
        assert.equal(job.attempts, 3);
        const last = await consumer.fail(job.id, 'final');
        assert.deepEqual(last.body, { ok: true, permanent: true, batch_aborted: false });
        await sleep(2500);
        assert.equal(await consumer.claim(), null);

        const wrongAdapter = await post(`/api/queue/${job.id}/complete`, { adapter_id: 'someone-else' }, { service: true });
        assert.equal(wrongAdapter.status, 404);
        const missing = await post('/api/queue/claim', { topic: consumer.topic }, { service: true });
        assert.equal(missing.status, 400);
    } finally {
        await consumer.unregister();
    }
});

test('batch pause, resume and cancel', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const { set } = await setWithFiles(3);
        await post(`/api/queue/${consumer.topic}/sets/${stripHash(set['@rid'])}`, { id: 'upper' });
        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === set['@rid']);
        const rid = stripHash(added.node['@rid']);

        const paused = await post(`/api/batches/${rid}/pause`);
        assert.equal(paused.status, 200);
        assert.equal(paused.body.status, 'paused');
        assert.equal(paused.body.deleted, 3);
        assert.equal(paused.body.batch.status, 'paused');
        await sse.waitFor((e) => e.command === 'process_update' && e.batch?.status === 'paused');
        assert.equal(await consumer.claim(), null);

        const resumed = await post(`/api/batches/${rid}/resume`);
        assert.equal(resumed.status, 200);
        assert.equal(resumed.body.status, 'running');
        assert.equal(resumed.body.resumed_messages, 3);
        const notPaused = await post(`/api/batches/${rid}/resume`);
        assert.equal(notPaused.status, 409);

        const job = await consumer.claimWait();
        assert.equal(job.payload.set_process, added.node['@rid']);

        const cancelled = await post(`/api/batches/${rid}/cancel`);
        assert.equal(cancelled.status, 200);
        assert.equal(cancelled.body.status, 'cancelled');
        assert.equal(cancelled.body.batch.status, 'cancelled');
        await sse.waitFor((e) => e.command === 'process_finished' && e.process?.status === 'cancelled' && e.process['@rid'] === added.node['@rid']);
        assert.equal(await consumer.claim(), null);
        const late = await consumer.fail(job.id, 'late');
        assert.equal(late.status, 200);
        const del = await call('DELETE', `/api/graph/vertices/${rid}`);
        assert.equal(del.status, 200);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('deleting a node with active jobs is refused (409)', async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const { set } = await setWithFiles(1);
        await post(`/api/queue/${consumer.topic}/sets/${stripHash(set['@rid'])}`, { id: 'upper' });
        const added = await sse.waitFor((e) => e.command === 'add' && e.type === 'process' && e.input === set['@rid']);
        const res = await call('DELETE', `/api/graph/vertices/${stripHash(added.node['@rid'])}`);
        assert.equal(res.status, 409);
        await consumer.drain();
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('dismissing a single job', async () => {
    const consumer = await setupService();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'd.txt', type: 'text/plain', content: 'd' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper' });
        const active = await waitFor(async () => {
            const list = (await get('/api/queue/jobs/active')).body;
            return list.find((j: any) => j.service_id === consumer.topic);
        });
        const res = await post(`/api/queue/jobs/${encodeURIComponent(active.rid)}/dismiss`);
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { ok: true, rid: active.rid });
        assert.equal(await consumer.claim(), null);
    } finally {
        await consumer.unregister();
    }
});

test('thumbnail flow: md-thumbnailer job and preview serving', async () => {
    const thumbnailer = new FakeConsumer({ id: 'md-thumbnailer', name: 'Thumbnailer', adapter: 'elg', category: 'system', tasks: { thumbnail: { name: 'Thumbnail', params: {} } } });
    await thumbnailer.register();
    const sse = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'pic.png', type: 'image/png', content: PNG_1x1 }])).body;
        const job = await thumbnailer.claimWait((j) => j.payload.file?.['@rid'] === file['@rid']);
        const msg = job.payload;
        assert.equal(msg.topic.id, 'md-thumbnailer');
        assert.equal(msg.service.id, 'md-thumbnailer');
        assert.deepEqual(msg.task, { id: 'thumbnail', params: { width: 800, type: 'jpeg' } });
        assert.equal(msg.file.metadata.width, 1);

        await thumbnailer.sendFile(msg, PNG_1x1, { label: 'preview', type: 'image', extension: 'jpg' });
        await thumbnailer.sendFile(msg, PNG_1x1, { label: 'thumbnail', type: 'image', extension: 'jpg' });
        await thumbnailer.complete(job.id);
        const upd = await sse.waitFor((e) => e.command === 'update' && e.target === file['@rid'] && e.node?.thumb);
        assert.match(upd.node.thumb, /api\/thumbnails\//);
        assert.equal(upd.node.image, upd.node.thumb);
        assert.equal(typeof upd.node.thumbnail_version, 'number');

        const dir = file.path.split('/').slice(0, -1).join('/');
        const preview = await get(`/api/thumbnails/${dir}`);
        assert.equal(preview.status, 200);
        assert.match(preview.headers.get('content-type') || '', /image\/jpeg/);
        assert.match(preview.headers.get('cache-control') || '', /no-store/);
        const small = await get(`/api/thumbnails/${dir}/thumbnail.jpg`);
        assert.equal(small.status, 200);

        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        assert.ok(!graph.body.nodes.find((n: any) => n.data.name === 'preview.jpg'), 'thumbnails are not graph nodes');

        const queued = await post(`/api/files/${stripHash(file['@rid'])}/thumbnail`);
        assert.equal(queued.status, 200);
        assert.equal(queued.body['@rid'], file['@rid']);
        await thumbnailer.claimWait((j) => j.payload.file?.['@rid'] === file['@rid']);
    } finally {
        sse.close();
        await thumbnailer.unregister();
    }
});

test('error callback marks the process and creates an error node', { skip: onlyNew }, async () => {
    const consumer = await setupService();
    const sse = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'e.txt', type: 'text/plain', content: 'e' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper' });
        const job = await consumer.claimWait();
        const res = await consumer.error(job.payload, { message: 'it broke', code: 'E_BROKE' });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, []);
        const upd = await sse.waitFor((e) => e.command === 'update' && e.target === job.payload.process['@rid'] && e.error);
        assert.equal(upd.error, 'errors: 1');
        const add = await sse.waitFor((e) => e.command === 'add' && e.type === 'error');
        assert.equal(add.input, job.payload.process['@rid']);
        assert.equal(add.node.type, 'error.json');
        const content = await get(`/api/files/${stripHash(add.node['@rid'])}`);
        assert.equal(content.status, 200);
        const log = JSON.parse(content.text);
        assert.equal(log.error.message, 'it broke');
        await consumer.complete(job.id);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('thumbnail failures are swallowed without an error node', async () => {
    const res = await post('/api/nomad/process/files/error', { error: 'x', message: { role: 'thumbnail', file: { '@rid': '#1:1' } } }, { service: true });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, []);
});

test('queue admin and other users jobs are protected', { skip: onlyNew }, async () => {
    const consumer = await setupService();
    try {
        await ensureOtherUser();
        const flush = await get(`/api/queue/${consumer.topic}/flush`, { user: OTHER });
        assert.equal(flush.status, 403);
        const ok = await get(`/api/queue/${consumer.topic}/flush`);
        assert.equal(ok.status, 200);
        assert.deepEqual(ok.body, { deleted: 0 });

        const { set } = await setWithFiles(1);
        await post(`/api/queue/${consumer.topic}/sets/${stripHash(set['@rid'])}`, { id: 'upper' });
        const mine = (await get('/api/queue/jobs/active')).body.find((j: any) => j.service_id === consumer.topic);
        assert.ok(mine);
        const theirs = (await get('/api/queue/jobs/active', { user: OTHER })).body.find((j: any) => j.service_id === consumer.topic);
        assert.equal(theirs, undefined);
        const pause = await post(`/api/batches/${stripHash(mine.rid)}/pause`, undefined, { user: OTHER });
        assert.equal(pause.status, 404);
        const cancel = await post(`/api/batches/${stripHash(mine.rid)}/cancel`, undefined, { user: OTHER });
        assert.equal(cancel.status, 404);
        await consumer.drain();
    } finally {
        await consumer.unregister();
    }
});

test('consumer routes need the service credential', { skip: onlyNew }, async () => {
    await ensureOtherUser();
    const claim = await call('POST', '/api/queue/claim', { user: OTHER, body: { topic: 'x', adapter_id: 'y' } });
    assert.equal(claim.status, 401);
    const reg = await call('POST', '/api/services/register', { user: OTHER, body: { service: { id: 'md-evil', tasks: {} } } });
    assert.equal(reg.status, 401);
    const cb = await call('POST', '/api/nomad/process/files/done', { user: OTHER, body: {} });
    assert.equal(cb.status, 401);
});

test('old backend: anyone can flush a topic', { skip: TARGET === 'old' ? false : 'old behaviour' }, async () => {
    await ensureOtherUser();
    const res = await get('/api/queue/md-nothing-here/flush', { user: OTHER });
    assert.equal(res.status, 200);
});
