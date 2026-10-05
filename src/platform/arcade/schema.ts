// Database schema: the same types, properties and indexes the old backend created
// (db.mjs createDB/ensureIndexes and graph.mjs initDB). Everything here is idempotent.

import type { ArcadeClient } from './client.ts';

export const VERTEX_TYPES = [
    'Project', 'Source', 'User', 'File', 'Process', 'Set', 'SetProcess', 'Entity', 'EntityType',
    'Request', 'Prompt', 'ErrorNode', 'ServiceGroup', 'Person',
] as const;

export const DOCUMENT_TYPES = ['Usage', 'TagLink'] as const;

// PROCESSED_BY, PRODUCED, HAS_ITEM, HAS_ENTITY, HAS_SET and HAS_SOURCE are no longer used by any
// query (plan/decisions.md A3) but are still created so that a database stays usable by the old
// backend for a rollback.
export const EDGE_TYPES = [
    'PROCESSED_BY', 'PRODUCED', 'HAS_ITEM', 'BELONGS_TO', 'HAS_ENTITY', 'HAS_SET', 'HAS_PROCESS',
    'DERIVED_FROM', 'HAS_OWNER', 'HAS_SOURCE',
] as const;

const CREATED_PROPERTIES = [
    "CREATE PROPERTY Project.label IF NOT EXISTS STRING (mandatory true, notnull true)",
    "CREATE PROPERTY Project.created IF NOT EXISTS DATETIME (readonly, default sysdate('YYYY-MM-DD HH:MM:SS'))",
    "CREATE PROPERTY Process.created IF NOT EXISTS DATETIME (readonly, default sysdate('YYYY-MM-DD HH:MM:SS'))",
    "CREATE PROPERTY SetProcess.created IF NOT EXISTS DATETIME (readonly, default sysdate('YYYY-MM-DD HH:MM:SS'))",
    "CREATE PROPERTY File.created IF NOT EXISTS DATETIME (readonly, default sysdate('YYYY-MM-DD HH:MM:SS'))",
];

const PROPERTIES = [
    'CREATE PROPERTY File.project_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY File.set IF NOT EXISTS STRING',
    'CREATE PROPERTY File.uuid IF NOT EXISTS STRING',
    'CREATE PROPERTY Set.project_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY Entity.owner IF NOT EXISTS STRING',
    'CREATE PROPERTY TagLink.target_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY TagLink.entity_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY TagLink.region_id IF NOT EXISTS STRING',
    'CREATE PROPERTY TagLink.owner IF NOT EXISTS STRING',
    'CREATE PROPERTY ServiceGroup.id IF NOT EXISTS STRING',
    // New (perf/results/step1-query-profile.md): looked up by value, so they get indexes below.
    'CREATE PROPERTY DERIVED_FROM.process_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY Process.set_process IF NOT EXISTS STRING',
    'CREATE PROPERTY Process.project_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY SetProcess.project_rid IF NOT EXISTS STRING',
    'CREATE PROPERTY User.id IF NOT EXISTS STRING',
];

const INDEXES: Array<[string, string, 'UNIQUE' | 'NOTUNIQUE']> = [
    ['File', 'project_rid', 'NOTUNIQUE'],
    ['File', 'set', 'NOTUNIQUE'],
    // New: lets a thumbnail request find its file (ownership check, plan/decisions.md B3).
    ['File', 'uuid', 'NOTUNIQUE'],
    ['Set', 'project_rid', 'NOTUNIQUE'],
    ['Entity', 'owner', 'NOTUNIQUE'],
    ['Project', 'label', 'NOTUNIQUE'],
    ['TagLink', 'target_rid', 'NOTUNIQUE'],
    ['TagLink', 'entity_rid', 'NOTUNIQUE'],
    ['ServiceGroup', 'id', 'UNIQUE'],
    // New: batch resume, cascade delete and grouped-run retries look edges up by process; the
    // delete cascade finds a batch's processes; reindex finds a desk's processes; every request
    // finds its user by id. All are additive: the old backend ignores them.
    ['DERIVED_FROM', 'process_rid', 'NOTUNIQUE'],
    ['Process', 'set_process', 'NOTUNIQUE'],
    ['Process', 'project_rid', 'NOTUNIQUE'],
    ['SetProcess', 'project_rid', 'NOTUNIQUE'],
    ['User', 'id', 'NOTUNIQUE'],
];

async function quietly(fn: () => Promise<unknown>, log: (m: string) => void, label: string): Promise<void> {
    try {
        await fn();
    } catch (error) {
        const message = String((error as Error).message || error);
        if (!message.toLowerCase().includes('already exists')) log(`Schema step failed: ${label}: ${message}`);
    }
}

/** Creates the database when missing. Returns true when it was created now. */
export async function ensureDatabase(db: ArcadeClient, log: (m: string) => void): Promise<boolean> {
    if (await db.databaseExists()) return false;
    await db.createDatabase();
    for (const statement of CREATED_PROPERTIES) {
        // Types must exist before their properties.
        const type = statement.split(' ')[2].split('.')[0];
        await quietly(() => db.sql(`CREATE VERTEX TYPE ${type} IF NOT EXISTS`, undefined, { quiet: true }), log, type);
        await quietly(() => db.sql(statement, undefined, { quiet: true }), log, statement);
    }
    return true;
}

export async function ensureSchema(db: ArcadeClient, log: (m: string) => void): Promise<void> {
    for (const type of VERTEX_TYPES) await quietly(() => db.sql(`CREATE VERTEX TYPE ${type} IF NOT EXISTS`, undefined, { quiet: true }), log, type);
    for (const type of DOCUMENT_TYPES) await quietly(() => db.sql(`CREATE DOCUMENT TYPE ${type} IF NOT EXISTS`, undefined, { quiet: true }), log, type);
    for (const type of EDGE_TYPES) await quietly(() => db.sql(`CREATE EDGE TYPE ${type} IF NOT EXISTS`, undefined, { quiet: true }), log, type);
    for (const statement of PROPERTIES) await quietly(() => db.sql(statement, undefined, { quiet: true }), log, statement);
    for (const [type, property, kind] of INDEXES) await quietly(() => db.ensureIndex(type, property, kind), log, `${type}.${property}`);
}
