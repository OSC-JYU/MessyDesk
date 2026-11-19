import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { CodingService } from '../../src/modules/coding/coding.ts';

interface World { grants: any[]; sql: Array<[string, any]>; calls: any[] }

function setup(options: { locked?: boolean; texts?: string[] } = {}) {
    const w: World = { grants: [{ roi_set: '#9:1', user_rid: '#3:2', project_rid: '#1:0', owner_rid: '#3:1', locked: Boolean(options.locked) }], sql: [], calls: [] };
    const texts = options.texts ?? ['#5:1', '#5:2'];
    const db: any = {
        first: async (q: string, p: any) => q.includes('FROM CodingGrant')
            ? w.grants.find((g) => g.roi_set === p.set && g.user_rid === p.coder) || null
            : null,
        firstByRid: async () => ({ '@rid': '#9:1' }),
        rows: async (q: string, p: any) => {
            if (q.includes('expand(out')) return [{ rid: '#4:0', node_type: 'Set' }];
            if (q.includes('FROM File WHERE set')) return texts.map((rid) => ({ rid, label: rid }));
            if (q.includes('FROM CodingGrant WHERE roi_set')) return w.grants.filter((g) => g.roi_set === p.set);
            return [];
        },
        rowsByRids: async () => [{ rid: '#3:2', label: 'Coder Two' }],
        sql: async (q: string, p: any) => (w.sql.push([q, p]), {}),
    };
    const access: any = { findOwned: async (rid: string) => rid === '#9:1' ? { node: { '@type': 'Set', type: 'roi-set' }, projectRid: '#1:0' } : { node: { path: '/nonexistent' }, projectRid: '#1:0' } };
    const rois: any = {
        readText: async (...a: any[]) => (w.calls.push(['read', ...a]), {}),
        saveText: async (...a: any[]) => (w.calls.push(['save', ...a]), {}),
        tagRegion: async (...a: any[]) => (w.calls.push(['tag', ...a]), {}),
        untagRegion: async (...a: any[]) => (w.calls.push(['untag', ...a]), {}),
        coverage: async (...a: any[]) => (w.calls.push(['coverage', ...a]), { files: { '#5:1': { regions: 3, tagged: 1, untagged: 2 } } }),
    };
    const tags: any = { tags: async (...a: any[]) => (w.calls.push(['tags', ...a]), { result: [] }) };
    const users: any = { find: async (rid: string) => (rid === '#3:2' || rid === '#3:3' ? { rid } : null) };
    const filters: any = { apply: async (...a: any[]) => (w.calls.push(['apply', ...a]), { roi_set: `#9:${10 + w.calls.length}` }) };
    return { coding: new CodingService(db, access, rois, tags, users, filters), w };
}

test('a user without a grant gets 404 for everything, even for a set that exists', async () => {
    const { coding, w } = setup();
    for (const call of [
        () => coding.texts('9:1', '#3:9'),
        () => coding.readRegions('9:1', '5:1', '#3:9'),
        () => coding.saveRegions('9:1', '5:1', {}, '#3:9'),
        () => coding.tagRegion('9:1', '5:1', 'r', '7:1', '#3:9'),
        () => coding.deskTags('9:1', '#3:9'),
        () => coding.content('9:1', '5:1', '#3:9'),
        () => coding.coverage('9:1', '#3:9'),
    ]) await assert.rejects(call, /not found/i);
    assert.equal(w.calls.length, 0);
});

test('a coder works for the owner of the desk, and is recorded as the one who tagged', async () => {
    const { coding, w } = setup();
    await coding.saveRegions('9:1', '5:1', { rois: [] }, '#3:2');
    await coding.tagRegion('9:1', '5:2', 'r1', '7:1', '#3:2');
    await coding.readRegions('9:1', '5:1', '#3:2');
    await coding.deskTags('9:1', '#3:2');
    assert.deepEqual(w.calls[0], ['save', '#5:1', '#9:1', { rois: [] }, '#3:1']);
    assert.deepEqual(w.calls[1], ['tag', '#5:2', '#9:1', 'r1', '7:1', '#3:1', '#3:2']);
    assert.deepEqual(w.calls[2], ['read', '#5:1', '#9:1', '#3:1']);
    assert.deepEqual(w.calls[3], ['tags', '#3:1', '#1:0']);
});

test('a text outside the set is refused', async () => {
    const { coding, w } = setup();
    await assert.rejects(() => coding.readRegions('9:1', '5:99', '#3:2'), /Text not found/);
    await assert.rejects(() => coding.saveRegions('9:1', '5:99', {}, '#3:2'), /Text not found/);
    await assert.rejects(() => coding.content('9:1', '5:99', '#3:2'), /Text not found/);
    assert.equal(w.calls.length, 0);
});

test('a locked set can be read but not written', async () => {
    const { coding, w } = setup({ locked: true });
    await coding.readRegions('9:1', '5:1', '#3:2');
    await assert.rejects(() => coding.saveRegions('9:1', '5:1', {}, '#3:2'), /locked/);
    await assert.rejects(() => coding.tagRegion('9:1', '5:1', 'r', '7:1', '#3:2'), /locked/);
    await assert.rejects(() => coding.untagRegion('9:1', '5:1', 'r', '7:1', '#3:2'), /locked/);
    assert.deepEqual(w.calls.map((c) => c[0]), ['read']);
});

