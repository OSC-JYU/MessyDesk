// Coders: users who may code in one ROI set of someone else's desk, and nothing else.
//
// The owner of a desk assigns a ROI set to a coder (a CodingGrant). The coder reaches only what the
// grant names: the ROI set, the texts it covers (to read), the desk's tags (to pick from) and the
// regions and region tags of that set (to write). Everything else on the desk answers 404, as for
// a stranger. The access rule of the rest of the system (AccessService, owner only) is not
// widened: coder routes check the grant here and then act for the owner, recording the coder as
// the one who tagged.

import Boom from '@hapi/boom';
import fs from 'node:fs/promises';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import type { AccessService } from '../access/access.ts';
import { readJson } from '../../platform/storage/fsutil.ts';
import type { FiltersService } from '../filters/filters.ts';
import type { RoisService } from '../rois/rois.ts';
import { codePointLength, regionList, sliceCodePoints } from '../rois/text-regions.ts';
import type { TagsService } from '../tags/tags.ts';
import type { UsersService } from '../users/users.ts';

export interface Grant {
    roiSet: string;
    coder: string;
    owner: string;
    project: string;
    locked: boolean;
}

const MAX_TEXT_BYTES = 20 * 1024 * 1024;

function clean(value: unknown, what: string): string {
    const r = tryRid(String(value ?? '').replace('_', ':'));
    if (!r) throw Boom.badRequest(`Invalid ${what}`);
    return r;
}

export class CodingService {
    private readonly db: ArcadeClient;
    private readonly access: AccessService;
    private readonly rois: RoisService;
    private readonly tags: TagsService;
    private readonly users: UsersService;
    private readonly filters: FiltersService;

    constructor(db: ArcadeClient, access: AccessService, rois: RoisService, tags: TagsService, users: UsersService, filters: FiltersService) {
        this.filters = filters;
        this.db = db;
        this.access = access;
        this.rois = rois;
        this.tags = tags;
        this.users = users;
    }

    // ---- owner side ----------------------------------------------------------------------

    private async ownedRoiSet(setParam: string, ownerRid: string): Promise<{ set: string; project: string }> {
        const set = clean(setParam, 'ROI set');
        const owned = await this.access.findOwned(set, ownerRid);
        if (!owned || owned.node['@type'] !== 'Set' || String(owned.node.type) !== 'roi-set') throw Boom.notFound('ROI set not found');
        return { set, project: owned.projectRid };
    }

    /** The people who may code in a ROI set. */
    async coders(setParam: string, ownerRid: string): Promise<any[]> {
        const { set } = await this.ownedRoiSet(setParam, ownerRid);
        const rows = await this.db.rows('SELECT user_rid, locked FROM CodingGrant WHERE roi_set = :set', { set });
        const names = await this.names(rows.map((r) => r.user_rid));
        // How far the coders are: texts of the set, and texts with passages (all coders share the set's own numbers).
        const total = (await this.textsOfSet(set, '').catch(() => [])).length;
        const coverage = (await this.rois.coverage(set, ownerRid).catch(() => ({ files: {} }))).files || {};
        const withPassages = Object.keys(coverage).length;
        const regions = Object.values<any>(coverage).reduce((n, c) => n + c.regions, 0);
        const untagged = Object.values<any>(coverage).reduce((n, c) => n + c.untagged, 0);
        return rows.map((r) => ({ user_rid: r.user_rid, name: names.get(r.user_rid) || r.user_rid, locked: Boolean(r.locked), progress: { texts: total, with_passages: withPassages, passages: regions, untagged } }));
    }

    async assign(setParam: string, coderParam: string, ownerRid: string): Promise<any> {
        const { set, project } = await this.ownedRoiSet(setParam, ownerRid);
        const coder = clean(coderParam, 'user');
        if (coder === toRid(ownerRid)) throw Boom.badRequest('You own this desk already');
        if (!(await this.users.find(coder))) throw Boom.notFound('User not found');
        const existing = await this.db.first('SELECT @rid AS rid FROM CodingGrant WHERE roi_set = :set AND user_rid = :coder', { set, coder });
        if (!existing) {
            await this.db.sql('INSERT INTO CodingGrant SET roi_set = :set, user_rid = :coder, project_rid = :project, owner_rid = :owner, locked = false', { set, coder, project, owner: toRid(ownerRid) });
        }
        return { roi_set: set, user_rid: coder, locked: false };
    }

