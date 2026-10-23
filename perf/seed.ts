// Direct loader for performance datasets (plan/performance-testing.md section 4.1).
//
// Writes users, projects, sets, files, pipeline outputs, entities and tag links straight into
// ArcadeDB with the same types, properties and edges the backend creates (upload: nodes.ts
// createOriginalFile; set runs: createSetProcessWithOutput + createProcessFile). No files are
// written to disk; paths are the strings the backend would store.
//
//   node dist/perf/seed.js --db perf_small --users 10 --projects 3 --sets 4 --files 1000 --depth 2 \
//        --entities 500 --links 2 [--drop] [--parallel 1]
//
// Prints progress to stderr and writes perf/results/<db>.seed.json with counts, load time and
// sample rids (the first user's first project, set, file, output file, process) for the
// profiling and load scripts.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { uuidv7 } from '../src/platform/ids.ts';
import { DataLayout } from '../src/platform/storage/layout.ts';
import { client, dropDatabase, json, perfDbOptionsFromEnv, prepareDatabase, sqlScript, str, type PerfDbOptions } from './lib/arcade.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'messydesk_perf' },
        users: { type: 'string', default: '1' },
        'user-offset': { type: 'string', default: '0' },
        projects: { type: 'string', default: '1' },
        sets: { type: 'string', default: '1' },
        files: { type: 'string', default: '100' },
        depth: { type: 'string', default: '1' },
        entities: { type: 'string', default: '0' },
        links: { type: 'string', default: '0' },
        chunk: { type: 'string', default: '100' },
        parallel: { type: 'string', default: '1' },
        drop: { type: 'boolean', default: false },
    },
});

const cfg = {
    users: Number(args.users),
    userOffset: Number(args['user-offset']),
    projects: Number(args.projects),
    sets: Number(args.sets),
    files: Number(args.files),
    depth: Number(args.depth),
    entities: Number(args.entities),
    links: Number(args.links),
    chunk: Number(args.chunk),
    parallel: Number(args.parallel),
};

const opts: PerfDbOptions = { ...perfDbOptionsFromEnv(), database: String(args.db) };
const db = client(opts);
const layout = new DataLayout('data');
const STAGES = [
    { label: 'Rotate', service: 'md-sharp', task: 'rotate', type: 'image', extension: 'jpg' },
    { label: 'OCR', service: 'md-tesseract', task: 'ocr', type: 'text', extension: 'txt' },
    { label: 'Translate', service: 'md-libretranslate', task: 'translate', type: 'text', extension: 'txt' },
    { label: 'NER', service: 'md-gliner2', task: 'ner', type: 'ner.json', extension: 'json' },
    { label: 'Language', service: 'md-lingua', task: 'detect', type: 'text', extension: 'txt' },
];

const counts = { users: 0, projects: 0, sets: 0, files: 0, outputs: 0, processes: 0, entities: 0, links: 0, edges: 0 };
const samples: Record<string, string> = {};
const originalSets = new Map<string, string[]>();
const started = Date.now();
let lastReport = 0;

function report(force = false): void {
    const now = Date.now();
    if (!force && now - lastReport < 5000) return;
    lastReport = now;
    const secs = (now - started) / 1000;
    const nodes = counts.files + counts.outputs;
    console.error(`[${secs.toFixed(0)}s] files ${counts.files} outputs ${counts.outputs} links ${counts.links} (${(nodes / secs).toFixed(0)} file nodes/s)`);
}

async function createOne(statement: string): Promise<string> {
    const row = await db.first(statement);
    if (!row?.['@rid']) throw new Error(`No rid from: ${statement.slice(0, 120)}`);
    return row['@rid'];
}

async function pool<T>(items: T[], size: number, fn: (item: T) => Promise<void>): Promise<void> {
    let next = 0;
    const workers = Array.from({ length: Math.min(size, items.length) }, async () => {
        while (next < items.length) await fn(items[next++]);
    });
    await Promise.all(workers);
}

interface Stage { process: string; outputSet: string; meta: (typeof STAGES)[number] }

