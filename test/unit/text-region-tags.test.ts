import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TAG_PALETTE, colorFromLabel, isHexColor, nextTagColor } from '../../src/modules/tags/tag-colors.ts';
import { TagsService } from '../../src/modules/tags/tags.ts';
import { RoisService } from '../../src/modules/rois/rois.ts';

test('a new tag gets the palette colour used least, in palette order', () => {
    assert.equal(nextTagColor([]), TAG_PALETTE[0]);
    assert.equal(nextTagColor([TAG_PALETTE[0]]), TAG_PALETTE[1]);
    assert.equal(nextTagColor([...TAG_PALETTE]), TAG_PALETTE[0]);
    assert.equal(nextTagColor([...TAG_PALETTE, TAG_PALETTE[0].toUpperCase()]), TAG_PALETTE[1]);
    assert.equal(nextTagColor(['blue', null, undefined]), TAG_PALETTE[0]);
});

test('colours are checked and a missing colour comes from the label', () => {
    assert.equal(isHexColor('#a1B2c3'), true);
    assert.equal(isHexColor('blue'), false);
    assert.equal(isHexColor('#abc'), false);
    assert.equal(colorFromLabel('joy'), colorFromLabel('joy'));
    assert.ok((TAG_PALETTE as readonly string[]).includes(colorFromLabel('anything')));
});

test('a region link keeps its ROI set, so two sets on one text stay apart', async () => {
    const sql: any[] = [];
    const db: any = {
        first: async () => null,
        sql: async (query: string, params: any) => (sql.push([query, params]), { result: [] }),
    };
    const tags: any = new TagsService(db, {} as any);
    await tags.createTagLink('#7:1', '#5:1', '#3:0', { region_id: 'r1', roi_set: '#9:1' });
    const insert = sql.find(([q]) => q.startsWith('INSERT INTO TagLink'));
    assert.match(insert[0], /roi_set = :roi_set/);
    assert.equal(insert[1].roi_set, '#9:1');
    assert.equal(insert[1].region_id, 'r1');
    // A file-level link has no ROI set even if one is passed.
    sql.length = 0;
    await tags.createTagLink('#7:1', '#5:1', '#3:0', { roi_set: '#9:1' });
    assert.equal(sql.find(([q]) => q.startsWith('INSERT INTO TagLink'))[1].roi_set, null);
});

test('removing region links is limited to one text, one ROI set and the given regions', async () => {
    const sql: any[] = [];
    const db: any = { sql: async (query: string, params: any) => (sql.push([query, params]), {}) };
    const tags: any = new TagsService(db, {} as any);
    await tags.removeRegionLinks('#5:1', '#9:1', ['a', 'b']);
    await tags.removeRegionLinks('#5:1', '#9:1', []);
    await tags.removeRegionLinks('#5:1', '#9:1');
    assert.equal(sql.length, 2);
    assert.match(sql[0][0], /region_id IN :regions/);
    assert.deepEqual(sql[0][1], { t: '#5:1', s: '#9:1', regions: ['a', 'b'] });
    assert.match(sql[1][0], /region_id IS NOT NULL/);
});

test('tagging a region needs an existing region, and untagged regions stay', async () => {
    const linked: any[] = [];
    const tags: any = { link: async (...a: any[]) => (linked.push(a), { rid: '#1:1' }), reindexFileTags: async () => null };
    const rois: any = new RoisService({} as any, {} as any, {} as any, {} as any, tags);
    rois.textOf = async () => ({ owned: {}, text: 'abc' });
    rois.storedRegionIds = async () => ['r1'];
    await assert.rejects(() => rois.tagRegion('5:1', '9:1', 'nope', '7:1', '#3:0'), /Region not found/);
    const result = await rois.tagRegion('5:1', '9:1', 'r1', '7:1', '#3:0');
    assert.deepEqual(result, { region: 'r1', tag: '#7:1' });
    assert.deepEqual(linked[0], ['#7:1', '#5:1', '#3:0', { region_id: 'r1', roi_set: '#9:1' }]);
    tags.link = async () => undefined;
    await assert.rejects(() => rois.tagRegion('5:1', '9:1', 'r1', '7:1', '#3:0'), /Tag not found/);
});

test('saving a text keeps the links of regions that stay and drops the others', async () => {
    const dropped: any[] = [];
    const tags: any = { removeRegionLinks: async (...a: any[]) => dropped.push(a), reindexFileTags: async () => null };
    const rois: any = new RoisService({} as any, {} as any, {} as any, {} as any, tags);
    rois.textOf = async () => ({ owned: {}, text: 'Hello world' });
    rois.storedRegionIds = async () => ['a', 'b', 'c'];
    rois.save = async () => ({ '@rid': '#8:1' });
    await rois.saveText('5:1', '9:1', { rois: [{ id: 'a', start: 0, end: 2 }, { id: 'c', start: 3, end: 5 }] }, '#3:0');
    assert.deepEqual(dropped, [['#5:1', '#9:1', ['b']]]);
});

test('the search fields of a file carry the tags of its passages, each tag once', async () => {
    let sent: any = null;
    const db: any = {
        rows: async (q: string) => q.includes('region_id IS NOT NULL')
            ? [{ entity_rid: '#7:1' }, { entity_rid: '#7:2' }]
            : [],
        rowsByRids: async () => [{ rid: '#7:1', label: 'Anger' }, { rid: '#7:2', label: 'Hope' }],
    };
    const tags: any = new TagsService(db, {} as any);
    tags.setTagSync(async (_f: string, _u: string, fields: any) => (sent = fields));
    await tags.reindexFileTags('#5:1', '#3:0');
    assert.deepEqual(sent.passage_tag_rid, ['#7:1', '#7:2']);
    assert.deepEqual(sent.passage_tag_label, ['Anger', 'Hope']);
    assert.deepEqual(sent.tag_label, []);
});
