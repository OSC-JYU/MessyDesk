// Scenario S9 (plan section 7): delete a set (with everything derived from it) or a whole desk
// through the API, time it, and count what is left: nodes and tag links of the desk, and files on
// disk under the desk's directory.
//
//   node dist/perf/s9-delete.js --db perf26 --set <rid>         # DELETE /api/graph/vertices/{set}
//   node dist/perf/s9-delete.js --db perf26 --project <rid>     # DELETE /api/projects/{rid}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';
import { call, rid } from './lib/http.ts';

const { values: args } = parseArgs({
    options: {
        db: { type: 'string', default: 'perf26' },
        set: { type: 'string' },
        project: { type: 'string' },
        label: { type: 'string', default: 'run' },
    },
});

const db = client({ ...perfDbOptionsFromEnv(), database: String(args.db) });

async function snapshot(project: string, projectDir: string): Promise<Record<string, number>> {
    const n = async (sql: string) => Number((await db.first(sql, { p: project }))?.c || 0);
    let files = 0;
    try {
        files = Number(execFileSync('sh', ['-c', `find "${projectDir}" -type f | wc -l`]).toString().trim());
    } catch { files = 0; }
    return {
        project_nodes: await n('SELECT count(*) AS c FROM Project WHERE @rid = :p'),
        files: await n('SELECT count(*) AS c FROM File WHERE project_rid = :p'),
        sets: await n('SELECT count(*) AS c FROM Set WHERE project_rid = :p'),
        set_processes: await n('SELECT count(*) AS c FROM SetProcess WHERE project_rid = :p'),
        processes: await n('SELECT count(*) AS c FROM Process WHERE project_rid = :p'),
        tag_links: await n('SELECT count(*) AS c FROM TagLink WHERE project_rid = :p'),
        files_on_disk: files,
    };
}

async function main(): Promise<void> {
    const target = args.set ? `#${rid(String(args.set))}` : args.project ? `#${rid(String(args.project))}` : '';
    if (!target) throw new Error('--set or --project required');
    const project = args.project ? target : (await db.first('SELECT project_rid FROM Set WHERE @rid = :r', { r: target }))?.project_rid;
    const dataDir = process.env.DATA_DIR || '';
    const projectDir = path.join(dataDir, 'projects', String(project).replace('#', '').replace(':', '_'));
    const before = await snapshot(project, projectDir);
    console.error('before', before);
    const res = args.project
        ? await call('DELETE', `/api/projects/${rid(target)}`)
        : await call('DELETE', `/api/graph/vertices/${rid(target)}`);
    const after = await snapshot(project, projectDir);
    const result = {
        scenario: args.project ? 'S9 delete desk' : 'S9 delete set', target, project,
        status: res.status, seconds: Math.round(res.ms / 100) / 10, deleted: res.body?.deleted ?? null, before, after,
    };
    fs.writeFileSync(`perf/results/s9-delete.${args.label}.json`, JSON.stringify(result, null, 2));
    console.log(JSON.stringify(result, null, 2));
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
