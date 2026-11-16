import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SetMerge } from '../../src/modules/sets/merge.ts';

function setup(files: any[], sets: Record<string, any> = {}) {
    const created: any[] = [];
    const edges: any[] = [];
    const refs: any[] = [];
    const db: any = {
        rows: async (sql: string) => (sql.includes('FROM File WHERE set IN') ? files.map((f) => ({ ...f })) : []),
        rowsByRids: async () => [],
    };
    const store: any = {
        createVertex: async (type: string, attrs: any) => (created.push([type, attrs]), { '@rid': `#9:${created.length}`, uuid: `u${created.length}`, ...attrs }),
        setAttribute: async () => {},
        connect: async () => {},
        connectDerivedFrom: async (...args: any[]) => edges.push(args),
    };
    const layout: any = { processFilesDir: () => '/tmp/md-merge-test/p', setDir: () => '/tmp/md-merge-test/s' };
    const access: any = {
        findOwned: async (rid: string) => (sets[rid] ? { node: sets[rid], projectRid: '#1:0' } : null),
    };
    const nodes: any = {
        createReferenceFile: async (_p: string, msg: any, ref: string) => refs.push([msg.output_set, ref]),
        updateFileCount: async () => 0,
    };
    return { merge: new SetMerge(db, store, layout, access, nodes), created, edges, refs };
}

const twoSets = { '#5:1': { '@type': 'Set', label: 'A' }, '#5:2': { '@type': 'Set', label: 'B' } };

test('merging two sets makes a set of references, one per file, linked to both sets', async () => {
    const { merge, created, edges, refs } = setup([
        { rid: '#2:1', set: '#5:1', type: 'image', label: 'a.jpg' },
        { rid: '#2:2', set: '#5:2', type: 'image', label: 'b.jpg' },
        { rid: '#2:1', set: '#5:2', type: 'image', label: 'a.jpg' },
    ], twoSets);
    const result = await merge.merge(['#5:1', '#5:2'], '', '#3:0');
    assert.equal(result.files, 2);
    assert.equal(result.skipped_duplicates, 1);
    assert.equal(created.find(([t]) => t === 'Set')[1].label, 'A + B');
    assert.deepEqual(edges.map((e) => e[1]), ['#5:1', '#5:2']);
    assert.deepEqual(refs.map((r) => r[1]), ['#2:1', '#2:2']);
});

test('sets with different kinds of files, or fewer than two sets, are refused', async () => {
    const mixed = setup([{ rid: '#2:1', set: '#5:1', type: 'image' }, { rid: '#2:2', set: '#5:2', type: 'text' }], twoSets);
    await assert.rejects(() => mixed.merge.merge(['#5:1', '#5:2'], 'x', '#3:0'), /different kinds/);
    await assert.rejects(() => mixed.merge.merge(['#5:1'], 'x', '#3:0'), /at least two/);
    await assert.rejects(() => mixed.merge.merge(['#5:1', '#5:9'], 'x', '#3:0'), /Set not found/);
});
