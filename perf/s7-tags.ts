// Scenario S7 (plan section 7): tags at scale. Grows one user's entities and TagLinks directly in
// ArcadeDB in steps, and after each step times the tag calls the UI makes, over HTTP against a
// running backend: the tags page (/api/entities with and without a desk filter, /api/tags,
// /api/tags/machine), tagged files of an entity, a set's tag summary, a file's tags, a set page
// with tags, and tagging and untagging one file.
//
//   node dist/perf/s7-tags.js --db perf_run2 --steps 1000:10000,10000:100000,100000:1000000
//
// Each step is "entities:links" in total for the user. Links go on the files of the user's first
// project, half made by users, half by machine (md-gliner2/ner). Writes perf/results/s7-tags.json.

import fs from 'node:fs';
import { parseArgs } from 'node:util';
import { uuidv7 } from '../src/platform/ids.ts';
import { client, json, perfDbOptionsFromEnv, sqlScript, type PerfDbOptions } from './lib/arcade.ts';
import { call, get, percentiles, rid, USER } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'perf_run2' },
        steps: { type: 'string', default: '1000:10000,10000:100000,100000:1000000' },
        runs: { type: 'string', default: '5' },
        label: { type: 'string', default: 'run' },
    },
});

const opts: PerfDbOptions = { ...perfDbOptionsFromEnv(), database: String(args.db) };
const db = client(opts);
const TYPES = ['Tag', 'Tag', 'Tag', 'Person', 'Location', 'Theme', 'Organisation', 'Date'];

async function counts(user: string): Promise<{ entities: number; links: number }> {
    const e = await db.first('SELECT count(*) AS c FROM Entity WHERE owner = :u', { u: user });
    const l = await db.first('SELECT count(*) AS c FROM TagLink WHERE owner = :u', { u: user });
    return { entities: Number(e?.c || 0), links: Number(l?.c || 0) };
}

async function growEntities(user: string, from: number, to: number): Promise<void> {
    for (let start = from; start < to; start += 500) {
        const statements: string[] = [];
        for (let i = start; i < Math.min(to, start + 500); i += 1) {
            statements.push(`CREATE VERTEX Entity CONTENT ${json({ uuid: uuidv7(), type: TYPES[i % TYPES.length], label: `perf tag ${i}`, icon: 'tag', color: 'blue', owner: user, created_by: i % 2 ? 'machine' : 'user' })}`);
        }
        await sqlScript(opts, statements);
    }
}

async function growLinks(user: string, entities: string[], files: string[], from: number, to: number): Promise<void> {
    // Link n goes to file n % files and entity (n * 7919) % entities: spread, no duplicates as long
    // as links stay below files × entities.
    for (let start = from; start < to; start += 1000) {
        const statements: string[] = [];
        for (let n = start; n < Math.min(to, start + 1000); n += 1) {
            const machine = n % 2 === 1;
            statements.push(`INSERT INTO TagLink CONTENT ${json({
                entity_rid: entities[(n * 7919) % entities.length], target_rid: files[n % files.length], region_id: null, owner: user,
                created_by: machine ? 'machine' : 'user', service_id: machine ? 'md-gliner2' : null, task: machine ? 'ner' : null, confidence: machine ? '0.9' : null,
            })}`);
        }
        await sqlScript(opts, statements);
        if ((start / 1000) % 50 === 0) console.error(`  links ${start}/${to}`);
    }
}

async function time(name: string, fn: () => Promise<{ status: number; text: string; ms: number }>, runs: number): Promise<any> {
    const ms: number[] = [];
    let status = 0;
    let bytes = 0;
    await fn();
    for (let i = 0; i < runs; i += 1) {
        const res = await fn();
        ms.push(res.ms);
        status = res.status;
        bytes = res.text.length;
    }
    const p = percentiles(ms);
    console.log(`  ${name.padEnd(40)} p50 ${String(p.p50).padStart(7)} ms  max ${String(p.max).padStart(7)} ms  ${String(Math.round(bytes / 1024)).padStart(8)} KB  ${status}`);
    return { name, status, kb: Math.round(bytes / 1024), ...p };
}

