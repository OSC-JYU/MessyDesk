import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    get, post, put, del, call, OTHER, onlyNew, onlyOld, ensureOtherUser, uniq, stripHash,
    createProject, createSet, upload, PNG_1x1, SseListener,
} from './helpers.ts';

test('POST /api/projects creates a project with an expiration date', async () => {
    const label = uniq('Desk');
    const project = await createProject(label);
    assert.match(project['@rid'], /^#\d+:\d+$/);
    assert.equal(project['@type'], 'Project');
    assert.equal(project.label, label);
    assert.equal(project.description, 'contract test');
    assert.match(project.expiration_date, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(project.uuid);
});

test('duplicate project label is rejected', async () => {
    const label = uniq('Dup');
    await createProject(label);
    const res = await post('/api/projects', { label });
    assert.ok(res.status >= 400);
    if (process.env.TARGET !== 'old') assert.equal(res.status, 409);
});

test('project without label is rejected', async () => {
    const res = await post('/api/projects', { description: 'x' });
    assert.ok(res.status >= 400);
    if (process.env.TARGET !== 'old') assert.equal(res.status, 400);
});

test('GET /api/projects lists own projects sorted by label with counts', async () => {
    const project = await createProject(uniq('AAA list'));
    const res = await get('/api/projects');
    assert.equal(res.status, 200);
    const row = res.body.find((p: any) => p['@rid'] === project['@rid']);
    assert.ok(row);
    assert.equal(row.label, project.label);
    assert.equal(row.node_count, 0);
    assert.equal(row.file_count, 0);
    const labels = res.body.map((p: any) => String(p.label || '').toUpperCase());
    assert.deepEqual(labels, [...labels].sort((a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)));

    await ensureOtherUser();
    const others = await get('/api/projects', { user: OTHER });
    assert.ok(!others.body.find((p: any) => p['@rid'] === project['@rid']));
});

test('PUT /api/projects/{rid} renames, other users cannot', async () => {
    const project = await createProject();
    const label = uniq('Renamed');
    const res = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'label', value: label });
    assert.equal(res.status, 200);
    const list = await get('/api/projects');
    assert.equal(list.body.find((p: any) => p['@rid'] === project['@rid']).label, label);

    await ensureOtherUser();
    const forbidden = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'label', value: 'x' }, { user: OTHER });
    assert.equal(forbidden.status, 400);
    const bad = await put(`/api/projects/${stripHash(project['@rid'])}`, { key: 'owner', value: 'x' });
    assert.equal(bad.status, 400);
});

test('storage summary and update-size', async () => {
    const summary = await get('/api/projects/storage-summary');
    assert.equal(summary.status, 200);
    assert.equal(typeof summary.body.used_mb, 'number');
    assert.equal(typeof summary.body.quota_gb, 'number');
    assert.equal(summary.body.quota_mb, summary.body.quota_gb * 1024);
    assert.equal(typeof summary.body.used_percent, 'number');

    const sizes = await post('/api/projects/update-size');
    assert.equal(sizes.status, 200);
    assert.equal(typeof sizes.body.updated, 'number');
    assert.ok(Array.isArray(sizes.body.projects));
    if (sizes.body.projects.length) {
        const p = sizes.body.projects[0];
        assert.ok(p.rid && typeof p.size === 'number' && typeof p.bytes === 'number');
    }
});