async function seedSet(userRid: string, projectRid: string, setIndex: number): Promise<void> {
    const setUuid = uuidv7();
    const setPath = layout.setDir(projectRid, setUuid);
    const setRid = await createOne(`CREATE VERTEX Set CONTENT ${json({ uuid: setUuid, label: `Set ${setIndex + 1}`, project_rid: projectRid, path: setPath, filepath: `${setPath}/set.json`, count: cfg.files, active: true })}`);
    await db.sql(`CREATE EDGE BELONGS_TO FROM ${setRid} TO ${projectRid}`);
    counts.sets += 1;
    counts.edges += 1;
    if (!originalSets.has(projectRid)) originalSets.set(projectRid, []);
    originalSets.get(projectRid)!.push(setRid);

    // The set's pipeline: SetProcess + output set per stage (createSetProcessWithOutput).
    const stages: Stage[] = [];
    let input = setRid;
    for (let d = 0; d < cfg.depth; d += 1) {
        const meta = STAGES[d % STAGES.length];
        const now = new Date().toISOString();
        const process = await createOne(`CREATE VERTEX SetProcess CONTENT ${json({ uuid: uuidv7(), label: meta.label, path: '', service: meta.service, service_id: meta.service, task: meta.task, project_rid: projectRid, status: 'done', processed_files: cfg.files, failed_files: 0, total_files: cfg.files, input_set: input, topic: meta.service, task_id: meta.task, started_at: now, updated_at: now, finished_at: now, active: true })}`);
        await db.sql(`CREATE EDGE BELONGS_TO FROM ${process} TO ${projectRid}`);
        const outUuid = uuidv7();
        const outPath = layout.setDir(projectRid, outUuid);
        const outputSet = await createOne(`CREATE VERTEX Set CONTENT ${json({ uuid: outUuid, label: `${meta.label} output`, project_rid: projectRid, path: outPath, count: cfg.files, active: true })}`);
        await db.sql(`CREATE EDGE DERIVED_FROM FROM ${outputSet} TO ${input} SET process_rid = ${str(process)}, process_id = ${str(process)}, cruncher = ${str(meta.service)}, task = ${str(meta.task)}`);
        counts.processes += 1;
        counts.sets += 1;
        counts.edges += 2;
        stages.push({ process, outputSet, meta });
        input = outputSet;
    }

    // Files and their outputs, one transaction per chunk.
    for (let start = 0; start < cfg.files; start += cfg.chunk) {
        const statements: string[] = [];
        const end = Math.min(cfg.files, start + cfg.chunk);
        for (let i = start; i < end; i += 1) {
            const uuid = uuidv7();
            const label = `page_${String(i + 1).padStart(6, '0')}.jpg`;
            const file = {
                uuid, project_rid: projectRid, type: 'image', extension: 'jpg', label, original_filename: label,
                description: '', info: '', expand: false, metadata: { size: 0.4, width: 2480, height: 3508 }, _active: true,
                path: layout.filePath(projectRid, uuid, 'jpg'), set: setRid,
            };
            statements.push(`LET f${i} = CREATE VERTEX File CONTENT ${json(file)}`);
            statements.push(`CREATE EDGE BELONGS_TO FROM $f${i} TO ${projectRid}`);
            let source = `$f${i}`;
            stages.forEach((stage, d) => {
                const outUuid = uuidv7();
                const text = stage.meta.type === 'text' ? `Sample text of ${label} at stage ${stage.meta.label}. `.repeat(4) : '';
                const out = {
                    uuid: outUuid, project_rid: projectRid, type: stage.meta.type, extension: stage.meta.extension, label: `${label}.${stage.meta.extension}`,
                    description: '', info: text, expand: false, _active: true, path: layout.filePath(projectRid, outUuid, stage.meta.extension), set: stage.outputSet,
                    metadata: { size: 0.01 },
                };
                statements.push(`LET o${i}_${d} = CREATE VERTEX File CONTENT ${json(out)}`);
                statements.push(`CREATE EDGE DERIVED_FROM FROM $o${i}_${d} TO ${source} SET process_rid = ${str(stage.process)}, process_id = ${str(stage.process)}, cruncher = ${str(stage.meta.service)}, task = ${str(stage.meta.task)}`);
                source = `$o${i}_${d}`;
            });
        }
        await sqlScript(opts, statements);
        counts.files += end - start;
        counts.outputs += (end - start) * cfg.depth;
        counts.edges += (end - start) * (1 + cfg.depth);
        report();
    }
}

