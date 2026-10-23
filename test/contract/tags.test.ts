import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    get, post, put, del, call, OTHER, onlyNew, ensureOtherUser, uniq, stripHash,
    createProject, createSet, upload, PNG_1x1, FakeConsumer, sampleDescriptor, SseListener, waitFor,
} from './helpers.ts';

test('entity types, entities and tags', { skip: onlyNew }, async () => {
    const types = await get('/api/entities/types');
    assert.equal(types.status, 200);
    assert.deepEqual(types.body.map((t: any) => t.type).sort(), ['Date', 'Location', 'Organisation', 'Person', 'Quality', 'Tag', 'Theme']);
    const tagType = types.body.find((t: any) => t.type === 'Tag');
    assert.equal(tagType.label, 'Tag');
    assert.equal(tagType.color, 'blue');

    const desk = await createProject();
    const label = uniq('person');
    const created = await post('/api/entities', { type: 'Person', label, project_rid: desk['@rid'] });
    assert.equal(created.body.result[0].creator_rid.length > 0, true);
    assert.equal(created.status, 200);
    assert.equal(created.body.result[0].label, label);
    assert.equal(created.body.result[0].created_by, 'user');

    const tagLabel = uniq('tag');
    const tag = await post('/api/tags', { label: tagLabel, description: 'a tag', project_rid: desk['@rid'] });
    assert.equal(tag.status, 200);
    const tags = await get('/api/tags');
    assert.equal(tags.status, 200);
    const row = tags.body.result.find((t: any) => t.label === tagLabel);
    assert.ok(row);
    assert.match(row.rid, /^#\d+:\d+$/);
    assert.equal(row.description, 'a tag');
    assert.equal(row.type, 'Tag');

    // Types with counts; the tags of a type come one page at a time (plan/decisions.md G3).
    const grouped = await get('/api/entities');
    assert.equal(grouped.status, 200);
    const person = grouped.body.find((g: any) => g.type === 'Person');
    assert.equal(typeof person.count, 'number');
    assert.ok(person.count >= 1);
    assert.equal(person.labels, undefined, 'tags are no longer listed in the groups');
    const byType = await get(`/api/entities/by-type/Person?search=${encodeURIComponent(label)}`);
    assert.equal(byType.status, 200);
    assert.equal(byType.body.type, 'Person');
    assert.equal(byType.body.total, 1);
    assert.equal(byType.body.items[0].label, label);
    assert.match(byType.body.items[0]['@rid'], /^#\d+:\d+$/);
    const userMade = await get('/api/entities?created_by=user');
    assert.ok(userMade.body.find((g: any) => g.type === 'Person'));
    const machineMade = await get(`/api/entities/by-type/Person?created_by=machine&search=${encodeURIComponent(label)}`);
    assert.equal(machineMade.body.total, 0);
});

test('link and unlink an entity to a file', { skip: onlyNew }, async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    const up = await upload(project['@rid'], [{ name: 'tagged.txt', type: 'text/plain', content: 't' }], set['@rid']);
    const file = up.body; // a single file keeps the old response shape: the node itself
    const label = uniq('link');
    const created = await post('/api/entities', { type: 'Tag', label, project_rid: project['@rid'] });
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
    assert.equal(items.body.total, 1);
    assert.equal(items.body.items.length, 1);
    assert.equal(items.body.items[0].rid, file['@rid']);
    assert.match(items.body.items[0].thumb, /api\/thumbnails\//);

    // The desk filter reads the desk stored on the link (plan/decisions.md G4).
    const deskTypes = await get(`/api/entities?project_rid=${encodeURIComponent(project['@rid'])}`);
    assert.deepEqual(deskTypes.body.map((g: any) => [g.type, g.count]), [['Tag', 1]]);
    const deskTags = await get(`/api/entities/by-type/Tag?project_rid=${encodeURIComponent(project['@rid'])}`);
    assert.deepEqual(deskTags.body.items.map((i: any) => i.label), [label]);

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
    const created = await post('/api/entities', { type: 'Tag', label: uniq('filter'), project_rid: project['@rid'] });
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

    // A set whose files have no tags at all (e.g. what a model made) cannot be filtered by tags.
    const bare = await createSet(project['@rid']);
    await upload(project['@rid'], [{ name: 'bare.txt', type: 'text/plain', content: '3' }], bare['@rid']);
    const refused = await post(`/api/filters/mdf-set-filter/files/${stripHash(bare['@rid'])}`, { selection_mode: 'include', selected_entity_rids: [eRid], match: 'or' });
    assert.equal(refused.status, 400);
    assert.match(refused.body.message, /no tags/);
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

test('machine tags are listed per desk and per model', { skip: onlyNew }, async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-tagger-' + uniq('t').split(' ')[1], {
        models: {
            small: { name: 'Small', supported_types: ['text'], supported_formats: ['txt'] },
            large: { name: 'Large', supported_types: ['text'], supported_formats: ['txt'] },
        },
        tasks: { classify: { name: 'Classify', behaviour: 'one-to-one', autotag: true, params: {} } },
    }));
    await consumer.register();
    try {
        const label = uniq('topic');
        const deskA = await createProject();
        const deskB = await createProject();
        const file = (await upload(deskA['@rid'], [{ name: 'a.txt', type: 'text/plain', content: 'About cats.' }])).body;
        for (const model of ['small', 'large']) {
            await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'classify', model, params: {} });
            const job = await consumer.claimWait();
            assert.equal(job.payload.task.model.id, model);
            const answer = { task: 'classify', result: { category: [label] } };
            const sent = await consumer.sendFile(job.payload, JSON.stringify(answer), { label: 'a.txt.json', type: 'json', extension: 'json' });
            assert.equal(sent.status, 200);
            await consumer.complete(job.id);
        }

        const onA = (await get(`/api/tags/machine?project_rids=${encodeURIComponent(deskA['@rid'])}`)).body
            .filter((r: any) => r.service_id === consumer.topic);
        // The same tag from two models shows under both.
        assert.deepEqual(onA.map((r: any) => [r.model, r.task, r.label, r.count]).sort(), [['large', 'classify', label, 1], ['small', 'classify', label, 1]]);
        assert.equal(onA[0].service_name, consumer.topic);
        const onB = (await get(`/api/tags/machine?project_rids=${encodeURIComponent(deskB['@rid'])}`)).body
            .filter((r: any) => r.service_id === consumer.topic);
        assert.deepEqual(onB, []);

        // The file lists the tag once.
        const doc = await get(`/api/documents/${stripHash(file['@rid'])}`);
        assert.deepEqual(doc.body.entities.map((e: any) => e.label), [label]);
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

test('human tags belong to desks: create, share by import, rename, remove, delete', async () => {
    const a = await createProject();
    const b = await createProject();
    const label = uniq('invoice');
    const created = await post('/api/entities', { type: 'Tag', label, project_rid: a['@rid'] });
    assert.equal(created.status, 200);
    const eRid = created.body.result[0]['@rid'];
    // Creating the same tag in the same desk again returns it.
    const again = await post('/api/tags', { label, project_rid: a['@rid'] });
    assert.equal(again.body.result[0]['@rid'], eRid);
    assert.equal((await post('/api/tags', { label })).status, 400);

    // A new desk has no human tags; the tag is not usable there.
    const tagsOf = async (desk: any) => (await get(`/api/tags?project_rid=${encodeURIComponent(desk['@rid'])}`)).body.result.map((t: any) => t.label);
    assert.deepEqual(await tagsOf(a), [label]);
    assert.deepEqual(await tagsOf(b), []);
    const setB = await createSet(b['@rid']);
    const fileB = (await upload(b['@rid'], [{ name: 'b.txt', type: 'text/plain', content: 'b' }], setB['@rid'])).body;
    assert.equal((await post(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(fileB['@rid'])}`)).status, 204);

    // Import shares the tag (same id).
    const imported = await post(`/api/projects/${stripHash(b['@rid'])}/tags/import`, { from_project_rid: a['@rid'] });
    assert.equal(imported.status, 200);
    assert.deepEqual([imported.body.imported, imported.body.skipped], [1, 0]);
    assert.deepEqual(await tagsOf(b), [label]);
    assert.equal((await post(`/api/projects/${stripHash(b['@rid'])}/tags/import`, { entity_rids: [eRid] })).body.skipped, 1);
    assert.equal((await post(`/api/entities/${stripHash(eRid)}/vertex/${stripHash(fileB['@rid'])}`)).status, 200);

    // The global view shows where the tag belongs; the admin list shows who made it.
    const byType = await get(`/api/entities/by-type/Tag?search=${encodeURIComponent(label)}`);
    assert.deepEqual(byType.body.items[0].desks.map((d: any) => d.rid).sort(), [a['@rid'], b['@rid']].sort());
    const admin = await get(`/api/tags/admin?project_rid=${encodeURIComponent(b['@rid'])}`);
    assert.equal(admin.status, 200);
    assert.equal(admin.body.items[0].rid, eRid);
    assert.equal(admin.body.items[0].files, 1);
    assert.equal(admin.body.items[0].desks.length, 2);
    assert.ok(admin.body.items[0].creator.name);

    const usage = await get(`/api/entities/${stripHash(eRid)}/usage`);
    assert.equal(usage.body.files, 1);
    assert.deepEqual(usage.body.desks.map((d: any) => d.files).sort(), [0, 1]);

    // Rename applies in every desk; a clash in a desk is a conflict.
    const renamed = uniq('bill');
    assert.equal((await call('PATCH', `/api/entities/${stripHash(eRid)}`, { body: { label: renamed } })).status, 200);
    assert.deepEqual(await tagsOf(a), [renamed]);
    assert.deepEqual(await tagsOf(b), [renamed]);
    const doc = await get(`/api/documents/${stripHash(fileB['@rid'])}`);
    assert.deepEqual(doc.body.entities.map((e: any) => e.label), [renamed]);
    assert.equal(doc.body.entities[0].tagged_by.length, 1);
    const other = await post('/api/entities', { type: 'Tag', label: uniq('other'), project_rid: a['@rid'] });
    const clash = await call('PATCH', `/api/entities/${stripHash(other.body.result[0]['@rid'])}`, { body: { label: renamed } });
    assert.equal(clash.status, 409);

    // Remove from desk B: its links go, desk A keeps the tag.
    const removed = await del(`/api/projects/${stripHash(b['@rid'])}/tags/${stripHash(eRid)}`);
    assert.equal(removed.status, 200);
    assert.equal(removed.body.deleted, false);
    assert.deepEqual(await tagsOf(b), []);
    assert.deepEqual((await get(`/api/documents/${stripHash(fileB['@rid'])}`)).body.entities, []);
    assert.ok((await tagsOf(a)).includes(renamed));

    // Removing it from the last desk deletes it; delete everywhere removes it from all desks.
    const last = await del(`/api/projects/${stripHash(a['@rid'])}/tags/${stripHash(eRid)}`);
    assert.equal(last.body.deleted, true);
    const gone = await post('/api/entities', { type: 'Tag', label: uniq('gone'), project_rid: a['@rid'] });
    const goneRid = gone.body.result[0]['@rid'];
    await post(`/api/projects/${stripHash(b['@rid'])}/tags/import`, { entity_rids: [goneRid] });
    assert.equal((await del(`/api/entities/${stripHash(goneRid)}`)).status, 200);
    assert.deepEqual(await tagsOf(a), [other.body.result[0].label]);
    assert.deepEqual(await tagsOf(b), []);
    assert.equal((await get(`/api/entities/${stripHash(goneRid)}/usage`)).status, 404);

    // Another user cannot touch the tag or the desk.
    await ensureOtherUser();
    assert.equal((await post(`/api/projects/${stripHash(a['@rid'])}/tags`, { label: 'x' }, { user: OTHER })).status, 404);
    assert.equal((await call('PATCH', `/api/entities/${stripHash(other.body.result[0]['@rid'])}`, { body: { label: 'y' }, user: OTHER })).status, 404);
});

test('machine tags cannot be renamed or deleted in the tag admin', async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-admin-' + uniq('n').split(' ')[1], {
        tasks: { extract: { name: 'Extract', behaviour: 'one-to-one', params_help: { autotag: { display: 'checkbox' } }, params: {} } },
    }));
    await consumer.register();
    try {
        const project = await createProject();
        const file = (await upload(project['@rid'], [{ name: 'm.txt', type: 'text/plain', content: 'x' }])).body;
        await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'extract', params: { autotag: true } });
        const job = await consumer.claimWait();
        await consumer.sendFile(job.payload, JSON.stringify({ rois: { r1: { id: 'r1', label: 'machine-label', text: 'x', start: 0, end: 1, confidence: 0.5 } } }), { label: 'm.ner.json', type: 'ner.json', extension: 'json' });
        await consumer.complete(job.id);
        const machine = (await get(`/api/tags/machine?project_rid=${encodeURIComponent(project['@rid'])}`)).body.find((r: any) => r.service_id === consumer.topic);
        assert.equal((await call('PATCH', `/api/entities/${stripHash(machine.entity_rid)}`, { body: { label: 'nope' } })).status, 400);
        assert.equal((await del(`/api/entities/${stripHash(machine.entity_rid)}`)).status, 400);
    } finally {
        await consumer.unregister();
    }
});

test('Tag Filter by ROI labels from ner.json runs (search index)', async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-roi-' + uniq('n').split(' ')[1], {
        tasks: { extract: { name: 'Extract', behaviour: 'one-to-one', params_help: { autotag: { display: 'checkbox' } }, params: {} } },
    }));
    await consumer.register();
    try {
        const project = await createProject();
        const set = await createSet(project['@rid']);
        const up = await upload(project['@rid'], [
            { name: 'one.txt', type: 'text/plain', content: 'Alice in Turku' },
            { name: 'two.txt', type: 'text/plain', content: 'Nothing here' },
        ], set['@rid']);
        const [one] = up.body.uploaded;
        // No autotag: the labels are ROI data only, never tags.
        await post(`/api/queue/${consumer.topic}/files/${stripHash(one['@rid'])}`, { id: 'extract', params: { autotag: false } });
        const job = await consumer.claimWait();
        const ner = { rois: {
            r1: { id: 'r1', label: 'person', text: 'Alice', start: 0, end: 5, confidence: 0.9 },
            r2: { id: 'r2', label: 'place', text: 'Turku', start: 9, end: 14, confidence: 0.7 },
        } };
        assert.equal((await consumer.sendFile(job.payload, JSON.stringify(ner), { label: 'one.ner.json', type: 'ner.json', extension: 'json' })).status, 200);
        await consumer.complete(job.id);
        assert.deepEqual((await get('/api/tags/machine')).body.filter((r: any) => r.service_id === consumer.topic), []);

        const scope = `project_rid=${encodeURIComponent(project['@rid'])}`;
        const labels = await waitFor(async () => {
            const res = await get(`/api/tags/roi/labels?${scope}`);
            const mine = res.body.items?.filter((r: any) => r.service_id === consumer.topic) || [];
            return mine.length === 2 ? mine : null;
        }, 15000);
        assert.deepEqual(labels.map((r: any) => [r.label, r.count, r.task]), [['person', 1, 'extract'], ['place', 1, 'extract']]);
        assert.equal((await get(`/api/tags/roi/labels?${scope}&search=PERS`)).body.items.length, 1);

        const criterion = (label: string) => ({ service_id: consumer.topic, task: 'extract', model: '', label });
        const run = (body: any) => post(`/api/filters/mdf-set-filter/files/${stripHash(set['@rid'])}`, body);
        const included = await run({ selection_mode: 'include', selected_roi_labels: [criterion('person')] });
        assert.equal(included.status, 200);
        assert.equal(included.body.matched_files, 1);
        const files = await get(`/api/sets/${stripHash(included.body.output_set['@rid'])}/files`);
        assert.equal(files.body.files[0].label, 'one.txt');
        assert.equal((await run({ selection_mode: 'include', match: 'and', selected_roi_labels: [criterion('person'), criterion('place')] })).body.matched_files, 1);
        assert.equal((await run({ selection_mode: 'include', match: 'and', selected_roi_labels: [criterion('person'), criterion('missing')] })).body.matched_files, 0);
        assert.equal((await run({ selection_mode: 'exclude', selected_roi_labels: [criterion('person')] })).body.matched_files, 1);

        // ROI labels and tags in one filter.
        const tag = await post('/api/entities', { type: 'Tag', label: uniq('mixed'), project_rid: project['@rid'] });
        const two = up.body.uploaded[1];
        await post(`/api/entities/${stripHash(tag.body.result[0]['@rid'])}/vertex/${stripHash(two['@rid'])}`);
        const either = await run({ selection_mode: 'include', match: 'or', selected_entity_rids: [tag.body.result[0]['@rid']], selected_roi_labels: [criterion('person')] });
        assert.equal(either.body.matched_files, 2);
        const both = await run({ selection_mode: 'include', match: 'and', selected_entity_rids: [tag.body.result[0]['@rid']], selected_roi_labels: [criterion('person')] });
        assert.equal(both.body.matched_files, 0);

        // Another user sees none of it; deleting the file removes its labels.
        await ensureOtherUser();
        assert.deepEqual((await get(`/api/tags/roi/labels?${scope}`, { user: OTHER })).body.items, []);
        assert.equal((await del(`/api/graph/vertices/${stripHash(one['@rid'])}`)).status, 200);
        await waitFor(async () => (await get(`/api/tags/roi/labels?${scope}`)).body.items.filter((r: any) => r.service_id === consumer.topic).length === 0 || null, 15000);
    } finally {
        await consumer.unregister();
    }
});

test('deleting a desk removes its tag vocabulary and tags no other desk has', async () => {
    const a = await createProject();
    const b = await createProject();
    const kept = await post('/api/entities', { type: 'Tag', label: uniq('shared'), project_rid: a['@rid'] });
    const lost = await post('/api/entities', { type: 'Tag', label: uniq('only-a'), project_rid: a['@rid'] });
    const keptRid = kept.body.result[0]['@rid'];
    await post(`/api/projects/${stripHash(b['@rid'])}/tags/import`, { entity_rids: [keptRid] });

    assert.equal((await del(`/api/graph/vertices/${stripHash(a['@rid'])}`)).status, 200);
    await waitFor(async () => (await get(`/api/entities/${stripHash(lost.body.result[0]['@rid'])}/usage`)).status === 404 || null, 20000);
    const usage = await get(`/api/entities/${stripHash(keptRid)}/usage`);
    assert.equal(usage.status, 200);
    assert.deepEqual(usage.body.desks.map((d: any) => d.rid), [b['@rid']]);
});

test('autotag reuses the desk\'s own human tag with the same label, other desks get a machine tag', async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-contract-reuse-' + uniq('n').split(' ')[1], {
        tasks: { extract: { name: 'Extract', behaviour: 'one-to-one', params_help: { autotag: { display: 'checkbox' } }, params: {} } },
    }));
    await consumer.register();
    try {
        const label = uniq('topic');
        const withTag = await createProject();
        const without = await createProject();
        const human = (await post('/api/tags', { label, project_rid: withTag['@rid'] })).body.result[0]['@rid'];
        const runOn = async (project: any) => {
            const file = (await upload(project['@rid'], [{ name: 'r.txt', type: 'text/plain', content: 'x' }])).body;
            await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'extract', params: { autotag: true } });
            const job = await consumer.claimWait();
            const ner = { rois: { r1: { id: 'r1', label, text: 'x', start: 0, end: 1, confidence: 0.5 } } };
            await consumer.sendFile(job.payload, JSON.stringify(ner), { label: 'r.ner.json', type: 'ner.json', extension: 'json' });
            await consumer.complete(job.id);
            const rows = (await get(`/api/tags/machine?project_rid=${encodeURIComponent(project['@rid'])}`)).body.filter((r: any) => r.service_id === consumer.topic);
            return rows[0].entity_rid;
        };
        assert.equal(await runOn(withTag), human);
        const other = await runOn(without);
        assert.notEqual(other, human);
        assert.deepEqual((await get(`/api/tags?project_rid=${encodeURIComponent(without['@rid'])}`)).body.result, []);
    } finally {
        await consumer.unregister();
    }
});

test('tagged files of several tags: any (default) or all of them', async () => {
    const project = await createProject();
    const set = await createSet(project['@rid']);
    const up = await upload(project['@rid'], [
        { name: 'one.txt', type: 'text/plain', content: '1' },
        { name: 'two.txt', type: 'text/plain', content: '2' },
        { name: 'three.txt', type: 'text/plain', content: '3' },
    ], set['@rid']);
    const [one, two, three] = up.body.uploaded;
    const tag = async (label: string) => (await post('/api/entities', { type: 'Tag', label: uniq(label), project_rid: project['@rid'] })).body.result[0]['@rid'];
    const [a, b, c] = [await tag('a'), await tag('b'), await tag('c')];
    const put_ = (e: string, f: any) => post(`/api/entities/${stripHash(e)}/vertex/${stripHash(f['@rid'])}`);
    for (const f of [one, two, three]) await put_(a, f);
    for (const f of [one, two]) await put_(b, f);
    await put_(c, one);

    const items = async (tags: string[], match?: string) => {
        const res = await get(`/api/entities/items?entities=${tags.map(stripHash).join(',')}&project_rid=${encodeURIComponent(project['@rid'])}${match ? `&match=${match}` : ''}`);
        assert.equal(res.status, 200);
        return res.body.items.map((i: any) => i.label).sort();
    };
    assert.deepEqual(await items([b, c]), ['one.txt', 'two.txt']);
    assert.deepEqual(await items([b, c], 'or'), ['one.txt', 'two.txt']);
    assert.deepEqual(await items([b, c], 'and'), ['one.txt']);
    assert.deepEqual(await items([a, b, c], 'and'), ['one.txt']);
    assert.deepEqual(await items([a, b], 'and'), ['one.txt', 'two.txt']);
    assert.deepEqual(await items([a], 'and'), ['one.txt', 'three.txt', 'two.txt']);
    const unused = await tag('unused');
    assert.deepEqual(await items([a, unused], 'and'), []);
    assert.deepEqual(await items([a, unused], 'or'), ['one.txt', 'three.txt', 'two.txt']);

    // Paged: the total is for all the files, the items for the page.
    const page = await get(`/api/entities/items?entities=${stripHash(a)}&project_rid=${encodeURIComponent(project['@rid'])}&skip=1&limit=1`);
    assert.equal(page.body.total, 3);
    assert.equal(page.body.skip, 1);
    assert.equal(page.body.items.length, 1);
});

test('tag types: add, a tag needs a type, delete only when empty, Tag is protected', async () => {
    const desk = await createProject();
    const name = uniq('Kind');
    const added = await post('/api/entities/types', { type: name, color: '#112233' });
    assert.equal(added.status, 200);
    assert.equal(added.body.type, name);
    assert.equal((await post('/api/entities/types', { type: name.toUpperCase() })).status, 409);
    assert.equal((await post('/api/entities/types', { type: ' ' })).status, 400);
    assert.equal((await post('/api/entities/types', { type: 'a/b' })).status, 400);

    const types = (await get('/api/entities/types?counts=1')).body;
    const mine = types.find((t: any) => t.type === name);
    assert.deepEqual([mine.count, mine.protected, mine.color], [0, false, '#112233']);
    assert.equal(types.find((t: any) => t.type === 'Tag').protected, true);
    assert.equal((await get('/api/entities/types')).body.find((t: any) => t.type === name).count, undefined);

    // A tag cannot be made without a type, or with an unknown one.
    assert.equal((await post('/api/entities', { label: uniq('x'), project_rid: desk['@rid'] })).status, 400);
    assert.equal((await post('/api/entities', { type: 'Nonexistent', label: uniq('x'), project_rid: desk['@rid'] })).status, 400);
    assert.equal((await post(`/api/projects/${stripHash(desk['@rid'])}/tags`, { label: uniq('x') })).status, 400);

    const tag = await post('/api/entities', { type: name, label: uniq('typed'), project_rid: desk['@rid'] });
    assert.equal(tag.status, 200);
    assert.equal(tag.body.result[0].color, '#112233');
    const blocked = await del(`/api/entities/types/${encodeURIComponent(name)}`);
    assert.equal(blocked.status, 409);
    assert.match(blocked.text, /1 tag/);
    assert.equal((await del(`/api/entities/${stripHash(tag.body.result[0]['@rid'])}`)).status, 200);
    assert.equal((await del(`/api/entities/types/${encodeURIComponent(name)}`)).status, 200);
    assert.equal((await del(`/api/entities/types/${encodeURIComponent(name)}`)).status, 404);
    assert.equal((await del('/api/entities/types/Tag')).status, 400);

    // Types belong to the user: another user does not see or touch them.
    await ensureOtherUser();
    const other = await post('/api/entities/types', { type: name }, { user: OTHER });
    assert.equal(other.status, 200);
    assert.equal((await del(`/api/entities/types/${encodeURIComponent(name)}`, { user: OTHER })).status, 200);
});
