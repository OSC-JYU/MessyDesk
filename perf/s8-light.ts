// S8 follow-up: the current search index next to a lighter one, on the same OCR-like pages with
// OCR errors. "Full" is today's documents (text in `fulltext`: 2-15 character n-grams, copied to
// the whole-word `fulltext_exact`); "light" puts the text only in `fulltext_exact`. Measures
// index size, search time, and how many pages that contain a word, correctly or misread by OCR,
// each way of searching finds.
//
//   node dist/perf/s8-light.js --mb 200 [--full mdfull --light mdlight]
//
// Both cores must exist with the MessyDesk schema (tools/solr-init-v2.sh). Writes
// perf/results/s8-light.json.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { percentiles } from './lib/http.ts';
import { SolrClient } from '../src/platform/solr/solr.ts';

const { values: args } = parseArgs({
    options: {
        mb: { type: 'string', default: '200' },
        solr: { type: 'string', default: 'http://localhost:8983/solr' },
        full: { type: 'string', default: 'mdfull' },
        light: { type: 'string', default: 'mdlight' },
        error: { type: 'string', default: '0.03' },
        'no-load': { type: 'boolean', default: false },
    },
});
const SOLR = String(args.solr).replace(/\/$/, '');
const ERROR_RATE = Number(args.error);

// ---- text with OCR errors --------------------------------------------------------------------

const words = fs.readFileSync('/usr/share/dict/words', 'utf8').split('\n').filter((w) => /^[a-z]{2,}$/.test(w));
const cumulative: number[] = [];
let total = 0;
for (let r = 1; r <= words.length; r += 1) { total += 1 / r; cumulative.push(total); }
// mulberry32: a small seeded generator. (A plain LCG in floating point lost precision and
// cycled through only ~3 000 words.)
let seed = 7;
function random(): number {
    seed = (seed + 0x6d2b79f5) | 0;
    let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
function pick(): number {
    const x = random() * total;
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (cumulative[mid] < x) lo = mid + 1; else hi = mid; }
    return lo;
}
// Typical OCR confusions; each changes a word by one or two characters.
const CONFUSIONS: Array<[RegExp, string]> = [[/m/, 'rn'], [/rn/, 'm'], [/l/, '1'], [/i/, 'l'], [/e/, 'c'], [/o/, '0'], [/h/, 'b'], [/u/, 'n'], [/a/, 'o'], [/s/, '5'], [/d/, 'cl'], [/c/, 'e']];
function misread(word: string): string {
    const options = CONFUSIONS.filter(([re]) => re.test(word));
    if (!options.length) return word;
    const [re, to] = options[Math.floor(random() * options.length)];
    return word.replace(re, to);
}

// Which pages contain each word, as written and as misread (for recall).
const clean = new Map<number, Set<number>>();
const misreadIn = new Map<number, Set<number>>();
function page(id: number): string {
    const out: string[] = [];
    let length = 0;
    while (length < 2500) {
        const rank = pick();
        let w = words[rank];
        if (random() < ERROR_RATE) {
            const bad = misread(w);
            if (bad !== w) {
                if (!misreadIn.has(rank)) misreadIn.set(rank, new Set());
                misreadIn.get(rank)!.add(id);
                w = bad;
            }
        } else {
            if (!clean.has(rank)) clean.set(rank, new Set());
            clean.get(rank)!.add(id);
        }
        out.push(w);
        length += w.length + 1;
    }
    return out.join(' ');
}

