// Entities (tags, people, places...), entity types and TagLink rows that attach entities to files.
//
// TagLink is a document type, not an edge: one row per (entity, file[, region]). `created_by`
// separates manual tags ('user') from Autotag ones ('machine'). A machine-made entity left with no
// links is deleted; user-made entities are kept even when unused.
//
// A user-made (human) tag belongs to desks through DeskTag rows (a document type): a new desk has
// no human tags, and importing a tag into another desk adds a DeskTag for the same entity. Machine
// tags belong to a desk only through the TagLink.project_rid of their links.

import Boom from '@hapi/boom';
import type { ArcadeClient, ArcadeEnvelope } from '../../platform/arcade/client.ts';
import { toRid, tryRid, uuidv7 } from '../../platform/ids.ts';
import { readJsonOrEmpty } from '../../platform/storage/fsutil.ts';
import type { AccessService } from '../access/access.ts';
import { GraphStore } from '../../shared/graph-store.ts';

export const ENTITY_TYPES = [
    { type: 'Tag', icon: 'tag', color: 'blue', label: 'Tag' },
    { type: 'Person', icon: 'account', color: 'rgb(17, 138, 42)', label: 'Person' },
    { type: 'Location', icon: 'map-marker', color: 'green', label: 'Location' },
    { type: 'Theme', icon: 'shape', color: 'rgb(129, 19, 138)', label: 'Theme' },
    { type: 'Quality', icon: 'message-alert', color: 'orange', label: 'Quality' },
    { type: 'Date', icon: 'calendar-range', color: 'rgb(43, 95, 98)', label: 'Date' },
    { type: 'Organisation', icon: 'warehouse', color: 'rgb(40, 19, 163)', label: 'Organisation' },
];

