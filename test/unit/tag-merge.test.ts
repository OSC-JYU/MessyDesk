import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagsService } from '../../src/modules/tags/tags.ts';

const entities: Record<string, any> = {
    '#7:1': { rid: '#7:1', label: 'Anger', type: 'Tag', created_by: 'user' },
    '#7:2': { rid: '#7:2', label: 'Wrath', type: 'Tag', created_by: 'user' },
    '#7:3': { rid: '#7:3', label: 'Rage', type: 'Tag', created_by: 'user' },
    '#7:4': { rid: '#7:4', label: 'Paris', type: 'Location', created_by: 'user' },
    '#7:5': { rid: '#7:5', label: 'Auto', type: 'Tag', created_by: 'machine' },
};

const link = (rid: string, target: string, region: string | null = null, set: string | null = null) => ({
    rid, target_rid: target, region_id: region, roi_set: set, tagged_by: '#3:0', created_by: 'user', service_id: null, task: null, model: null,
});

function setup() {
    const sql: Array<[string, any]> = [];
    const links: Record<string, any[]> = {
        '#7:1': [link('#20:1', '#5:1'), link('#20:2', '#5:2', 'r1', '#9:1')],
        '#7:2': [link('#21:1', '#5:1'), link('#21:2', '#5:3'), link('#21:3', '#5:2', 'r1', '#9:1'), link('#21:4', '#5:2', 'r2', '#9:1')],
        '#7:3': [link('#22:1', '#5:3'), link('#22:2', '#5:4')],
    };
    const db: any = {
        legacy: false,
        firstByRid: async (_f: string, rid: string) => entities[rid] ? { ...entities[rid], '@rid': rid } : null,
        first: async () => null,
        rows: async (query: string, params: any) => {
            if (query.includes('FROM TagLink WHERE entity_rid')) return links[params.e] || [];
            if (query.includes('FROM DeskTag WHERE entity_rid IN')) return [{ entity_rid: '#7:2', project_rid: '#1:0' }, { entity_rid: '#7:3', project_rid: '#1:1' }].filter((r) => params.entities.includes(r.entity_rid));
            return [];
        },
        rowsByRids: async () => [{ rid: '#1:0', label: 'Desk A' }, { rid: '#1:1', label: 'Desk B' }],
        sql: async (query: string, params: any) => (sql.push([query, params]), {}),
    };
    const tags: any = new TagsService(db, {} as any);
    tags.attachToDesk = async (...a: any[]) => (sql.push(['attach', a]), true);
    const reindexed: string[][] = [];
    tags.reindexFiles = async (files: string[]) => (reindexed.push(files), { files: files.length, background: false });
    return { tags, sql, reindexed };
}

test('merging moves the links, does not double a link the tag has, and removes the sources', async () => {
    const { tags, sql, reindexed } = setup();
    const result = await tags.merge('7:1', { source_rids: ['7:2', '7:3'] }, '#3:0');
    assert.equal(result.dry_run, false);
    // Already on Anger: file #5:1 and region r1 of #5:2. #5:3 is on Wrath and Rage: kept once.
    assert.equal(result.duplicates, 3);
    assert.equal(result.links, 3);
    assert.deepEqual(sql.filter(([q]) => q.startsWith('DELETE FROM #2')).map(([q]) => q), ['DELETE FROM #21:1', 'DELETE FROM #21:3', 'DELETE FROM #22:1']);
    const moves = sql.filter(([q]) => q.startsWith('UPDATE TagLink'));
    assert.deepEqual(moves.map(([, p]) => p), [{ t: '#7:1', s: '#7:2' }, { t: '#7:1', s: '#7:3' }]);
    assert.ok(sql.some(([q]) => q === "DELETE FROM #7:2 WHERE @type = 'Entity'"));
    assert.ok(sql.some(([q]) => q === "DELETE FROM #7:3 WHERE @type = 'Entity'"));
    // The target joins the desks of the sources.
    assert.deepEqual(sql.filter(([q]) => q === 'attach').map(([, a]) => a[1]).sort(), ['#1:0', '#1:1']);
    // Every file that had a link (whole-file or passage) is reindexed.
    assert.deepEqual(reindexed[0].sort(), ['#5:1', '#5:2', '#5:3', '#5:4']);
});

test('a link that two merged tags share is kept once', async () => {
    const { tags, sql } = setup();
    await tags.merge('7:1', { source_rids: ['7:2', '7:3'] }, '#3:0');
    // #5:3 is on both Wrath and Rage: Wrath's link moves, Rage's is the duplicate.
    assert.ok(sql.some(([q]) => q === 'DELETE FROM #22:1'));
});

test('a dry run changes nothing and reports the effect', async () => {
    const { tags, sql } = setup();
    const result = await tags.merge('7:1', { source_rids: ['7:2'], dry_run: true }, '#3:0');
    assert.equal(result.dry_run, true);
    assert.deepEqual(result.desks.map((d: any) => d.label), ['Desk A']);
    assert.equal(sql.length, 0);
});

test('only human tags of one type can be merged, and something must be chosen', async () => {
    const { tags } = setup();
    await assert.rejects(() => tags.merge('7:1', { source_rids: ['7:4'] }, '#3:0'), /only tags of one type/);
    await assert.rejects(() => tags.merge('7:1', { source_rids: ['7:5'] }, '#3:0'), /Machine tags/);
    await assert.rejects(() => tags.merge('7:1', { source_rids: ['7:1'] }, '#3:0'), /at least one other/);
    await assert.rejects(() => tags.merge('7:1', {}, '#3:0'), /at least one other/);
});