test('only the owner of a ROI set assigns coders, and not themselves or unknown users', async () => {
    const { coding, w } = setup();
    await coding.assign('9:1', '3:3', '#3:1');
    assert.ok(w.sql.some(([q, p]) => q.startsWith('INSERT INTO CodingGrant') && p.coder === '#3:3' && p.owner === '#3:1' && p.project === '#1:0'));
    await assert.rejects(() => coding.assign('9:1', '3:1', '#3:1'), /own this desk/);
    await assert.rejects(() => coding.assign('9:1', '3:77', '#3:1'), /User not found/);
    await assert.rejects(() => coding.assign('9:1', 'bad', '#3:1'), /Invalid user/);
    const notOwner = setup();
    (notOwner.coding as any).access.findOwned = async () => null;
    await assert.rejects(() => notOwner.coding.assign('9:1', '3:3', '#3:9'), /ROI set not found/);
    await assert.rejects(() => notOwner.coding.coders('9:1', '#3:9'), /ROI set not found/);
});

test('the owner sees the coders with names, and can lock and remove them', async () => {
    const { coding, w } = setup();
    assert.deepEqual(await coding.coders('9:1', '#3:1'), [{ user_rid: '#3:2', name: 'Coder Two', locked: false, progress: { texts: 2, with_passages: 1, passages: 3, untagged: 2 } }]);
    await coding.lock('9:1', '3:2', true, '#3:1');
    await coding.unassign('9:1', '3:2', '#3:1');
    assert.ok(w.sql.some(([q, p]) => q.startsWith('UPDATE CodingGrant') && p.locked === true));
    assert.ok(w.sql.some(([q]) => q.startsWith('DELETE FROM CodingGrant')));
});

test('one set per coder is made and assigned in one step, with the coder in its name', async () => {
    const { coding, w } = setup();
    (coding as any).names = async () => new Map([['#3:2', 'Ann'], ['#3:3', 'Bob']]);
    (coding as any).assign = async (...a: any[]) => (w.calls.push(['assign', ...a]), {});
    const made = await coding.createSetsForCoders('4:0', ['3:2', '3:3', '3:2'], '#3:1', 'Round 1');
    assert.equal(made.length, 2);
    const applies = w.calls.filter((c) => c[0] === 'apply');
    assert.deepEqual(applies.map((c) => c[4]), [{ set_label: 'Round 1: Ann' }, { set_label: 'Round 1: Bob' }]);
    assert.deepEqual(w.calls.filter((c) => c[0] === 'assign').map((c) => c[2]), ['#3:2', '#3:3']);
    await assert.rejects(() => coding.createSetsForCoders('4:0', [], '#3:1'), /at least one/);
    await assert.rejects(() => coding.createSetsForCoders('4:0', ['3:1'], '#3:1'), /own this desk|not found/);
});

test('the export has one object per passage, untagged ones with no tags, and a CSV form', async () => {
    const { coding } = setup();
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'exp-'));
    await fs.writeFile(path.join(dir, 't.txt'), 'Hei 😀 maailma');
    await fs.writeFile(path.join(dir, 'r.json'), JSON.stringify({ rois: { a: { id: 'a', start: 6, end: 13 }, b: { id: 'b', start: 0, end: 3 } } }));
    const c: any = coding;
    c.access.isProjectOwner = async () => true;
    c.rois.regionFiles = async () => [{ path: path.join(dir, 'r.json'), set: '#9:1', text_rid: '#5:1' }];
    c.db.rowsByRids = async (_f: string, _r: string[], where: string) => {
        if (where.includes('Set')) return [{ rid: '#9:1', label: 'Coding: Ann' }];
        if (where.includes('File')) return [{ rid: '#5:1', label: 'a, "b".txt', path: path.join(dir, 't.txt'), origin_label: 'scan.pdf', page_number: 2 }];
        if (where.includes('Entity')) return [{ rid: '#7:1', label: 'Anger' }];
        return [{ rid: '#3:2', label: 'Ann', id: 'a@x.fi' }];
    };
    const rows = c.db.rows;
    c.db.rows = async (q: string, p: any) => q.includes('FROM TagLink') ? [{ region_id: 'a', entity_rid: '#7:1', tagged_by: '#3:2', created_by: 'user' }] : rows(q, p);
    const out = await c.exportSegments('1:0', '#3:1');
    assert.equal(out.segments.length, 2);
    const a = out.segments.find((s: any) => s.region_id === 'a');
    assert.equal(a.text, 'maailma');
    assert.equal(a.document, 'scan.pdf');
    assert.equal(a.page, 2);
    assert.deepEqual(a.tags.map((t: any) => t.label), ['Anger']);
    assert.deepEqual(a.coders, ['Ann']);
    assert.deepEqual(out.segments.find((s: any) => s.region_id === 'b').tags, []);
    const csv = CodingService.toCsv(out);
    assert.match(csv.split('\n')[0], /^file,file_label,/);
    assert.ok(csv.includes('"a, ""b"".txt"'));
    await fs.rm(dir, { recursive: true, force: true });
});

test('the export is for the owner of the desk only', async () => {
    const { coding } = setup();
    (coding as any).access.isProjectOwner = async () => false;
    await assert.rejects(() => coding.exportSegments('1:0', '#3:9'), /Desk not found/);
});
