// Scenario S5 (plan section 7): run a one-to-one batch over a set with W instant fake consumers,
// against a running backend, and check the bookkeeping afterwards.
//
//   node dist/perf/s5-batch.js --set <rid> --workers 16 [--db perf_profile]
//
// Measures how long the "start batch" request takes (it publishes one job per file inside the
// request), jobs per minute through claim -> result callback -> complete, callback latency as the
// batch proceeds, and then checks: outputs = files, one output per input, processed_files = files,
// status done, and the output set's stored count. Writes perf/results/s5-batch.<label>.json.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { FakeConsumer } from './fake-consumer.ts';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';
import { percentiles, post, rid, sleep } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        set: { type: 'string' },
        workers: { type: 'string', default: '4' },
        db: { type: 'string', default: 'perf_profile' },
        task: { type: 'string', default: 'upper' },
        label: { type: 'string' },
        stall: { type: 'string', default: '120' },
        late: { type: 'boolean', default: false },
    },
});

const db = client({ ...perfDbOptionsFromEnv(), database: String(args.db) });

async function main(): Promise<void> {
    if (!args.set) throw new Error('--set <rid> required (e.g. the set from s1-upload)');
    const setRid = `#${rid(String(args.set))}`;
    const workers = Number(args.workers);
    const topic = `md-perf-${Date.now()}`;
    const consumers = Array.from({ length: workers }, () => new FakeConsumer(topic));
    for (const c of consumers) await c.register();
    const files = Number((await db.first('SELECT count(*) AS c FROM File WHERE set = :s', { s: setRid }))?.c || 0);

    const started = performance.now();
    // --late starts the consumers only after the dispatch request returns, to time it alone.
    let working = args.late ? [] : consumers.map((c) => c.work(0));
    const dispatch = await post(`/api/queue/${topic}/sets/${rid(setRid)}`, { id: args.task, params: {} });
    if (args.late) working = consumers.map((c) => c.work(0));
    const dispatchMs = Math.round(dispatch.ms);
    if (dispatch.status !== 200) console.error(`dispatch: ${dispatch.status} ${dispatch.text.slice(0, 300)}`);

    // The batch: the newest SetProcess whose output set derives from the input set.
    const edges = await db.edgesOf<any>('in', 'DERIVED_FROM', [setRid], ['process_rid']);
    const processes = await db.rowsByRids<any>('@rid AS rid, started_at', edges.map((e) => e.process_rid), "@type = 'SetProcess'");
    processes.sort((a, b) => String(b.started_at).localeCompare(String(a.started_at)));
    const batchRid = processes[0]?.rid;
    const outputSet = edges.find((e) => e.process_rid === batchRid)?.target;
    if (!batchRid) throw new Error('batch not found');

    const progress: Array<{ s: number; processed: number }> = [];
    let lastProcessed = -1;
    let lastChange = performance.now();
    let status = '';
    for (;;) {
        // Read from the database: GET /api/batches/{rid} finds the owner from queue rows, which
        // are removed when the batch finishes.
        const batch = await db.first('SELECT status, processed_files FROM SetProcess WHERE @rid = :r', { r: batchRid });
        const processed = Number(batch?.processed_files ?? 0);
        status = String(batch?.status ?? '');
        const outputs = consumers.reduce((n, c) => n + c.stats.callbacks, 0);
        progress.push({ s: Math.round((performance.now() - started) / 1000), processed });
        if (processed !== lastProcessed || outputs) {
            if (processed !== lastProcessed) lastChange = performance.now();
            lastProcessed = processed;
        }
        if (progress.length % 5 === 0) console.error(`[${progress.at(-1)!.s}s] processed ${processed}/${files}, callbacks ${outputs}, status ${status}`);
        const callbacksDone = outputs >= files;
        if (status === 'done' && callbacksDone) break;
        if (callbacksDone && performance.now() - lastChange > 15000) break; // counters stuck: B7
        if (performance.now() - lastChange > Number(args.stall) * 1000) break;
        await sleep(2000);
    }
    const seconds = (performance.now() - started) / 1000;
    for (const c of consumers) c.stop();
    await Promise.all(working);
    for (const c of consumers) await c.unregister();

    // Bookkeeping checks.
    const outputs = Number((await db.first('SELECT count(*) AS c FROM File WHERE set = :s', { s: outputSet }))?.c || 0);
    // Inputs with an output in this batch (the output set's own edge to the input set left out).
    const sources = (await db.rows('SELECT source, count(*) AS n FROM (SELECT @in AS source FROM DERIVED_FROM WHERE process_rid = :p) GROUP BY source', { p: batchRid }))
        .filter((r) => String(r.source) !== setRid);
    const duplicates = sources.filter((r) => Number(r.n) > 1).length;
    const batchNode = await db.first('SELECT status, processed_files, failed_files, total_files FROM SetProcess WHERE @rid = :r', { r: batchRid });
    const outputSetNode = await db.first('SELECT count FROM Set WHERE @rid = :r', { r: outputSet });

    const callbackMs = consumers.flatMap((c) => c.stats.callbackMs);
    const thirds = [0, 1, 2].map((k) => percentiles(callbackMs.slice(Math.floor((k * callbackMs.length) / 3), Math.floor(((k + 1) * callbackMs.length) / 3))));
    const result = {
        scenario: 'S5 batch one-to-one',
        files, workers, late_consumers: args.late, topic, batch: batchRid, output_set: outputSet,
        dispatch_ms: dispatchMs,
        seconds: Math.round(seconds),
        jobs_per_minute: Math.round((consumers.reduce((n, c) => n + c.stats.callbacks, 0) / seconds) * 60),
        callback_ms: percentiles(callbackMs),
        callback_ms_by_third: thirds,
        claim_ms: percentiles(consumers.flatMap((c) => c.stats.claimMs)),
        complete_ms: percentiles(consumers.flatMap((c) => c.stats.completeMs)),
        callback_errors: consumers.reduce((n, c) => n + c.stats.errors, 0),
        checks: {
            outputs,
            inputs_with_output: sources.length,
            inputs_with_duplicate_outputs: duplicates,
            processed_files: batchNode?.processed_files ?? null,
            failed_files: batchNode?.failed_files ?? null,
            status: batchNode?.status ?? null,
            output_set_count: outputSetNode?.count ?? null,
            ok: outputs === files && sources.length === files && duplicates === 0 && Number(batchNode?.processed_files) === files && batchNode?.status === 'done' && Number(outputSetNode?.count) === files,
        },
        progress,
    };
    fs.writeFileSync(`perf/results/s5-batch.${args.label || `${files}.w${workers}`}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ ...result, progress: undefined }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
