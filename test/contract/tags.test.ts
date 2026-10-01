import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    get, post, put, del, call, OTHER, onlyNew, ensureOtherUser, uniq, stripHash,
    createProject, createSet, upload, PNG_1x1, FakeConsumer, sampleDescriptor, SseListener,
} from './helpers.ts';

test('entity types, entities and tags', async () => {
    const types = await get('/api/entities/types');
    assert.equal(types.status, 200);
    assert.deepEqual(types.body.map((t: any) => t.type).sort(), ['Date', 'Location', 'Organisation', 'Person', 'Quality', 'Tag', 'Theme']);
    const tagType = types.body.find((t: any) => t.type === 'Tag');
    assert.equal(tagType.label, 'Tag');
    assert.equal(tagType.color, 'blue');

    const label = uniq('person');
    const created = await post('/api/entities', { type: 'Person', label });
    assert.equal(created.status, 200);
    assert.equal(created.body.result[0].label, label);
    assert.equal(created.body.result[0].created_by, 'user');

    const tagLabel = uniq('tag');
    const tag = await post('/api/tags', { label: tagLabel, description: 'a tag' });
    assert.equal(tag.status, 200);
    const tags = await get('/api/tags');
    assert.equal(tags.status, 200);
    const row = tags.body.result.find((t: any) => t.label === tagLabel);
    assert.ok(row);
    assert.match(row.rid, /^#\d+:\d+$/);
    assert.equal(row.description, 'a tag');
    assert.equal(row.type, 'Tag');

    const grouped = await get('/api/entities');
    assert.equal(grouped.status, 200);
    const person = grouped.body.find((g: any) => g.type === 'Person');
    assert.ok(person.labels.includes(label));
    assert.ok(person.items.some((i: any) => i.label === label && i['@rid']));
    assert.equal(typeof person.count, 'number');
});

test('link and unlink an entity to a file', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    const up = await upload(project['@rid'], [{ name: 'tagged.txt', type: 'text/plain', content: 't' }], set['@rid']);
    const file = up.body; // a single file keeps the old response shape: the node itself
    const label = uniq('link');
    const created = await post('/api/entities', { type: 'Tag', label });
    const eRid = created.body.result[0]['@rid'];

    const linked = await post(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(file['@rid'])}`);
    assert.equal(linked.status, 200);
    const doc = await get(`/api/documents/${stripHash(file['@rid'])}`);
    assert.deepEqual(doc.body.entities.map((e: any) => e.label), [label]);
    assert.equal(doc.body.entities[0].rid, eRid);

    const setEntities = await get(`/api/entities/sets/${stripHash(set['@rid'])}`);
    assert.deepEqual(setEntities.body, [{ rid: eRid, label, type: 'Tag', icon: 'tag', color: 'blue', count: 1 }]);

    const items = await get(`/api/entities/items?entities=${stripHash(eRid)}&project_rid=${encodeURIComponent(project['@rid'])}`);
    assert.equal(items.status, 200);
    assert.equal(items.body.length, 1);
    assert.equal(items.body[0].rid, file['@rid']);
    assert.match(items.body[0].thumb, /api\/thumbnails\//);

    const scoped = await get(`/api/entities?project_rid=${encodeURIComponent(project['@rid'])}`);
    assert.deepEqual(scoped.body.map((g: any) => g.type), ['Tag']);

    const setFiles = await get(`/api/sets/${stripHash(set['@rid'])}/files`);
    assert.deepEqual(setFiles.body.files[0].entities.map((e: any) => e.label), [label]);

    const unlinked = await del(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(file['@rid'])}`);
    assert.equal(unlinked.status, 200);
    const doc2 = await get(`/api/documents/${stripHash(file['@rid'])}`);
    assert.deepEqual(doc2.body.entities, []);

    await ensureOtherUser();
    const foreign = await post(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(file['@rid'])}`, undefined, { user: OTHER });
    // Old backend: 500 from the shortestPath lookup. New: same as "entity not found", an empty 204.
    if (process.env.TARGET === 'old') assert.ok([204, 500].includes(foreign.status));
    else assert.equal(foreign.status, 204);
});

test('tag filter set (mdf-set-filter)', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    const up = await upload(project['@rid'], [
        { name: 'one.txt', type: 'text/plain', content: '1' },
        { name: 'two.txt', type: 'text/plain', content: '2' },
    ], set['@rid']);
    const [one] = up.body.uploaded;
    const created = await post('/api/entities', { type: 'Tag', label: uniq('filter') });
    const eRid = created.body.result[0]['@rid'];
    await post(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(one['@rid'])}`);

    const res = await post(`/api/filters/mdf-set-filter/files/${stripHash(set['@rid'])}`, { selection_mode: 'include', selected_entity_rids: [eRid], match: 'or' });
    assert.equal(res.status, 200);
    assert.equal(res.body.matched_files, 1);
    assert.equal(res.body.selection_mode, 'include');
    assert.equal(res.body.process['@type'], 'SetProcess');
    assert.equal(res.body.output_set['@type'], 'Set');
    const files = await get(`/api/sets/${stripHash(res.body.output_set['@rid'])}/files`);
    assert.equal(files.body.file_count, 1);
    assert.equal(files.body.files[0].label, 'one.txt');
    assert.equal(files.body.files[0].ref, one['@rid']);

    const untagged = await post(`/api/filters/mdf-set-filter/files/${stripHash(set['@rid'])}`, { selection_mode: 'untagged' });
    assert.equal(untagged.body.matched_files, 1);
    const none = await post(`/api/filters/mdf-set-filter/files/${stripHash(set['@rid'])}`, { selection_mode: 'include', selected_entity_rids: [] });
    assert.ok(none.status >= 400);
});

