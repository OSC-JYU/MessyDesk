// Scenario S7, autotag part (plan section 7, B11): a batch whose outputs are ner.json files with
// K labels each, on a task with `autotag`, so every output tags its input file K times. An md-solr
// service with an `update_tags` task is registered (as in production), so each tag change goes
// through processing.syncTags. Counts what that leaves behind: Process nodes, md-solr jobs,
// entities and links, and times the batch.
//
//   node dist/perf/s7-autotag.js --db perf_run2 --set <rid> --labels 5 --workers 8

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { FakeConsumer, type FakeOutput } from './fake-consumer.ts';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';
import { call, percentiles, post, rid, sleep, USER } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'perf_run2' },
        set: { type: 'string' },
        labels: { type: 'string', default: '5' },
        vocabulary: { type: 'string', default: '200' },
        workers: { type: 'string', default: '8' },
        label: { type: 'string', default: 'run' },
    },
});

const db = client({ ...perfDbOptionsFromEnv(), database: String(args.db) });
const K = Number(args.labels);
const V = Number(args.vocabulary);

/** ner.json with K regions; labels come from a vocabulary of V, so entities are shared between files. */
function nerOutput(msg: any): FakeOutput {
    const seed = Number(String(msg.file?.['@rid'] || '').split(':')[1] || 0);
    const rois: Record<string, unknown> = {};
    for (let k = 0; k < K; k += 1) rois[`r${k}`] = { label: `ner label ${(seed * 31 + k * 7) % V}`, confidence: 0.5 + k / (2 * K), text: 'x' };
    return { content: JSON.stringify({ rois }), label: `${msg.file?.label || 'file'}.ner.json`, type: 'ner.json', extension: 'json' };
}

async function snapshot(user: string): Promise<Record<string, number>> {
    const n = async (sql: string, params: Record<string, unknown> = {}) => Number((await db.first(sql, params))?.c || 0);
    return {
        process_nodes: await n('SELECT count(*) AS c FROM Process'),
        entities: await n('SELECT count(*) AS c FROM Entity WHERE owner = :u', { u: user }),
        machine_links: await n('SELECT count(*) AS c FROM TagLink WHERE owner = :u AND created_by = "machine"', { u: user }),
    };
}

async function main(): Promise<void> {
    if (!args.set) throw new Error('--set <rid> required');
    const setRid = `#${rid(String(args.set))}`;
    const user = (await db.first('SELECT @rid AS rid FROM User WHERE id = :id', { id: USER }))?.rid;
    const files = Number((await db.first('SELECT count(*) AS c FROM File WHERE set = :s', { s: setRid }))?.c || 0);

    // md-solr as in production, so tag changes are queued as update_tags jobs.
    const solr = new FakeConsumer('md-solr');
    const solrDescriptor = { id: 'md-solr', name: 'Solr', type: 'solr', adapter: 'solr', supported_types: ['text'], supported_formats: ['txt'], tasks: { index: { name: 'Search index', behaviour: 'many-to-one', params: {} }, update_tags: { name: 'Sync tags to search index', params: {} } } };
    const reg = await post('/api/services/register', { source: 'perf', service: solrDescriptor }, { service: true });
    if (reg.status !== 200) throw new Error(`md-solr register: ${reg.status} ${reg.text}`);
    await post(`/api/services/md-solr/adapter/${solr.adapterId}`, { control_url: 'http://localhost:1' }, { service: true });

    const topic = `md-perf-ner-${Date.now()}`;
    const consumers = Array.from({ length: Number(args.workers) }, () => new FakeConsumer(topic, nerOutput));
    for (const c of consumers) await c.register();
    const before = await snapshot(user);
    const started = performance.now();
    const working = consumers.map((c) => c.work(0));
    const dispatch = await post(`/api/queue/${topic}/sets/${rid(setRid)}`, { id: 'ner', params: {} });
    if (dispatch.status !== 200) throw new Error(`dispatch: ${dispatch.status} ${dispatch.text}`);
    for (;;) {
        await sleep(2000);
        const done = consumers.reduce((n, c) => n + c.stats.callbacks + c.stats.errors, 0);
        if (done >= files) break;
        if (Math.round((performance.now() - started) / 1000) % 20 < 2) console.error(`  ${done}/${files} outputs`);
    }
    const seconds = (performance.now() - started) / 1000;
    for (const c of consumers) c.stop();
    await Promise.all(working);
    for (const c of consumers) await c.unregister();
    const after = await snapshot(user);

    const queued = await call('GET', '/api/queue/jobs/active');
    const solrJobs = (Array.isArray(queued.body) ? queued.body : []).filter((j: any) => j.service_id === 'md-solr').reduce((n: number, j: any) => n + Number(j.total_files || 0), 0);
    await call('DELETE', `/api/services/md-solr/adapter/${solr.adapterId}`, { service: true });
    const flush = await call('GET', '/api/queue/md-solr/flush');

    const callbackMs = consumers.flatMap((c) => c.stats.callbackMs);
    const result = {
        scenario: 'S7 autotag', files, labels_per_file: K, vocabulary: V, workers: consumers.length,
        seconds: Math.round(seconds), outputs_per_minute: Math.round((files / seconds) * 60),
        callback_ms: percentiles(callbackMs), callback_errors: consumers.reduce((n, c) => n + c.stats.errors, 0),
        created: {
            process_nodes: after.process_nodes - before.process_nodes,
            entities: after.entities - before.entities,
            machine_links: after.machine_links - before.machine_links,
            md_solr_jobs_listed: solrJobs,
            md_solr_jobs_flushed: flush.body?.deleted ?? null,
        },
    };
    fs.writeFileSync(`perf/results/s7-autotag.${args.label}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
