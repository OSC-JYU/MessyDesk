// Grouped browsing of a set: the order of the groups and the part of the files a page needs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { entryWindow, flatSegments, isGrouped, sortGroups } from '../../src/modules/files/set-groups.ts';

const groups = sortGroups([
    { origin_rid: '#9:2', origin_label: 'b.pdf', count: '3' },
    { origin_rid: '#9:1', origin_label: 'a.pdf', count: 2 },
    { origin_rid: '#9:3', origin_label: 'a.pdf', count: 1 },
]);

test('groups are ordered by label, then rid', () => {
    assert.deepEqual(groups.map((g) => [g.origin_rid, g.count]), [['#9:1', 2], ['#9:3', 1], ['#9:2', 3]]);
});

test('one PDF alone is not grouped, anything else with an origin is', () => {
    assert.equal(isGrouped([], 5), false);
    assert.equal(isGrouped(groups.slice(0, 1), 0), false);
    assert.equal(isGrouped(groups.slice(0, 1), 2), true);
    assert.equal(isGrouped(groups, 0), true);
});

test('a page of the top level: group cards first, then the other files', () => {
    assert.deepEqual(entryWindow(groups, 4, 0, 2), { groups: groups.slice(0, 2), fileSkip: 0, fileLimit: 0 });
    assert.deepEqual(entryWindow(groups, 4, 2, 3), { groups: groups.slice(2), fileSkip: 0, fileLimit: 2 });
    assert.deepEqual(entryWindow(groups, 4, 4, 10), { groups: [], fileSkip: 1, fileLimit: 3 });
    assert.deepEqual(entryWindow(groups, 4, 9, 10), { groups: [], fileSkip: 6, fileLimit: 0 });
});

test('positions of the whole set in the grouped order', () => {
    assert.deepEqual(flatSegments(groups, 2, 0, 3), [{ origin: '#9:1', skip: 0, limit: 2 }, { origin: '#9:3', skip: 0, limit: 1 }]);
    assert.deepEqual(flatSegments(groups, 2, 2, 1), [{ origin: '#9:3', skip: 0, limit: 1 }]);
    assert.deepEqual(flatSegments(groups, 2, 4, 3), [{ origin: '#9:2', skip: 1, limit: 2 }, { origin: null, skip: 0, limit: 1 }]);
    assert.deepEqual(flatSegments(groups, 2, 5, 4), [{ origin: '#9:2', skip: 2, limit: 1 }, { origin: null, skip: 0, limit: 2 }]);
    assert.deepEqual(flatSegments(groups, 2, 7, 4), [{ origin: null, skip: 1, limit: 1 }]);
    assert.deepEqual(flatSegments(groups, 2, 8, 4), []);
    // stepping one file at a time visits every file once, in order
    const seen: string[] = [];
    for (let i = 0; i < 8; i += 1) for (const s of flatSegments(groups, 2, i, 1)) seen.push(`${s.origin}:${s.skip}`);
    assert.deepEqual(seen, ['#9:1:0', '#9:1:1', '#9:3:0', '#9:2:0', '#9:2:1', '#9:2:2', 'null:0', 'null:1']);
});
