// Faceted ROI-data: browsing the regions of `ner.json` outputs (named entities, language spans...)
// grouped by (service_id, task, label), read straight from the files. No entities or TagLink rows
// are involved.

import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import { readJson } from '../../platform/storage/fsutil.ts';
import { projectRidsFrom } from './tags.ts';

export interface NerScope {
    search?: unknown;
    project_rid?: unknown;
    project_rids?: unknown;
    file_rids?: unknown;
    page?: unknown;
    pageSize?: unknown;
}

function ridArray(list: unknown): string[] {
    if (!Array.isArray(list)) return [];
    return [...new Set(list.map((r) => tryRid(String(r))).filter((r): r is NonNullable<typeof r> => Boolean(r)))];
}

function regionsOf(parsed: any): any[] {
    return Object.values(parsed?.rois || parsed || {});
}

export class NerService {
    private readonly db: ArcadeClient;

    constructor(db: ArcadeClient) {
        this.db = db;
    }

    /** ner.json runs whose source is the given file, newest first. */
    async regionsOfFile(fileRid: string): Promise<any[]> {
        const rows = await this.db.rows(
            'MATCH {type:File, as:ner, where:(type = "ner.json")}-DERIVED_FROM->{type:File, where:(@rid = :rid)} RETURN ner ORDER BY ner.created DESC',
            { rid: toRid(fileRid) },
        );
        const nodes = rows.map((r) => r.ner).filter(Boolean);
        return Promise.all(nodes.map(async (node) => {
            try {
                const parsed = await readJson(node.path);
                return { rid: node['@rid'], service_id: node.service_id, task: node.task, created: node.created, set: node.set, rois: parsed.rois || parsed };
            } catch (error) {
                return { rid: node['@rid'], service_id: node.service_id, task: node.task, created: node.created, set: node.set, error: 'Error reading NER JSON: ' + (error as Error).message };
            }
        }));
    }

    /**
     * All ner.json runs of the user, optionally limited to projects, and to runs related (as
     * ancestor or descendant) to the given tagged files.
     */
    async runs(userRid: string, scope: NerScope = {}): Promise<any[]> {
        const projects = projectRidsFrom(scope);
        const projectClause = projects.length ? ' AND @rid IN :projects' : '';
        const rows = await this.db.rows(
            `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project, where:(@type = 'Project'${projectClause})}<--{as:file, where:(@type = 'File' AND type = "ner.json"), while:($depth < 40)} RETURN DISTINCT file`,
            { user: toRid(userRid), ...(projects.length ? { projects } : {}) },
        );
        let nodes = rows.map((r) => r.file).filter(Boolean);
        if (!nodes.length) return [];

        const tagged = ridArray(scope.file_rids);
        if (tagged.length) {
            const taggedSet = new Set(tagged);
            const taggedAncestors = new Set<string>();
            for (const rid of tagged) {
                for (const row of await this.db.traverse('out', ['DERIVED_FROM'], rid)) taggedAncestors.add(row['@rid']);
            }
            const scoped = [];
            for (const node of nodes) {
                if (taggedAncestors.has(node['@rid'])) { scoped.push(node); continue; }
                const ancestors = (await this.db.traverse('out', ['DERIVED_FROM'], node['@rid'])).map((r: any) => r['@rid']);
                if (ancestors.some((rid: string) => taggedSet.has(rid))) scoped.push(node);
            }
            nodes = scoped;
        }
        if (!nodes.length) return [];
        // service_id/task are stamped on newer runs; older ones have them only on the edge.
        const edges = await this.db.rows('SELECT @out AS rid, cruncher, task FROM DERIVED_FROM WHERE @out IN :rids', { rids: nodes.map((n) => n['@rid']) });
        const byRid = new Map(edges.map((e) => [e.rid, e]));
        return nodes.map((node) => {
            const edge = byRid.get(node['@rid']);
            return { ...node, service_id: node.service_id || edge?.cruncher || null, task: node.task || edge?.task || null };
        });
    }

