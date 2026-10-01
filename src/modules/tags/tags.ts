// Entities (tags, people, places...), entity types and TagLink rows that attach entities to files.
//
// TagLink is a document type, not an edge: one row per (entity, file[, region]). `created_by`
// separates manual tags ('user') from Autotag ones ('machine'). A machine-made entity left with no
// links is deleted; user-made entities are kept even when unused.

import type { ArcadeClient, ArcadeEnvelope } from '../../platform/arcade/client.ts';
import { toRid, tryRid, uuidv7 } from '../../platform/ids.ts';
import { readJsonOrEmpty } from '../../platform/storage/fsutil.ts';
import type { AccessService } from '../access/access.ts';

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

export interface LinkMeta {
    region_id?: string | null;
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

    /** Entities grouped by type, optionally only those linked to files of the given projects. */
    async groupedEntities(userRid: string, options: { project_rid?: unknown; project_rids?: unknown } = {}): Promise<any[]> {
        const projects = projectRidsFrom(options);
        const select = 'SELECT type, count(type) AS count, LIST(label) AS labels, icon, color, LIST(@this) AS items FROM Entity';
        if (!projects.length) return this.db.rows(`${select} WHERE owner = :owner GROUP BY type ORDER BY count DESC`, { owner: userRid });
        const files = await this.db.rows('SELECT @rid AS rid FROM File WHERE project_rid IN :projects', { projects });
        const fileRids = files.map((r) => r.rid).filter(Boolean);
        if (!fileRids.length) return [];
        const links = await this.db.rows('SELECT DISTINCT entity_rid FROM TagLink WHERE target_rid IN :files AND owner = :owner', { files: fileRids, owner: userRid });
        const entityRids = links.map((r) => r.entity_rid).filter(Boolean);
        if (!entityRids.length) return [];
        return this.db.rows(`${select} WHERE owner = :owner AND @rid IN :entities GROUP BY type ORDER BY count DESC`, { owner: userRid, entities: entityRids });
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
        const entities = await this.db.rows(
            'SELECT @rid AS rid, label, type, icon, color FROM Entity WHERE owner = :owner AND @rid IN :entities',
            { owner: userRid, entities: links.map((l) => l.entity_rid).filter(Boolean) },
        );
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
            ? await this.db.rows('SELECT label, info, description, @rid AS rid, path, type FROM File WHERE @rid IN :targets AND project_rid IN :projects', { targets, projects })
            : await this.db.rows('SELECT label, info, description, @rid AS rid, path, type FROM File WHERE @rid IN :targets', { targets });
        for (const item of items) item.thumb = apiUrl + 'api/thumbnails/' + String(item.path || '').split('/').slice(0, -1).join('/');
        return items;
    }

    /** File-level entities of a node (GET /api/documents/{rid}). */
    async linkedEntities(rid: string, userRid: string): Promise<any[]> {
        const links = await this.db.rows('SELECT entity_rid FROM TagLink WHERE target_rid = :target AND region_id IS NULL AND owner = :owner', { target: toRid(rid), owner: userRid });
        const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
        if (!entityRids.length) return [];
        return this.db.rows('SELECT label, type, @rid AS rid, color, icon FROM Entity WHERE owner = :owner AND @rid IN :entities', { owner: userRid, entities: entityRids });
    }

    /** Entities of many files at once, for set listings: Map<fileRid, entity[]>. */
    async entitiesForFiles(fileRids: string[]): Promise<Map<string, any[]>> {
        const result = new Map<string, any[]>();
        if (!fileRids.length) return result;
        const links = await this.db.rows('SELECT target_rid, entity_rid FROM TagLink WHERE target_rid IN :files AND region_id IS NULL', { files: fileRids });
        const entityRids = [...new Set(links.map((l) => l.entity_rid).filter(Boolean))];
        const entities = entityRids.length
            ? await this.db.rows('SELECT label, icon, color, @rid AS rid FROM Entity WHERE @rid IN :entities', { entities: entityRids })
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
            "INSERT INTO TagLink SET entity_rid = :e, target_rid = :t, region_id = :r, owner = :owner, created_by = :createdBy, service_id = :serviceId, task = :taskId, confidence = :conf, created = sysdate('YYYY-MM-DD HH:MM:SS')",
            {
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
        const entity = await this.db.first('SELECT @rid FROM Entity WHERE @rid = :e AND owner = :owner', { e, owner: userRid });
        if (!entity || !(await this.access.canRead(t, userRid))) return undefined;
        const linked = await this.createTagLink(e, t, userRid, meta);
        if (!meta.region_id) await this.reindexFileTags(t, userRid);
        return linked;
    }

    async unlink(entityRid: string, targetRid: string, userRid: string): Promise<any> {
        const e = tryRid(entityRid);
        const t = tryRid(targetRid);
        if (!e || !t) return undefined;
        const entity = await this.db.first('SELECT @rid FROM Entity WHERE @rid = :e AND owner = :owner', { e, owner: userRid });
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
        const entity = await this.db.first('SELECT created_by FROM Entity WHERE @rid = :e', { e });
        if (!entity || entity.created_by !== 'machine') return;
        const count = await this.db.first('SELECT count(*) AS count FROM TagLink WHERE entity_rid = :e', { e });
        if (Number(count?.count || 0) > 0) return;
        await this.db.sql('DELETE FROM Entity WHERE @rid = :e', { e });
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
                const entities = await this.db.rows('SELECT @rid AS rid, label FROM Entity WHERE @rid IN :entities', { entities: entityRids });
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

    // ---- Autotag -------------------------------------------------------------------------

    /**
     * Turns an arrived output file into machine tags on its source file: one entity and one link
     * per distinct label. Two shapes are understood: region files ({rois: {...}}) and whole-document
     * classifications ({result: {category: "x" | ["x", "y"]}}).
     */
    async autotag(outputPath: string, sourceRid: string, message: any, entityType = 'Tag'): Promise<any[]> {
        const parsed = await readJsonOrEmpty(outputPath);
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
            await this.link(entityRid, sourceRid, userRid, { created_by: 'machine', service_id: message.service?.id || null, task: message.task?.id || null, confidence });
            linked.push({ entity_rid: entityRid, label, confidence });
        }
        return linked;
    }

    /** Machine tags grouped by (service_id, task, entity) with link counts. */
    async machineTags(userRid: string): Promise<any[]> {
        const links = await this.db.rows(
            'SELECT service_id, task, entity_rid, count(*) AS count FROM TagLink WHERE created_by = "machine" AND owner = :owner GROUP BY service_id, task, entity_rid',
            { owner: userRid },
        );
        if (!links.length) return [];
        const entities = await this.db.rows('SELECT @rid AS rid, label, description FROM Entity WHERE @rid IN :entities', { entities: [...new Set(links.map((l) => l.entity_rid).filter(Boolean))] });
        const byRid = new Map(entities.map((e) => [e.rid, e]));
        return links
            .map((l) => ({ service_id: l.service_id, task: l.task, entity_rid: l.entity_rid, label: byRid.get(l.entity_rid)?.label || null, description: byRid.get(l.entity_rid)?.description || null, count: l.count }))
            .filter((r) => r.label)
            .sort((a, b) => String(a.service_id).localeCompare(String(b.service_id)) || String(a.task).localeCompare(String(b.task)) || String(a.label).localeCompare(String(b.label)));
    }
}
