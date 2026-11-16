import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { canSeeDemo, DemosService, publicDemo } from '../../src/modules/demos/demos.ts';
import { writeBundleZip } from '../../src/modules/demos/exporter.ts';

test('canSeeDemo follows service groups and users; empty lists mean everyone', () => {
    const everyone = { service_groups: [], users: [] };
    const groups = { service_groups: ['OSC'], users: ['a@x.fi'] };
    assert.equal(canSeeDemo(everyone, { id: 'u@x.fi', access: 'user', service_groups: [] }), true);
    assert.equal(canSeeDemo(groups, { id: 'u@x.fi', access: 'user', service_groups: ['OTHER'] }), false);
    assert.equal(canSeeDemo(groups, { id: 'u@x.fi', access: 'user', service_groups: ['OSC'] }), true);
    assert.equal(canSeeDemo(groups, { id: 'a@x.fi', access: 'user' }), true);
    assert.equal(canSeeDemo(groups, { id: 'z@x.fi', access: 'admin' }), true);
});

test('upload, update, visibility and removal of a demo', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'demos-'));
    try {
        const bundle = {
            manifest: { format: 1, title: { en: 'From zip' }, description: { en: 'd' }, created: '', source: 's', project: 'p', files: 0 },
            graph: { nodes: [{ id: 'p', type: 'Project', props: { label: 'x' } }], edges: [], documents: [] },
            projectDir: dataDir, files: [],
            cover: { extension: 'png', data: Buffer.from('png') },
        };
        const zip = path.join(dataDir, 'in.zip');
        await writeBundleZip(bundle, zip);
        const demos = new DemosService({ dataDir, access: {} as any, covers: {} as any, exporter: {} as any, importer: {} as any });
        const meta = await demos.createFromUpload(createReadStream(zip), { service_groups: ['OSC'] });
        assert.equal(meta.title.en, 'From zip');
        assert.equal(meta.cover, 'cover.png');
        assert.equal(meta.version, 1);
        assert.equal(publicDemo(meta).has_cover, true);
        assert.equal('service_groups' in publicDemo(meta), false);

        assert.equal((await demos.listFor({ rid: '#1:1', id: 'u', access: 'user', service_groups: [] })).length, 0);
        assert.equal((await demos.listFor({ rid: '#1:1', id: 'u', access: 'user', service_groups: ['OSC'] })).length, 1);
        await assert.rejects(() => demos.importFor(meta.id, { rid: '#1:1', id: 'u', access: 'user', service_groups: [] }), /not found/i);

        const updated = await demos.update(meta.id, { title: { en: 'New', fi: 'Uusi' }, service_groups: [] });
        assert.equal(updated.title.fi, 'Uusi');
        assert.deepEqual(updated.service_groups, []);
        await assert.rejects(() => demos.update(meta.id, { title: { 'bad lang': 'x' } }), /language/i);
        await assert.rejects(() => demos.get('../etc'), /not found/i);

        await demos.remove(meta.id);
        assert.equal((await demos.list()).length, 0);
    } finally {
        await fsp.rm(dataDir, { recursive: true, force: true });
    }
});
