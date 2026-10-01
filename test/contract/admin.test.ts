import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
    get, post, put, del, call, OTHER, TARGET, onlyNew, ensureOtherUser, uniq, stripHash,
    createProject, upload, SseListener, FakeConsumer, sampleDescriptor,
} from './helpers.ts';

test('services: admin install, reload and forget', async () => {
    const id = 'md-contract-inst-' + uniq('i').split(' ')[1];
    await ensureOtherUser();
    const forbidden = await post('/api/services/install', { kind: 'external', id, url: 'http://localhost:1' }, { user: OTHER });
    assert.equal(forbidden.status, 403);
    const badKind = await post('/api/services/install', { kind: 'weird', id });
    assert.equal(badKind.status, 400);
    const noUrl = await post('/api/services/install', { kind: 'external', id });
    assert.equal(noUrl.status, 400);
    const installed = await post('/api/services/install', { kind: 'external', id, url: 'http://localhost:1', service: JSON.stringify({ tasks: { a: { name: 'A' } } }) });
    assert.equal(installed.status, 200);
    assert.equal(installed.body.status, 'created');
    assert.equal(installed.body.service.kind, 'external');
    assert.equal(installed.body.service.local_url, 'http://localhost:1');
    assert.equal(installed.body.service.location, 'external');
    assert.equal(installed.body.service.tasks.a.behaviour, 'one-to-one');

    const reload = await post('/api/services/reload', {});
    assert.equal(reload.status, 200);
    assert.equal(reload.body.status, 'ok');
    const after = await get('/api/services');
    assert.ok(after.body[id], 'installed service survives a reload (persisted registry)');

    assert.equal((await del(`/api/services/${id}`, { user: OTHER })).status, 403);
    const forgotten = await del(`/api/services/${id}`);
    assert.deepEqual(forgotten.body, { status: 'forgotten', service: id });
    const again = await del(`/api/services/${id}`);
    assert.equal(again.body.status, 'not_found');
    assert.equal((await del('/api/services/bad id')).status, 400);
});

test('unknown service descriptor is an empty 204', async () => {
    const res = await get('/api/services/md-no-such-service', { service: true });
    // The old handler returned undefined, which Hapi turns into a 500.
    assert.equal(res.status, TARGET === 'old' ? 500 : 204);
});

test('project position update', async () => {
    const project = await createProject();
    const ok = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'position', value: { x: 100, y: -200 } });
    assert.equal(ok.status, 200);
    const bad = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'position', value: { x: 1.5, y: 0 } });
    assert.equal(bad.status, 400);
    const far = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'position', value: { x: 20000, y: 0 } });
    assert.equal(far.status, 400);
});

test('sources: create publishes an init job for md-<type>', async () => {
    const consumer = new FakeConsumer({ id: 'md-dspace7', name: 'DSpace', adapter: 'dspace7', category: 'preparation', tasks: { init: { name: 'Init' }, make_query: { name: 'Query' } } });
    await consumer.register();
    try {
        await consumer.drain();
        const project = await createProject();
        const res = await post(`/api/projects/${stripHash(project['@rid'])}/sources`, { type: 'dspace7', label: 'Repo', url: 'https://demo.dspace.org/server/api' });
        assert.equal(res.status, 200);
        assert.equal(res.body['@type'], 'Source');
        assert.equal(res.body.status, 'initing...');
        assert.equal(res.body.project_rid, project['@rid']);
        const job = await consumer.claimWait((j) => j.payload.file?.['@rid'] === res.body['@rid']);
        assert.equal(job.payload.task.id, 'init');
        assert.equal(job.payload.task.params.url, 'https://demo.dspace.org/server/api');
        await consumer.complete(job.id);
        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        assert.ok(graph.body.nodes.find((n: any) => n.data.id === res.body['@rid'] && n.data._type === 'Source'));
    } finally {
        await consumer.unregister();
    }
});

