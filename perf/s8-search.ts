// Scenario S8 (plan section 7): search index size and search speed. Grows the Solr core with
// OCR-like pages in steps and after each step records the index size on disk, bytes per page and
// per MB of text, and the latency of 20 fixed searches made exactly as the backend makes them
// (SolrClient.search: edismax over the n-gram field, highlighting on), at 1 and 10 concurrent
// searches. Also times indexing the way md-solr does it (one commit per page).
//
//   node dist/perf/s8-search.js --steps 10,50,200 [--solr http://localhost:8983/solr --core messydesk]
//
// Steps are MB of text in total. Text is generated: words from /usr/share/dict/words picked with
// a Zipf distribution (a few words very common, most rare), ~2 500 characters per page like an OCR
// page. Writes perf/results/s8-search.<label>.json.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { SolrClient } from '../src/platform/solr/solr.ts';
import { percentiles } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        steps: { type: 'string', default: '10,50,200' },
        solr: { type: 'string', default: 'http://localhost:8983/solr' },
        core: { type: 'string', default: 'messydesk' },
        label: { type: 'string', default: 'run' },
        owner: { type: 'string', default: '#1:0' },
        projects: { type: 'string', default: '20' },
    },
});

const base = `${String(args.solr).replace(/\/$/, '')}/${args.core}`;
const solr = new SolrClient({ url: String(args.solr), core: String(args.core) });
const words = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => /^[a-z]{2,}$/.test(w));
// Zipf: rank r has weight 1/r. Precompute the cumulative table once.
const cumulative: number[] = [];
let sum = 0;
for (let r = 1; r <= words.length; r += 1) {
    sum += 1 / r;
    cumulative.push(sum);
}
// mulberry32: a small seeded generator. (A plain LCG in floating point lost precision and
// cycled through only ~3 000 words.)
let seed = 42;
function random(): number {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function word(): string {
    const x = random() * sum;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
        const mid = (lo + hi) >> 1;
        if (cumulative[mid] < x) lo = mid + 1;
        else hi = mid;
    }
    return words[lo];
}
function page(chars = 2500): string {
    const out: string[] = [];
    let length = 0;
    while (length < chars) {
        const w = word();
        out.push(w);
        length += w.length + 1;
    }
    return out.join(' ');
}

let docCount = 0;
function doc(projects: number): any {
    docCount += 1;
    const n = docCount;
    const project = `#1:${n % projects}`;
    return {
        id: `#10:${n}:#7:1`, node: `#10:${n}`, process: '#7:1', set_process: '#7:1', project, set: `#19:${n % 50}`,
        owner: String(args.owner), type: 'text', label: `page_${String(n).padStart(7, '0')}.txt`, description: '',
        path: `data/projects/${project.replace('#', '').replace(':', '_')}/files/x/${n}.txt`, fulltext: page(),
    };
}

async function post(path: string, body: unknown): Promise<void> {
    const res = await fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`Solr ${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function indexStatus(): Promise<{ numDocs: number; bytes: number }> {
    const res = await (await fetch(`${String(args.solr).replace(/\/$/, '')}/admin/cores?action=STATUS&core=${args.core}&wt=json`)).json() as any;
    const index = res?.status?.[String(args.core)]?.index || {};
    return { numDocs: Number(index.numDocs || 0), bytes: Number(index.sizeInBytes || 0) };
}

// Fixed searches: common and rare words, prefixes, phrases.
const QUERIES = ['the', 'and of', 'house', 'river', 'governments', 'abandon*', 'stat*', '"the house"', 'zymurgy', 'quixotic', 'water fire', 'king queen', 'mountain', 'ab', 'tion', 'library science', '"of the"', 'paris', 'electric', 'xylophone'];

async function timeSearches(concurrency: number, projects: string[]): Promise<any> {
    const ms: number[] = [];
    let hits = 0;
    let next = 0;
    const jobs = [...QUERIES, ...QUERIES];
    async function worker(): Promise<void> {
        while (next < jobs.length) {
            const q = jobs[next++];
            const started = performance.now();
            const res = await solr.search({ query: q, project_rids: projects }, String(args.owner));
            ms.push(performance.now() - started);
            hits += Number(res?.response?.numFound || 0);
        }
    }
    await Promise.all(Array.from({ length: concurrency }, worker));
    return { concurrency, ...percentiles(ms), avg_hits: Math.round(hits / jobs.length) };
}

async function main(): Promise<void> {
    const projects = Number(args.projects);
    await post('/update?commit=true', { delete: { query: '*:*' } });
    const results: any[] = [];
    let textBytes = 0;
    for (const step of String(args.steps).split(',').map(Number)) {
        const target = step * 1024 * 1024;
        const started = performance.now();
        while (textBytes < target) {
            const batch = Array.from({ length: 500 }, () => doc(projects));
            textBytes += batch.reduce((n, d) => n + d.fulltext.length, 0);
            await post('/update', batch);
        }
        await post('/update?commit=true', { commit: {} });
        const loadSeconds = (performance.now() - started) / 1000;
        const status = await indexStatus();
        const all = await timeSearches(1, []);
        const oneDesk = await timeSearches(1, ['#1:1']);
        const parallel = await timeSearches(10, []);
        const row: any = {
            text_mb: Math.round(textBytes / 1048576), docs: status.numDocs, index_mb: Math.round(status.bytes / 1048576),
            index_bytes_per_doc: Math.round(status.bytes / Math.max(1, status.numDocs)), index_to_text: Math.round((status.bytes / textBytes) * 10) / 10,
            bulk_load_docs_per_s: Math.round(((status.numDocs - (results.at(-1)?.docs || 0)) / loadSeconds)), search_all_desks: all, search_one_desk: oneDesk, search_10_parallel: parallel,
        };
        results.push(row);
        console.log(JSON.stringify(row));
    }
    // Indexing like md-solr: one page per request, commit each time.
    const md: number[] = [];
    for (let i = 0; i < 100; i += 1) {
        const started = performance.now();
        await post('/update?commit=true', [doc(projects)]);
        md.push(performance.now() - started);
    }
    const perDocCommit = percentiles(md);
    console.log(JSON.stringify({ md_solr_style_commit_per_page_ms: perDocCommit }));
    fs.writeFileSync(`perf/results/s8-search.${args.label}.json`, JSON.stringify({ when: new Date().toISOString(), results, md_solr_style_commit_per_page_ms: perDocCommit }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
