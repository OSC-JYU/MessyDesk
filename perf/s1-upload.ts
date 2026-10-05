// Scenario S1 (plan section 7): upload N images into one set the way the UI does (chunks of 20
// files, 3 chunks in parallel, MessyDesk-UI api/client.js uploadFiles), against a running backend.
//
//   node dist/perf/s1-upload.js --files 10000 [--chunk 20] [--parallel 3] [--thumbnails]
//
// Reports chunk latency per 1 000 files already in the set (does uploading get slower as the set
// grows?), total time, and checks afterwards that the set's stored count, its members and its
// set.json agree. Writes perf/results/s1-upload.<files>.json; prints the set rid for S5.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { call, get, JPEG_1x1, percentiles, post, rid, sleep } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        files: { type: 'string', default: '1000' },
        chunk: { type: 'string', default: '20' },
        parallel: { type: 'string', default: '3' },
        thumbnails: { type: 'boolean', default: false },
        label: { type: 'string' },
    },
});

const total = Number(args.files);
const chunkSize = Number(args.chunk);
const parallel = Number(args.parallel);

async function main(): Promise<void> {
    const project = await post('/api/projects', { label: `Perf S1 ${total} ${Date.now()}`, description: 'perf' });
    if (project.status !== 200) throw new Error(`project: ${project.status} ${project.text}`);
    const projectRid = project.body['@rid'];
    const set = await post(`/api/projects/${rid(projectRid)}/sets`, { label: `Upload ${total}`, description: 'perf' });
    if (set.status !== 200) throw new Error(`set: ${set.status} ${set.text}`);
    const setRid = set.body['@rid'];
    const query = args.thumbnails ? '' : '?no-thumbnails=true';
    const url = `/api/projects/${rid(projectRid)}/upload/${rid(setRid)}${query}`;

    const chunks: number[][] = [];
    for (let i = 0; i < total; i += chunkSize) chunks.push(Array.from({ length: Math.min(chunkSize, total - i) }, (_, k) => i + k));
    const samples: Array<{ before: number; ms: number; files: number; failed: number; status: number }> = [];
    let uploaded = 0;
    let next = 0;
    const started = performance.now();
    let lastLog = 0;

    async function worker(): Promise<void> {
        while (next < chunks.length) {
            const chunk = chunks[next++];
            const form = new FormData();
            for (const i of chunk) form.append('file', new Blob([JPEG_1x1], { type: 'image/jpeg' }), `page_${String(i + 1).padStart(6, '0')}.jpg`);
            const before = uploaded;
            const res = await call('POST', url, { form });
            const failed = Array.isArray(res.body?.failed) ? res.body.failed.length : (res.status === 200 ? 0 : chunk.length);
            uploaded += chunk.length - failed;
            samples.push({ before, ms: res.ms, files: chunk.length, failed, status: res.status });
            if (res.status !== 200 && samples.filter((s) => s.status !== 200).length <= 3) console.error(`chunk failed: ${res.status} ${res.text.slice(0, 200)}`);
            if (performance.now() - lastLog > 10000) {
                lastLog = performance.now();
                console.error(`[${Math.round((lastLog - started) / 1000)}s] ${uploaded}/${total} uploaded, last chunk ${Math.round(res.ms)} ms`);
            }
        }
    }
    await Promise.all(Array.from({ length: parallel }, worker));
    const seconds = (performance.now() - started) / 1000;

    // Chunk latency by how many files the set already had.
    const buckets = new Map<number, number[]>();
    for (const s of samples) {
        const key = Math.floor(s.before / 1000) * 1000;
        if (!buckets.has(key)) buckets.set(key, []);
        buckets.get(key)!.push(s.ms);
    }
    const curve = [...buckets.entries()].sort((a, b) => a[0] - b[0]).map(([from, ms]) => ({ set_size_from: from, ...percentiles(ms) }));

    // Consistency: stored count, members, set.json (written once the set has been quiet for 5 s).
    await sleep(7000);
    const listing = await get(`/api/sets/${rid(setRid)}/files?limit=1`);
    const node = await get(`/api/documents/${rid(setRid)}`).catch(() => null);
    let manifestItems: number | null = null;
    const setPath = set.body.path || node?.body?.path;
    const dataDir = process.env.DATA_DIR;
    if (setPath) {
        const candidates = [setPath, dataDir ? path.join(dataDir, '..', '..', setPath) : null].filter(Boolean) as string[];
        for (const dir of candidates) {
            try {
                manifestItems = JSON.parse(fs.readFileSync(path.join(dir, 'set.json'), 'utf8')).items.length;
                break;
            } catch { /* try next */ }
        }
    }
    const result = {
        scenario: 'S1 upload',
        files: total, chunk: chunkSize, parallel, thumbnails: args.thumbnails,
        project: projectRid, set: setRid,
        seconds: Math.round(seconds), files_per_second: Math.round((uploaded / seconds) * 10) / 10,
        uploaded, failed_chunks: samples.filter((s) => s.status !== 200).length,
        members: listing.body?.file_count ?? null,
        stored_count: node?.body?.count ?? null,
        manifest_items: manifestItems,
        chunk_ms_by_set_size: curve,
    };
    fs.mkdirSync('perf/results', { recursive: true });
    fs.writeFileSync(`perf/results/s1-upload.${args.label || total}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, chunk_ms_by_set_size: undefined }, null, 2));
    for (const row of curve) console.log(`set ${String(row.set_size_from).padStart(6)}+  chunk p50 ${String(row.p50).padStart(6)} ms  p95 ${String(row.p95).padStart(6)} ms  max ${row.max} ms`);
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
