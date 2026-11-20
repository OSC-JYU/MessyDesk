import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { planRoiRun, roiMode, referencesLocally } from '../../src/modules/processing/roi-runs.ts';

// Region set #20:1 drawn on set #5:1 with images #2:1..#2:3. #2:1 has regions, #2:2 an emptied
// roi.json, #2:3 no roi.json at all.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-roi-runs-'));
const write = (name: string, data: unknown) => {
    const file = path.join(dir, name);
    fs.writeFileSync(file, JSON.stringify(data));
    return file;
};
const roiFiles = [
    { '@rid': '#30:1', path: write('a.roi.json', { rois: { r1: { type: 'rect' } } }) },
    { '@rid': '#30:2', path: write('b.roi.json', { rois: {} }) },
];
const images = ['#2:1', '#2:2', '#2:3'].map((rid, i) => ({ rid, type: 'image', extension: 'jpg', label: `p${i + 1}.jpg`, project_rid: '#1:0' }));
const imageOf: Record<string, string> = { '#30:1': '#2:1', '#30:2': '#2:2', '#20:1': '#5:1' };
const db: any = {
    edgesOf: async (_d: string, _e: string, rids: string[]) => rids.map((r) => ({ target: r, source: imageOf[r] })),
    rows: async (_sql: string, params: any) => (params.set === '#5:1' ? images : []),
    rowsByRids: async () => [],
};

test('the run param no_rois and the task opt-in are read', () => {
    assert.equal(roiMode({ params: { no_rois: 'all' } }), 'all');
    assert.equal(roiMode({ params: { no_rois: 'only' } }), 'only');
    assert.equal(roiMode({ params: {} }), null);
    assert.equal(referencesLocally({ tasks: { t: { no_rois_output: 'reference' } } }, { id: 't' }), true);
    assert.equal(referencesLocally({ tasks: { t: {} } }, { id: 't' }), false);
});

test('without no_rois every roi.json is a job, as before', async () => {
    const plan = await planRoiRun(db, '#20:1', roiFiles, null, true);
    assert.deepEqual(plan.jobs.map((f) => f['@rid']), ['#30:1', '#30:2']);
    assert.deepEqual(plan.references, []);
});

test('only: empty roi.json files are skipped', async () => {
    const plan = await planRoiRun(db, '#20:1', roiFiles, 'only', true);
    assert.deepEqual(plan.jobs.map((f) => f['@rid']), ['#30:1']);
    assert.deepEqual(plan.references, []);
});

test('all with the opt-in: images without regions become references in MessyDesk', async () => {
    const plan = await planRoiRun(db, '#20:1', roiFiles, 'all', true);
    assert.deepEqual(plan.jobs.map((f) => f['@rid']), ['#30:1']);
    assert.deepEqual(plan.references.map((i) => i.rid), ['#2:2', '#2:3']);
});

test('all without the opt-in: images without regions are sent as placeholder jobs', async () => {
    const plan = await planRoiRun(db, '#20:1', roiFiles, 'all', false);
    assert.deepEqual(plan.jobs, [roiFiles[0], { '@rid': '#2:2', roi_placeholder: true }, { '@rid': '#2:3', roi_placeholder: true }]);
    assert.deepEqual(plan.references, []);
});
