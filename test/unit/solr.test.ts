import { test } from 'node:test';
import assert from 'node:assert/strict';
import { fuzzyQuery, ocrVariants, parseRoiKey, roiKey, roiRunDocument, SolrClient } from '../../src/platform/solr/solr.ts';
import { NerService } from '../../src/modules/tags/ner.ts';

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

test('ROI keys round-trip, also with a "|" in the label or an empty model', () => {
    assert.equal(roiKey('md-gliner2', 'extract_entities', '', 'person'), 'md-gliner2|extract_entities||person');
    assert.deepEqual(parseRoiKey('md-gliner2|extract_entities||person'), { service_id: 'md-gliner2', task: 'extract_entities', model: '', label: 'person' });
    assert.equal(parseRoiKey(roiKey('s', 't', 'm', 'a|b')).label, 'a|b');
});

test('a ROI run document has one key per distinct label and never uses the node field', () => {
    const doc = roiRunDocument({ nerRid: '#12:3', sourceRid: '#9:1', owner: '#3:0', project: '5:2', serviceId: 'md-lingua', task: 'detect_language', model: null, labels: ['fi', 'en', 'fi'] });
    assert.equal(doc.id, 'roi:12:3');
    assert.equal(doc.type, 'roi_run');
    assert.equal(doc.project, '#5:2');
    assert.equal(doc.roi_source, '#9:1');
    assert.deepEqual(doc.roi_key, ['md-lingua|detect_language||fi', 'md-lingua|detect_language||en']);
    assert.equal('node' in doc, false);
});

test('ner.json labels are the distinct non-empty region labels', () => {
    assert.deepEqual(NerService.labelsOf({ rois: { a: { label: 'person' }, b: { label: ' person ' }, c: { label: '' }, d: { text: 'x' }, e: { label: 'place' } } }), ['person', 'place']);
    assert.deepEqual(NerService.labelsOf({ r1: { label: 'fi' } }), ['fi']);
    assert.deepEqual(NerService.labelsOf(null), []);
});

function withFetch(handler: (url: string, init?: any) => any, run: () => Promise<void>): Promise<void> {
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init?: any) => {
        const body = handler(String(url), init);
        return new Response(JSON.stringify(body), { status: 200 });
    }) as any;
    return run().finally(() => { globalThis.fetch = original; });
}

test('ROI label list asks for one extra key to know whether there is more', async () => {
    let requested = '';
    await withFetch((url) => {
        requested = url;
        return { facet_counts: { facet_fields: { roi_key: ['s|t||a', 2, 's|t||b', 1, 's|t||c', 1] } } };
    }, async () => {
        const solr = new SolrClient({ url: 'http://solr', core: 'c' });
        const page = await solr.roiLabels('#3:0', { projects: ['5:2'], search: 'Per', limit: 2 });
        assert.deepEqual(page.items.map((i) => [i.label, i.count]), [['a', 2], ['b', 1]]);
        assert.equal(page.hasMore, true);
    });
    const params = new URL(requested).searchParams;
    assert.equal(params.get('facet.limit'), '3');
    assert.equal(params.get('facet.contains'), 'Per');
    assert.deepEqual(params.getAll('fq'), ['owner:"#3:0"', 'type:"roi_run"', '(project:"#5:2" OR project:"5:2")']);
});

test('ROI sources keep only the wanted keys, page through results and fail loudly', async () => {
    const bodies: any[] = [];
    await withFetch((_url, init) => {
        const params = JSON.parse(init.body).params;
        bodies.push(params);
        const docs = params.start === 0
            ? [{ roi_source: '#9:1', roi_key: ['s|t||a', 's|t||other'] }, { roi_source: '#9:2', roi_key: 's|t||b' }]
            : [{ roi_source: '#9:1', roi_key: ['s|t||b'] }];
        return { response: { numFound: 3, docs } };
    }, async () => {
        const solr = new SolrClient({ url: 'http://solr', core: 'c' });
        const found = await solr.roiSources('#3:0', ['#9:1', '#9:2'], ['s|t||a', 's|t||b']);
        assert.deepEqual([...found.get('#9:1')!].sort(), ['s|t||a', 's|t||b']);
        assert.deepEqual([...found.get('#9:2')!], ['s|t||b']);
    });
    assert.ok(bodies[0].fq.includes('{!terms f=roi_source}#9:1,#9:2'));
    assert.equal((await new SolrClient({ url: 'http://solr', core: 'c' }).roiSources('#3:0', [], ['k'])).size, 0);

    const original = globalThis.fetch;
    globalThis.fetch = (async () => new Response('down', { status: 503 })) as any;
    try {
        await assert.rejects(new SolrClient({ url: 'http://solr', core: 'c' }).roiSources('#3:0', ['#9:1'], ['k']), /failed: 503/);
    } finally {
        globalThis.fetch = original;
    }
});