/** Machine tags (autotag) are made with this type, so it must always exist. */
export const PROTECTED_TYPE = 'Tag';
const TYPE_NAME = /^[\p{L}\p{N}][\p{L}\p{N} _-]{0,39}$/u;
const TYPE_COLOR = /^[#\w(),.% -]{1,40}$/;
/** Files per page of the tag view, and the most a client may ask for. */
const ENTITY_ITEMS_PAGE = 24;
const ENTITY_ITEMS_MAX_PAGE = 200;

export interface TagFields {
    tag_label: string[];
    tag_rid: string[];
    tag_created_by: string[];
    tag_confidence: Array<number | string>;
}

/** Sends tag fields to the search index (queued through md-solr, or directly). */
export type TagSync = (fileRid: string, userRid: string, fields: TagFields) => Promise<unknown>;

export interface EntityListOptions {
    project_rid?: unknown;
    project_rids?: unknown;
    created_by?: unknown;
    search?: unknown;
    type?: unknown;
}

export interface LinkMeta {
    region_id?: string | null;
    /** The caller re-syncs the file's search tags itself, once for many links. */
    defer_reindex?: boolean;
    /** The desk of the target, stored on the link so desk filters can use an index. */
    project_rid?: string | null;
    created_by?: 'user' | 'machine';
    /** The user who attached the tag (for machine links, the user whose request started the run). */
    tagged_by?: string | null;
    service_id?: string | null;
    task?: string | null;
    model?: string | null;
    confidence?: number | null;
}

function ridList(values: unknown): string[] {
    const list = Array.isArray(values) ? values : String(values || '').split(',');
    return [...new Set(list.map((v) => tryRid(String(v).trim())).filter((v): v is NonNullable<typeof v> => Boolean(v)))];
}

/** Which run made a machine tag: service, task and model (the model id, when the run had one). */
function runOf(message: any): { service_id: string | null; task: string | null; model: string | null } {
    return { service_id: message.service?.id || null, task: message.task?.id || null, model: message.task?.model?.id || null };
}

export function projectRidsFrom(options: { project_rid?: unknown; project_rids?: unknown }): string[] {
    const raw = Array.isArray(options.project_rids) ? options.project_rids : (options.project_rid ? [options.project_rid] : []);
    return ridList(raw);
}

export class TagsService {
    private readonly db: ArcadeClient;
    private readonly access: AccessService;
    private tagSync: TagSync | null = null;
    private readonly creating = new Map<string, Promise<any | null>>();

    constructor(db: ArcadeClient, access: AccessService) {
        this.db = db;
        this.access = access;
    }

    setTagSync(sync: TagSync): void {
        this.tagSync = sync;
    }

    // ---- entity types --------------------------------------------------------------------

    async createEntityTypes(userRid: string): Promise<void> {
        for (const t of ENTITY_TYPES) {
            await this.db.sql('CREATE VERTEX EntityType CONTENT :content', { content: { owner: userRid, ...t, uuid: uuidv7(), active: true } });
        }
    }

    entityTypeSchema(userRid: string): Promise<any[]> {
        return this.db.rows('SELECT FROM EntityType WHERE owner = :owner ORDER BY type', { owner: userRid });
    }

    /** The user's tag types, shared by all of their desks; with `counts`, how many tags each has and whether it is protected. */
    async entityTypes(userRid: string, counts = false): Promise<any[]> {
        const types = await this.entityTypeSchema(userRid);
        if (!counts) return types;
        const rows = await this.db.rows('SELECT type, count(*) AS count FROM Entity WHERE owner = :owner GROUP BY type', { owner: userRid });
        const byType = new Map(rows.map((r) => [r.type, Number(r.count)]));
        return types.map((t) => ({ ...t, count: byType.get(t.type) || 0, protected: t.type === PROTECTED_TYPE }));
    }

    /** POST /api/entities/types: adds a tag type (name unique per user, ignoring case). */
    async createEntityType(userRid: string, data: { type?: unknown; color?: unknown }): Promise<any> {
        const type = String(data?.type ?? '').trim();
        if (!TYPE_NAME.test(type)) throw Boom.badRequest('A type name is 1-40 characters: letters, numbers, spaces, "_" and "-", starting with a letter or number');
        const color = data?.color === undefined || data.color === null || data.color === '' ? 'blue-grey' : String(data.color).trim();
        if (!TYPE_COLOR.test(color)) throw Boom.badRequest('Invalid colour');
        const existing = await this.entityTypeSchema(userRid);
        if (existing.some((t) => String(t.type).toLowerCase() === type.toLowerCase())) throw Boom.conflict(`The type "${type}" already exists`);
        const content = { owner: userRid, type, label: type, icon: 'tag', color, uuid: uuidv7(), active: true };
        const created = await this.db.sql('CREATE VERTEX EntityType CONTENT :content', { content });
        return created?.result?.[0] ?? content;
    }

    /** DELETE /api/entities/types/{type}: only when no tag (of any desk) has the type; 'Tag' is never deleted. */
    async deleteEntityType(userRid: string, type: string): Promise<{ type: string; deleted: true }> {
        const existing = (await this.entityTypeSchema(userRid)).find((t) => t.type === type);
        if (!existing) throw Boom.notFound('Tag type not found');
        if (type === PROTECTED_TYPE) throw Boom.badRequest(`The type "${PROTECTED_TYPE}" is used by machine tags and cannot be deleted`);
        const count = Number((await this.db.first('SELECT count(*) AS count FROM Entity WHERE owner = :owner AND type = :type', { owner: userRid, type }))?.count || 0);
        if (count > 0) throw Boom.conflict(`The type "${type}" still has ${count} tag${count === 1 ? '' : 's'}. Delete them first.`);
        await this.db.sql('DELETE FROM EntityType WHERE owner = :owner AND type = :type', { owner: userRid, type });
        return { type, deleted: true };
    }

    private async hasType(type: unknown, userRid: string): Promise<boolean> {
        return typeof type === 'string' && (await this.entityTypeSchema(userRid)).some((t) => t.type === type);
    }

    // ---- entities ------------------------------------------------------------------------

    /** Filters shared by the tag lists: desks, who made the tag, and a label search. */
    private entityFilter(userRid: string, options: EntityListOptions): { where: string; params: Record<string, unknown> } {
        const clauses = ["@type = 'Entity'", 'owner = :owner'];
        const params: Record<string, unknown> = { owner: userRid };
        if (options.created_by === 'user' || options.created_by === 'machine') {
            clauses.push('created_by = :createdBy');
            params.createdBy = options.created_by;
        }
        const search = String(options.search ?? '').trim().toLowerCase();
        if (search) {
            clauses.push('label.toLowerCase() LIKE :search');
            params.search = `%${search.replace(/[%_]/g, '')}%`;
        }
        if (options.type) {
            clauses.push('type = :type');
            params.type = String(options.type);
        }
        return { where: clauses.join(' AND '), params };
    }

    /** Entities of the given desks: human tags of their vocabulary and entities linked to their files (both indexed). */
    private async entityRidsInProjects(userRid: string, projects: string[]): Promise<string[]> {
        const linked = await this.db.rows('SELECT DISTINCT entity_rid FROM TagLink WHERE project_rid IN :projects AND owner = :owner', { projects, owner: userRid });
        const vocabulary = await this.db.rows('SELECT DISTINCT entity_rid FROM DeskTag WHERE project_rid IN :projects AND owner = :owner', { projects, owner: userRid });
        return [...new Set([...linked, ...vocabulary].map((r) => r.entity_rid).filter(Boolean))];
    }

    private async inDesk(entityRid: string, projectRid: string): Promise<boolean> {
        const row = await this.db.first('SELECT @rid AS rid FROM DeskTag WHERE project_rid = :p AND entity_rid = :e LIMIT 1', { p: toRid(projectRid), e: toRid(entityRid) });
        return Boolean(row?.rid);
    }

    /** Adds a human tag to a desk's vocabulary. Does nothing when it is already there. */
    private async attachToDesk(entityRid: string, projectRid: string, userRid: string): Promise<boolean> {
        if (await this.inDesk(entityRid, projectRid)) return false;
        await this.db.sql(
            `INSERT INTO DeskTag SET project_rid = :p, entity_rid = :e, owner = :owner, added_by = :adder, created = ${this.db.legacy ? "sysdate('YYYY-MM-DD HH:MM:SS')" : "sysdate().format('YYYY-MM-DD HH:MM:SS')"}`,
            { p: toRid(projectRid), e: toRid(entityRid), owner: userRid, adder: userRid },
        );
        return true;
    }

    /** The desks (rid and label) each entity belongs to through DeskTag. */
    private async desksOf(entityRids: string[]): Promise<Map<string, Array<{ rid: string; label: string }>>> {
        const result = new Map<string, Array<{ rid: string; label: string }>>();
        if (!entityRids.length) return result;
        const rows = await this.db.rows('SELECT entity_rid, project_rid FROM DeskTag WHERE entity_rid IN :entities', { entities: entityRids });
        const projects = await this.db.rowsByRids('@rid AS rid, label', [...new Set(rows.map((r) => r.project_rid).filter(Boolean))], "@type = 'Project' AND _deleting IS NULL");
        const labels = new Map(projects.map((p) => [p.rid, p.label]));
        for (const row of rows) {
            if (!labels.has(row.project_rid)) continue;
            const list = result.get(row.entity_rid) || [];
            if (!list.some((d) => d.rid === row.project_rid)) list.push({ rid: row.project_rid, label: labels.get(row.project_rid) });
            result.set(row.entity_rid, list);
        }
        return result;
    }

    /** Display names of users, by rid. */
    private async userNames(userRids: Iterable<string | null | undefined>): Promise<Map<string, string>> {
        const rids = [...new Set([...userRids].filter((r): r is string => Boolean(r)))];
        const rows = rids.length ? await this.db.rowsByRids('@rid AS rid, label, id', rids, "@type = 'User'") : [];
        return new Map(rows.map((u) => [u.rid, u.label || u.id || u.rid]));
    }

    /**
     * GET /api/entities: the user's tag types with how many tags each has, optionally only tags
     * used on the given desks, made by users or machines, or matching a label search. The tags
     * themselves come from entitiesOfType (plan/decisions.md G3: returning every tag was 21 MB at
     * 100 000 tags).
     */
    async groupedEntities(userRid: string, options: EntityListOptions = {}): Promise<Array<{ type: string; count: number; icon: unknown; color: unknown }>> {
        const projects = projectRidsFrom(options);
        const { where, params } = this.entityFilter(userRid, { ...options, type: undefined });
        let counts: Array<{ type: string; count: number }>;
        if (!projects.length) {
            counts = await this.db.rows(`SELECT type, count(*) AS count FROM Entity WHERE ${where.replace("@type = 'Entity' AND ", '')} GROUP BY type`, params);
        } else {
            const entities = await this.db.rowsByRids<{ type: string }>('type', await this.entityRidsInProjects(userRid, projects), where, params);
            const byType = new Map<string, number>();
            for (const e of entities) byType.set(e.type, (byType.get(e.type) || 0) + 1);
            counts = [...byType.entries()].map(([type, count]) => ({ type, count }));
        }
        const schema = new Map((await this.entityTypeSchema(userRid)).map((t: any) => [t.type, t]));
        const groups = [];
        for (const row of counts) {
            if (!row.type || !Number(row.count)) continue;
            let look: any = schema.get(row.type);
            if (!look) look = await this.db.first('SELECT icon, color FROM Entity WHERE owner = :owner AND type = :type LIMIT 1', { owner: userRid, type: row.type });
            groups.push({ type: row.type, count: Number(row.count), icon: look?.icon ?? null, color: look?.color ?? null });
        }
        return groups.sort((a, b) => b.count - a.count || a.type.localeCompare(b.type));
    }

    /** GET /api/entities/by-type/{type}: one page of a type's tags, sorted by label. */
    async entitiesOfType(userRid: string, type: string, options: EntityListOptions & { skip?: unknown; limit?: unknown } = {}): Promise<{ type: string; total: number; skip: number; limit: number; items: any[] }> {
        const skip = Math.max(0, Number.parseInt(String(options.skip ?? 0), 10) || 0);
        const limit = Math.min(1000, Math.max(1, Number.parseInt(String(options.limit ?? 200), 10) || 200));
        const projects = projectRidsFrom(options);
        const { where, params } = this.entityFilter(userRid, { ...options, type });
        const fields = '@rid, @type, label, type, icon, color, created_by, description';
        if (!projects.length) {
            const local = where.replace("@type = 'Entity' AND ", '');
            const total = Number((await this.db.first(`SELECT count(*) AS c FROM Entity WHERE ${local}`, params))?.c || 0);
            const items = await this.db.rows(`SELECT ${fields} FROM Entity WHERE ${local} ORDER BY label SKIP :skip LIMIT :limit`, { ...params, skip, limit });
            await this.addDesks(items);
            return { type, total, skip, limit, items };
        }
        const all = await this.db.rowsByRids(fields, await this.entityRidsInProjects(userRid, projects), where, params);
        all.sort((a, b) => (String(a.label ?? '') < String(b.label ?? '') ? -1 : String(a.label ?? '') > String(b.label ?? '') ? 1 : 0));
        const items = all.slice(skip, skip + limit);
        await this.addDesks(items);
        return { type, total: all.length, skip, limit, items };
    }

    /** Adds `desks` to the human tags of a page, so the global view can show where a tag belongs. */
    private async addDesks(items: any[]): Promise<void> {
        const human = items.filter((i) => i.created_by !== 'machine' && i['@rid']);
        const desks = await this.desksOf(human.map((i) => i['@rid']));
        for (const item of human) item.desks = desks.get(item['@rid']) || [];
    }

    /**
     * Creates an entity. A user-made one (no `created_by: 'machine'`) is added to the vocabulary of
     * `projectRid`; when the desk already has a human tag with this type and label, that one is returned.
     */
    async createEntity(data: any, userRid: string, projectRid?: string | null): Promise<ArcadeEnvelope | undefined> {
        if (!data?.type || data.type === 'undefined') return undefined;
        if (!data?.label || data.label === 'undefined') return undefined;
        const human = data.created_by !== 'machine';
        if (human && projectRid) {
            const existing = await this.findHumanInDesk(data.type, String(data.label), userRid, projectRid);
            if (existing) return { result: [existing] } as ArcadeEnvelope;
        }
        const schema = await this.db.first('SELECT color, icon FROM EntityType WHERE type = :type AND owner = :owner', { type: data.type, owner: userRid });
        const icon = data.icon || schema?.icon || 'mdi-tag';
        const color = data.color || schema?.color || '#ff8844';
        const content: Record<string, unknown> = {
            uuid: uuidv7(),
            type: data.type,
            label: data.label,
            icon,
            color,
            owner: userRid,
            created_by: human ? 'user' : 'machine',
            creator_rid: userRid,
        };
        if (data.description) content.description = String(data.description);
        const created = await this.db.sql('CREATE VERTEX Entity CONTENT :content', { content });
        const rid = created?.result?.[0]?.['@rid'];
        if (human && projectRid && rid) await this.attachToDesk(rid, projectRid, userRid);
        return created;
    }

    /** The user's tags of type Tag; with a desk, only that desk's human tags. */
    async tags(userRid: string, projectRid?: string | null): Promise<ArcadeEnvelope> {
        const project = projectRid ? tryRid(projectRid) : null;
        if (projectRid && !project) throw Boom.badRequest('Invalid project_rid');
        if (!project) return this.db.sql('SELECT @rid AS rid, label, type, icon, color, description FROM Entity WHERE owner = :owner AND type = "Tag" ORDER BY label', { owner: userRid });
        const rids = await this.deskEntityRids(project, userRid);
        const rows = await this.db.rowsByRids('@rid AS rid, label, type, icon, color, description', rids, '@type = \'Entity\' AND owner = :owner AND type = "Tag"', { owner: userRid });
        rows.sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')));
        return { result: rows } as ArcadeEnvelope;
    }

    async createTag(label: unknown, userRid: string, description?: unknown, projectRid?: string | null): Promise<ArcadeEnvelope | undefined> {
        if (!label) return undefined;
        return this.createEntity({ type: 'Tag', label, description }, userRid, projectRid);
    }

    /** The entities in a desk's vocabulary (human tags). */
    private async deskEntityRids(projectRid: string, userRid: string): Promise<string[]> {
        const rows = await this.db.rows('SELECT DISTINCT entity_rid FROM DeskTag WHERE project_rid = :p AND owner = :owner', { p: toRid(projectRid), owner: userRid });
        return rows.map((r) => r.entity_rid).filter(Boolean);
    }

    /** The human tag with this type and label in the desk's vocabulary. */
    private async findHumanInDesk(type: string, label: string, userRid: string, projectRid: string): Promise<any | null> {
        const rows = await this.db.rows('SELECT FROM Entity WHERE type = :type AND label = :label AND owner = :owner AND created_by = "user"', { type, label, owner: userRid });
        for (const row of rows) if (await this.inDesk(row['@rid'], projectRid)) return row;
        return null;
    }

    /** What a desk calls this tag: its own human tag, else the user's machine tag. */
    private async findEntityForDesk(type: string, label: string, userRid: string, projectRid: string | null): Promise<any | null> {
        if (projectRid) {
            const human = await this.findHumanInDesk(type, label, userRid, projectRid);
            if (human) return human;
        }
        const rows = await this.db.rows('SELECT FROM Entity WHERE type = :type AND label = :label AND owner = :owner AND created_by = "machine"', { type, label, owner: userRid });
        return rows[0] || null;
    }

    /**
     * The user's machine-made tag with this type and label, created when missing. Parallel autotag
     * callbacks with the same new label each created their own copy (162 duplicates in one run of
     * 1 000 files, perf/results/tags.md), so creation is serialised per tag in this process.
     */
    private findOrCreateMachineEntity(type: string, label: string, userRid: string, projectRid: string | null): Promise<any | null> {
        const key = `${userRid}\u0000${projectRid}\u0000${type}\u0000${label}`;
        const pending = this.creating.get(key);
        if (pending) return pending;
        const work = (async () => {
            const found = await this.findEntityForDesk(type, label, userRid, projectRid);
            if (found) return found;
            return (await this.createEntity({ type, label, created_by: 'machine' }, userRid))?.result?.[0] ?? null;
        })().finally(() => this.creating.delete(key));
        this.creating.set(key, work);
        return work;
    }

    /** Creates missing entities and links them all to a file (POST /api/entities/link/{rid}). */
    async createEntitiesAndLink(list: any[], targetRid: string, userRid: string): Promise<any[]> {
        const target = toRid(targetRid);
        const owned = await this.access.findOwned(target, userRid);
        if (!owned) return [];
        const created = [];
        for (const item of list) {
            if (!(await this.hasType(item?.type, userRid))) continue;
            const existing = item?.type && item?.label ? await this.findEntityForDesk(item.type, item.label, userRid, owned.projectRid) : null;
            if (existing) {
                await this.link(existing['@rid'], target, userRid);
            } else {
                const entity = await this.createEntity(item, userRid, owned.projectRid);
                if (entity?.result?.length) await this.link(entity.result[0]['@rid'], target, userRid);
                created.push(entity);
            }
        }
        return created;
    }

    /** Entities linked to a set's files with per-entity file counts. */
    async setEntities(setRid: string, userRid: string): Promise<any[]> {
        const owned = await this.access.findOwned(setRid, userRid);
        if (!owned || owned.node['@type'] !== 'Set') return [];
        const files = await this.db.rows('SELECT @rid AS rid FROM File WHERE set = :set', { set: toRid(setRid) });
        const fileRids = files.map((r) => r.rid).filter(Boolean);
        if (!fileRids.length) return [];
        // A file can have several links to one tag (by hand and by different models): count files.
        const pairs = await this.db.rows(
            'SELECT DISTINCT entity_rid, target_rid FROM TagLink WHERE target_rid IN :files AND region_id IS NULL AND owner = :owner',
            { files: fileRids, owner: userRid },
        );
        const counts = new Map<string, number>();
        for (const p of pairs) if (p.entity_rid) counts.set(p.entity_rid, (counts.get(p.entity_rid) || 0) + 1);
        const links = [...counts.entries()].map(([entity_rid, count]) => ({ entity_rid, count }));
        if (!links.length) return [];
        const entities = await this.db.rowsByRids('@rid AS rid, label, type, icon, color', links.map((l) => l.entity_rid), "@type = 'Entity' AND owner = :owner", { owner: userRid });
        const byRid = new Map(entities.map((e) => [e.rid, e]));
        return links
            .map((l) => {
                const e = byRid.get(l.entity_rid);
                return e ? { rid: e.rid, label: e.label, type: e.type, icon: e.icon, color: e.color, count: l.count } : null;
            })
            .filter(Boolean)
            .sort((a: any, b: any) => (b.count - a.count) || String(a.label).localeCompare(String(b.label)));
    }

    /**
     * Targets that have every one of the entities. Starts from the tag with the fewest
     * links and checks the others against those targets only, so a popular tag does not make it slow.
     */
    private async filesWithAll(entityRids: string[], desk: string, params: Record<string, unknown>): Promise<string[]> {
        const counts = await this.db.rows(`SELECT entity_rid, count(*) AS count FROM TagLink WHERE entity_rid IN :entities AND owner = :owner${desk} GROUP BY entity_rid`, { ...params, entities: entityRids });
        const byEntity = new Map(counts.map((c) => [c.entity_rid, Number(c.count)]));
        if (entityRids.some((e) => !byEntity.get(e))) return [];
        const [rarest, ...others] = [...entityRids].sort((a, b) => byEntity.get(a)! - byEntity.get(b)!);
        let targets = (await this.db.rows(`SELECT DISTINCT target_rid FROM TagLink WHERE entity_rid = :e AND owner = :owner${desk}`, { ...params, e: rarest })).map((r) => r.target_rid).filter(Boolean);
        for (const entity of others) {
            const keep = new Set<string>();
            for (let i = 0; i < targets.length; i += 500) {
                const rows = await this.db.rows(`SELECT DISTINCT target_rid FROM TagLink WHERE entity_rid = :e AND owner = :owner${desk} AND target_rid IN :chunk`, { ...params, e: entity, chunk: targets.slice(i, i + 500) });
                for (const row of rows) keep.add(row.target_rid);
            }
            targets = targets.filter((t: string) => keep.has(t));
            if (!targets.length) return [];
        }
        return targets;
    }

    /**
     * Rids of the files tagged with any (`match: 'or'`, the default) or all (`'and'`) of the
     * entities, in a stable order. Filtered by desk in the query, or links on other desks would count.
     */
    async fileRidsWithEntities(entities: unknown, userRid: string, options: { project_rid?: unknown; project_rids?: unknown; match?: unknown }): Promise<string[]> {
        const entityRids = ridList(entities);
        if (!entityRids.length) return [];
        const projects = projectRidsFrom(options);
        const all = String(options.match || 'or').toLowerCase() === 'and' && entityRids.length > 1;
        const desk = projects.length ? ' AND project_rid IN :projects' : '';
        const params = projects.length ? { owner: userRid, projects } : { owner: userRid };
        const targets = all
            ? await this.filesWithAll(entityRids, desk, params)
            : (await this.db.rows(`SELECT DISTINCT target_rid FROM TagLink WHERE entity_rid IN :entities AND owner = :owner${desk}`, { ...params, entities: entityRids })).map((l) => l.target_rid);
        return [...new Set<string>(targets.filter(Boolean))].sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
    }

    /**
     * One page of the files tagged with any or all of the entities (see fileRidsWithEntities), with
     * thumbnail URLs: { total, skip, limit, items }.
     */
    async entityItems(entities: unknown, userRid: string, options: { project_rid?: unknown; project_rids?: unknown; match?: unknown; skip?: unknown; limit?: unknown }, apiUrl: string): Promise<{ total: number; skip: number; limit: number; items: any[] }> {
        const skip = Math.max(0, Number.parseInt(String(options.skip ?? 0), 10) || 0);
        const limit = Math.min(ENTITY_ITEMS_MAX_PAGE, Math.max(1, Number.parseInt(String(options.limit ?? ENTITY_ITEMS_PAGE), 10) || ENTITY_ITEMS_PAGE));
        const all = await this.fileRidsWithEntities(entities, userRid, options);
        const targets = all.slice(skip, skip + limit);
        if (!targets.length) return { total: all.length, skip, limit, items: [] };
        const projects = projectRidsFrom(options);
        const rows = projects.length
            ? await this.db.rowsByRids('label, info, description, @rid AS rid, path, type', targets, "@type = 'File' AND project_rid IN :projects", { projects })
            : await this.db.rowsByRids('label, info, description, @rid AS rid, path, type', targets, "@type = 'File'");
        const byRid = new Map(rows.map((row) => [row.rid, row]));
        const items = targets.map((rid) => byRid.get(rid)).filter((row): row is NonNullable<typeof row> => Boolean(row));
        for (const item of items) item.thumb = apiUrl + 'api/thumbnails/' + String(item.path || '').split('/').slice(0, -1).join('/');
        return { total: all.length, skip, limit, items };
    }

    /** File-level entities of a node (GET /api/documents/{rid}). */
    async linkedEntities(rid: string, userRid: string): Promise<any[]> {
        const links = await this.db.rows('SELECT entity_rid, tagged_by, created_by FROM TagLink WHERE target_rid = :target AND region_id IS NULL AND owner = :owner', { target: toRid(rid), owner: userRid });
        const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
        if (!entityRids.length) return [];
        const entities = await this.db.rowsByRids('label, type, @rid AS rid, color, icon', entityRids, "@type = 'Entity' AND owner = :owner", { owner: userRid });
        // Who attached each tag by hand (machine links are told apart by their run, not their user).
        const names = await this.userNames(links.map((l) => (l.created_by === 'machine' ? null : l.tagged_by)));
        for (const entity of entities) {
            const by = new Set(links.filter((l) => l.entity_rid === entity.rid && l.created_by !== 'machine' && l.tagged_by).map((l) => l.tagged_by));
            entity.tagged_by = [...by].map((r) => ({ rid: r, name: names.get(r) || r }));
        }
        return entities;
    }

    /** Entities of many files at once, for set listings: Map<fileRid, entity[]>. */
    async entitiesForFiles(fileRids: string[]): Promise<Map<string, any[]>> {
        const result = new Map<string, any[]>();
        if (!fileRids.length) return result;
        const links = await this.db.rows('SELECT target_rid, entity_rid FROM TagLink WHERE target_rid IN :files AND region_id IS NULL', { files: fileRids });
        const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
        const entities = entityRids.length
            ? await this.db.rowsByRids('label, icon, color, @rid AS rid', entityRids, "@type = 'Entity'")
            : [];
        const byRid = new Map(entities.map((e) => [e.rid, e]));
        const seen = new Set<string>();
        for (const link of links) {
            const entity = byRid.get(link.entity_rid);
            const key = `${link.target_rid}\u0000${link.entity_rid}`;
            if (!entity || seen.has(key)) continue;
            seen.add(key);
            if (!result.has(link.target_rid)) result.set(link.target_rid, []);
            result.get(link.target_rid)!.push(entity);
        }
        return result;
    }

    // ---- links ---------------------------------------------------------------------------

    /**
     * One link per tag, file (and region) and maker: the user, or a machine run of one service,
     * task and model. So the same tag from two models shows under both in the machine tag list.
     */
    private async createTagLink(entityRid: string, targetRid: string, userRid: string, meta: LinkMeta = {}): Promise<any> {
        const region = meta.region_id ? String(meta.region_id) : null;
        const createdBy = meta.created_by || 'user';
        const fields: Record<string, string | null> = {
            region_id: region,
            created_by: createdBy,
            service_id: createdBy === 'machine' ? meta.service_id ?? null : null,
            task: createdBy === 'machine' ? meta.task ?? null : null,
            model: createdBy === 'machine' ? meta.model ?? null : null,
        };
        const taggedBy = meta.tagged_by ?? userRid;
        // Two people attaching the same tag to a file keep one link each.
        if (createdBy === 'user') fields.tagged_by = taggedBy;
        const where = ['entity_rid = :e', 'target_rid = :t'];
        const params: Record<string, unknown> = { e: entityRid, t: targetRid };
        for (const [key, value] of Object.entries(fields)) {
            if (value === null) where.push(`${key} IS NULL`);
            else {
                where.push(`${key} = :${key}`);
                params[key] = value;
            }
        }
        const existing = await this.db.first(`SELECT @rid AS rid FROM TagLink WHERE ${where.join(' AND ')}`, params);
        if (existing) return existing;
        return this.db.sql(
            `INSERT INTO TagLink SET entity_rid = :e, target_rid = :t, region_id = :region_id, owner = :owner, tagged_by = :tagged_by, created_by = :created_by, service_id = :service_id, task = :task, model = :model, confidence = :conf, project_rid = :project, created = ${this.db.legacy ? "sysdate('YYYY-MM-DD HH:MM:SS')" : "sysdate().format('YYYY-MM-DD HH:MM:SS')"}`,
            {
                ...fields,
                tagged_by: taggedBy,
                project: meta.project_rid ? toRid(meta.project_rid) : null,
                e: entityRid,
                t: targetRid,
                owner: userRid,
                conf: meta.confidence != null ? String(meta.confidence) : null,
            },
        );
    }

    /** Links an entity to a node. Returns undefined when the entity or node is not the user's. */
    async link(entityRid: string, targetRid: string, userRid: string, meta: LinkMeta = {}): Promise<any> {
        const e = tryRid(entityRid);
        const t = tryRid(targetRid);
        if (!e || !t) return undefined;
        const entity = await this.db.firstByRid('@rid, created_by', e, "@type = 'Entity' AND owner = :owner", { owner: userRid });
        if (!entity) return undefined;
        const owned = await this.access.findOwned(t, userRid);
        if (!owned) return undefined;
        // A human tag can be attached only on desks that have it.
        if (entity.created_by !== 'machine' && !(await this.inDesk(e, owned.projectRid))) return undefined;
        const linked = await this.createTagLink(e, t, userRid, { ...meta, project_rid: owned.projectRid });
        if (!meta.region_id && !meta.defer_reindex) await this.reindexFileTags(t, userRid);
        return linked;
    }

    async unlink(entityRid: string, targetRid: string, userRid: string): Promise<any> {
        const e = tryRid(entityRid);
        const t = tryRid(targetRid);
        if (!e || !t) return undefined;
        const entity = await this.db.firstByRid('@rid', e, "@type = 'Entity' AND owner = :owner", { owner: userRid });
        if (!entity) return undefined;
        const deleted = await this.db.sql('DELETE FROM TagLink WHERE entity_rid = :e AND target_rid = :t AND region_id IS NULL', { e, t });
        await this.reindexFileTags(t, userRid);
        await this.pruneOrphanMachineTag(e);
        return deleted;
    }

    /** Deletes a machine-made entity that has no links left. */
    async pruneOrphanMachineTag(entityRid: string): Promise<void> {
        const e = tryRid(entityRid);
        if (!e) return;
        const entity = await this.db.firstByRid('created_by', e, "@type = 'Entity'");
        if (!entity || entity.created_by !== 'machine') return;
        const count = await this.db.first('SELECT count(*) AS count FROM TagLink WHERE entity_rid = :e', { e });
        if (Number(count?.count || 0) > 0) return;
        await this.db.sql(`DELETE FROM ${e} WHERE @type = 'Entity'`);
    }

    /** Removes the links of deleted nodes and prunes machine entities left without links. */
    async removeLinksOf(targetRids: string[]): Promise<void> {
        if (!targetRids.length) return;
        const affected = new Set<string>();
        for (let i = 0; i < targetRids.length; i += 1000) {
            const targets = targetRids.slice(i, i + 1000);
            for (const row of await this.db.rows('SELECT DISTINCT entity_rid AS rid FROM TagLink WHERE target_rid IN :targets', { targets })) affected.add(row.rid);
            await this.db.sql('DELETE FROM TagLink WHERE target_rid IN :targets', { targets });
        }
        for (const rid of affected) await this.pruneOrphanMachineTag(rid);
    }

    /** Removes the machine links a deleted ner.json run produced on its source file. */
    async removeMachineLinksOfRun(sourceRid: string, serviceId: string | null, task: string | null, model: string | null = null): Promise<void> {
        let where = 'target_rid = :t AND created_by = "machine"';
        const params: Record<string, unknown> = { t: sourceRid };
        if (serviceId) { where += ' AND service_id = :s'; params.s = serviceId; }
        if (task) { where += ' AND task = :task'; params.task = task; }
        if (model) { where += ' AND model = :model'; params.model = model; }
        const affected = await this.db.rows(`SELECT DISTINCT entity_rid AS rid FROM TagLink WHERE ${where}`, params);
        await this.db.sql(`DELETE FROM TagLink WHERE ${where}`, params);
        for (const row of affected) await this.pruneOrphanMachineTag(row.rid);
    }

    /** Recomputes the tag_* search fields of a file from its TagLink rows. Never throws. */
    async reindexFileTags(fileRid: string, userRid: string): Promise<unknown> {
        try {
            const links = await this.db.rows('SELECT entity_rid, created_by, confidence FROM TagLink WHERE target_rid = :t AND region_id IS NULL AND owner = :owner', { t: toRid(fileRid), owner: userRid });
            const fields: TagFields = { tag_label: [], tag_rid: [], tag_created_by: [], tag_confidence: [] };
            if (links.length) {
                const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
                const entities = await this.db.rowsByRids('@rid AS rid, label', entityRids, "@type = 'Entity'");
                const labels = new Map(entities.map((e) => [e.rid, e.label]));
                // One entry per tag: made by the user if any link is, with the best machine confidence.
                const perTag = new Map<string, { createdBy: string; confidence: number }>();
                for (const link of links) {
                    if (!labels.get(link.entity_rid)) continue;
                    const current = perTag.get(link.entity_rid);
                    const createdBy = current?.createdBy === 'user' || (link.created_by || 'user') === 'user' ? 'user' : 'machine';
                    const confidence = Math.max(current?.confidence ?? 0, Number(link.confidence) || 0);
                    perTag.set(link.entity_rid, { createdBy, confidence });
                }
                for (const [rid, tag] of perTag) {
                    fields.tag_label.push(labels.get(rid));
                    fields.tag_rid.push(rid);
                    fields.tag_created_by.push(tag.createdBy);
                    fields.tag_confidence.push(tag.confidence);
                }
            }
            return this.tagSync ? await this.tagSync(toRid(fileRid), userRid, fields) : null;
        } catch {
            return null;
        }
    }

    /**
     * Fills TagLink.project_rid on links made before it was stored (or by the old backend), in
     * the background at startup. Links whose target has no desk get '' so they are not read again.
     */
    async backfillLinkProjects(log: (message: string) => void): Promise<number> {
        if (!(await this.db.first('SELECT @rid FROM TagLink WHERE project_rid IS NULL LIMIT 1'))) return 0;
        // One scan for the targets, then one indexed update per target (target_rid is indexed).
        const targets = (await this.db.rows('SELECT DISTINCT target_rid FROM TagLink WHERE project_rid IS NULL')).map((r) => r.target_rid).filter(Boolean);
        const known = new Map((await this.db.rowsByRids<any>('@rid AS rid, project_rid', targets)).map((r) => [String(r.rid), r.project_rid]));
        const store = new GraphStore(this.db);
        let done = 0;
        for (const target of targets) {
            let project = known.get(String(target)) as string | undefined;
            if (!project && tryRid(target)) project = (await store.projectRidOf(toRid(target))) || undefined;
            const value = project && tryRid(project) ? toRid(project) : '';
            await this.db.sql('UPDATE TagLink SET project_rid = :p WHERE target_rid = :t AND project_rid IS NULL', { p: value, t: target });
            done += 1;
            if (done % 1000 === 0) log(`TagLink desks: ${done}/${targets.length} files`);
        }
        log(`TagLink desks filled for ${targets.length} files`);
        return targets.length;
    }

    // ---- Autotag -------------------------------------------------------------------------

    /**
     * Turns an arrived output file into machine tags on its source file: one entity and one link
     * per distinct label. Two shapes are understood: region files ({rois: {...}}) and whole-document
     * classifications ({result: {category: "x" | ["x", "y"]}}).
     */
    async autotag(outputPath: string, sourceRid: string, message: any, entityType = 'Tag'): Promise<any[]> {
        const parsed = await readJsonOrEmpty(outputPath);
        if (parsed.file_tags && typeof parsed.file_tags === 'object') return this.autotagFiles(parsed.file_tags, message, entityType);
        let regions: any[];
        if (parsed.rois) regions = Object.values(parsed.rois);
        else if (parsed.result && parsed.result.category !== undefined) {
            const cats = Array.isArray(parsed.result.category) ? parsed.result.category : [parsed.result.category];
            regions = cats.filter(Boolean).map((label: string) => ({ label, confidence: null }));
        } else regions = Object.values(parsed);
        if (!regions.length) return [];
        const userRid = message.userId;
        const projectRid = (await this.access.findOwned(sourceRid, userRid))?.projectRid ?? null;
        const best = new Map<string, number | null>();
        for (const region of regions) {
            if (!region?.label) continue;
            const current = best.get(region.label);
            if (current === undefined || (region.confidence ?? 0) > (current ?? 0)) best.set(region.label, region.confidence ?? null);
        }
        const linked = [];
        for (const [label, confidence] of best) {
            const entity = await this.findOrCreateMachineEntity(entityType, label, userRid, projectRid);
            const entityRid = entity?.['@rid'];
            if (!entityRid) continue;
            await this.link(entityRid, sourceRid, userRid, { created_by: 'machine', ...runOf(message), confidence, defer_reindex: true });
            linked.push({ entity_rid: entityRid, label, confidence });
        }
        // One search-index update for all labels, not one per label.
        if (linked.length && tryRid(sourceRid)) await this.reindexFileTags(toRid(sourceRid), userRid);
        return linked;
    }

    /**
     * Tags for several files at once ({file_tags: {"<file rid>": [{label, confidence}]}}), e.g. the
     * topic of each page from a whole-set run. `link` checks that each file is the user's.
     */
    private async autotagFiles(fileTags: Record<string, any>, message: any, entityType: string): Promise<any[]> {
        const userRid = message.userId;
        const entities = new Map<string, string | null>();
        const projects = new Map<string, string | null>();
        const linked = [];
        for (const [target, tags] of Object.entries(fileTags)) {
            if (!tryRid(target) || !Array.isArray(tags)) continue;
            if (!projects.has(target)) projects.set(target, (await this.access.findOwned(target, userRid))?.projectRid ?? null);
            const projectRid = projects.get(target)!;
            for (const tag of tags) {
                const label = typeof tag?.label === 'string' ? tag.label.trim() : '';
                if (!label) continue;
                const key = `${projectRid}\u0000${label}`;
                if (!entities.has(key)) {
                    const entity = await this.findOrCreateMachineEntity(entityType, label, userRid, projectRid);
                    entities.set(key, entity?.['@rid'] || null);
                }
                const entityRid = entities.get(key);
                if (!entityRid) continue;
                const confidence = Number.isFinite(Number(tag.confidence)) ? Number(tag.confidence) : null;
                const done = await this.link(entityRid, target, userRid, { created_by: 'machine', ...runOf(message), confidence, defer_reindex: true });
                if (done) linked.push({ entity_rid: entityRid, target_rid: target, label, confidence });
            }
        }
        for (const target of new Set(linked.map((l) => toRid(l.target_rid)))) await this.reindexFileTags(target, userRid);
        return linked;
    }

    // ---- tag admin (human tags) ----------------------------------------------------------

    private async requireDesk(projectRid: unknown, userRid: string): Promise<string> {
        const clean = tryRid(projectRid);
        if (!clean || !(await this.access.isProjectOwner(clean, userRid))) throw Boom.notFound('Desk not found');
        return toRid(clean);
    }

    /** A user's human tag; machine tags are managed per run, not here. */
    private async humanEntity(entityRid: unknown, userRid: string): Promise<any> {
        const clean = tryRid(entityRid);
        const entity = clean ? await this.db.firstByRid('@rid AS rid, label, type, description, created_by', clean, "@type = 'Entity' AND owner = :owner", { owner: userRid }) : null;
        if (!entity) throw Boom.notFound('Tag not found');
        if (entity.created_by === 'machine') throw Boom.badRequest('Machine tags cannot be changed here');
        return entity;
    }

    /** Files (file-level links) of a tag, optionally only on one desk. */
    private async linkedFiles(entityRid: string, projectRid?: string): Promise<string[]> {
        const rows = await this.db.rows(
            `SELECT DISTINCT target_rid FROM TagLink WHERE entity_rid = :e AND region_id IS NULL${projectRid ? ' AND project_rid = :p' : ''}`,
            projectRid ? { e: entityRid, p: projectRid } : { e: entityRid },
        );
        return rows.map((r) => r.target_rid).filter(Boolean);
    }

    /**
     * Updates the search fields of files after their tags changed. A popular tag is on thousands of
     * files, so above a few hundred it runs after the response.
     */
    private async reindexFiles(targets: string[], userRid: string): Promise<{ files: number; background: boolean }> {
        const run = async () => {
            for (let i = 0; i < targets.length; i += 10) await Promise.all(targets.slice(i, i + 10).map((t) => this.reindexFileTags(t, userRid)));
        };
        if (targets.length > 200) {
            run().catch(() => {});
            return { files: targets.length, background: true };
        }
        await run();
        return { files: targets.length, background: false };
    }

    /** GET /api/entities/{rid}/usage: where a human tag is used, for the rename and delete warnings. */
    async usage(entityRid: string, userRid: string): Promise<any> {
        const entity = await this.humanEntity(entityRid, userRid);
        const desks = (await this.desksOf([entity.rid])).get(entity.rid) || [];
        const links = await this.db.rows('SELECT DISTINCT target_rid, project_rid FROM TagLink WHERE entity_rid = :e AND region_id IS NULL', { e: entity.rid });
        const byDesk = new Map<string, number>();
        for (const link of links) byDesk.set(link.project_rid, (byDesk.get(link.project_rid) || 0) + 1);
        return {
            rid: entity.rid,
            label: entity.label,
            type: entity.type,
            files: new Set(links.map((l) => l.target_rid)).size,
            desks: desks.map((d) => ({ ...d, files: byDesk.get(d.rid) || 0 })),
        };
    }

    /** PATCH /api/entities/{rid}: renames a human tag in every desk that has it. */
    async rename(entityRid: string, data: { label?: unknown; description?: unknown }, userRid: string): Promise<any> {
        const entity = await this.humanEntity(entityRid, userRid);
        const label = String(data?.label ?? entity.label).trim();
        if (!label) throw Boom.badRequest('Label is required');
        if (label !== entity.label) {
            const desks = (await this.desksOf([entity.rid])).get(entity.rid) || [];
            const same = await this.db.rows('SELECT @rid AS rid FROM Entity WHERE type = :type AND label = :label AND owner = :owner AND created_by = "user"', { type: entity.type, label, owner: userRid });
            for (const other of same) {
                if (other.rid === entity.rid) continue;
                for (const desk of desks) if (await this.inDesk(other.rid, desk.rid)) throw Boom.conflict(`The desk "${desk.label}" already has a tag "${label}"`);
            }
        }
        const sets = ['label = :label'];
        const params: Record<string, unknown> = { label };
        if (data?.description !== undefined) {
            sets.push('description = :description');
            params.description = String(data.description ?? '');
        }
        await this.db.sql(`UPDATE ${entity.rid} SET ${sets.join(', ')} WHERE @type = 'Entity'`, params);
        const reindexed = label !== entity.label ? await this.reindexFiles(await this.linkedFiles(entity.rid), userRid) : { files: 0, background: false };
        return { rid: entity.rid, label, reindexed };
    }

    /** POST /api/projects/{rid}/tags: creates a human tag in the desk (or returns the desk's tag with that label). */
    async createInDesk(projectRid: string, data: any, userRid: string): Promise<ArcadeEnvelope | undefined> {
        const project = await this.requireDesk(projectRid, userRid);
        const label = String(data?.label ?? '').trim();
        if (!label) throw Boom.badRequest('Label is required');
        const type = data?.type;
        if (!(await this.hasType(type, userRid))) throw Boom.badRequest('A tag needs one of your tag types');
        return this.createEntity({ type, label, description: data?.description }, userRid, project);
    }

    /** POST /api/projects/{rid}/tags/import: adds tags of another desk (or chosen tags) to this desk, sharing their ids. */
    async importIntoDesk(projectRid: string, data: { entity_rids?: unknown; from_project_rid?: unknown }, userRid: string): Promise<{ imported: number; skipped: number; conflicts: Array<{ rid: string; label: string }> }> {
        const project = await this.requireDesk(projectRid, userRid);
        let rids: string[];
        if (data?.from_project_rid) {
            const from = await this.requireDesk(data.from_project_rid, userRid);
            if (from === project) throw Boom.badRequest('Pick another desk');
            rids = await this.deskEntityRids(from, userRid);
        } else {
            rids = ridList(data?.entity_rids);
        }
        const result = { imported: 0, skipped: 0, conflicts: [] as Array<{ rid: string; label: string }> };
        if (!rids.length) return result;
        const entities = await this.db.rowsByRids('@rid AS rid, label, type', rids, "@type = 'Entity' AND owner = :owner AND created_by = 'user'", { owner: userRid });
        for (const entity of entities) {
            if (await this.inDesk(entity.rid, project)) { result.skipped += 1; continue; }
            // The desk has another tag with the same type and label: sharing both would make two of them.
            if (await this.findHumanInDesk(entity.type, entity.label, userRid, project)) { result.conflicts.push({ rid: entity.rid, label: entity.label }); continue; }
            await this.attachToDesk(entity.rid, project, userRid);
            result.imported += 1;
        }
        return result;
    }

    /** DELETE /api/projects/{rid}/tags/{entity}: takes the tag out of the desk and removes its links there. */
    async removeFromDesk(projectRid: string, entityRid: string, userRid: string): Promise<any> {
        const project = await this.requireDesk(projectRid, userRid);
        const entity = await this.humanEntity(entityRid, userRid);
        if (!(await this.inDesk(entity.rid, project))) throw Boom.notFound('The desk does not have this tag');
        const targets = await this.linkedFiles(entity.rid, project);
        await this.db.sql('DELETE FROM TagLink WHERE entity_rid = :e AND project_rid = :p', { e: entity.rid, p: project });
        await this.db.sql('DELETE FROM DeskTag WHERE entity_rid = :e AND project_rid = :p', { e: entity.rid, p: project });
        const left = await this.db.first('SELECT count(*) AS count FROM DeskTag WHERE entity_rid = :e', { e: entity.rid });
        const deleted = Number(left?.count || 0) === 0;
        if (deleted) {
            await this.db.sql('DELETE FROM TagLink WHERE entity_rid = :e', { e: entity.rid });
            await this.db.sql(`DELETE FROM ${entity.rid} WHERE @type = 'Entity'`);
        }
        return { rid: entity.rid, deleted, reindexed: await this.reindexFiles(targets, userRid) };
    }

    /** DELETE /api/entities/{rid}: deletes a human tag, its links and its place in every desk. */
    async deleteEverywhere(entityRid: string, userRid: string): Promise<any> {
        const entity = await this.humanEntity(entityRid, userRid);
        const targets = await this.linkedFiles(entity.rid);
        await this.db.sql('DELETE FROM TagLink WHERE entity_rid = :e', { e: entity.rid });
        await this.db.sql('DELETE FROM DeskTag WHERE entity_rid = :e', { e: entity.rid });
        await this.db.sql(`DELETE FROM ${entity.rid} WHERE @type = 'Entity'`);
        return { rid: entity.rid, deleted: true, reindexed: await this.reindexFiles(targets, userRid) };
    }

    /** Desks were deleted: their vocabulary goes, and human tags no desk has any more. */
    async removeDeskTags(projectRids: string[]): Promise<void> {
        const projects = projectRids.map((p) => tryRid(p)).filter((p): p is NonNullable<typeof p> => Boolean(p));
        if (!projects.length) return;
        const rows = await this.db.rows('SELECT DISTINCT entity_rid FROM DeskTag WHERE project_rid IN :projects', { projects });
        await this.db.sql('DELETE FROM DeskTag WHERE project_rid IN :projects', { projects });
        for (const row of rows) {
            const left = await this.db.first('SELECT count(*) AS count FROM DeskTag WHERE entity_rid = :e', { e: row.entity_rid });
            if (Number(left?.count || 0) > 0) continue;
            await this.db.sql('DELETE FROM TagLink WHERE entity_rid = :e', { e: row.entity_rid });
            await this.db.sql(`DELETE FROM ${row.entity_rid} WHERE @type = 'Entity' AND created_by = 'user'`);
        }
    }

    /**
     * GET /api/tags/admin: the human tags of a desk (or all of the user's), with the desks they belong to,
     * how many files carry them and who made them.
     */
    async adminList(userRid: string, options: EntityListOptions & { skip?: unknown; limit?: unknown } = {}): Promise<{ total: number; skip: number; limit: number; items: any[] }> {
        const skip = Math.max(0, Number.parseInt(String(options.skip ?? 0), 10) || 0);
        const limit = Math.min(1000, Math.max(1, Number.parseInt(String(options.limit ?? 200), 10) || 200));
        const project = projectRidsFrom(options)[0] || null;
        const { where, params } = this.entityFilter(userRid, { search: options.search, created_by: 'user' });
        const fields = '@rid AS rid, label, type, icon, color, description, creator_rid';
        let total: number;
        let items: any[];
        if (project) {
            const all = await this.db.rowsByRids(fields, await this.deskEntityRids(project, userRid), where, params);
            all.sort((a, b) => String(a.label ?? '').localeCompare(String(b.label ?? '')));
            total = all.length;
            items = all.slice(skip, skip + limit);
        } else {
            const local = where.replace("@type = 'Entity' AND ", '');
            total = Number((await this.db.first(`SELECT count(*) AS c FROM Entity WHERE ${local}`, params))?.c || 0);
            items = await this.db.rows(`SELECT ${fields} FROM Entity WHERE ${local} ORDER BY label SKIP :skip LIMIT :limit`, { ...params, skip, limit });
        }
        const rids = items.map((i) => i.rid);
        const desks = await this.desksOf(rids);
        const names = await this.userNames(items.map((i) => i.creator_rid));
        const links = rids.length
            ? await this.db.rows(`SELECT DISTINCT entity_rid, target_rid FROM TagLink WHERE entity_rid IN :rids AND region_id IS NULL${project ? ' AND project_rid = :p' : ''}`, project ? { rids, p: project } : { rids })
            : [];
        const files = new Map<string, number>();
        for (const link of links) files.set(link.entity_rid, (files.get(link.entity_rid) || 0) + 1);
        for (const item of items) {
            item.desks = desks.get(item.rid) || [];
            item.files = files.get(item.rid) || 0;
            item.creator = item.creator_rid ? { rid: item.creator_rid, name: names.get(item.creator_rid) || item.creator_rid } : null;
        }
        return { total, skip, limit, items };
    }

    /** Machine tags grouped by (service_id, task, model, entity) with link counts, optionally only on the given desks. */
    async machineTags(userRid: string, options: { project_rid?: unknown; project_rids?: unknown } = {}): Promise<any[]> {
        const projects = projectRidsFrom(options);
        const links = await this.db.rows(
            `SELECT service_id, task, model, entity_rid, count(*) AS count FROM TagLink WHERE created_by = "machine" AND owner = :owner${projects.length ? ' AND project_rid IN :projects' : ''} GROUP BY service_id, task, model, entity_rid`,
            projects.length ? { owner: userRid, projects } : { owner: userRid },
        );
        if (!links.length) return [];
        const entities = await this.db.rowsByRids('@rid AS rid, label, description', links.map((l) => l.entity_rid), "@type = 'Entity'");
        const byRid = new Map(entities.map((e) => [e.rid, e]));
        return links
            .map((l) => ({ service_id: l.service_id, task: l.task, model: l.model ?? null, entity_rid: l.entity_rid, label: byRid.get(l.entity_rid)?.label || null, description: byRid.get(l.entity_rid)?.description || null, count: l.count }))
            .filter((r) => r.label)
            .sort((a, b) => String(a.service_id).localeCompare(String(b.service_id)) || String(a.model ?? '').localeCompare(String(b.model ?? '')) || String(a.task).localeCompare(String(b.task)) || String(a.label).localeCompare(String(b.label)));
    }
}
