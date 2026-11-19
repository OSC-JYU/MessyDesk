import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoisService } from '../../src/modules/rois/rois.ts';
import { TagsService } from '../../src/modules/tags/tags.ts';

test('a passage is listed once with its text, its surroundings and all its tags', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pas-'));
    const textPath = path.join(dir, 'a.txt');
    await fs.writeFile(textPath, 'Hei 😀 maailma, kuinka voit tänään?');
    const roiPath = path.join(dir, 'a.roi.json');
    await fs.writeFile(roiPath, JSON.stringify({ rois: { r1: { id: 'r1', type: 'text', start: 6, end: 13 } } }));
    const queries: string[] = [];
    const db: any = {
        first: async (query: string) => {
            queries.push(query);
            if (query.includes('count(*)')) return { total: 1 };
            return { roi: { path: roiPath } };
        },
        rows: async (query: string) => (queries.push(query), [{ target_rid: '#5:1', roi_set: '#9:1', region_id: 'r1' }]),
        rowsByRids: async () => [{ rid: '#5:1', label: 'a.txt', path: textPath }],
    };
    const tags: any = { regionTags: async () => ({ r1: [{ rid: '#7:1', label: 'Anger' }, { rid: '#7:2', label: 'Hope' }] }) };
    const rois = new RoisService(db, {} as any, {} as any, {} as any, tags);
    const result = await rois.passages('7:1,7:2', '#3:0', { limit: '5' });
    assert.equal(result.total, 1);
    assert.equal(result.items.length, 1);
    const [item] = result.items;
    assert.equal(item.text, 'maailma');
    assert.equal(item.before, 'Hei 😀 ');
    assert.equal(item.after.startsWith(', kuinka'), true);
    assert.deepEqual(item.tags.map((t: any) => t.label), ['Anger', 'Hope']);
    assert.equal(item.file_label, 'a.txt');
    assert.ok(queries.some((q) => q.includes('region_id IS NOT NULL')));
    await fs.rm(dir, { recursive: true, force: true });
});

test('no tags, no passages', async () => {
    const rois = new RoisService({} as any, {} as any, {} as any, {} as any, {} as any);
    assert.deepEqual(await rois.passages('', '#3:0'), { total: 0, skip: 0, limit: 20, items: [] });
});

test('passages that lost their region or text are left out', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'pas-'));
    const roiPath = path.join(dir, 'a.roi.json');
    await fs.writeFile(roiPath, JSON.stringify({ rois: {} }));
    const db: any = {
        first: async (query: string) => (query.includes('count(*)') ? { total: 1 } : { roi: { path: roiPath } }),
        rows: async () => [{ target_rid: '#5:1', roi_set: '#9:1', region_id: 'gone' }],
        rowsByRids: async () => [{ rid: '#5:1', label: 'a.txt', path: path.join(dir, 'a.txt') }],
    };
    const tags: any = { regionTags: async () => ({}) };
    const rois = new RoisService(db, {} as any, {} as any, {} as any, tags);
    assert.deepEqual((await rois.passages('7:1', '#3:0')).items, []);
    await fs.rm(dir, { recursive: true, force: true });
});

test('passage counts count each coded region once, however many tags it has', async () => {
    const db: any = {
        rows: async () => [
            { target_rid: '#5:1', roi_set: '#9:1', region_id: 'a' },
            { target_rid: '#5:1', roi_set: '#9:1', region_id: 'b' },
            { target_rid: '#5:2', roi_set: '#9:1', region_id: 'a' },
        ],
    };
    const tags: any = new TagsService(db, {} as any);
    const counts = await tags.passageCounts(['#5:1', '#5:2', '#5:3']);
    assert.deepEqual([...counts], [['#5:1', 2], ['#5:2', 1]]);
    assert.equal((await tags.passageCounts([])).size, 0);
});