test('machine tags and NER label browsing from a ner.json output', async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-ner-' + uniq('n').split(' ')[1], {
        tasks: { extract: { name: 'Extract', behaviour: 'one-to-one', params_help: { autotag: { display: 'checkbox' } }, params: {} } },
    }));
    await consumer.register();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'ner.txt', type: 'text/plain', content: 'Alice met Bob in Turku.' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'extract', params: { autotag: true } });
        const job = await consumer.claimWait();
        assert.equal(job.payload.task.autotag, true);
        const ner = { rois: {
            r1: { id: 'r1', label: 'person', text: 'Alice', start: 0, end: 5, confidence: 0.9 },
            r2: { id: 'r2', label: 'person', text: 'Bob', start: 10, end: 13, confidence: 0.8 },
            r3: { id: 'r3', label: 'place', text: 'Turku', start: 17, end: 22, confidence: 0.7 },
        } };
        const sent = await consumer.sendFile(job.payload, JSON.stringify(ner), { label: 'ner.txt.ner.json', type: 'ner.json', extension: 'json' });
        assert.equal(sent.status, 200);
        await consumer.complete(job.id);

        const machine = await get('/api/tags/machine');
        const rows = machine.body.filter((r: any) => r.service_id === consumer.topic);
        assert.deepEqual(rows.map((r: any) => r.label).sort(), ['person', 'place']);
        assert.equal(rows[0].task, 'extract');
        assert.equal(rows[0].count, 1);

        const labels = await get(`/api/tags/ner/labels?project_rid=${encodeURIComponent(project['@rid'])}`);
        const mine = labels.body.filter((r: any) => r.service_id === consumer.topic);
        assert.deepEqual(mine.map((r: any) => [r.label, r.count]).sort(), [['person', 2], ['place', 1]]);

        const mentions = await get(`/api/tags/ner/labels/mentions?service_id=${consumer.topic}&task=extract&label=person&project_rid=${encodeURIComponent(project['@rid'])}`);
        assert.equal(mentions.status, 200);
        assert.equal(mentions.body.total, 2);
        assert.equal(mentions.body.page, 1);
        assert.equal(mentions.body.pageSize, 20);
        assert.deepEqual(mentions.body.mentions.map((m: any) => m.text), ['Alice', 'Bob']);
        assert.deepEqual(Object.keys(mentions.body.mentions[0].hits[0]).sort(), ['confidence', 'end', 'file_label', 'file_rid', 'ner_rid', 'region_id', 'start']);
        assert.equal(mentions.body.mentions[0].hits[0].file_rid, file['@rid']);

        const doc = await get(`/api/documents/${stripHash(file['@rid'])}`);
        assert.deepEqual(doc.body.entities.map((e: any) => e.label).sort(), ['person', 'place']);
    } finally {
        await consumer.unregister();
    }
});

test('ROIs: upsert, read, update, delete', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid'], 'Images');
    const up = await upload(project['@rid'], [{ name: 'r.png', type: 'image/png', content: PNG_1x1 }], set['@rid'], undefined, '?no-thumbnails=true');
    const image = up.body;
    const roiSet = await createSet(project['@rid'], 'Regions');
    const base = `/api/images/${stripHash(image['@rid'])}/sets/${stripHash(roiSet['@rid'])}/rois`;

    assert.ok((await get(base)).status >= 400, 'no regions yet');
    const rois = { rois: { a: { id: 'a', type: 'rect', left: 1, top: 2, width: 3, height: 4 } } };
    const created = await post(base, rois);
    assert.equal(created.status, 200);
    assert.equal(created.body.type, 'roi.json');
    assert.equal(created.body.set, roiSet['@rid']);
    const roiRid = created.body['@rid'];

    const read = await get(base);
    assert.equal(read.status, 200);
    assert.deepEqual(read.body, rois);

    const again = await post(base, { rois: { b: { id: 'b' } } });
    assert.equal(again.body['@rid'], roiRid, 'POST is an upsert');

    const updated = await put(`${base}/${stripHash(roiRid)}`, { rois: { c: { id: 'c' } } });
    assert.deepEqual(updated.body, { message: 'ROI updated successfully' });
    assert.deepEqual((await get(base)).body, { rois: { c: { id: 'c' } } });

    const removed = await del(`${base}/${stripHash(roiRid)}`);
    assert.deepEqual(removed.body, { message: 'ROI deleted successfully', deleted: true });
});