async function seedTags(userRid: string, projectRid: string): Promise<void> {
    if (!cfg.entities) return;
    const entityRids: string[] = [];
    for (let start = 0; start < cfg.entities; start += 200) {
        const statements: string[] = [];
        const end = Math.min(cfg.entities, start + 200);
        for (let i = start; i < end; i += 1) {
            const machine = i % 2 === 1;
            statements.push(`LET e${i} = CREATE VERTEX Entity CONTENT ${json({ uuid: uuidv7(), type: i % 5 === 0 ? 'Person' : 'Tag', label: `tag ${i}`, icon: 'tag', color: 'blue', owner: userRid, created_by: machine ? 'machine' : 'user' })}`);
        }
        const result = await sqlScript(opts, statements, `[${Array.from({ length: end - start }, (_, k) => `$e${start + k}.@rid`).join(', ')}]`);
        entityRids.push(...(result?.result || []).flatMap((r: any) => r.value ?? []));
        counts.entities += end - start;
    }
    if (!cfg.links) return;
    // Links on the uploaded files of the project (TagLink is a document, no edges).
    const files = await db.rows('SELECT @rid AS rid FROM File WHERE project_rid = :p AND set IN :sets', { p: projectRid, sets: originalSets.get(projectRid) || [] });
    let n = 0;
    for (let start = 0; start < files.length; start += cfg.chunk) {
        const statements: string[] = [];
        for (const f of files.slice(start, start + cfg.chunk)) {
            for (let k = 0; k < cfg.links; k += 1) {
                const entity = entityRids[(n * 7 + k * 13) % entityRids.length];
                n += 1;
                const machine = k % 2 === 1;
                statements.push(`INSERT INTO TagLink CONTENT ${json({ entity_rid: entity, target_rid: f.rid, region_id: null, owner: userRid, created_by: machine ? 'machine' : 'user', service_id: machine ? 'md-gliner2' : null, task: machine ? 'ner' : null, confidence: machine ? '0.9' : null })}`);
                counts.links += 1;
            }
        }
        if (statements.length) await sqlScript(opts, statements);
        report();
    }
}

async function seedUser(u: number): Promise<void> {
    const id = u === 0 ? 'perf.user@localhost' : `perf.user${u}@localhost`;
    // An existing user gets more projects (to grow one user's data between profiling runs).
    const existing = await db.first('SELECT @rid AS rid FROM User WHERE id = :id', { id });
    const userRid = existing?.rid || await createOne(`CREATE VERTEX User CONTENT ${json({ uuid: uuidv7(), id, label: `Perf user ${u}`, access: 'user', active: true })}`);
    if (!existing) counts.users += 1;
    for (let p = 0; p < cfg.projects; p += 1) {
        const projectRid = await createOne(`CREATE VERTEX Project CONTENT ${json({ uuid: uuidv7(), label: `Perf project ${p + 1}`, expiration_date: '2027-12-31', active: true })}`);
        await db.sql(`CREATE EDGE HAS_OWNER FROM ${projectRid} TO ${userRid}`);
        counts.projects += 1;
        for (let s = 0; s < cfg.sets; s += 1) await seedSet(userRid, projectRid, s);
        await seedTags(userRid, projectRid);
    }
}

/** Sample rids from the first seeded user's first project, for the profiling and load scripts. */
async function collectSamples(): Promise<void> {
    const id = cfg.userOffset === 0 ? 'perf.user@localhost' : `perf.user${cfg.userOffset}@localhost`;
    const user = await db.first('SELECT @rid AS rid FROM User WHERE id = :id', { id });
    if (!user) return;
    samples.user = user.rid;
    const project = await db.first('SELECT @rid AS rid FROM (SELECT expand(in("HAS_OWNER")) FROM :u) ORDER BY @rid LIMIT 1', { u: user.rid });
    if (!project) return;
    samples.project = project.rid;
    const set = await db.first('SELECT @rid AS rid FROM Set WHERE project_rid = :p AND label = "Set 1"', { p: project.rid });
    if (set) samples.set = set.rid;
    const file = set && await db.first('SELECT @rid AS rid FROM File WHERE set = :s ORDER BY label LIMIT 1', { s: set.rid });
    if (file) samples.file = file.rid;
    let cursor = file?.rid;
    for (let d = 0; cursor && d < cfg.depth; d += 1) {
        const edge = await db.first('SELECT @out AS rid, process_rid FROM DERIVED_FROM WHERE @in = :r AND @out.@type = "File"', { r: cursor });
        if (!edge) break;
        cursor = edge.rid;
        samples.output_file = edge.rid;
        if (d === 0) samples.set_process = edge.process_rid;
    }
    const outputSet = samples.output_file && await db.first('SELECT set FROM :r', { r: samples.output_file });
    if (outputSet?.set) samples.output_set = outputSet.set;
    const entity = await db.first('SELECT @rid AS rid FROM Entity WHERE owner = :u LIMIT 1', { u: user.rid });
    if (entity) samples.entity = entity.rid;
}

async function main(): Promise<void> {
    if (args.drop) await dropDatabase(opts);
    await prepareDatabase(db);
    const users = Array.from({ length: cfg.users }, (_, i) => cfg.userOffset + i);
    await pool(users, cfg.parallel, seedUser);
    report(true);
    await collectSamples();
    const result = { database: opts.database, config: cfg, counts, samples, seconds: Math.round((Date.now() - started) / 1000), finished: new Date().toISOString() };
    const dir = path.resolve('perf/results');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${opts.database}.seed${cfg.userOffset ? `.${cfg.userOffset}` : ''}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
