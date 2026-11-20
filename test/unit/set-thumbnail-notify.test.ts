import assert from 'node:assert/strict';
import { test } from 'node:test';
import { shouldNotifySetThumbnail } from '../../src/modules/results/results.ts';

test('set thumbnails notify for the first four files only', () => {
    const notified = Array.from({ length: 35 }, (_, i) => i + 1).filter((n) => shouldNotifySetThumbnail(n));
    assert.deepEqual(notified, [1, 2, 3, 4]);
});

test('a split PDF set notifies for the first page only', () => {
    const notified = Array.from({ length: 10 }, (_, i) => i + 1).filter((n) => shouldNotifySetThumbnail(n, 1));
    assert.deepEqual(notified, [1]);
});

test('set thumbnails ignore missing or invalid positions', () => {
    for (const value of [0, -1, Number.NaN, undefined as any]) assert.equal(shouldNotifySetThumbnail(value), false);
});
