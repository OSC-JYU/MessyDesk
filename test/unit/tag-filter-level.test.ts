import { test } from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { FiltersService, SET_FILTER } from '../../src/modules/filters/filters.ts';

async function run(params: any) {
    const queries: string[] = [];
    const tmp = os.tmpdir();
    const db: any = {
        rowsByRids: async (_f: string, rids: string[]) => rids.map((r) => ({ rid: r, label: 'Anger' })),
        rows: async (query: string) => (queries.push(query), []),
        first: async (query: string) => (queries.push(query), { rid: '#9:9' }),
    };
    let n = 0;
    const store: any = {
        createVertex: async (_t: string, a: any) => ({ '@rid': `#${++n}:0`, uuid: `u${n}`, ...a }),
        setAttribute: async () => {},
        connect: async () => {},
        connectDerivedFrom: async () => {},
    };
    const layout: any = { processFilesDir: () => path.join(tmp, 'tfl-p'), setDir: () => path.join(tmp, 'tfl-s') };
    const access: any = { findOwned: async () => ({ node: { '@rid': '#4:0', '@type': 'Set' }, projectRid: '#1:0' }) };
    const nodes: any = { setFileRids: async () => ['#5:1'], updateFileCount: async () => {}, createReferenceFile: async () => ({}) };
    const service = new FiltersService(db, store, layout, access, nodes, {} as any);
    service.setFilters({ [SET_FILTER]: {} });
    const result = await service.apply(SET_FILTER, '#4:0', '#3:0', { selected_entity_rids: ['#7:1'], ...params });
    return { queries, result };
}

test('the tag filter counts whole-file tags by default, so coded passages do not make a file match', async () => {
    const { queries } = await run({});
    const links = queries.filter((q) => q.includes('FROM TagLink'));
    assert.ok(links.length > 0);
    assert.ok(links.every((q) => q.includes('region_id IS NULL')));
});

test('the tag filter can look at coded passages, or at both', async () => {
    const passage = await run({ tag_level: 'passage' });
    assert.ok(passage.queries.filter((q) => q.includes('FROM TagLink')).every((q) => q.includes('region_id IS NOT NULL')));
    assert.match(passage.result.process.info, /coded passages/);
    const any = await run({ tag_level: 'any' });
    assert.ok(any.queries.filter((q) => q.includes('FROM TagLink')).every((q) => !q.includes('region_id')));
    const file = await run({});
    assert.doesNotMatch(file.result.process.info, /passages/);
});

test('files with no tags at all is counted at the chosen level', async () => {
    const { queries } = await run({ selection_mode: 'untagged', tag_level: 'passage' });
    assert.ok(queries.some((q) => q.startsWith('SELECT DISTINCT target_rid FROM TagLink') && q.includes('region_id IS NOT NULL')));
});
