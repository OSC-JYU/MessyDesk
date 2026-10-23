// Compares index lookups with a full scan for the lookups the backend relies on, to catch an
// index that lost entries (seen on ArcadeDB 25.3.1). Prints one line per check.
//
//   PERF_DB_HOST=http://localhost:2484 node dist/perf/check-indexes.js --db perf26

import { parseArgs } from 'node:util';
import { client, perfDbOptionsFromEnv } from './lib/arcade.ts';

const { values: args } = parseArgs({ options: { db: { type: 'string', default: 'perf26' } } });
const db = client({ ...perfDbOptionsFromEnv(), database: String(args.db) });

async function check(type: string, field: string): Promise<void> {
    const groups = await db.rows(`SELECT ${field}.asString() AS k, count(*) AS n FROM ${type} WHERE ${field} IS NOT NULL GROUP BY ${field}.asString()`);
    let missing = 0;
    let keys = 0;
    for (const g of groups) {
        keys += 1;
        const n = Number((await db.first(`SELECT count(*) AS c FROM ${type} WHERE ${field} = :k`, { k: g.k }))?.c || 0);
        if (n !== Number(g.n)) missing += 1;
    }
    console.log(`${type}.${field}: ${keys} keys checked, ${missing} with a different count by index`);
}

await check('TagLink', 'target_rid');
await check('TagLink', 'entity_rid');
await check('TagLink', 'project_rid');
await check('File', 'set');
await check('File', 'project_rid');
