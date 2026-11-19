import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { RoisService } from '../../src/modules/rois/rois.ts';

async function setup(existingRegions: any = null) {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'imp-'));
    const nerPath = path.join(dir, 'ner.json');
    await fs.writeFile(nerPath, JSON.stringify({ rois: {
        a: { id: 'a', type: 'text', start: 0, end: 3, text: 'Hei', label: 'greeting', confidence: 0.9 },
        b: { id: 'b', type: 'text', start: 4, end: 11, text: 'maailma', label: 'place', confidence: 0.5 },
        c: { id: 'c', type: 'text', start: 5, end: 999, label: 'place' },
        d: { id: 'd', type: 'text', start: 0, end: 3, label: 'greeting' },
    } }));
    const roiPath = path.join(dir, 'x.roi.json');
    if (existingRegions) await fs.writeFile(roiPath, JSON.stringify(existingRegions));
    const saved: any[] = [];
    const links: any[] = [];
    const made: string[] = [];
    const db: any = {
        first: async () => ({ ner: { path: nerPath, service_id: 'md-gliner2', task: 'extract_entities' } }),
        rows: async () => [],
    };
    const tags: any = {
        createInDesk: async (_p: string, d: any) => (made.push(d.label), { result: [{ '@rid': `#7:${made.length}` }] }),
        link: async (...a: any[]) => (links.push(a), {}),
        reindexFileTags: async () => null,
    };
    const rois: any = new RoisService(db, {} as any, {} as any, {} as any, tags);
    rois.textOf = async () => ({ owned: { projectRid: '#1:0' }, text: 'Hei 😀 maailma' });
    rois.roiOf = async () => (existingRegions ? { path: roiPath } : null);
    rois.save = async (...a: any[]) => (saved.push(a), {});
    return { rois, saved, links, made, dir };
}

test('spans become regions, labels become desk tags linked as machine tags with confidence', async () => {
    const { rois, saved, links, made, dir } = await setup();
    const result = await rois.importSpans('5:1', '9:1', { ner_rid: '#8:1' }, '#3:0');
    assert.deepEqual(result, { regions: 3, tags: 2, skipped: 1 });
    assert.deepEqual(Object.keys(saved[0][2].rois).sort(), ['a', 'b', 'd']);
    assert.equal(saved[0][2].rois.a.label, undefined);
    assert.deepEqual(made.sort(), ['greeting', 'place']);
    const a = links.find((l) => l[3].region_id === 'a');
    assert.deepEqual(a[3], { region_id: 'a', roi_set: '#9:1', created_by: 'machine', service_id: 'md-gliner2', task: 'extract_entities', confidence: 0.9, defer_reindex: true });
    await fs.rm(dir, { recursive: true, force: true });
});

test('existing regions stay, imported spans are not doubled, labels can be chosen', async () => {
    const { rois, saved, links, dir } = await setup({ rois: { a: { id: 'a', type: 'text', start: 0, end: 3 } } });
    const result = await rois.importSpans('5:1', '9:1', { ner_rid: '#8:1', labels: ['place'] }, '#3:0');
    assert.equal(result.regions, 1);
    assert.deepEqual(Object.keys(saved[0][2].rois).sort(), ['a', 'b']);
    assert.deepEqual(links.map((l: any) => l[3].region_id), ['b']);
    await fs.rm(dir, { recursive: true, force: true });
});

test('a NER run that is not on this text is refused', async () => {
    const { rois, dir } = await setup();
    await assert.rejects(() => rois.importSpans('5:1', '9:1', {}, '#3:0'), /ner_rid/);
    rois.db.first = async () => null;
    await assert.rejects(() => rois.importSpans('5:1', '9:1', { ner_rid: '#8:1' }, '#3:0'), /No such NER run/);
    await fs.rm(dir, { recursive: true, force: true });
});
