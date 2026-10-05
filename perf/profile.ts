// Plan step 1: runs the queries behind the suspected bottlenecks (plan/performance-testing.md
// section 3) against a seeded database, with the statements and parameters the backend uses.
// For each query: median wall time of 3 runs, rows returned, and from ArcadeDB's PROFILE the
// records read and whether it scanned a whole type instead of using an index.
//
//   node dist/perf/profile.js --db perf_profile --label S
//
// Reads the sample rids from perf/results/<db>.seed.json and writes
// perf/results/<db>.profile.<label>.json (plans included) plus a one-line-per-query table on stdout.

import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'messydesk_perf' },
        label: { type: 'string', default: 'run' },
        runs: { type: 'string', default: '3' },
        only: { type: 'string' },
    },
});

const opts = { ...perfDbOptionsFromEnv(), database: String(args.db) };
const db = client(opts);
const seed = JSON.parse(fs.readFileSync(path.resolve('perf/results', `${opts.database}.seed.json`), 'utf8'));
const s: Record<string, string> = seed.samples;

interface Probe {
    id: string;
    bottleneck: string;
    code: string;
    sql: string;
    params?: () => Promise<Record<string, unknown>> | Record<string, unknown>;
}

const deskSets = async () => (await db.rows('SELECT @rid AS rid FROM Set WHERE project_rid = :p AND set IS NULL', { p: s.project })).map((r) => r.rid);
const setFileRids = async (set: string) => (await db.rows('SELECT @rid AS rid FROM File WHERE set = :s', { s: set })).map((r) => r.rid);
const projectFileRids = async () => (await db.rows('SELECT @rid AS rid FROM File WHERE project_rid IN :p', { p: [s.project] })).map((r) => r.rid);
const setCount = async () => Number((await db.first('SELECT count(*) AS c FROM File WHERE set = :s', { s: s.set }))?.c || 0);