test('prompts: create, list, update', async () => {
    const name = uniq('Prompt');
    const created = await post('/api/prompts', { type: 'text', name, description: 'desc', content: 'Say hi', output_type: 'text' });
    assert.equal(created.status, 200);
    const list = await get('/api/prompts');
    const row = list.body.find((p: any) => p.name === name);
    assert.ok(row);
    assert.equal(row.content, 'Say hi');
    assert.equal(row.output_type, 'text');
    assert.equal(row.json_schema, '');
    const me = await get('/api/me');
    assert.equal(row.owner, me.body.rid);
    const upd = await post('/api/prompts', { ...row, content: 'Say bye' });
    assert.equal(upd.status, 200);
    const after = (await get('/api/prompts')).body.find((p: any) => p.name === name);
    assert.equal(after.content, 'Say bye');
    const badSchema = await post('/api/prompts', { type: 'text', name: uniq('x'), description: 'd', content: 'c', json_schema: '[1,2]' });
    assert.equal(badSchema.status, 422);
});

test('service groups (admin)', async () => {
    const id = 'CT_' + uniq('g').split(' ')[1];
    const created = await post('/api/service-groups', { id, name: 'Contract', description: 'grp' });
    assert.equal(created.status, 200);
    assert.equal(created.body.id, id);
    const list = await get('/api/service-groups');
    assert.ok(list.body.find((g: any) => g.id === id && g.name === 'Contract' && g.rid));
    const dup = await post('/api/service-groups', { id });
    assert.equal(dup.status, 400);
    const upd = await put(`/api/service-groups/${id}`, { name: 'Renamed' });
    assert.equal(upd.body.name, 'Renamed');
    const noLogo = await get(`/api/service-groups/${id}/logo`);
    assert.equal(noLogo.status, 404);
    await ensureOtherUser();
    assert.equal((await get('/api/service-groups', { user: OTHER })).status, 403);
    const removed = await del(`/api/service-groups/${id}`);
    assert.deepEqual(removed.body, { success: true });
    const bad = await post('/api/service-groups', { id: 'no spaces' });
    assert.equal(bad.status, 400);
});

test('help pages', async () => {
    const index = await call('GET', '/api/help', { user: null });
    assert.equal(index.status, 200);
    assert.match(index.headers.get('content-type') || '', /text\/html/);
    const page = await call('GET', '/api/help/sets', { user: null });
    assert.equal(page.status, 200);
    const missing = await call('GET', '/api/help/nope-page', { user: null });
    assert.equal(missing.status, 404);
    const bad = await call('GET', '/api/help/..%2Fx', { user: null });
    assert.ok(bad.status >= 400);
    const css = await call('GET', '/api/help/styles/help.css', { user: null });
    assert.equal(css.status, 200);
});

test('search info and empty search', async () => {
    const info = await get('/api/search/info');
    assert.equal(info.status, 200);
    assert.equal(typeof info.body.total_docs, 'number');
    assert.ok(Array.isArray(info.body.project_counts));
    const empty = await post('/api/search', { query: '' });
    assert.equal(empty.status, 200);
    assert.deepEqual(empty.body, []);
    const res = await post('/api/search', { query: 'nothing-matches-this-zzz', rows: 5 });
    assert.equal(res.status, 200);
    assert.equal(res.body.response.numFound, 0);
});

test('ner/source/errors reads are owner-only', { skip: onlyNew }, async () => {
    const project = await createProject();
    const file = (await upload(project['@rid'], [{ name: 'o.txt', type: 'text/plain', content: 'o' }])).body;
    await ensureOtherUser();
    const rid = stripHash(file['@rid']);
    assert.equal((await get(`/api/files/${rid}/ner`, { user: OTHER })).status, 404);
    assert.equal((await get(`/api/errors/${rid}`, { user: OTHER })).status, 404);
    assert.equal((await get(`/api/files/${rid}/source`, { user: OTHER })).status, 404);
    const dir = file.path.split('/').slice(0, -1).join('/');
    assert.equal((await get(`/api/thumbnails/${dir}`, { user: OTHER })).status, 404);
    assert.equal((await get('/api/thumbnails/../../etc')).status, 404);
});

test('several SSE connections per user all receive events', { skip: onlyNew }, async () => {
    const a = await new SseListener().open();
    const b = await new SseListener().open();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 's.txt', type: 'text/plain', content: 's' }])).body;
        await a.waitFor((e) => e.command === 'add' && e.node?.['@rid'] === file['@rid']);
        await b.waitFor((e) => e.command === 'add' && e.node?.['@rid'] === file['@rid']);
    } finally {
        a.close();
        b.close();
    }
});