    async unassign(setParam: string, coderParam: string, ownerRid: string): Promise<any> {
        const { set } = await this.ownedRoiSet(setParam, ownerRid);
        await this.db.sql('DELETE FROM CodingGrant WHERE roi_set = :set AND user_rid = :coder', { set, coder: clean(coderParam, 'user') });
        return { removed: true };
    }

    /** A locked set is read-only for its coder (they are done, or the owner is reviewing). */
    async lock(setParam: string, coderParam: string, locked: boolean, ownerRid: string): Promise<any> {
        const { set } = await this.ownedRoiSet(setParam, ownerRid);
        const coder = clean(coderParam, 'user');
        await this.db.sql('UPDATE CodingGrant SET locked = :locked WHERE roi_set = :set AND user_rid = :coder', { locked, set, coder });
        return { roi_set: set, user_rid: coder, locked };
    }

    private async names(rids: string[]): Promise<Map<string, string>> {
        const found = rids.length ? await this.db.rowsByRids('@rid AS rid, label, id', rids, "@type = 'User'") : [];
        return new Map(found.map((u) => [u.rid, u.label || u.id]));
    }

    /**
     * One ROI set per coder on the same texts, each assigned to its coder, in one step. `source` is
     * a text or a set of texts. Returns the sets made.
     */
    async createSetsForCoders(sourceParam: string, coderParams: unknown, ownerRid: string, labelPrefix?: unknown): Promise<any[]> {
        const source = clean(sourceParam, 'source');
        const coders = [...new Set((Array.isArray(coderParams) ? coderParams : []).map((c) => clean(c, 'user')))];
        if (!coders.length) throw Boom.badRequest('Choose at least one coder');
        if (!(await this.access.findOwned(source, ownerRid))) throw Boom.notFound('Source not found');
        const names = await this.names(coders);
        for (const coder of coders) {
            if (coder === toRid(ownerRid)) throw Boom.badRequest('You own this desk already');
            if (!names.has(coder)) throw Boom.notFound('User not found');
        }
        const prefix = typeof labelPrefix === 'string' && labelPrefix.trim() ? labelPrefix.trim() : 'Coding';
        const made: any[] = [];
        for (const coder of coders) {
            const process = await this.filters.apply('mdf-text-roi', source, ownerRid, { set_label: `${prefix}: ${names.get(coder)}` });
            await this.assign(process.roi_set, coder, ownerRid);
            made.push({ roi_set: process.roi_set, user_rid: coder, name: names.get(coder) });
        }
        return made;
    }

    /**
     * A new ROI set with a copy of the passages and tags of this one, owned by the desk owner: the
     * start of a final, adjudicated set. Nothing in the original changes.
     */
    async copySet(setParam: string, ownerRid: string, label?: unknown): Promise<any> {
        const { set } = await this.ownedRoiSet(setParam, ownerRid);
        const sources = await this.db.rows(`SELECT @rid AS rid FROM (SELECT expand(out('DERIVED_FROM')) FROM ${set})`);
        if (!sources[0]) throw Boom.badRequest('This ROI set has no source');
        const name = typeof label === 'string' && label.trim() ? label.trim() : 'Final';
        const created = await this.filters.apply('mdf-text-roi', sources[0].rid, ownerRid, { set_label: name });
        const target = created.roi_set;
        let passages = 0;
        for (const file of await this.rois.regionFiles({ set })) {
            const data = await readJson(file.path).catch(() => null);
            const regions = regionList(data);
            if (!regions.length) continue;
            await this.rois.saveText(file.text_rid, target, { rois: regions }, ownerRid);
            const tagged = await this.tags.regionTags(file.text_rid, set, ownerRid);
            for (const [region, list] of Object.entries(tagged)) {
                for (const tag of list) await this.tags.link(tag.rid, file.text_rid, ownerRid, { region_id: region, roi_set: target, defer_reindex: true });
            }
            await this.tags.reindexFileTags(file.text_rid, ownerRid);
            passages += regions.length;
        }
        return { roi_set: target, label: name, passages };
    }

    // ---- export --------------------------------------------------------------------------

