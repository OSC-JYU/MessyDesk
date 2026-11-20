// "Clever text join": texts are grouped by the original PDF or uploaded text file they came from.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { manyToOneGroups } from '../../src/modules/processing/grouping.ts';

const nodes: Record<string, any> = {
    '#1:1': { rid: '#1:1', label: 'a.pdf', type: 'original-pdf' },
    '#1:2': { rid: '#1:2', label: 'a-1.pdf', type: 'pdf' },
    '#1:3': { rid: '#1:3', label: 'a-2.pdf', type: 'pdf' },
    '#1:4': { rid: '#1:4', label: 'a-1.txt', type: 'text', extension: 'txt' },
    '#1:5': { rid: '#1:5', label: 'a-2.txt', type: 'text', extension: 'txt' },
    '#1:6': { rid: '#1:6', label: 'note.md', type: 'text', extension: 'md' },
    '#1:7': { rid: '#1:7', label: 'note-fi.md', type: 'text', extension: 'md' },
};
const parents: Record<string, string> = { '#1:2': '#1:1', '#1:3': '#1:1', '#1:4': '#1:2', '#1:5': '#1:3', '#1:7': '#1:6' };

const db: any = {
    edgesOf: async (_dir: string, _type: string, rids: string[]) =>
        rids.filter((r) => parents[r]).map((r) => ({ source: parents[r], target: r })),
    rowsByRids: async (_fields: string, rids: string[]) => rids.map((r) => nodes[r]),
};
const file = (rid: string) => ({ '@rid': rid, ...nodes[rid] });

test('texts of split PDF pages are joined per original PDF, uploaded texts stay apart', async () => {
    const files = ['#1:4', '#1:5', '#1:6', '#1:7'].map(file);
    const service = { tasks: { join_text: { grouping_mode: 'text_source' } } };
    const groups = await manyToOneGroups(db, service, { id: 'join_text' }, files, false);
    const byLabel = Object.fromEntries(groups.map((g) => [g.label, g.files.map((f) => f.label)]));
    assert.deepEqual(byLabel, { 'a.pdf': ['a-1.txt', 'a-2.txt'], 'note.md': ['note-fi.md', 'note.md'] });
});
