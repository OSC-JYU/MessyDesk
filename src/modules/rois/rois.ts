// Regions of interest drawn on an image, stored as one roi.json File node per (image, region set).
// Coordinates are percentages of the image size.

import Boom from '@hapi/boom';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { ridToPathPart, toRid, tryRid } from '../../platform/ids.ts';
import fs from 'node:fs/promises';
import { readJson, writeJson } from '../../platform/storage/fsutil.ts';
import { isStale, normalizeTextRegions, regionList, sliceCodePoints } from './text-regions.ts';
import { projectRidsFrom, ridList } from '../tags/tags.ts';
import { sourceFileOf, type GraphStore } from '../../shared/graph-store.ts';
import type { TagsService } from '../tags/tags.ts';
import type { AccessService } from '../access/access.ts';
import type { GraphService } from '../graph/graph.ts';

/** URL segments may use "12_3" as well as "12:3". */
function rid(value: string): string {
    const r = tryRid(String(value).replace('_', ':'));
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

/**
 * File type of image regions (percent coordinates). Regions of a text have their own type, so the
 * services made for image regions (Sharp: extract, erase...) are not offered for them.
 */
export const IMAGE_ROI_TYPE = 'roi.json';
export const TEXT_ROI_TYPE = 'text-roi.json';

export class RoisService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly access: AccessService;
    private readonly graph: GraphService;
    private readonly tags: TagsService;

    constructor(db: ArcadeClient, store: GraphStore, access: AccessService, graph: GraphService, tags: TagsService) {
        this.tags = tags;
        this.db = db;
        this.store = store;
        this.access = access;
        this.graph = graph;
    }

    private async roiOf(imageRid: string, setRid: string): Promise<any | null> {
        const row = await this.db.first(
            'MATCH {type:File, as:roi, where:(set = :set AND type IN ["roi.json", "text-roi.json"])}-DERIVED_FROM->{type:File, where:(@rid = :image)} RETURN roi ORDER BY roi.created DESC LIMIT 1',
            { set: setRid, image: imageRid },
        );
        return row?.roi || null;
    }

    /** An image has the system tag "has ROI" while any of its region sets holds a region. */
    private async syncRoiTag(imageRid: string, userRid: string): Promise<void> {
        try {
            const rows = await this.db.rows('MATCH {type:File, as:roi, where:(type IN ["roi.json", "text-roi.json"])}-DERIVED_FROM->{type:File, where:(@rid = :image)} RETURN roi', { image: imageRid });
            let regions = 0;
            for (const row of rows) {
                if (!row.roi?.path) continue;
                regions += RoisService.regionCount(await readJson(row.roi.path).catch(() => null));
            }
            await this.tags.setSystemTag(imageRid, 'has ROI', userRid, regions > 0);
        } catch {
            // The tag is a convenience: a failure must not fail saving the regions.
        }
    }

    /** Regions in a roi.json: `{ rois: [...] }` or `{ rois: { id: {...} } }`. */
    static regionCount(data: any): number {
        const rois = data?.rois ?? data;
        if (Array.isArray(rois)) return rois.length;
        return rois && typeof rois === 'object' ? Object.keys(rois).length : 0;
    }

    /** POST: creates the roi.json, or overwrites the existing one (upsert). */
    async save(imageParam: string, setParam: string, data: unknown, userRid: string, type: string = IMAGE_ROI_TYPE): Promise<any> {
        const image = rid(imageParam);
        const set = rid(setParam);
        const owned = await this.access.findOwned(image, userRid);
        if (!owned) throw Boom.notFound('Image not found: ' + image);
        const imagePath = owned.node.path;
        if (!imagePath) throw Boom.badRequest('Image path not found for node: ' + image);
        const existing = await this.roiOf(image, set);
        if (existing) {
            if (!existing.path) throw Boom.internal('ROI path not found for node: ' + existing['@rid']);
            await writeJson(path.dirname(existing.path), path.basename(existing.path), data);
            // Text regions saved before they had their own type are corrected here.
            if (existing.type !== type) await this.store.setAttribute(existing['@rid'], 'type', type);
            await this.syncRoiTag(image, userRid);
            return existing;
        }
        const roi = await this.store.createVertex('File', {
            type,
            extension: 'json',
            set,
            project_rid: owned.node.project_rid || owned.projectRid,
            label: `${path.basename(owned.node.label || image)}.roi.json`,
        });
        await this.store.connectDerivedFrom(roi['@rid'], image);
        const dir = path.dirname(imagePath);
        const file = `${ridToPathPart(roi['@rid'])}.roi.json`;
        await writeJson(dir, file, data);
        await this.store.setAttributes(roi['@rid'], { path: path.join(dir, file), set });
        await this.syncRoiTag(image, userRid);
        return roi;
    }

    async read(imageParam: string, setParam: string, userRid: string): Promise<any> {
        const image = rid(imageParam);
        if (!(await this.access.canRead(image, userRid))) throw Boom.notFound('ROI not found for file: ' + image);
        const roi = await this.roiOf(image, rid(setParam));
        if (!roi) throw Boom.notFound('ROI not found for file: ' + image);
        try {
            return await readJson(roi.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Boom.notFound('ROI JSON file not found: ' + roi.path);
            throw Boom.internal('Error reading ROI JSON: ' + (error as Error).message);
        }
    }

    async update(roiParam: string, data: unknown, userRid: string): Promise<any> {
        const owned = await this.access.findOwned(rid(roiParam), userRid);
        if (!owned) throw Boom.notFound('ROI not found: ' + roiParam);
        if (!owned.node.path) throw Boom.internal('ROI path not found for node: ' + roiParam);
        await writeJson(path.dirname(owned.node.path), path.basename(owned.node.path), data);
        const image = await sourceFileOf(this.db, owned.node['@rid'], '@rid AS rid');
        if (image?.rid) await this.syncRoiTag(image.rid, userRid);
        return { message: 'ROI updated successfully' };
    }

    async remove(imageParam: string, setParam: string, roiParam: string, userRid: string): Promise<any> {
        const image = rid(imageParam);
        const set = rid(setParam);
        const roi = rid(roiParam);
        const row = await this.db.first(
            'MATCH {type:File, as:roi, where:(@rid = :roi AND set = :set AND type IN ["roi.json", "text-roi.json"])}-DERIVED_FROM->{type:File, as:image, where:(@rid = :image)} RETURN roi.@rid AS rid',
            { roi, set, image },
        );
        if (!row) throw Boom.notFound('ROI not found for delete');
        await this.graph.deleteNode(toRid(roi), userRid);
        await this.tags.removeRegionLinks(image, set);
        await this.tags.reindexFileTags(image, userRid);
        await this.syncRoiTag(image, userRid);
        return { message: 'ROI deleted successfully', deleted: true };
    }

    // ---- text regions --------------------------------------------------------------------
    // The same roi.json files, with offsets into a text file (see text-regions.ts).

    private async textOf(rid: string, userRid: string): Promise<{ owned: any; text: string }> {
        const owned = await this.access.findOwned(rid, userRid);
        if (!owned) throw Boom.notFound('Text not found: ' + rid);
        if (String(owned.node.type) !== 'text' || !owned.node.path) throw Boom.badRequest('Not a text file: ' + rid);
        try {
            return { owned, text: await fs.readFile(owned.node.path, 'utf8') };
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Boom.notFound('Text content not found: ' + rid);
            throw error;
        }
    }

    private checkedTextRegions(data: unknown, text: string): any {
        try {
            return normalizeTextRegions(data, text);
        } catch (error) {
            throw Boom.badRequest((error as Error).message);
        }
    }

    /** The ids of the regions stored for a text in a ROI set. */
    private async storedRegionIds(textRid: string, setRid: string): Promise<string[]> {
        const roi = await this.roiOf(textRid, setRid);
        if (!roi?.path) return [];
        const data = await readJson(roi.path).catch(() => null);
        return regionList(data).map((r) => String(r?.id)).filter(Boolean);
    }

    /** Drops the tag links of regions that the new set no longer has. */
    private async dropLinksOfRemoved(textRid: string, setRid: string, before: string[], after: any, userRid: string): Promise<void> {
        const kept = new Set(Object.keys(after?.rois || {}));
        const gone = before.filter((id) => !kept.has(id));
        await this.tags.removeRegionLinks(textRid, setRid, gone);
        if (gone.length) await this.tags.reindexFileTags(textRid, userRid);
    }

    /** POST: saves the regions of a text in a ROI set (upsert), after checking the offsets. */
    async saveText(textParam: string, setParam: string, data: unknown, userRid: string): Promise<any> {
        const textRid = rid(textParam);
        const setRid = rid(setParam);
        const { text } = await this.textOf(textRid, userRid);
        const checked = this.checkedTextRegions(data, text);
        const before = await this.storedRegionIds(textRid, setRid);
        const saved = await this.save(textParam, setParam, checked, userRid, TEXT_ROI_TYPE);
        await this.dropLinksOfRemoved(textRid, setRid, before, checked, userRid);
        return saved;
    }

    /** GET: the regions, the tags of each region and `stale: true` when the text changed after they were made. */
    async readText(textParam: string, setParam: string, userRid: string): Promise<any> {
        const data = await this.read(textParam, setParam, userRid);
        const { text } = await this.textOf(rid(textParam), userRid);
        const region_tags = await this.tags.regionTags(rid(textParam), rid(setParam), userRid);
        return { ...data, stale: isStale(data, text), region_tags };
    }

    /** PUT: replaces the regions of one roi.json of a text. */
    async updateText(roiParam: string, data: unknown, userRid: string): Promise<any> {
        const owned = await this.access.findOwned(rid(roiParam), userRid);
        if (!owned) throw Boom.notFound('ROI not found: ' + roiParam);
        const source = await sourceFileOf(this.db, owned.node['@rid'], '@rid AS rid');
        if (!source?.rid) throw Boom.notFound('Text not found for ROI: ' + roiParam);
        const { text } = await this.textOf(source.rid, userRid);
        const checked = this.checkedTextRegions(data, text);
        const setRid = tryRid(owned.node.set);
        const before = setRid ? await this.storedRegionIds(source.rid, setRid) : [];
        const result = await this.update(roiParam, checked, userRid);
        if (setRid) await this.dropLinksOfRemoved(source.rid, setRid, before, checked, userRid);
        return result;
    }

    /** The region files of texts: of one ROI set, or of a whole desk. */
    async regionFiles(where: { set?: string; project?: string }): Promise<Array<{ path: string; text_rid: string; set: string }>> {
        const conditions = ['type = "text-roi.json"'];
        const params: Record<string, unknown> = {};
        if (where.set) { conditions.push('set = :set'); params.set = where.set; }
        if (where.project) { conditions.push('project_rid = :project'); params.project = where.project; }
        return this.db.rows(
            `MATCH {type:File, as:roi, where:(${conditions.join(' AND ')})}-DERIVED_FROM->{type:File, as:text} RETURN roi.path AS path, roi.set AS set, text.@rid AS text_rid`,
            params,
        );
    }

    /**
     * How much of each text is marked in a ROI set: text rid -> { regions, tagged, untagged }.
     * Only texts with at least one region are listed, so a text that is missing has none. Feeds the
     * navigation of the coding view ("next text without passages", "next with untagged passages").
     */
    async coverage(setParam: string, userRid: string): Promise<any> {
        const setRid = rid(setParam);
        if (!(await this.access.canRead(setRid, userRid))) throw Boom.notFound('ROI set not found');
        const rows = await this.regionFiles({ set: setRid });
        const links = await this.db.rows('SELECT target_rid, region_id FROM TagLink WHERE roi_set = :set AND region_id IS NOT NULL AND owner = :owner', { set: setRid, owner: userRid });
        const taggedBy = new Map<string, Set<string>>();
        for (const link of links) {
            if (!taggedBy.has(link.target_rid)) taggedBy.set(link.target_rid, new Set());
            taggedBy.get(link.target_rid)!.add(link.region_id);
        }
        const files: Record<string, { regions: number; tagged: number; untagged: number }> = {};
        for (const row of rows) {
            if (!row.path || !row.text_rid) continue;
            const ids = regionList(await readJson(row.path).catch(() => null)).map((r) => String(r?.id));
            if (!ids.length) continue;
            const tagged = ids.filter((id) => taggedBy.get(row.text_rid)?.has(id)).length;
            files[row.text_rid] = { regions: ids.length, tagged, untagged: ids.length - tagged };
        }
        return { roi_set: setRid, files };
    }

    /**
     * The coded passages of tags: a page of the regions that have any of the tags, with the text of
     * the passage and some text around it. A passage appears once, with all its tags.
     */
    async passages(entities: unknown, userRid: string, options: { project_rid?: unknown; project_rids?: unknown; skip?: unknown; limit?: unknown } = {}): Promise<any> {
        const entityRids = ridList(entities);
        const skip = /^\d+$/.test(String(options.skip ?? '')) ? Number(options.skip) : 0;
        const limit = Math.min(/^\d+$/.test(String(options.limit ?? '')) ? Number(options.limit) : 20, 100);
        if (!entityRids.length) return { total: 0, skip, limit, items: [] };
        const projects = projectRidsFrom(options);
        const where = `entity_rid IN :entities AND region_id IS NOT NULL AND owner = :owner${projects.length ? ' AND project_rid IN :projects' : ''}`;
        const params: Record<string, unknown> = { entities: entityRids, owner: userRid, ...(projects.length ? { projects } : {}) };
        const distinct = `SELECT DISTINCT target_rid, roi_set, region_id FROM TagLink WHERE ${where}`;
        const total = Number((await this.db.first(`SELECT count(*) AS total FROM (${distinct})`, params))?.total || 0);
        const rows = await this.db.rows(`${distinct} ORDER BY target_rid, roi_set, region_id SKIP :skip LIMIT :limit`, { ...params, skip, limit });
        const files = new Map<string, any>();
        const fileRids = [...new Set(rows.map((r) => r.target_rid).filter(Boolean))];
        if (fileRids.length) {
            for (const f of await this.db.rowsByRids('@rid AS rid, label, path', fileRids, "@type = 'File'")) files.set(f.rid, f);
        }
        const texts = new Map<string, string | null>();
        const regionSets = new Map<string, Map<string, any>>();
        const tagsBySet = new Map<string, Record<string, any[]>>();
        const CONTEXT = 120;
        const items: any[] = [];
        for (const row of rows) {
            const file = files.get(row.target_rid);
            if (!file?.path || !row.roi_set) continue;
            if (!texts.has(row.target_rid)) texts.set(row.target_rid, await fs.readFile(file.path, 'utf8').catch(() => null));
            const text = texts.get(row.target_rid);
            const key = `${row.target_rid}|${row.roi_set}`;
            if (!regionSets.has(key)) {
                const roi = await this.roiOf(row.target_rid, row.roi_set);
                const data = roi?.path ? await readJson(roi.path).catch(() => null) : null;
                regionSets.set(key, new Map(regionList(data).map((r) => [String(r?.id), r])));
                tagsBySet.set(key, await this.tags.regionTags(row.target_rid, row.roi_set, userRid));
            }
            const region = regionSets.get(key)!.get(String(row.region_id));
            if (!region || text === null || text === undefined) continue;
            const snippet = sliceCodePoints(text, region.start, region.end);
            const before = sliceCodePoints(text, Math.max(0, region.start - CONTEXT), region.start);
            const after = sliceCodePoints(text, region.end, region.end + CONTEXT);
            items.push({
                file_rid: row.target_rid,
                file_label: file.label,
                roi_set: row.roi_set,
                region_id: row.region_id,
                start: region.start,
                end: region.end,
                text: snippet,
                before,
                after,
                tags: tagsBySet.get(key)?.[String(row.region_id)] || [],
            });
        }
        return { total, skip, limit, items };
    }

    /**
     * Imports the spans of a ner.json run on this text (for example Gliner's) into a ROI set: each
     * span becomes a region, and each label a tag of the desk (made when missing) linked to its
     * regions as a machine tag with the span's confidence. Existing regions of the set stay; a span
     * already imported (same id) is skipped. Spans that do not fit the text are counted, not fatal.
     * `labels` limits the import to those labels.
     */
    async importSpans(textParam: string, setParam: string, data: { ner_rid?: unknown; labels?: unknown }, userRid: string): Promise<any> {
        const textRid = rid(textParam);
        const setRid = rid(setParam);
        const { owned, text } = await this.textOf(textRid, userRid);
        const nerRid = tryRid(data?.ner_rid);
        if (!nerRid) throw Boom.badRequest('ner_rid is required');
        const nerNode = await this.db.first(
            'MATCH {type:File, as:ner, where:(@rid = :ner AND type = "ner.json")}-DERIVED_FROM->{type:File, where:(@rid = :text)} RETURN ner',
            { ner: nerRid, text: textRid },
        );
        const ner = nerNode?.ner;
        if (!ner?.path) throw Boom.notFound('No such NER run on this text');
        const wanted = Array.isArray(data?.labels) ? new Set(data.labels.map(String)) : null;
        const spans = regionList(await readJson(ner.path).catch(() => null))
            .filter((r) => r && typeof r.label === 'string' && r.label && (!wanted || wanted.has(r.label)));

        const existing = await this.roiOf(textRid, setRid);
        const current = existing?.path ? await readJson(existing.path).catch(() => null) : null;
        const kept = regionList(current).filter((r) => r?.id);
        const have = new Set(kept.map((r) => String(r.id)));
        const fresh: any[] = [];
        let skipped = 0;
        for (const span of spans) {
            const id = String(span.id ?? `${span.start}_${span.end}_${span.label}`);
            if (have.has(id)) { skipped += 1; continue; }
            fresh.push({ ...span, id, type: 'text' });
            have.add(id);
        }
        let checked: any;
        const valid: any[] = [];
        for (const span of fresh) {
            try {
                normalizeTextRegions({ rois: [span] }, text);
                valid.push(span);
            } catch {
                skipped += 1;
            }
        }
        try {
            checked = normalizeTextRegions({ rois: [...kept, ...valid.map(({ label: _l, confidence: _c, ...region }) => region)] }, text);
        } catch (error) {
            throw Boom.badRequest((error as Error).message);
        }
        if (!valid.length) return { regions: 0, tags: 0, skipped };
        await this.save(textParam, setParam, checked, userRid, TEXT_ROI_TYPE);

        const project = owned.projectRid;
        const tagByLabel = new Map<string, string>();
        for (const label of new Set(valid.map((s) => String(s.label).trim()).filter(Boolean))) {
            const made = await this.tags.createInDesk(project, { type: 'Tag', label }, userRid);
            const entity = made?.result?.[0];
            const entityRid = tryRid(entity?.['@rid'] ?? entity?.rid);
            if (entityRid) tagByLabel.set(label, entityRid);
        }
        for (const span of valid) {
            const entityRid = tagByLabel.get(String(span.label).trim());
            if (!entityRid) continue;
            await this.tags.link(entityRid, textRid, userRid, {
                region_id: span.id,
                roi_set: setRid,
                created_by: 'machine',
                service_id: ner.service_id ?? null,
                task: ner.task ?? null,
                confidence: Number.isFinite(Number(span.confidence)) ? Number(span.confidence) : null,
                defer_reindex: true,
            });
        }
        await this.tags.reindexFileTags(textRid, userRid);
        return { regions: valid.length, tags: tagByLabel.size, skipped };
    }

    /** Puts a tag on a region of a text in a ROI set. A region can have any number of tags, or none. */
    async tagRegion(textParam: string, setParam: string, regionId: string, entityParam: string, userRid: string, actor?: string): Promise<any> {
        const textRid = rid(textParam);
        const setRid = rid(setParam);
        await this.textOf(textRid, userRid);
        if (!(await this.storedRegionIds(textRid, setRid)).includes(regionId)) throw Boom.notFound('Region not found: ' + regionId);
        const linked = await this.tags.link(rid(entityParam), textRid, userRid, { region_id: regionId, roi_set: setRid, ...(actor ? { tagged_by: actor } : {}) });
        if (!linked) throw Boom.notFound('Tag not found or not in this desk');
        await this.tags.reindexFileTags(textRid, userRid);
        return { region: regionId, tag: rid(entityParam) };
    }

    async untagRegion(textParam: string, setParam: string, regionId: string, entityParam: string, userRid: string): Promise<any> {
        const textRid = rid(textParam);
        await this.textOf(textRid, userRid);
        await this.tags.unlinkRegion(rid(entityParam), textRid, rid(setParam), regionId, userRid);
        await this.tags.reindexFileTags(textRid, userRid);
        return { region: regionId, tag: rid(entityParam), removed: true };
    }
}