    /**
     * Every coded (and marked) passage of a desk, or of one ROI set, one object per passage: the
     * hand-over format for analysis and for tools outside MessyDesk. An untagged passage has an empty
     * `tags` list. `coders` are the people who tagged it (machine imports are marked as such).
     */
    async exportSegments(projectParam: string, ownerRid: string, options: { roi_set?: unknown } = {}): Promise<any> {
        const project = clean(projectParam, 'desk');
        if (!(await this.access.isProjectOwner(project, ownerRid))) throw Boom.notFound('Desk not found');
        const onlySet = options.roi_set ? clean(options.roi_set, 'ROI set') : undefined;
        const files = await this.rois.regionFiles({ project, ...(onlySet ? { set: onlySet } : {}) });
        const setRids = [...new Set(files.map((f) => f.set).filter(Boolean))];
        const textRids = [...new Set(files.map((f) => f.text_rid))];
        const setRows = setRids.length ? await this.db.rowsByRids('@rid AS rid, label', setRids, "@type = 'Set'") : [];
        const textRows = textRids.length ? await this.db.rowsByRids('@rid AS rid, label, path, origin_rid, origin_label, page_number', textRids, "@type = 'File'") : [];
        const setLabel = new Map(setRows.map((s) => [s.rid, s.label]));
        const textBy = new Map(textRows.map((t) => [t.rid, t]));
        const segments: any[] = [];
        for (const file of files) {
            const textRow = textBy.get(file.text_rid);
            if (!textRow?.path) continue;
            const text = await fs.readFile(textRow.path, 'utf8').catch(() => null);
            if (text === null) continue;
            const regions = regionList(await readJson(file.path).catch(() => null));
            const links = await this.db.rows('SELECT region_id, entity_rid, tagged_by, created_by, confidence FROM TagLink WHERE target_rid = :t AND roi_set = :s AND region_id IS NOT NULL AND owner = :owner', { t: file.text_rid, s: file.set, owner: toRid(ownerRid) });
            const labels = new Map((links.length ? await this.db.rowsByRids('@rid AS rid, label', [...new Set(links.map((l) => l.entity_rid))], "@type = 'Entity'") : []).map((e) => [e.rid, e.label]));
            const who = await this.names(links.map((l) => l.tagged_by).filter(Boolean));
            const length = codePointLength(text);
            for (const region of regions) {
                if (!Number.isInteger(region?.start) || !Number.isInteger(region?.end)) continue;
                const mine = links.filter((l) => l.region_id === region.id);
                segments.push({
                    file: file.text_rid,
                    file_label: textRow.label,
                    document: textRow.origin_label || null,
                    page: textRow.page_number ?? null,
                    text_length: length,
                    roi_set: file.set,
                    roi_set_label: setLabel.get(file.set) || null,
                    region_id: region.id,
                    start: region.start,
                    end: region.end,
                    text: sliceCodePoints(text, region.start, region.end),
                    tags: [...new Map(mine.filter((l) => labels.has(l.entity_rid)).map((l) => [l.entity_rid, { rid: l.entity_rid, label: labels.get(l.entity_rid) }])).values()],
                    coders: [...new Set(mine.map((l) => (l.created_by === 'machine' ? 'machine' : who.get(l.tagged_by) || l.tagged_by)).filter(Boolean))],
                });
            }
        }
        segments.sort((a, b) => String(a.file).localeCompare(String(b.file), undefined, { numeric: true }) || a.start - b.start);
        return { desk: project, roi_set: onlySet ?? null, generated: new Date().toISOString(), unit: 'unicode code points', segments };
    }

    static toCsv(exported: any): string {
        const cell = (v: unknown) => {
            const s = v === null || v === undefined ? '' : String(v);
            return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
        };
        const header = ['file', 'file_label', 'document', 'page', 'roi_set', 'roi_set_label', 'region_id', 'start', 'end', 'text', 'tags', 'coders'];
        const lines = [header.join(',')];
        for (const s of exported.segments) {
            lines.push([s.file, s.file_label, s.document, s.page, s.roi_set, s.roi_set_label, s.region_id, s.start, s.end, s.text, s.tags.map((t: any) => t.label).join('; '), s.coders.join('; ')].map(cell).join(','));
        }
        return lines.join('\n') + '\n';
    }

    // ---- coder side ----------------------------------------------------------------------

    /** The grant of this user on this set, or 404 (also when the set is gone). */
    async grant(setParam: string, coderRid: string, write = false): Promise<Grant> {
        const set = clean(setParam, 'ROI set');
        const row = await this.db.first('SELECT project_rid, owner_rid, locked FROM CodingGrant WHERE roi_set = :set AND user_rid = :coder', { set, coder: toRid(coderRid) });
        if (!row) throw Boom.notFound('ROI set not found');
        const node = await this.db.firstByRid('@rid, _deleting', set, "@type = 'Set'");
        if (!node || node._deleting) throw Boom.notFound('ROI set not found');
        if (write && row.locked) throw Boom.forbidden('This set is locked');
        return { roiSet: set, coder: toRid(coderRid), owner: row.owner_rid, project: row.project_rid, locked: Boolean(row.locked) };
    }

