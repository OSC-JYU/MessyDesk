// Entities (tags, people, places...), entity types and TagLink rows that attach entities to files.
//
// TagLink is a document type, not an edge: one row per (entity, file[, region]). `created_by`
// separates manual tags ('user') from Autotag ones ('machine'). A machine-made entity left with no
// links is deleted; user-made entities are kept even when unused.

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
    service_id?: string | null;
    task?: string | null;
    confidence?: number | null;
}

function ridList(values: unknown): string[] {
    const list = Array.isArray(values) ? values : String(values || '').split(',');
    return [...new Set(list.map((v) => tryRid(String(v).trim())).filter((v): v is NonNullable<typeof v> => Boolean(v)))];
}

export function projectRidsFrom(options: { project_rid?: unknown; project_rids?: unknown }): string[] {
    const raw = Array.isArray(options.project_rids) ? options.project_rids : (options.project_rid ? [options.project_rid] : []);
    return ridList(raw);
}

export class TagsService {
    private readonly db: ArcadeClient;
    private readonly access: AccessService;
    private tagSync: TagSync | null = null;

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

    /** Entities linked to files of the given desks (TagLink.project_rid, indexed). */
    private async entityRidsInProjects(userRid: string, projects: string[]): Promise<string[]> {
        const rows = await this.db.rows('SELECT DISTINCT entity_rid FROM TagLink WHERE project_rid IN :projects AND owner = :owner', { projects, owner: userRid });
        return rows.map((r) => r.entity_rid).filter(Boolean);
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
            return { type, total, skip, limit, items };
        }
        const all = await this.db.rowsByRids(fields, await this.entityRidsInProjects(userRid, projects), where, params);
        all.sort((a, b) => (String(a.label ?? '') < String(b.label ?? '') ? -1 : String(a.label ?? '') > String(b.label ?? '') ? 1 : 0));
        return { type, total: all.length, skip, limit, items: all.slice(skip, skip + limit) };
    }

    async createEntity(data: any, userRid: string): Promise<ArcadeEnvelope | undefined> {
        if (!data?.type || data.type === 'undefined') return undefined;
        if (!data?.label || data.label === 'undefined') return undefined;
        const schema = await this.db.first('SELECT color, icon FROM EntityType WHERE type = :type', { type: data.type });
        const icon = data.icon || schema?.icon || 'mdi-tag';
        const color = data.color || schema?.color || '#ff8844';
        const content: Record<string, unknown> = {
            uuid: uuidv7(),
            type: data.type,
            label: data.label,
            icon,
            color,
            owner: userRid,
            created_by: data.created_by === 'machine' ? 'machine' : 'user',
        };
        if (data.description) content.description = String(data.description);
        return this.db.sql('CREATE VERTEX Entity CONTENT :content', { content });
    }

    tags(userRid: string): Promise<ArcadeEnvelope> {
        return this.db.sql('SELECT @rid AS rid, label, type, icon, color, description FROM Entity WHERE owner = :owner AND type = "Tag" ORDER BY label', { owner: userRid });
    }

    async createTag(label: unknown, userRid: string, description?: unknown): Promise<ArcadeEnvelope | undefined> {
        if (!label) return undefined;
        return this.createEntity({ type: 'Tag', label, description }, userRid);
    }

    private async findEntity(type: string, label: string, userRid: string): Promise<any | null> {
        const row = await this.db.first('SELECT FROM Entity WHERE type = :type AND label = :label AND owner = :owner', { type, label, owner: userRid });
        return row || null;
    }

    /** Creates missing entities and links them all to a file (POST /api/entities/link/{rid}). */
    async createEntitiesAndLink(list: any[], targetRid: string, userRid: string): Promise<any[]> {
        const target = toRid(targetRid);
        const created = [];
        for (const item of list) {
            const existing = item?.type && item?.label ? await this.findEntity(item.type, item.label, userRid) : null;
            if (existing) {
                await this.link(existing['@rid'], target, userRid);
            } else {
                const entity = await this.createEntity(item, userRid);
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
        const links = await this.db.rows(
            'SELECT entity_rid, count(*) AS count FROM TagLink WHERE target_rid IN :files AND region_id IS NULL AND owner = :owner GROUP BY entity_rid',
            { files: fileRids, owner: userRid },
        );
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

    /** Files tagged with any of the entities (first 20 links), with thumbnail URLs. */
    async entityItems(entities: unknown, userRid: string, options: { project_rid?: unknown; project_rids?: unknown }, apiUrl: string): Promise<any[]> {
        const entityRids = ridList(entities);
        if (!entityRids.length) return [];
        const links = await this.db.rows('SELECT DISTINCT target_rid FROM TagLink WHERE entity_rid IN :entities AND owner = :owner LIMIT 20', { entities: entityRids, owner: userRid });
        const targets = links.map((l) => l.target_rid).filter(Boolean);
        if (!targets.length) return [];
        const projects = projectRidsFrom(options);
        const items = projects.length
            ? await this.db.rowsByRids('label, info, description, @rid AS rid, path, type', targets, "@type = 'File' AND project_rid IN :projects", { projects })
            : await this.db.rowsByRids('label, info, description, @rid AS rid, path, type', targets, "@type = 'File'");
        for (const item of items) item.thumb = apiUrl + 'api/thumbnails/' + String(item.path || '').split('/').slice(0, -1).join('/');
        return items;
    }

    /** File-level entities of a node (GET /api/documents/{rid}). */
    async linkedEntities(rid: string, userRid: string): Promise<any[]> {
        const links = await this.db.rows('SELECT entity_rid FROM TagLink WHERE target_rid = :target AND region_id IS NULL AND owner = :owner', { target: toRid(rid), owner: userRid });
        const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
        if (!entityRids.length) return [];
        return this.db.rowsByRids('label, type, @rid AS rid, color, icon', entityRids, "@type = 'Entity' AND owner = :owner", { owner: userRid });
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
        for (const link of links) {
            const entity = byRid.get(link.entity_rid);
            if (!entity) continue;
            if (!result.has(link.target_rid)) result.set(link.target_rid, []);
            result.get(link.target_rid)!.push(entity);
        }
        return result;
    }

    // ---- links ---------------------------------------------------------------------------

    private async createTagLink(entityRid: string, targetRid: string, userRid: string, meta: LinkMeta = {}): Promise<any> {
        const region = meta.region_id || null;
        const existing = region
            ? await this.db.first('SELECT @rid AS rid FROM TagLink WHERE entity_rid = :e AND target_rid = :t AND region_id = :r', { e: entityRid, t: targetRid, r: String(region) })
            : await this.db.first('SELECT @rid AS rid FROM TagLink WHERE entity_rid = :e AND target_rid = :t AND region_id IS NULL', { e: entityRid, t: targetRid });
        if (existing) return existing;
        return this.db.sql(
            `INSERT INTO TagLink SET entity_rid = :e, target_rid = :t, region_id = :r, owner = :owner, created_by = :createdBy, service_id = :serviceId, task = :taskId, confidence = :conf, project_rid = :project, created = ${this.db.legacy ? "sysdate('YYYY-MM-DD HH:MM:SS')" : "sysdate().format('YYYY-MM-DD HH:MM:SS')"}`,
            {
                project: meta.project_rid ? toRid(meta.project_rid) : null,
                e: entityRid,
                t: targetRid,
                r: region === null ? null : String(region),
                owner: userRid,
                createdBy: meta.created_by || 'user',
                serviceId: meta.service_id ?? null,
                taskId: meta.task ?? null,
                conf: meta.confidence != null ? String(meta.confidence) : null,
            },
        );
    }

    /** Links an entity to a node. Returns undefined when the entity or node is not the user's. */
    async link(entityRid: string, targetRid: string, userRid: string, meta: LinkMeta = {}): Promise<any> {
        const e = tryRid(entityRid);
        const t = tryRid(targetRid);
        if (!e || !t) return undefined;
        const entity = await this.db.firstByRid('@rid', e, "@type = 'Entity' AND owner = :owner", { owner: userRid });
        if (!entity) return undefined;
        const owned = await this.access.findOwned(t, userRid);
        if (!owned) return undefined;
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
        const affected = await this.db.rows('SELECT DISTINCT entity_rid AS rid FROM TagLink WHERE target_rid IN :targets', { targets: targetRids });
        await this.db.sql('DELETE FROM TagLink WHERE target_rid IN :targets', { targets: targetRids });
        for (const row of affected) await this.pruneOrphanMachineTag(row.rid);
    }

    /** Removes the machine links a deleted ner.json run produced on its source file. */
    async removeMachineLinksOfRun(sourceRid: string, serviceId: string | null, task: string | null): Promise<void> {
        let where = 'target_rid = :t AND created_by = "machine"';
        const params: Record<string, unknown> = { t: sourceRid };
        if (serviceId) { where += ' AND service_id = :s'; params.s = serviceId; }
        if (task) { where += ' AND task = :task'; params.task = task; }
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
                for (const link of links) {
                    const label = labels.get(link.entity_rid);
                    if (!label) continue;
                    fields.tag_label.push(label);
                    fields.tag_rid.push(link.entity_rid);
                    fields.tag_created_by.push(link.created_by || 'user');
                    fields.tag_confidence.push(link.confidence != null ? link.confidence : 0);
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
        const best = new Map<string, number | null>();
        for (const region of regions) {
            if (!region?.label) continue;
            const current = best.get(region.label);
            if (current === undefined || (region.confidence ?? 0) > (current ?? 0)) best.set(region.label, region.confidence ?? null);
        }
        const linked = [];
        for (const [label, confidence] of best) {
            let entity = await this.findEntity(entityType, label, userRid);
            if (!entity) {
                const created = await this.createEntity({ type: entityType, label, created_by: 'machine' }, userRid);
                entity = created?.result?.[0];
            }
            const entityRid = entity?.['@rid'];
            if (!entityRid) continue;
            await this.link(entityRid, sourceRid, userRid, { created_by: 'machine', service_id: message.service?.id || null, task: message.task?.id || null, confidence, defer_reindex: true });
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
        const linked = [];
        for (const [target, tags] of Object.entries(fileTags)) {
            if (!tryRid(target) || !Array.isArray(tags)) continue;
            for (const tag of tags) {
                const label = typeof tag?.label === 'string' ? tag.label.trim() : '';
                if (!label) continue;
                if (!entities.has(label)) {
                    let entity = await this.findEntity(entityType, label, userRid);
                    if (!entity) entity = (await this.createEntity({ type: entityType, label, created_by: 'machine' }, userRid))?.result?.[0];
                    entities.set(label, entity?.['@rid'] || null);
                }
                const entityRid = entities.get(label);
                if (!entityRid) continue;
                const confidence = Number.isFinite(Number(tag.confidence)) ? Number(tag.confidence) : null;
                const done = await this.link(entityRid, target, userRid, { created_by: 'machine', service_id: message.service?.id || null, task: message.task?.id || null, confidence, defer_reindex: true });
                if (done) linked.push({ entity_rid: entityRid, target_rid: target, label, confidence });
            }
        }
        for (const target of new Set(linked.map((l) => toRid(l.target_rid)))) await this.reindexFileTags(target, userRid);
        return linked;
    }

    /** Machine tags grouped by (service_id, task, entity) with link counts. */
    async machineTags(userRid: string): Promise<any[]> {
        const links = await this.db.rows(
            'SELECT service_id, task, entity_rid, count(*) AS count FROM TagLink WHERE created_by = "machine" AND owner = :owner GROUP BY service_id, task, entity_rid',
            { owner: userRid },
        );
        if (!links.length) return [];
        const entities = await this.db.rowsByRids('@rid AS rid, label, description', links.map((l) => l.entity_rid), "@type = 'Entity'");
        const byRid = new Map(entities.map((e) => [e.rid, e]));
        return links
            .map((l) => ({ service_id: l.service_id, task: l.task, entity_rid: l.entity_rid, label: byRid.get(l.entity_rid)?.label || null, description: byRid.get(l.entity_rid)?.description || null, count: l.count }))
            .filter((r) => r.label)
            .sort((a, b) => String(a.service_id).localeCompare(String(b.service_id)) || String(a.task).localeCompare(String(b.task)) || String(a.label).localeCompare(String(b.label)));
    }
}