test('sets: create, upload into it, list files and graph shape', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid'], 'My set');
    assert.equal(set['@type'], 'Set');
    assert.equal(set.label, 'My set');
    assert.equal(set.project_rid, project['@rid']);
    assert.ok(set.path && set.filepath.endsWith('set.json'));

    const many = await upload(project['@rid'], [
        { name: 'a.txt', type: 'text/plain', content: 'alpha text' },
        { name: 'b.txt', type: 'text/plain', content: 'beta text' },
    ], set['@rid']);
    assert.equal(many.status, 200);
    assert.equal(many.body.total, 2);
    assert.equal(many.body.uploaded.length, 2);
    assert.deepEqual(many.body.failed, []);

    const files = await get(`/api/sets/${stripHash(set['@rid'])}/files?skip=0&limit=10`);
    assert.equal(files.status, 200);
    assert.equal(files.body.file_count, 2);
    assert.equal(files.body.limit, 10);
    assert.equal(files.body.skip, 0);
    assert.deepEqual(files.body.files.map((f: any) => f.label), ['a.txt', 'b.txt']);
    const f = files.body.files[0];
    assert.equal(f.type, 'text');
    assert.equal(f.set, set['@rid']);
    assert.ok(Array.isArray(f.entities));
    assert.match(f.thumb, /api\/thumbnails\//);

    const mixed = await upload(project['@rid'], [{ name: 'c.png', type: 'image/png', content: PNG_1x1 }], set['@rid']);
    assert.equal(mixed.status, 400);

    const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
    assert.equal(graph.status, 200);
    assert.ok(Array.isArray(graph.body.nodes) && Array.isArray(graph.body.edges));
    const setNode = graph.body.nodes.find((n: any) => n.data.id === set['@rid']);
    assert.ok(setNode);
    assert.equal(setNode.data.type, 'Set');
    assert.equal(setNode.data._type, 'Set');
    assert.equal(setNode.data.name, 'My set');
    assert.equal(setNode.data.count, 2);
    assert.deepEqual(setNode.data.types, ['text']);
    assert.equal(setNode.data.processed, false);
    assert.equal(setNode.data.text_samples.length, 2);
    assert.ok(Array.isArray(setNode.data.paths));
    assert.ok(!graph.body.nodes.find((n: any) => n.data.name === 'a.txt'), 'set members are not desk nodes');
});

test('upload a text file to the desk, read it back', async () => {
    const project = await createProject();
    const sse = await new SseListener().open();
    try {
        const res = await upload(project['@rid'], [{ name: 'note.txt', type: 'text/plain', content: 'Hello world from contract' }]);
        assert.equal(res.status, 200);
        const file = res.body;
        assert.equal(file['@type'], 'File');
        assert.equal(file.type, 'text');
        assert.equal(file.extension, 'txt');
        assert.equal(file.label, 'note.txt');
        assert.equal(file.original_filename, 'note.txt');
        assert.equal(file.project_rid, project['@rid']);
        assert.ok(file.path.endsWith('.txt'));
        assert.equal(typeof file.metadata.size, 'number');
        assert.equal(file.info, 'Hello world from contract...');
        assert.equal(file._type, 'text');

        const add = await sse.waitFor((e) => e.command === 'add' && e.node?.['@rid'] === file['@rid']);
        assert.equal(add.type, 'text');
        assert.equal(add.image, 'api/thumbnails');

        const content = await get(`/api/files/${stripHash(file['@rid'])}`);
        assert.equal(content.status, 200);
        assert.equal(content.text, 'Hello world from contract');
        assert.match(content.headers.get('content-type') || '', /text\/plain/);

        const doc = await get(`/api/documents/${stripHash(file['@rid'])}`);
        assert.equal(doc.status, 200);
        assert.equal(doc.body['@rid'], file['@rid']);
        assert.deepEqual(doc.body.entities, []);

        const graph = await get(`/api/projects/${stripHash(project['@rid'])}`);
        const node = graph.body.nodes.find((n: any) => n.data.id === file['@rid']);
        assert.ok(node);
        assert.equal(node.data.type, 'text');
        assert.equal(node.data._type, 'File');
        assert.equal(node.data.name, 'note.txt');
        assert.ok(node.data.image.startsWith('/api/thumbnails/'));
    } finally {
        sse.close();
    }
});

test('multi-file upload onto the desk is rejected', async () => {
    const project = await createProject();
    const res = await upload(project['@rid'], [
        { name: 'a.txt', type: 'text/plain', content: 'a' },
        { name: 'b.txt', type: 'text/plain', content: 'b' },
    ]);
    assert.equal(res.status, 400);
});

test('PDF upload needs the splitter (single upload reports it as 400)', async () => {
    const project = await createProject();
    const res = await upload(project['@rid'], [{ name: 'x.pdf', type: 'application/pdf', content: '%PDF-1.4' }]);
    assert.equal(res.status, 400);
    assert.match(res.body.message, /md-pypdf_fs/);
});

