// Times the backend's own functions (not copied SQL) on a seeded database, for the code paths
// the query profile found slow. Use after changing queries to confirm the fix end to end.
//
//   node dist/perf/profile-code.js --db perf_profile --label after
//
// Runs ensureSchema first, so new indexes are built (and their build time is reported). Only
// read-only functions and connectDerivedFrom (which rewrites an existing edge's properties with
// the same values) are called, so the dataset stays as it was.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { AccessService } from '../src/modules/access/access.ts';
import { BatchState } from '../src/modules/batches/batch-state.ts';
import { groupByRootSource } from '../src/modules/processing/grouping.ts';
import { DeskGraph } from '../src/modules/projects/desk-graph.ts';
import { TagsService } from '../src/modules/tags/tags.ts';
import { GraphStore } from '../src/shared/graph-store.ts';
import { ensureSchema } from '../src/platform/arcade/schema.ts';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'messydesk_perf' },
        label: { type: 'string', default: 'code' },
        runs: { type: 'string', default: '3' },
    },
});

const opts = { ...perfDbOptionsFromEnv(), database: String(args.db) };
const db = client(opts);
const seed = JSON.parse(fs.readFileSync(path.resolve('perf/results', `${opts.database}.seed.json`), 'utf8'));
const s: Record<string, string> = seed.samples;
const store = new GraphStore(db);
const access = new AccessService(db);
const desk = new DeskGraph(db, 'http://localhost:8200/');
const batches = new BatchState(db, store);
const tags = new TagsService(db, access);

async function median(fn: () => Promise<unknown>, runs: number): Promise<{ ms: number; result: unknown }> {
    let result = await fn();
    const times: number[] = [];
    for (let i = 0; i < runs; i += 1) {
        const started = performance.now();
        result = await fn();
        times.push(performance.now() - started);
    }
    times.sort((a, b) => a - b);
    return { ms: Math.round(times[Math.floor(times.length / 2)] * 10) / 10, result };
}

function size(result: unknown): string {
    if (Array.isArray(result)) return `${result.length} rows`;
    if (result instanceof Set || result instanceof Map) return `${result.size} items`;
    if (result === null || result === undefined) return 'null';
    if (typeof result === 'object') return 'object';
    return String(result);
}

async function main(): Promise<void> {
    const schemaStarted = performance.now();
    await ensureSchema(db, (m) => console.error(m));
    const schemaMs = Math.round(performance.now() - schemaStarted);
    console.log(`ensureSchema (builds new indexes): ${schemaMs} ms`);

    const deskSets = (await db.rows('SELECT @rid AS rid FROM Set WHERE project_rid = :p AND set IS NULL', { p: s.project })).map((r) => r.rid);
    const outputFiles = await db.rows('SELECT @rid, label, type, path FROM File WHERE set = :s', { s: s.output_set });
    const setFiles = (await db.rows('SELECT @rid AS rid FROM File WHERE set = :s', { s: s.set })).map((r) => r.rid);
    const firstEdge = (await db.edgesOf('out', 'DERIVED_FROM', [s.output_file], ['process_rid']))[0];

    const probes: Array<[string, () => Promise<unknown>]> = [
        ['access.findOwned(file)', () => access.findOwned(s.file, s.user)],
        ['access.findOwned(output)', () => access.findOwned(s.output_file, s.user)],
        ['access.findOwned(other user)', () => access.findOwned(s.file, '#16:999999')],
        ['store.projectRidOf(output)', () => store.projectRidOf(s.output_file)],
        ['store.sourceFileOf(output)', () => store.sourceFileOf(s.output_file)],
        ['store.connectDerivedFrom (existing edge)', () => store.connectDerivedFrom(s.output_file, firstEdge.source, firstEdge.process_rid)],
        ['desk.processedSetRids', () => desk.processedSetRids(deskSets)],
        ['desk.usePdfThumbnail', () => desk.usePdfThumbnail({ type: 'pdf', '@rid': s.output_file })],
        ['batches.processedInputs', () => batches.processedInputs(s.set_process)],
        ['batches.outputFor', () => batches.outputFor(s.set_process, s.file, null)],
        ['batches.processOfSet', () => batches.processOfSet(s.output_set)],
        ['grouping.groupByRootSource (1 000 files)', () => groupByRootSource(db, outputFiles)],
        ['db.rowsByRids (500 files)', () => db.rowsByRids('@rid AS rid, label', setFiles.slice(0, 500), "@type = 'File'")],
        ['delete: edges of a node (both ways)', () => db.edgesOf('both', 'DERIVED_FROM', [s.file], ['process_rid'])],
        ['delete: outputs by process_rid', () => db.rows('SELECT @out AS rid FROM DERIVED_FROM WHERE process_rid = :rid', { rid: s.set_process })],
        ['tags.groupedEntities (project filter)', () => tags.groupedEntities(s.user, { project_rid: s.project })],
        ['tags.setEntities', () => tags.setEntities(s.set, s.user)],
    ];
    const results = [];
    for (const [id, fn] of probes) {
        try {
            const { ms, result } = await median(fn, Number(args.runs));
            results.push({ id, ms, result: size(result) });
            console.log(`${id.padEnd(44)} ${String(ms).padStart(9)} ms  ${size(result)}`);
        } catch (error) {
            results.push({ id, error: (error as Error).message });
            console.log(`${id.padEnd(44)} ERROR ${(error as Error).message.slice(0, 120)}`);
        }
    }
    fs.writeFileSync(path.resolve('perf/results', `${opts.database}.code.${args.label}.json`), JSON.stringify({ database: opts.database, label: args.label, schema_ms: schemaMs, when: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