const PROBES: Probe[] = [
    {
        id: 'access.findOwned(file)', bottleneck: 'B1', code: 'access/access.ts:28',
        sql: 'MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project}<--{as:node, where:(@rid = :rid), while:($depth < 40)} RETURN node, project.@rid AS project_rid LIMIT 1',
        params: () => ({ user: s.user, rid: s.file }),
    },
    {
        id: 'access.findOwned(output)', bottleneck: 'B1', code: 'access/access.ts:28',
        sql: 'MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project}<--{as:node, where:(@rid = :rid), while:($depth < 40)} RETURN node, project.@rid AS project_rid LIMIT 1',
        params: () => ({ user: s.user, rid: s.output_file }),
    },
    {
        id: 'access.isProjectOwner', bottleneck: '-', code: 'access/access.ts:55',
        sql: 'MATCH {type:Project, as:project, where:(@rid = :rid)}-HAS_OWNER->{type:User, as:p, where:(@rid = :user)} RETURN project.@rid AS rid',
        params: () => ({ rid: s.project, user: s.user }),
    },
    {
        id: 'graphStore.projectRidOf(output)', bottleneck: 'B3', code: 'shared/graph-store.ts:427',
        sql: 'MATCH {type:Project, as:project}<--{as:node, where:(@rid = :rid), while:($depth < 40)} RETURN project.@rid AS rid LIMIT 1',
        params: () => ({ rid: s.output_file }),
    },
    {
        id: 'connectDerivedFrom (WHERE of the UPDATE)', bottleneck: 'B2', code: 'shared/graph-store.ts:413',
        sql: `SELECT @rid FROM DERIVED_FROM WHERE @out = ${s.output_file} AND @in = ${s.file}`,
    },
    {
        id: 'deskGraph.processedSetRids', bottleneck: 'B2', code: 'projects/desk-graph.ts:606',
        sql: 'SELECT DISTINCT @in AS rid FROM DERIVED_FROM WHERE @in IN :rids AND process_rid IS NOT NULL',
        params: async () => ({ rids: await deskSets() }),
    },
    {
        id: 'batches.processedInputs', bottleneck: 'B2', code: 'batches/batch-state.ts:90',
        sql: 'SELECT DISTINCT @in AS rid FROM DERIVED_FROM WHERE process_rid = :rid',
        params: () => ({ rid: s.set_process }),
    },
    {
        id: 'batches.processOfSet', bottleneck: 'B2', code: 'batches/batch-state.ts:107',
        sql: 'SELECT process_rid FROM DERIVED_FROM WHERE @out = :rid AND process_rid IS NOT NULL LIMIT 1',
        params: () => ({ rid: s.output_set }),
    },
    {
        id: 'graph.deleteNode: outputs of node', bottleneck: 'B10', code: 'graph/graph.ts:155',
        sql: 'SELECT @out AS rid, process_rid FROM DERIVED_FROM WHERE @in = :rid',
        params: () => ({ rid: s.file }),
    },
    {
        id: 'graph.deleteNode: edges either way', bottleneck: 'B10', code: 'graph/graph.ts:160',
        sql: 'SELECT process_rid FROM DERIVED_FROM WHERE @in = :rid OR @out = :rid',
        params: () => ({ rid: s.file }),
    },
    {
        id: 'files.source / sourceFileOf', bottleneck: '-', code: 'files/files.ts:177',
        sql: 'MATCH {type:File, as:target, where:(@rid = :rid)}-DERIVED_FROM->{type:File, as:source} RETURN source',
        params: () => ({ rid: s.output_file }),
    },
    {
        id: 'grouping: parents of a set (IN list)', bottleneck: '-', code: 'processing/grouping.ts:63',
        sql: 'SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN :rids',
        params: async () => ({ rids: await setFileRids(s.output_set) }),
    },
    {
        id: 'deskGraph.forProject (desk MATCH)', bottleneck: 'B8', code: 'projects/desk-graph.ts:463',
        sql: `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project, where:(@rid = :project)}.in()
            {as:node, where:((@type="Set" OR @type="File" OR @type="SetProcess" OR @type="Source") AND set IS NULL AND $depth > 0), while:($depth < 20)}
            RETURN node, node.outE() AS edges`,
        params: () => ({ user: s.user, project: s.project }),
    },
    {
        id: 'deskGraph.decorateSets (all members)', bottleneck: 'B8', code: 'projects/desk-graph.ts:563',
        sql: 'SELECT @rid AS rid, set, path, label, type, info, metadata FROM File WHERE set IN :sets ORDER BY label',
        params: async () => ({ sets: await deskSets() }),
    },
    {
        id: 'projects.list (count per project)', bottleneck: 'B9', code: 'projects/projects.ts:79',
        sql: `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project, where:(@rid = :project)}.in()
             {as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source" OR @type="Filter") AND $depth > 0), while:($depth < 40)}
             RETURN DISTINCT node.@rid AS rid, node.@type AS type`,
        params: () => ({ user: s.user, project: s.project }),
    },
    {
        id: 'files.setFiles count', bottleneck: 'B14', code: 'files/files.ts:260',
        sql: 'SELECT count(*) AS file_count FROM File WHERE set = :set',
        params: () => ({ set: s.set }),
    },
    {
        id: 'files.setFiles first page', bottleneck: 'B14', code: 'files/files.ts:261',
        sql: 'SELECT FROM File WHERE set = :set ORDER BY label SKIP :skip LIMIT :limit',
        params: () => ({ set: s.set, skip: 0, limit: 10 }),
    },
    {
        id: 'files.setFiles last page', bottleneck: 'B14', code: 'files/files.ts:261',
        sql: 'SELECT FROM File WHERE set = :set ORDER BY label SKIP :skip LIMIT :limit',
        params: async () => ({ set: s.set, skip: Math.max(0, (await setCount()) - 10), limit: 10 }),
    },
    {
        id: 'set run: setFiles limit 10000', bottleneck: 'B5/B6', code: 'processing/processing.ts:222',
        sql: 'SELECT FROM File WHERE set = :set ORDER BY label SKIP :skip LIMIT :limit',
        params: () => ({ set: s.set, skip: 0, limit: 10000 }),
    },
    {
        id: 'nodes.syncSetManifest items', bottleneck: 'B4', code: 'nodes/nodes.ts:118',
        sql: 'SELECT @rid AS rid, @type AS node, label, path, type FROM File WHERE set = :set',
        params: () => ({ set: s.output_set }),
    },
    {
        id: 'batches.get (SetProcess by @rid)', bottleneck: 'B7', code: 'batches/batch-state.ts:24',
        sql: 'SELECT FROM SetProcess WHERE @rid = :rid LIMIT 1',
        params: () => ({ rid: s.set_process }),
    },
    {
        id: 'batches.get (Process fallback)', bottleneck: 'B7', code: 'batches/batch-state.ts:25',
        sql: 'SELECT FROM Process WHERE @rid = :rid LIMIT 1',
        params: () => ({ rid: s.set_process }),
    },
    {
        id: 'files by @rid IN (grouping, attachSources)', bottleneck: '-', code: 'processing/processing.ts:307',
        sql: 'SELECT @rid AS rid, label, path, type FROM File WHERE @rid IN :rids',
        params: async () => ({ rids: (await setFileRids(s.set)).slice(0, 500) }),
    },
    {
        id: 'graph.deleteNode: processes of batch', bottleneck: 'B10', code: 'graph/graph.ts:165',
        sql: 'SELECT @rid AS rid FROM Process WHERE set_process = :rid',
        params: () => ({ rid: s.set_process }),
    },
    {
        id: 'semantic.indexes (files by type)', bottleneck: 'B18', code: 'semantic/semantic.ts:152',
        sql: 'SELECT @rid AS rid, label, type, path, project_rid, created FROM File WHERE type IN :types AND project_rid IN :projects',
        params: () => ({ types: ['faiss', 'embeddings'], projects: [s.project] }),
    },
    {
        id: 'reindexProject (SetProcess by project)', bottleneck: '-', code: 'processing/processing.ts:494',
        sql: 'SELECT @rid AS process_rid, input_set FROM SetProcess WHERE project_rid IN :projects AND (service_id = "md-solr" OR service = "Solr" OR service = "md-solr" OR topic = "md-solr")',
        params: () => ({ projects: [s.project, s.project.replace('#', '')] }),
    },
    {
        id: 'tags.entityItems / linkedEntities (Entity @rid IN)', bottleneck: '-', code: 'tags/tags.ts:188',
        sql: 'SELECT label, type, @rid AS rid, color, icon FROM Entity WHERE owner = :owner AND @rid IN :entities',
        params: async () => ({ owner: s.user, entities: (await db.rows('SELECT @rid AS rid FROM Entity WHERE owner = :o LIMIT 50', { o: s.user })).map((r) => r.rid) }),
    },
    {
        id: 'tags.groupedEntities (all)', bottleneck: 'B12', code: 'tags/tags.ts:82',
        sql: 'SELECT type, count(type) AS count, LIST(label) AS labels, icon, color, LIST(@this) AS items FROM Entity WHERE owner = :owner GROUP BY type ORDER BY count DESC',
        params: () => ({ owner: s.user }),
    },
    {
        id: 'tags.groupedEntities (project: files)', bottleneck: 'B12', code: 'tags/tags.ts:83',
        sql: 'SELECT @rid AS rid FROM File WHERE project_rid IN :projects',
        params: () => ({ projects: [s.project] }),
    },
    {
        id: 'tags.groupedEntities (project: links IN)', bottleneck: 'B12', code: 'tags/tags.ts:86',
        sql: 'SELECT DISTINCT entity_rid FROM TagLink WHERE target_rid IN :files AND owner = :owner',
        params: async () => ({ files: await projectFileRids(), owner: s.user }),
    },
    {
        id: 'tags.setEntities (links IN)', bottleneck: 'B12', code: 'tags/tags.ts:149',
        sql: 'SELECT entity_rid, count(*) AS count FROM TagLink WHERE target_rid IN :files AND region_id IS NULL AND owner = :owner GROUP BY entity_rid',
        params: async () => ({ files: await setFileRids(s.set), owner: s.user }),
    },
    {
        id: 'tags.findEntity', bottleneck: 'B13', code: 'tags/tags.ts:121',
        sql: 'SELECT FROM Entity WHERE type = :type AND label = :label AND owner = :owner',
        params: () => ({ type: 'Tag', label: 'tag 3', owner: s.user }),
    },
    {
        id: 'tags.machineTags', bottleneck: 'B13', code: 'tags/tags.ts:380',
        sql: 'SELECT service_id, task, entity_rid, count(*) AS count FROM TagLink WHERE created_by = "machine" AND owner = :owner GROUP BY service_id, task, entity_rid',
        params: () => ({ owner: s.user }),
    },
    {
        id: 'tags.createTagLink exists?', bottleneck: '-', code: 'tags/tags.ts:216',
        sql: 'SELECT @rid AS rid FROM TagLink WHERE entity_rid = :e AND target_rid = :t AND region_id IS NULL',
        params: () => ({ e: s.entity, t: s.file }),
    },
    {
        id: 'tags.pruneOrphanMachineTag count', bottleneck: '-', code: 'tags/tags.ts:263',
        sql: 'SELECT count(*) AS count FROM TagLink WHERE entity_rid = :e',
        params: () => ({ e: s.entity }),
    },
];