test('upload to an unknown or foreign project is 404', async () => {
    const project = await createProject();
    await ensureOtherUser();
    const res = await upload(project['@rid'], [{ name: 'a.txt', type: 'text/plain', content: 'a' }], undefined, OTHER);
    assert.equal(res.status, 404);
});

test('files: other users cannot read', async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'secret.txt', type: 'text/plain', content: 'secret' }])).body;
    await ensureOtherUser();
    const res = await get(`/api/files/${stripHash(file['@rid'])}`, { user: OTHER });
    assert.ok([403, 404].includes(res.status));
    const doc = await get(`/api/documents/${stripHash(file['@rid'])}`, { user: OTHER });
    assert.equal(doc.status, 404);
    const graph = await get(`/api/projects/${stripHash(project['@rid'])}`, { user: OTHER });
    assert.deepEqual(graph.body.nodes, []);
});

test('text version and revert', async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'edit.txt', type: 'text/plain', content: 'original' }])).body;
    const rid = stripHash(file['@rid']);
    const sse = await new SseListener().open();
    try {
        const v = await post(`/api/files/${rid}/version`, { content: 'edited text' });
        assert.equal(v.status, 200);
        assert.equal(v.body.edited.task, 'text-edit');
        assert.equal((await get(`/api/files/${rid}`)).text, 'edited text');
        const upd = await sse.waitFor((e) => e.command === 'update' && e.target === file['@rid'] && e.node?.edited);
        assert.equal(typeof upd.node.thumbnail_version, 'number');

        const r = await post(`/api/files/${rid}/revert`);
        assert.equal(r.status, 200);
        assert.equal(r.body.edited, undefined);
        assert.equal((await get(`/api/files/${rid}`)).text, 'original');
        const again = await post(`/api/files/${rid}/revert`);
        assert.equal(again.status, 409);
        const empty = await post(`/api/files/${rid}/version`, {});
        assert.equal(empty.status, 400);
    } finally {
        sse.close();
    }
});

test('graph vertex attribute update and delete', async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'v.txt', type: 'text/plain', content: 'v' }])).body;
    const rid = stripHash(file['@rid']);
    const sse = await new SseListener().open();
    try {
        const res = await post(`/api/graph/vertices/${rid}`, { key: 'description', value: 'described' });
        assert.equal(res.status, 200);
        assert.deepEqual(res.body, { nodes: [], edges: [] });
        await sse.waitFor((e) => e.command === 'update' && e.target === file['@rid'] && e.description === 'described');
    } finally {
        sse.close();
    }
    const doc = await get(`/api/documents/${rid}`);
    assert.equal(doc.body.description, 'described');
    const bad = await post(`/api/graph/vertices/${rid}`, { key: 'owner', value: 'x' });
    assert.ok(bad.status >= 400);

    await ensureOtherUser();
    const foreign = await call('DELETE', `/api/graph/vertices/${rid}`, { user: OTHER });
    assert.ok([403, 404].includes(foreign.status));

    const deleted = await del(`/api/graph/vertices/${rid}`);
    assert.equal(deleted.status, 200);
    assert.equal(deleted.body.deleted, 1);
    assert.equal((await get(`/api/documents/${rid}`)).status, 404);
    assert.equal((await del(`/api/graph/vertices/${rid}`)).status, 404);
});

test('traverse and ancestors', async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 't.txt', type: 'text/plain', content: 't' }])).body;
    const rid = stripHash(file['@rid']);
    const tr = await get(`/api/graph/traverse/${rid}/out`);
    assert.equal(tr.status, 200);
    assert.deepEqual(tr.body.map((n: any) => n['@type']), ['File']);
    const anc = await get(`/api/files/${rid}/ancestors`);
    assert.equal(anc.status, 200);
    assert.deepEqual(anc.body, []);
    await ensureOtherUser();
    const foreign = await get(`/api/files/${rid}/ancestors`, { user: OTHER });
    assert.equal(foreign.status, 403);
});