async function main(): Promise<void> {
    const user = (await db.first('SELECT @rid AS rid FROM User WHERE id = :id', { id: USER }))?.rid;
    if (!user) throw new Error(`user ${USER} not found; run s1-upload first`);
    // The user's biggest project.
    const projects = (await db.rows('SELECT @rid AS rid FROM (SELECT expand(in("HAS_OWNER")) FROM :u)', { u: user })).map((r) => r.rid);
    let project = projects[0];
    let most = -1;
    for (const p of projects) {
        const n = Number((await db.first('SELECT count(*) AS c FROM File WHERE project_rid = :p', { p }))?.c || 0);
        if (n > most) { most = n; project = p; }
    }
    const set = (await db.first('SELECT @rid AS rid, count FROM Set WHERE project_rid = :p ORDER BY count DESC LIMIT 1', { p: project }))?.rid;
    const files = (await db.rows('SELECT @rid AS rid FROM File WHERE project_rid = :p', { p: project })).map((r) => r.rid);
    const firstFile = (await db.first('SELECT @rid AS rid FROM File WHERE set = :s ORDER BY label LIMIT 1', { s: set }))?.rid;
    console.error(`user ${user}, project ${project} (${files.length} files), set ${set}`);
    const runs = Number(args.runs);
    const results = [];

    for (const step of String(args.steps).split(',')) {
        const [wantEntities, wantLinks] = step.split(':').map(Number);
        let now = await counts(user);
        const grow = performance.now();
        if (now.entities < wantEntities) await growEntities(user, now.entities, wantEntities);
        const entities = (await db.rows('SELECT @rid AS rid FROM Entity WHERE owner = :u', { u: user })).map((r) => r.rid);
        if (now.links < wantLinks) await growLinks(user, entities, files, now.links, wantLinks);
        now = await counts(user);
        console.log(`step: ${now.entities} entities, ${now.links} links (${files.length} files; loaded in ${Math.round((performance.now() - grow) / 1000)} s)`);

        const linked = (await db.rows('SELECT entity_rid FROM TagLink WHERE target_rid = :t AND owner = :u LIMIT 5', { t: firstFile, u: user })).map((r) => r.entity_rid);
        const someEntities = linked.length ? linked : entities.slice(0, 5);
        // A user-made tag: unlinking a machine tag's last link deletes the tag.
        const fresh = (await db.first('SELECT @rid AS rid FROM Entity WHERE owner = :u AND created_by = "user" AND label = :l', { u: user, l: 'perf tag 2' }))?.rid;
        const timings = [
            await time('GET /api/entities', () => get('/api/entities'), runs),
            await time('GET /api/entities?project_rid', () => get(`/api/entities?project_rid=${encodeURIComponent(project)}`), runs),
            await time('GET /api/tags', () => get('/api/tags'), runs),
            await time('GET /api/tags/machine', () => get('/api/tags/machine'), runs),
            await time('GET /api/entities/items (5 tags)', () => get(`/api/entities/items?entities=${someEntities.map(rid).join(',')}`), runs),
            await time('GET /api/entities/sets/{set}', () => get(`/api/entities/sets/${rid(set)}`), runs),
            await time('GET /api/documents/{file}', () => get(`/api/documents/${rid(firstFile)}`), runs),
            await time('GET /api/sets/{set}/files?thumbnails', () => get(`/api/sets/${rid(set)}/files?skip=0&limit=10&thumbnails=true`), runs),
            await time('tag + untag one file', async () => {
                const a = await call('POST', `/api/entities/${rid(fresh)}/vertex/${rid(firstFile)}`);
                const b = await call('DELETE', `/api/entities/${rid(fresh)}/vertex/${rid(firstFile)}`);
                return { status: Math.max(a.status, b.status), text: '', ms: a.ms + b.ms };
            }, runs),
        ];
        results.push({ entities: now.entities, links: now.links, files: files.length, timings });
    }
    fs.writeFileSync(`perf/results/s7-tags.${args.label}.json`, JSON.stringify({ database: opts.database, when: new Date().toISOString(), results }, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
