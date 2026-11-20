import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveReferences } from '../../src/modules/files/references.ts';

test('references resolve to the file they point to, also through several levels', async () => {
    const refs: Record<string, string> = { '#1:2': '#1:1', '#1:3': '#1:2' };
    const db: any = { rowsByRids: async (_f: string, rids: string[]) => rids.filter((r) => refs[r]).map((r) => ({ rid: r, ref: refs[r] })) };
    const actual = await resolveReferences(db, ['#1:1', '#1:2', '#1:3', '#1:9']);
    assert.deepEqual([...actual], [['#1:1', '#1:1'], ['#1:2', '#1:1'], ['#1:3', '#1:1'], ['#1:9', '#1:9']]);
});

test('a set of references counts the tags on its members and on the files they point to', async () => {
    const { TagsService } = await import('../../src/modules/tags/tags.ts');
    // #1:2 is a reference to #1:1 (tagged "a"); #1:3 is a reference tagged "b" itself.
    const links = [{ entity_rid: '#7:1', target_rid: '#1:1' }, { entity_rid: '#7:2', target_rid: '#1:3' }];
    const refs: Record<string, string> = { '#1:2': '#1:1', '#1:3': '#1:0' };
    const db: any = {
        rows: async (sql: string) => (sql.includes('FROM File WHERE set') ? [{ rid: '#1:2' }, { rid: '#1:3' }] : links),
        rowsByRids: async (fields: string, rids: string[]) => (fields.includes('ref') ? rids.filter((r) => refs[r]).map((r) => ({ rid: r, ref: refs[r] })) : rids.map((r) => ({ rid: r, label: r })))
    };
    const access: any = { findOwned: async () => ({ node: { '@type': 'Set' }, projectRid: '#2:0' }) };
    const result = await new TagsService(db, access).setEntities('#5:1', '#3:0');
    assert.deepEqual(result.map((e: any) => [e.rid, e.count]).sort(), [['#7:1', 1], ['#7:2', 1]]);
});