test('DELETE /api/projects/{rid} removes the project', async () => {
    const project = await createProject();
    await upload(project['@rid'], [{ name: 'd.txt', type: 'text/plain', content: 'd' }]);
    await ensureOtherUser();
    const foreign = await del(`/api/projects/${stripHash(project['@rid'])}`, { user: OTHER });
    assert.equal(foreign.status, 404);
    const res = await del(`/api/projects/${stripHash(project['@rid'])}`);
    assert.equal(res.status, 200);
    assert.equal(res.body, project['@rid']);
    const list = await get('/api/projects');
    assert.ok(!list.body.find((p: any) => p['@rid'] === project['@rid']));
});

test('set zip job: queued job and status', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    await upload(project['@rid'], [{ name: 'z.txt', type: 'text/plain', content: 'z' }], set['@rid']);
    const job = await post(`/api/sets/${stripHash(set['@rid'])}/files/zip/jobs`);
    assert.equal(job.status, 202);
    assert.equal(job.body.status, 'queued');
    assert.equal(job.body.status_url, `/api/sets/${stripHash(set['@rid'])}/files/zip/jobs/${job.body.job_id}`);
    assert.equal(job.body.download_url, `${job.body.status_url}/download`);
    const status = await get(job.body.status_url);
    assert.equal(status.status, 200);
    assert.equal(status.body.status, 'processing');
    const dl = await get(job.body.download_url);
    assert.equal(dl.status, 409);
    const missing = await get(`/api/sets/${stripHash(set['@rid'])}/files/zip/jobs/00000000-0000-0000-0000-000000000000`);
    assert.equal(missing.status, 404);

    const empty = await createSet(project['@rid'], 'empty');
    const none = await post(`/api/sets/${stripHash(empty['@rid'])}/files/zip/jobs`);
    assert.equal(none.status, 404);
});

test('set thumbnails re-queue', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    await upload(project['@rid'], [{ name: 'p.png', type: 'image/png', content: PNG_1x1 }], set['@rid'], undefined, '?no-thumbnails=true');
    const res = await post(`/api/sets/${stripHash(set['@rid'])}/thumbnails`);
    assert.equal(res.status, 202);
    assert.equal(res.body.set_rid, set['@rid']);
    assert.equal(res.body.total_files, 1);
    assert.equal(res.body.queued, 1);
    assert.deepEqual(res.body.queued_by_type, { image: 1, pdf: 0 });
});

test('image upload extracts dimensions', async () => {
    const project = await createProject();
    const res = await upload(project['@rid'], [{ name: 'dot.png', type: 'image/png', content: PNG_1x1 }], undefined, undefined, '?no-thumbnails=true');
    assert.equal(res.status, 200);
    assert.equal(res.body.type, 'image');
    assert.equal(res.body.metadata.width, 1);
    assert.equal(res.body.metadata.height, 1);
    const content = await get(`/api/files/${stripHash(res.body['@rid'])}`);
    assert.equal(content.status, 200);
    assert.match(content.headers.get('content-type') || '', /image\/png/);
    const thumb = await get(`/api/thumbnails/${res.body.path.split('/').slice(0, -1).join('/')}`);
    assert.equal(thumb.status, 404);
});

test('dropped routes', { skip: onlyNew }, async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'x.txt', type: 'text/plain', content: 'x' }])).body;
    for (const [m, p] of [
        ['GET', '/events/test'],
        ['PUT', `/api/files/${stripHash(file['@rid'])}`],
        ['GET', `/api/graph/vertices/${stripHash(file['@rid'])}`],
        ['GET', `/api/projects/${stripHash(project['@rid'])}/files`],
        ['GET', '/api/queue/sweeper/summary'],
        ['GET', '/api/nomad/status'],
    ] as const) {
        const res = await call(m, p);
        assert.equal(res.status, 404, `${m} ${p}`);
    }
});

test('old: PUT /api/files/{rid} is a no-op returning the node', { skip: onlyOld }, async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'x.txt', type: 'text/plain', content: 'x' }])).body;
    const res = await put(`/api/files/${stripHash(file['@rid'])}`, { label: 'y' });
    assert.equal(res.status, 200);
    assert.equal(res.body.label, 'x.txt');
});