test('sources: a query is dispatched with the source url', { skip: onlyNew }, async () => {
    // The old backend could not look Sources up (getUserFileMetadata never matched them), so this 500ed.
    const consumer = new FakeConsumer({ id: 'md-dspace7', name: 'DSpace', adapter: 'dspace7', category: 'preparation', tasks: { init: { name: 'Init' }, make_query: { name: 'Query' } } });
    await consumer.register();
    try {
        await consumer.drain();
        const project = await createProject();
        const source = (await post(`/api/projects/${stripHash(project['@rid'])}/sources`, { type: 'dspace7', label: 'Repo', url: 'https://x.example/api' })).body;
        await consumer.drain();
        const sse = await new SseListener().open();
        try {
            const res = await post(`/api/queue/md-dspace7/sources/${stripHash(source['@rid'])}`, { id: 'make_query', params: { query: 'cats' } });
            assert.equal(res.status, 200);
            const added = await sse.waitFor((e) => e.command === 'add' && e.target === source['@rid']);
            assert.equal(added.type, 'process');
            assert.equal(added.set_node['@type'], 'Set');
            const job = await consumer.claimWait();
            assert.equal(job.queue, 'md-dspace7_batch');
            assert.equal(job.payload.task.params.url, 'https://x.example/api');
            assert.equal(job.payload.task.params.query, 'cats');
            assert.equal(job.payload.output_set, added.set_node['@rid']);
            await consumer.complete(job.id);
        } finally {
            sse.close();
        }
    } finally {
        await consumer.unregister();
    }
});

test('disk-mode result (/tmp callback, elg_fs) creates the output from the tmp dir', async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-fs-' + uniq('f').split(' ')[1]));
    await consumer.register();
    const sse = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'disk.txt', type: 'text/plain', content: 'disk mode' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper' });
        const job = await consumer.claimWait();
        const msg = job.payload;
        // The service writes into <data>/<db>/tmp; the callback names only the file.
        // Same rule as the backend: <parent of DATA_DIR>/<db>/tmp when the path has data/<db>,
        // otherwise <parent of DATA_DIR>/tmp. DATA_DIR is everything before /projects/.
        const filePath = path.resolve(msg.file.path);
        const dataDir = filePath.slice(0, filePath.indexOf(`${path.sep}projects${path.sep}`));
        const dataRoot = path.dirname(dataDir);
        const parts = msg.file.path.split('/').filter(Boolean);
        let tmpDir: string | null = path.join(dataRoot, 'tmp');
        for (let i = 0; i < parts.length - 1; i += 1) {
            if (parts[i] === 'data' && parts[i + 1]) { tmpDir = path.join(dataRoot, parts[i + 1], 'tmp'); break; }
        }
        if (!dataDir || !fs.existsSync(dataDir)) tmpDir = null;
        if (!tmpDir) {
            // The data directory is not reachable from the test process (remote backend): skip.
            await consumer.complete(job.id);
            return;
        }
        fs.mkdirSync(tmpDir, { recursive: true });
        const tmpName = `contract_${uniq('t').split(' ')[1]}.txt`;
        fs.writeFileSync(path.join(tmpDir, tmpName), 'DISK MODE');
        const callback = {
            file: { ...msg.file, type: 'text', extension: 'txt', label: 'disk.txt.upper.txt', source: msg.file },
            target: msg.file.project_rid,
            process: msg.process,
            output_set: msg.output_set,
            userId: msg.userId,
            total_files: 1,
            current_file: 1,
            file_total: 1,
            file_count: 1,
            service: msg.service,
            task: msg.task,
            response: { type: 'disk', time: 0.1 },
        };
        const res = await post('/api/nomad/process/files/tmp', { message: callback, tmp_path: tmpName }, { service: true });
        assert.equal(res.status, 200);
        const out = await sse.waitFor((e) => e.command === 'add' && e.input === msg.process['@rid'] && e.node?.['@type'] === 'File');
        assert.equal((await get(`/api/files/${stripHash(out.node['@rid'])}`)).text, 'DISK MODE');
        const traversal = await post('/api/nomad/process/files/tmp', { message: callback, tmp_path: '../../etc/passwd' }, { service: true });
        assert.equal(traversal.status, 422, 'only the base name is used; a missing tmp file is reported as 422 (as before)');
        const missing = await post('/api/nomad/process/files/tmp', { message: callback }, { service: true });
        assert.equal(missing.status, 422);
        await consumer.complete(job.id);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('graph edge attribute and delete (owner only)', { skip: TARGET === 'old' ? 'old backend has no ownership check' : false }, async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-edge-' + uniq('e').split(' ')[1]));
    await consumer.register();
    const sse = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'e.txt', type: 'text/plain', content: 'e' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper' });
        const job = await consumer.claimWait();
        await consumer.sendFile(job.payload, 'E', { label: 'e.up.txt', type: 'text', extension: 'txt' });
        await consumer.complete(job.id);
        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        const edge = graph.body.edges.find((e: any) => e.data.type === 'DERIVED_FROM');
        assert.ok(edge?.data.edge_rid);
        await ensureOtherUser();
        assert.equal((await post(`/api/graph/edges/${stripHash(edge.data.edge_rid)}`, { name: 'note', value: 'x' }, { user: OTHER })).status, 404);
        assert.equal((await post(`/api/graph/edges/${stripHash(edge.data.edge_rid)}`, { name: 'note', value: 'hello' })).status, 200);
        assert.equal((await post(`/api/graph/edges/${stripHash(edge.data.edge_rid)}`, { name: 'bad name', value: 'x' })).status, 400);
        assert.equal((await call('DELETE', `/api/graph/edges/${stripHash(edge.data.edge_rid)}`, { user: OTHER })).status, 404);
        assert.equal((await call('DELETE', `/api/graph/edges/${stripHash(edge.data.edge_rid)}`)).status, 200);
    } finally {
        sse.close();
        await consumer.unregister();
    }
});

