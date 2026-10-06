import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyQuery, ocrVariants } from '../../src/platform/solr/solr.ts';

test('fuzzy search makes plain words of 4+ letters fuzzy and leaves the rest', () => {
    assert.equal(fuzzyQuery('king queen'), 'king~1 queen~1');
    assert.equal(fuzzyQuery('"the house" river'), '"the house" river~1');
    assert.equal(fuzzyQuery('abandon* paris~2 label:foo'), 'abandon* paris~2 label:foo');
    assert.equal(fuzzyQuery('cat AND dog'), 'cat AND dog');
    assert.equal(fuzzyQuery('+river -town'), '+river~1 -(town~1 tovvn)');
});

test('fuzzy search adds the two-edit OCR confusions of a word', () => {
    assert.deepEqual(ocrVariants('governments'), ['governrnents', 'govemments']);
    assert.deepEqual(ocrVariants('modern'), ['rnodern', 'modem', 'moclern']);
    assert.deepEqual(ocrVariants('build'), ['builcl']);
    assert.equal(fuzzyQuery('modern'), `(modern~1 ${ocrVariants('modern').join(' ')})`);
});
