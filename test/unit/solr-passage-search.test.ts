import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SolrClient } from '../../src/platform/solr/solr.ts';

function client() {
    const requests: any[] = [];
    const solr: any = new SolrClient({ url: 'http://x', core: 'c' } as any);
    solr.postJson = async (_p: string, body: any) => (requests.push(body.params), { response: { docs: [] }, highlighting: {} });
    return { solr, requests };
}

test('search can be limited to texts with a coded passage that has the tags', async () => {
    const { solr, requests } = client();
    await solr.search({ query: 'war', passage_tag_rids: ['7:1', '#7:2', 'bad"'] }, '#3:0');
    const fq = requests[0].fq.join(' | ');
    assert.match(fq, /\(passage_tag_rid:"#7:1" OR passage_tag_rid:"#7:2"\)/);
    assert.doesNotMatch(fq, /bad/);
    await solr.search({ query: 'war', passage_tag_rids: ['#7:1', '#7:2'], passage_match: 'and' }, '#3:0');
    assert.match(requests[1].fq.join(' | '), /passage_tag_rid:"#7:1" AND passage_tag_rid:"#7:2"/);
});

test('without passage tags the search filter is unchanged', async () => {
    const { solr, requests } = client();
    await solr.search({ query: 'war' }, '#3:0');
    assert.ok(!requests[0].fq.join(' ').includes('passage_tag_rid'));
});