    /** The ROI sets a user may code in. */
    async mySets(coderRid: string): Promise<any[]> {
        const rows = await this.db.rows('SELECT roi_set, project_rid, locked FROM CodingGrant WHERE user_rid = :coder', { coder: toRid(coderRid) });
        const sets = rows.length ? await this.db.rowsByRids('@rid AS rid, label, _deleting', rows.map((r) => r.roi_set), "@type = 'Set'") : [];
        const projects = rows.length ? await this.db.rowsByRids('@rid AS rid, label', [...new Set(rows.map((r) => r.project_rid))], "@type = 'Project'") : [];
        const setBy = new Map(sets.map((s) => [s.rid, s]));
        const projectBy = new Map(projects.map((p) => [p.rid, p]));
        const out: any[] = [];
        for (const row of rows) {
            const set = setBy.get(row.roi_set);
            if (!set || set._deleting) continue;
            const texts = await this.textsOfSet(row.roi_set, row.project_rid).catch(() => []);
            out.push({ roi_set: row.roi_set, label: set.label, desk: projectBy.get(row.project_rid)?.label || '', locked: Boolean(row.locked), texts: texts.length });
        }
        return out;
    }

    /** The texts a ROI set covers: the text it was made on, or the text files of the set it was made on. */
    private async textsOfSet(roiSet: string, project: string): Promise<Array<{ rid: string; label: string }>> {
        const sources = await this.db.rows(`SELECT @rid AS rid, @type AS node_type FROM (SELECT expand(out('DERIVED_FROM')) FROM ${toRid(roiSet)})`);
        const texts: any[] = [];
        for (const source of sources) {
            if (source.node_type === 'Set') {
                texts.push(...await this.db.rows('SELECT @rid AS rid, label FROM File WHERE set = :set AND type = "text" ORDER BY label', { set: source.rid }));
            } else if (source.node_type === 'File') {
                const file = await this.db.firstByRid('@rid AS rid, label, type', source.rid, "@type = 'File'");
                if (file && file.type === 'text') texts.push(file);
            }
        }
        void project;
        return texts.map((t) => ({ rid: t.rid, label: t.label }));
    }

    async texts(setParam: string, coderRid: string): Promise<any[]> {
        const grant = await this.grant(setParam, coderRid);
        return this.textsOfSet(grant.roiSet, grant.project);
    }

    private async textOf(grant: Grant, textParam: string): Promise<string> {
        const text = clean(textParam, 'text');
        if (!(await this.textsOfSet(grant.roiSet, grant.project)).some((t) => t.rid === text)) throw Boom.notFound('Text not found');
        return text;
    }

    async content(setParam: string, textParam: string, coderRid: string): Promise<string> {
        const grant = await this.grant(setParam, coderRid);
        const text = await this.textOf(grant, textParam);
        const owned = await this.access.findOwned(text, grant.owner);
        if (!owned?.node.path) throw Boom.notFound('Text not found');
        const stat = await fs.stat(owned.node.path).catch(() => null);
        if (!stat) throw Boom.notFound('Text content not found');
        if (stat.size > MAX_TEXT_BYTES) throw Boom.entityTooLarge('The text is too large');
        return fs.readFile(owned.node.path, 'utf8');
    }

    /** The desk's tags, to pick from. A coder cannot make new ones. */
    async deskTags(setParam: string, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid);
        return this.tags.tags(grant.owner, grant.project);
    }

    async readRegions(setParam: string, textParam: string, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid);
        const text = await this.textOf(grant, textParam);
        return this.rois.readText(text, grant.roiSet, grant.owner);
    }

    async saveRegions(setParam: string, textParam: string, data: unknown, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid, true);
        const text = await this.textOf(grant, textParam);
        return this.rois.saveText(text, grant.roiSet, data, grant.owner);
    }

    async tagRegion(setParam: string, textParam: string, region: string, tagParam: string, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid, true);
        const text = await this.textOf(grant, textParam);
        return this.rois.tagRegion(text, grant.roiSet, region, tagParam, grant.owner, grant.coder);
    }

    async untagRegion(setParam: string, textParam: string, region: string, tagParam: string, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid, true);
        const text = await this.textOf(grant, textParam);
        return this.rois.untagRegion(text, grant.roiSet, region, tagParam, grant.owner);
    }

    async coverage(setParam: string, coderRid: string): Promise<any> {
        const grant = await this.grant(setParam, coderRid);
        return this.rois.coverage(grant.roiSet, grant.owner);
    }
}
