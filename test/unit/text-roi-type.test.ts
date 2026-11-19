import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoisService, TEXT_ROI_TYPE } from '../../src/modules/rois/rois.ts';

async function service(existing: any) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'roi-'));
    const created: any[] = [];
    const attrs: any[] = [];
    const store: any = {
        createVertex: async (_t: string, a: any) => (created.push(a), { '@rid': '#8:1', ...a }),
        connectDerivedFrom: async () => {},
        setAttributes: async () => {},
        setAttribute: async (...a: any[]) => attrs.push(a),
    };
    const access: any = { findOwned: async () => ({ node: { path: path.join(dir, 'a.txt'), label: 'a.txt' }, projectRid: '#1:0' }) };
    const tags: any = { setSystemTag: async () => {} };
    const db: any = { first: async () => (existing ? { roi: { ...existing, path: path.join(dir, 'x.roi.json') } } : null), rows: async () => [] };
    return { rois: new RoisService(db, store, access, {} as any, tags), created, attrs, dir };
}

test('text regions are stored with their own file type, so image-region services do not match them', async () => {
    const { rois, created, dir } = await service(null);
    await rois.save('5:1', '9:1', { rois: {} }, '#3:0', TEXT_ROI_TYPE);
    assert.equal(created[0].type, 'text-roi.json');
    await fs.rm(dir, { recursive: true, force: true });
});

test('image regions keep the roi.json type', async () => {
    const { rois, created, dir } = await service(null);
    await rois.save('5:1', '9:1', { rois: {} }, '#3:0');
    assert.equal(created[0].type, 'roi.json');
    await fs.rm(dir, { recursive: true, force: true });
});

test('text regions saved earlier as roi.json get the new type on the next save', async () => {
    const { rois, attrs, dir } = await service({ '@rid': '#8:7', type: 'roi.json' });
    await rois.save('5:1', '9:1', { rois: {} }, '#3:0', TEXT_ROI_TYPE);
    assert.deepEqual(attrs, [['#8:7', 'type', 'text-roi.json']]);
    await fs.rm(dir, { recursive: true, force: true });
});

test('coverage lists the texts with passages and how many of them are tagged', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cov-'));
    await fs.writeFile(path.join(dir, 'a.json'), JSON.stringify({ rois: { r1: { id: 'r1' }, r2: { id: 'r2' }, r3: { id: 'r3' } } }));
    await fs.writeFile(path.join(dir, 'b.json'), JSON.stringify({ rois: {} }));
    const db: any = {
        rows: async (query: string) => query.startsWith('MATCH')
            ? [{ path: path.join(dir, 'a.json'), text_rid: '#5:1' }, { path: path.join(dir, 'b.json'), text_rid: '#5:2' }, { path: path.join(dir, 'gone.json'), text_rid: '#5:3' }]
            : [{ target_rid: '#5:1', region_id: 'r1' }, { target_rid: '#5:1', region_id: 'r1' }, { target_rid: '#5:1', region_id: 'old' }],
    };
    const access: any = { canRead: async () => true };
    const rois = new RoisService(db, {} as any, access, {} as any, {} as any);
    const result = await rois.coverage('9:1', '#3:0');
    assert.deepEqual(result, { roi_set: '#9:1', files: { '#5:1': { regions: 3, tagged: 1, untagged: 2 } } });
    access.canRead = async () => false;
    await assert.rejects(() => rois.coverage('9:1', '#3:0'), /not found/);
    await fs.rm(dir, { recursive: true, force: true });
});
