// S8 follow-up: on an existing index, times the backend's search with variants of the Solr
// parameters (rows, highlighter) to see what the cost is made of. Read-only.
//
//   node dist/perf/s8-variants.js [--solr http://localhost:8983/solr --core messydesk]

import { parseArgs } from 'node:util';
import { percentiles } from './lib/http.ts';

const { values: args } = parseArgs({ options: { solr: { type: 'string', default: 'http://localhost:8983/solr' }, core: { type: 'string', default: 'messydesk' }, owner: { type: 'string', default: '#1:0' } } });
const base = `${String(args.solr).replace(/\/$/, '')}/${args.core}`;
const QUERIES = ['the', 'and of', 'house', 'river', 'governments', 'abandon*', 'stat*', '"the house"', 'zymurgy', 'quixotic', 'water fire', 'king queen', 'mountain', 'ab', 'tion', 'library science', '"of the"', 'paris', 'electric', 'xylophone'];

// The parameters SolrClient.search sends.
function params(q: string, rows: number): Record<string, unknown> {
    return {
        q, rows, defType: 'edismax', qf: 'fulltext_exact^10 fulltext^2 label^3 description^1', pf: 'fulltext_exact^20', pf2: 'fulltext_exact^5',
        hl: true, 'hl.fl': 'fulltext_exact,fulltext', 'hl.simple.pre': '<em>', 'hl.simple.post': '</em>', 'hl.snippets': 3, 'hl.fragsize': 100,
        wt: 'json', fl: 'description,label,id,node,process,project,set,owner,score,type,path', fq: [`owner:"${args.owner}"`, 'type:"text"'],
    };
}

const VARIANTS: Array<[string, (q: string) => Record<string, unknown>]> = [
    ['backend default (rows 250)', (q) => params(q, 250)],
    ['UI search page (rows 500)', (q) => params(q, 500)],
    ['rows 50', (q) => params(q, 50)],
    ['rows 500, unified highlighter', (q) => ({ ...params(q, 500), 'hl.method': 'unified' })],
    ['rows 500, highlight fulltext_exact only', (q) => ({ ...params(q, 500), 'hl.fl': 'fulltext_exact' })],
    ['rows 500, unified, fulltext_exact only', (q) => ({ ...params(q, 500), 'hl.method': 'unified', 'hl.fl': 'fulltext_exact' })],
    ['rows 500, no highlighting', (q) => ({ ...params(q, 500), hl: false })],
];

for (const [name, make] of VARIANTS) {
    const ms: number[] = [];
    let bytes = 0;
    for (const round of [0, 1]) {
        for (const q of QUERIES) {
            const started = performance.now();
            const res = await fetch(base + '/query', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: make(q) }) });
            const text = await res.text();
            if (round) { ms.push(performance.now() - started); bytes += text.length; }
        }
    }
    const p = percentiles(ms);
    console.log(`${name.padEnd(42)} p50 ${String(p.p50).padStart(5)} ms  p95 ${String(p.p95).padStart(5)} ms  ${Math.round(bytes / QUERIES.length / 1024)} KB/response`);
}
