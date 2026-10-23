// S8 follow-up: the backend's search (SolrClient.search) with 500 hits, as the UI's search page
// asks, on the existing index: time, response size, and how many hits come with a snippet.
//
//   node dist/perf/s8-highlight.js

import { SolrClient } from '../src/platform/solr/solr.ts';
import { percentiles } from './lib/http.ts';

const solr = new SolrClient({ url: process.env.SOLR_URL || 'http://localhost:8983/solr', core: process.env.SOLR_CORE || 'messydesk' });
const QUERIES = ['the', 'and of', 'house', 'river', 'governments', 'abandon*', 'stat*', '"the house"', 'zymurgy', 'quixotic', 'water fire', 'king queen', 'mountain', 'ab', 'tion', 'library science', '"of the"', 'paris', 'electric', 'xylophone'];
const ms: number[] = [];
let bytes = 0;
let hits = 0;
let withSnippet = 0;
for (const round of [0, 1]) {
    for (const q of QUERIES) {
        const started = performance.now();
        const res = await solr.search({ query: q, rows: 500 }, process.env.OWNER || '#1:0');
        if (!round) continue;
        ms.push(performance.now() - started);
        bytes += JSON.stringify(res).length;
        for (const doc of res?.response?.docs || []) {
            hits += 1;
            const hl = res.highlighting?.[doc.id] || {};
            if (hl.fulltext_exact?.[0] || hl.fulltext?.[0]) withSnippet += 1;
        }
    }
}
const p = percentiles(ms);
console.log(JSON.stringify({ p50: p.p50, p95: p.p95, kb_per_response: Math.round(bytes / QUERIES.length / 1024), hits, with_snippet: withSnippet }));
