import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferences } from '../../src/modules/files/references.ts';

test('references resolve to the file they point to, also through several levels', async () => {
    const refs: Record<string, string> = { '#1:2': '#1:1', '#1:3': '#1:2' };
    const db: any = { rowsByRids: async (_f: string, rids: string[]) => rids.filter((r) => refs[r]).map((r) => ({ rid: r, ref: refs[r] })) };
    const actual = await resolveReferences(db, ['#1:1', '#1:2', '#1:3', '#1:9']);
    assert.deepEqual([...actual], [['#1:1', '#1:1'], ['#1:2', '#1:1'], ['#1:3', '#1:1'], ['#1:9', '#1:9']]);
});