function summarisePlan(plan: string): { scans: string[]; indexes: string[]; records: number } {
    const scans = [...plan.matchAll(/FETCH FROM (?:TYPE|BUCKET) (\S+)/g)].map((m) => m[1]);
    const indexes = [...plan.matchAll(/FETCH FROM INDEX (\S+)/g)].map((m) => m[1]);
    const records = [...plan.matchAll(/= (\d+) RECORDS/g)].reduce((sum, m) => sum + Number(m[1]), 0);
    return { scans: [...new Set(scans)], indexes: [...new Set(indexes)], records };
}

async function timeQuery(sql: string, params: Record<string, unknown>): Promise<{ ms: number; rows: number }> {
    const started = performance.now();
    const rows = await db.rows(sql, params);
    return { ms: performance.now() - started, rows: rows.length };
}

async function main(): Promise<void> {
    const counts: Record<string, number> = {};
    for (const type of ['User', 'Project', 'Set', 'File', 'SetProcess', 'Entity', 'TagLink', 'DERIVED_FROM', 'BELONGS_TO']) {
        counts[type] = Number((await db.first(`SELECT count(*) AS c FROM ${type}`))?.c || 0);
    }
    const userProjects = (await db.rows('SELECT @rid AS rid FROM (SELECT expand(in("HAS_OWNER")) FROM :u)', { u: s.user })).map((r) => r.rid);
    const userFiles = Number((await db.first('SELECT count(*) AS c FROM File WHERE project_rid IN :ps', { ps: userProjects }))?.c || 0);
    counts.user_projects = userProjects.length;
    counts.user_files = userFiles;
    counts.set_files = await setCount();

    const results = [];
    const runs = Number(args.runs);
    for (const probe of PROBES) {
        if (args.only && !probe.id.includes(String(args.only))) continue;
        const params = probe.params ? await probe.params() : {};
        const times: number[] = [];
        let rows = 0;
        let error: string | null = null;
        try {
            await timeQuery(probe.sql, params); // warm-up
            for (let i = 0; i < runs; i += 1) {
                const t = await timeQuery(probe.sql, params);
                times.push(t.ms);
                rows = t.rows;
            }
        } catch (e) {
            error = (e as Error).message;
        }
        times.sort((a, b) => a - b);
        let plan = '';
        try {
            plan = (await db.first(`PROFILE ${probe.sql}`, params))?.executionPlanAsString || '';
        } catch (e) {
            plan = `PROFILE failed: ${(e as Error).message}`;
        }
        const summary = summarisePlan(plan);
        const inputSize = Object.values(params).reduce((n: number, v) => n + (Array.isArray(v) ? v.length : 0), 0);
        results.push({ ...probe, params: undefined, median_ms: times.length ? Math.round(times[Math.floor(times.length / 2)] * 10) / 10 : null, rows, in_list: inputSize, ...summary, error, plan });
        const line = [probe.bottleneck.padEnd(6), probe.id.padEnd(44), String(results.at(-1)!.median_ms ?? 'ERR').padStart(9), 'ms', String(rows).padStart(7), 'rows', String(summary.records).padStart(9), 'read', summary.scans.length ? `SCAN ${summary.scans.join(',')}` : '', error ? `ERROR ${error.slice(0, 80)}` : ''].join(' ');
        console.log(line);
    }
    const out = { database: opts.database, label: args.label, counts, when: new Date().toISOString(), results };
    fs.writeFileSync(path.resolve('perf/results', `${opts.database}.profile.${args.label}.json`), JSON.stringify(out, null, 2));
    console.log(JSON.stringify(counts));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
