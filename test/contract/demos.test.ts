import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
    get, post, put, del, call, OTHER, onlyNew, ensureOtherUser, uniq, stripHash,
    createProject, createSet, upload, waitFor, PNG_1x1, FakeConsumer, sampleDescriptor,
} from './helpers.ts';

const GROUP = 'demo-contract';

async function nodesOf(projectRid: string, user?: string): Promise<any[]> {
    const res = await get(`/api/projects/${stripHash(projectRid)}`, user ? { user } : {});
    assert.equal(res.status, 200, res.text);
    return res.body.nodes || [];
}

test('a desk is exported as a demo, shared by service group and imported as a copy', { skip: onlyNew }, async () => {
    const otherRid = await ensureOtherUser();
    await put(`/api/users/${stripHash(otherRid)}/service-groups`, { service_groups: [] });

    // A desk with a loose file, a set with a file and a tag on the set's file.
    const desk = await createProject(uniq('Demo source'));
    const set = await createSet(desk['@rid'], 'Pictures');
    const inSet = await upload(desk['@rid'], [{ name: 'in-set.png', type: 'image/png', content: PNG_1x1 }], set['@rid']);
    assert.equal(inSet.status, 200, inSet.text);
    const loose = await upload(desk['@rid'], [{ name: 'loose.png', type: 'image/png', content: PNG_1x1 }]);
    assert.equal(loose.status, 200, loose.text);
    const tagLabel = uniq('demotag');
    const tag = await post('/api/tags', { label: tagLabel, project_rid: desk['@rid'] });
    assert.equal(tag.status, 200, tag.text);
    const entity = (await get('/api/tags')).body.result.find((t: any) => t.label === tagLabel);
    assert.ok(entity);
    const setFiles = await get(`/api/sets/${stripHash(set['@rid'])}/files`);
    const setFile = setFiles.body.files[0];
    const linked = await post(`/api/entities/${stripHash(entity.rid)}/vertex/${stripHash(setFile['@rid'])}`, {});
    assert.equal(linked.status, 200, linked.text);

    // Only admins export.
    const denied = await post('/api/admin/demos', { project: desk['@rid'], title: { en: 'x' } }, { user: OTHER });
    assert.equal(denied.status, 403);
    assert.equal((await post('/api/admin/demos', { project: desk['@rid'] })).status, 400);

    const title = uniq('Learn');
    const created = await post('/api/admin/demos', { project: desk['@rid'], title: { en: title, fi: 'Opi' }, description: { en: 'About' }, service_groups: [GROUP] });
    assert.equal(created.status, 200, created.text);
    const demo = created.body;
    assert.equal(demo.version, 1);
    assert.ok(demo.files >= 2);
    // A new demo takes the cover of the desk (its first image; no thumbnail exists without a thumbnailer).
    assert.ok(demo.cover === null || /^cover\./.test(demo.cover));

    // Not shared with the other user yet.
    assert.equal((await get('/api/demos', { user: OTHER })).body.find((d: any) => d.id === demo.id), undefined);
    assert.equal((await post(`/api/demos/${demo.id}/import`, {}, { user: OTHER })).status, 404);
    assert.ok((await get('/api/demos')).body.find((d: any) => d.id === demo.id), 'admins see every demo');

    await put(`/api/users/${stripHash(otherRid)}/service-groups`, { service_groups: [GROUP] });
    const visible = (await get('/api/demos', { user: OTHER })).body.find((d: any) => d.id === demo.id);
    assert.ok(visible);
    assert.equal(visible.title.fi, 'Opi');
    assert.equal(visible.service_groups, undefined);

    // Import: a new desk with a copy of everything, owned by the importing user.
    const imported = await post(`/api/demos/${demo.id}/import`, {}, { user: OTHER });
    assert.equal(imported.status, 200, imported.text);
    const copy = imported.body.project;
    assert.notEqual(copy['@rid'], desk['@rid']);
    assert.equal(copy.label, desk.label);
    assert.equal(copy.demo_source, `${demo.id}@1`);

    const original = await nodesOf(desk['@rid']);
    const copied = await nodesOf(copy['@rid'], OTHER);
    assert.equal(copied.length, original.length);
    assert.equal(original.length, 2);
    const sourceRids = new Set(original.map((n: any) => n.data.id));
    assert.ok(copied.every((n: any) => !sourceRids.has(n.data.id)), 'every node has a new RID');

    const copiedSet = copied.find((n: any) => n.data._type === 'Set');
    assert.ok(copiedSet);
    const copiedSetRid = copiedSet.data.id;
    const files = await get(`/api/sets/${stripHash(copiedSetRid)}/files`, { user: OTHER });
    assert.equal(files.status, 200, files.text);
    assert.equal(files.body.files.length, 1);
    const content = await call('GET', `/api/files/${stripHash(files.body.files[0]['@rid'])}`, { user: OTHER, raw: false });
    assert.equal(content.status, 200);
    assert.notEqual(files.body.files[0]['@rid'], setFile['@rid']);
    assert.notEqual(files.body.files[0].uuid, setFile.uuid);

    // The tag came along and is linked to the copied file.
    const tags = await get('/api/tags', { user: OTHER });
    const copiedTag = tags.body.result.find((t: any) => t.label === tagLabel);
    assert.ok(copiedTag);
    const entities = await get(`/api/entities/sets/${stripHash(copiedSetRid)}`, { user: OTHER });
    assert.equal(entities.status, 200, entities.text);
    assert.ok(JSON.stringify(entities.body).includes(tagLabel));

    // The importing user does not see the source desk; a second import gets a free name.
    const foreign = await get(`/api/projects/${stripHash(desk['@rid'])}`, { user: OTHER });
    assert.ok(foreign.status >= 400 || !foreign.body.nodes?.length);
    const second = await post(`/api/demos/${demo.id}/import`, {}, { user: OTHER });
    assert.equal(second.body.project.label, `${desk.label} (2)`);

    // A new version affects later imports only.
    await upload(desk['@rid'], [{ name: 'third.png', type: 'image/png', content: PNG_1x1 }]);
    const again = await post(`/api/admin/demos/${demo.id}/export`, { project: desk['@rid'] });
    assert.equal(again.status, 200, again.text);
    assert.equal(again.body.version, 2);
    assert.equal((await nodesOf(copy['@rid'], OTHER)).length, original.length);
    const third = await post(`/api/demos/${demo.id}/import`, {}, { user: OTHER });
    assert.equal(third.body.project.demo_source, `${demo.id}@2`);
    assert.equal((await nodesOf(third.body.project['@rid'], OTHER)).length, original.length + 1);

    // Download, upload as a second demo, delete.
    const bundle = await call('GET', `/api/admin/demos/${demo.id}/bundle`, { raw: true });
    assert.equal(bundle.status, 200);
    assert.equal((await del(`/api/admin/demos/${demo.id}`)).status, 200);
    assert.equal((await get('/api/demos', { user: OTHER })).body.find((d: any) => d.id === demo.id), undefined);
});