    async labelGroups(userRid: string, scope: NerScope = {}): Promise<any[]> {
        const search = String(scope.search || '').trim().toLowerCase();
        const counts = new Map<string, any>();
        for (const node of await this.runs(userRid, scope)) {
            if (!node.path) continue;
            let parsed;
            try { parsed = await readJson(node.path); } catch { continue; }
            for (const region of regionsOf(parsed)) {
                if (!region?.label) continue;
                if (search) {
                    const labelMatch = String(region.label).toLowerCase().includes(search);
                    const textMatch = String(region.text || '').toLowerCase().includes(search);
                    if (!labelMatch && !textMatch) continue;
                }
                const key = `${node.service_id}:${node.task}:${region.label}`;
                const entry = counts.get(key) || { service_id: node.service_id, task: node.task, label: region.label, count: 0 };
                entry.count += 1;
                counts.set(key, entry);
            }
        }
        return [...counts.values()].sort((a, b) => String(a.service_id).localeCompare(String(b.service_id))
            || String(a.task).localeCompare(String(b.task)) || String(a.label).localeCompare(String(b.label)));
    }

    /** Source files of the runs that contain the label. */
    async labelFiles(serviceId: unknown, task: unknown, label: unknown, userRid: string, scope: NerScope = {}): Promise<any[]> {
        const runs = (await this.runs(userRid, scope)).filter((n) => n.service_id === serviceId && n.task === task);
        const files = [];
        const seen = new Set<string>();
        for (const node of runs) {
            if (!node.path) continue;
            let parsed;
            try { parsed = await readJson(node.path); } catch { continue; }
            if (!regionsOf(parsed).some((r) => r?.label === label)) continue;
            const source = await this.db.first('SELECT @in AS rid FROM DERIVED_FROM WHERE @out = :rid', { rid: node['@rid'] });
            if (!source?.rid || seen.has(source.rid)) continue;
            seen.add(source.rid);
            const file = await this.db.first('SELECT @rid AS rid, label, path, type FROM File WHERE @rid = :rid', { rid: source.rid });
            if (file) files.push(file);
        }
        return files;
    }

    /** Distinct mention texts of one label group, paged and searchable, with every hit. */
    async labelMentions(serviceId: unknown, task: unknown, label: unknown, userRid: string, scope: NerScope = {}): Promise<any> {
        const search = String(scope.search || '').trim().toLowerCase();
        const page = Math.max(1, parseInt(String(scope.page)) || 1);
        const pageSize = Math.max(1, Math.min(200, parseInt(String(scope.pageSize)) || 20));
        const files = await this.labelFiles(serviceId, task, label, userRid, scope);
        if (!files.length) return { mentions: [], total: 0, page, pageSize };
        const byText = new Map<string, any>();
        for (const file of files) {
            for (const run of await this.regionsOfFile(file.rid)) {
                for (const region of Object.values<any>(run.rois || {})) {
                    if (region?.label !== label) continue;
                    const text = String(region.text || '').trim();
                    if (!text || (search && !text.toLowerCase().includes(search))) continue;
                    let entry = byText.get(text);
                    if (!entry) {
                        entry = { text, count: 0, hits: [] };
                        byText.set(text, entry);
                    }
                    entry.count += 1;
                    entry.hits.push({
                        file_rid: file.rid,
                        file_label: file.label,
                        ner_rid: run.rid,
                        region_id: region.id || null,
                        start: region.start ?? null,
                        end: region.end ?? null,
                        confidence: region.confidence ?? null,
                    });
                }
            }
        }
        const all = [...byText.values()].sort((a, b) => a.text.localeCompare(b.text));
        const start = (page - 1) * pageSize;
        return { mentions: all.slice(start, start + pageSize), total: all.length, page, pageSize };
    }
}
