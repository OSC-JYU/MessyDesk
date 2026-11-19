import { test } from 'node:test';
import assert from 'node:assert/strict';
import { codePointLength, isStale, normalizeTextRegions, sliceCodePoints, textHash } from '../../src/modules/rois/text-regions.ts';

const text = 'Hei 😀 maailma, e\u0301!';

test('offsets count code points, not UTF-16 units', () => {
    assert.equal(text.length, codePointLength(text) + 1);
    assert.equal(sliceCodePoints(text, 4, 5), '😀');
    assert.equal(sliceCodePoints(text, 6, 13), 'maailma');
});

test('regions are keyed by id and get their snippet and the text hash', () => {
    const set = normalizeTextRegions({ rois: [{ id: 'a', start: 4, end: 5, tag: 'x' }, { id: 'b', start: 0, end: 3, text: 'ignored' }] }, text);
    assert.deepEqual(Object.keys(set.rois), ['a', 'b']);
    assert.equal(set.rois.a.text, '😀');
    assert.equal(set.rois.a.tag, 'x');
    assert.equal(set.rois.b.text, 'Hei');
    assert.equal(set.text_hash, textHash(text));
});

test('invalid regions are rejected with a message', () => {
    assert.throws(() => normalizeTextRegions({ rois: [{ id: 'a', start: 3, end: 3 }] }, text), /do not fit/);
    assert.throws(() => normalizeTextRegions({ rois: [{ id: 'a', start: -1, end: 2 }] }, text), /do not fit/);
    assert.throws(() => normalizeTextRegions({ rois: [{ id: 'a', start: 0, end: 999 }] }, text), /do not fit/);
    assert.throws(() => normalizeTextRegions({ rois: [{ id: 'a', start: 0.5, end: 2 }] }, text), /whole numbers/);
    assert.throws(() => normalizeTextRegions({ rois: [{ start: 0, end: 2 }] }, text), /id/);
    assert.throws(() => normalizeTextRegions({ rois: [{ id: 'a', start: 0, end: 2 }, { id: 'a', start: 1, end: 3 }] }, text), /Duplicate/);
});

test('overlapping and nested regions are allowed', () => {
    const set = normalizeTextRegions({ rois: [{ id: 'a', start: 0, end: 10 }, { id: 'b', start: 2, end: 5 }] }, text);
    assert.equal(Object.keys(set.rois).length, 2);
});

test('a changed text makes the set stale', () => {
    const set = normalizeTextRegions({ rois: [{ id: 'a', start: 0, end: 3 }] }, text);
    assert.equal(isStale(set, text), false);
    assert.equal(isStale(set, 'Moi 😀 maailma'), true);
});

test('a set from a service without a hash is stale when a snippet no longer matches', () => {
    const fromService = { rois: { r: { id: 'r', type: 'text', start: 0, end: 3, text: 'Hei' } } };
    assert.equal(isStale(fromService, text), false);
    assert.equal(isStale(fromService, 'Moi maailma'), true);
});