test('traverse rejects an unknown direction', { skip: onlyNew }, async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'd.txt', type: 'text/plain', content: 'd' }])).body;
    const res = await get(`/api/graph/traverse/${stripHash(file['@rid'])}/sideways`);
    assert.equal(res.status, 400);
});

test('help ingest from a service (service credential or admin)', { skip: onlyNew }, async () => {
    // Uses a service that serves markdown at /help; skipped when none is reachable.
    const helpUrl = process.env.HELP_SERVICE_URL || 'http://localhost:9010';
    const probe = await fetch(helpUrl + '/help').catch(() => null);
    if (!probe || !probe.ok) return;
    const id = 'md-contract-help-' + uniq('h').split(' ')[1];
    const consumer = new FakeConsumer({ id, name: 'Help test', adapter: 'elg', category: 'preparation', local_url: helpUrl, tasks: {} });
    await consumer.register();
    try {
        await ensureOtherUser();
        assert.equal((await post(`/api/services/${id}/help/ingest`, {}, { user: OTHER })).status, 403);
        const res = await post(`/api/services/${id}/help/ingest`, {}, { service: true });
        assert.equal(res.status, 200);
        assert.equal(res.body.status, 'ok');
        assert.equal(res.body.source, helpUrl + '/help');
        assert.equal(res.body.output, `/help/services/${id}/index.html`);
        const page = await call('GET', `/api/services/${id}/help`, { user: null });
        assert.equal(page.status, 200);
        assert.match(page.text, /<html/);
    } finally {
        await consumer.unregister();
        const dir = path.resolve(process.env.HELP_DIR || 'public/help/services', id);
        fs.rmSync(dir, { recursive: true, force: true });
    }
});

test('set creation on a foreign project is refused', async () => {
    const project = await createProject();
    await ensureOtherUser();
    const res = await post(`/api/projects/${stripHash(project['@rid'])}/sets`, { label: 'x' }, { user: OTHER });
    assert.ok(res.status >= 400);
});