test('a processed desk keeps its lineage when the service is gone', { skip: onlyNew }, async () => {
    const consumer = new FakeConsumer(sampleDescriptor('md-demo-' + uniq('t').split(' ')[1]));
    await consumer.register();
    let demoId = '';
    try {
        const desk = await createProject(uniq('Demo processed'));
        const file = (await upload(desk['@rid'], [{ name: 'in.txt', type: 'text/plain', content: 'make me loud' }])).body;
        const res = await post(`/api/queue/${consumer.topic}/files/${stripHash(file['@rid'])}`, { id: 'upper', params: {} });
        assert.equal(res.status, 200);
        const job = await consumer.claimWait();
        const sent = await consumer.sendFile(job.payload, 'MAKE ME LOUD', { label: 'in.txt.upper.txt', type: 'text', extension: 'txt' });
        assert.equal(sent.status, 200);
        await consumer.complete(job.id);
        const source = await waitFor(async () => {
            const nodes = await nodesOf(desk['@rid']);
            return nodes.length >= 3 ? nodes : null;
        }, 10000);
        assert.equal(source.length, 3);

        const created = await post('/api/admin/demos', { project: desk['@rid'], title: { en: uniq('Processed') } });
        assert.equal(created.status, 200, created.text);
        demoId = created.body.id;
    } finally {
        await consumer.unregister();
    }

    const imported = await post(`/api/demos/${demoId}/import`, {});
    assert.equal(imported.status, 200, imported.text);
    const copy = imported.body.project['@rid'];
    const graph = await get(`/api/projects/${stripHash(copy)}`);
    const nodes = graph.body.nodes;
    const process = nodes.find((n: any) => n.data._type === 'Process' || n.data.type === 'Process');
    const input = nodes.find((n: any) => n.data.name === 'in.txt');
    const output = nodes.find((n: any) => n.data.name === 'in.txt.upper.txt');
    assert.ok(process && input && output, 'input, process and output are all in the copy');
    assert.ok(graph.body.edges.find((e: any) => e.data.source === input.data.id && e.data.target === process.data.id));
    assert.ok(graph.body.edges.find((e: any) => e.data.source === process.data.id && e.data.target === output.data.id));
    const outRid = stripHash(output.data.id);
    assert.equal((await get(`/api/files/${outRid}`)).text, 'MAKE ME LOUD');
    const ancestors = await get(`/api/files/${outRid}/ancestors`);
    assert.deepEqual(ancestors.body.map((a: any) => a['@rid']), [input.data.id]);
    await del(`/api/admin/demos/${demoId}`);
});