async function post(core: string, path: string, body: unknown): Promise<void> {
    const res = await fetch(`${SOLR}/${core}${path}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    if (!res.ok) throw new Error(`${core}${path}: ${res.status} ${(await res.text()).slice(0, 300)}`);
}

async function size(core: string): Promise<number> {
    const res = await (await fetch(`${SOLR}/admin/cores?action=STATUS&core=${core}&wt=json`)).json() as any;
    return Number(res?.status?.[core]?.index?.sizeInBytes || 0);
}

// ---- search as the backend does ------------------------------------------------------------

function params(q: string, rows: number): Record<string, unknown> {
    return {
        q, rows, defType: 'edismax', qf: 'fulltext_exact^10 fulltext^2 label^3 description^1', pf: 'fulltext_exact^20', pf2: 'fulltext_exact^5',
        hl: true, 'hl.fl': 'fulltext_exact', 'hl.snippets': 3, 'hl.fragsize': 100, wt: 'json', fl: 'id', fq: ['owner:"#1:0"', 'type:"text"'],
    };
}

async function search(core: string, q: string, extra: Record<string, unknown> = {}, rows = 1000): Promise<{ ids: number[]; numFound: number; ms: number }> {
    const started = performance.now();
    if (extra.backend) {
        // The backend's own search (SolrClient.search), with or without `fuzzy`.
        const body = await new SolrClient({ url: SOLR, core }).search({ query: q, rows, fuzzy: extra.fuzzy === true }, '#1:0');
        return { ids: (body?.response?.docs || []).map((d: any) => Number(String(d.id).split(':')[1])), numFound: Number(body?.response?.numFound || 0), ms: performance.now() - started };
    }
    const res = await fetch(`${SOLR}/${core}/query`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ params: { ...params(q, rows), ...extra } }) });
    const body = await res.json() as any;
    const ms = performance.now() - started;
    return { ids: (body?.response?.docs || []).map((d: any) => Number(String(d.id).split(':')[1])), numFound: Number(body?.response?.numFound || 0), ms };
}

async function main(): Promise<void> {
    // --no-load regenerates the same pages (fixed seed) to rebuild the word statistics only.
    const load = !args['no-load'];
    if (load) for (const core of [args.full, args.light]) await post(String(core), '/update?commit=true', { delete: { query: '*:*' } });
    const target = Number(args.mb) * 1048576;
    let bytes = 0;
    let id = 0;
    while (bytes < target) {
        const full: any[] = [];
        const light: any[] = [];
        for (let i = 0; i < 500; i += 1) {
            id += 1;
            const text = page(id);
            bytes += text.length;
            const base = { id: `#10:${id}`, node: `#10:${id}`, owner: '#1:0', type: 'text', project: '#1:1', label: `page_${id}.txt` };
            full.push({ ...base, fulltext: text });
            light.push({ ...base, fulltext_exact: text });
        }
        if (load) await post(String(args.full), '/update', full);
        if (load) await post(String(args.light), '/update', light);
    }
    if (load) for (const core of [args.full, args.light]) await post(String(core), '/update?commit=true', { commit: {} });
    const sizes = { full_mb: Math.round((await size(String(args.full))) / 1048576), light_mb: Math.round((await size(String(args.light))) / 1048576), text_mb: Math.round(bytes / 1048576), pages: id };
    console.log(JSON.stringify(sizes));

    // Query words: length >= 6, on 20-800 pages counting misreadings, with misreadings present.
    console.error(`words seen ${clean.size}, misread ${misreadIn.size}`);
    const candidates = [...clean.keys()].filter((r) => words[r].length >= 6 && misreadIn.has(r)).filter((r) => {
        const n = new Set([...clean.get(r)!, ...misreadIn.get(r)!]).size;
        return n >= 20 && n <= 800;
    });
    console.error(`candidates ${candidates.length}`);
    const chosen = candidates.sort((a, b) => a - b).filter((_, i) => i % Math.max(1, Math.floor(candidates.length / 40)) === 0).slice(0, 40);
    const ways: Array<[string, string, (w: string) => string, Record<string, unknown>?]> = [
        ['full, backend search', String(args.full), (w) => w, { backend: true }],
        ['full, backend search + OCR misspellings', String(args.full), (w) => w, { backend: true, fuzzy: true }],
        ['light, backend search', String(args.light), (w) => w, { backend: true }],
        ['light, backend search + OCR misspellings', String(args.light), (w) => w, { backend: true, fuzzy: true }],
    ];
    const recall: any[] = [];
    for (const [name, core, make, extraParams] of ways) {
        let truthPages = 0;
        let foundClean = 0;
        let foundMisread = 0;
        let cleanTotal = 0;
        let misreadTotal = 0;
        let extra = 0;
        const ms: number[] = [];
        for (const r of chosen) {
            const c = clean.get(r)!;
            const m = new Set([...misreadIn.get(r)!].filter((p) => !c.has(p)));
            const truth = new Set([...c, ...m]);
            const res = await search(core, make(words[r]), extraParams || {});
            ms.push(res.ms);
            const found = new Set(res.ids);
            truthPages += truth.size;
            cleanTotal += c.size;
            misreadTotal += m.size;
            for (const p of c) if (found.has(p)) foundClean += 1;
            for (const p of m) if (found.has(p)) foundMisread += 1;
            extra += Math.max(0, res.numFound - [...found].filter((p) => truth.has(p)).length);
        }
        const p = percentiles(ms);
        const row = {
            way: name, words: chosen.length,
            pages_with_word_found_pct: Math.round((foundClean / cleanTotal) * 1000) / 10,
            pages_with_only_misread_word_found_pct: Math.round((foundMisread / Math.max(1, misreadTotal)) * 1000) / 10,
            other_pages_per_query: Math.round(extra / chosen.length),
            search_p50_ms: p.p50, search_p95_ms: p.p95,
        };
        recall.push(row);
        console.log(JSON.stringify(row));
    }
    fs.writeFileSync(`perf/results/s8-light${args['no-load'] ? '' : ''}.${process.env.S8_LABEL || 'run'}.json`, JSON.stringify({ when: new Date().toISOString(), error_rate: ERROR_RATE, sizes, recall }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
