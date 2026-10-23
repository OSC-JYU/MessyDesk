// Faceted ROI-data: browsing the regions of `ner.json` outputs (named entities, language spans...)
// grouped by (service_id, task, label), read straight from the files. No entities or TagLink rows
// are involved. The labels of each run are also indexed in Solr, one `roi_run` document per run
// (see SolrClient.roiLabels), for the label list and the Tag Filter; mention texts stay in the file.

import type { ArcadeClient } from '../../platform/arcade/client.ts';
import type { RoiRunDoc, SolrClient } from '../../platform/solr/solr.ts';
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
    private readonly solr: SolrClient | null;

    constructor(db: ArcadeClient, solr: SolrClient | null = null) {
        this.db = db;
        this.solr = solr;
    }

    /** The distinct labels of a ner.json file's regions (at most 2000, for one Solr document). */
    static labelsOf(parsed: any): string[] {
        const labels = new Set<string>();
        for (const region of regionsOf(parsed)) {
            const label = typeof region?.label === 'string' ? region.label.trim() : '';
            if (label && labels.size < 2000) labels.add(label);
        }
        return [...labels];
    }

    /** Indexes the labels of one new ner.json run. Never throws: a missed run is restored by "Reindex desk". */
    async indexRun(run: Omit<RoiRunDoc, 'labels'> & { path: string }): Promise<void> {
        if (!this.solr) return;
        try {
            const labels = NerService.labelsOf(await readJson(run.path));
            if (labels.length) await this.solr.indexRoiRuns([{ ...run, labels }]);
        } catch (error) {
            console.warn(`ROI label indexing failed for ${run.nerRid}: ${(error as Error).message}`);
        }
    }

    /** Rebuilds the ROI documents of a desk from its ner.json files (after the desk's search index was dropped). */
    async reindexProject(userRid: string, projectRid: string): Promise<{ runs: number; indexed: number }> {
        if (!this.solr) return { runs: 0, indexed: 0 };
        const nodes = await this.runs(userRid, { project_rid: projectRid });
        const edges = await this.db.edgesOf('out', 'DERIVED_FROM', nodes.map((n) => n['@rid']));
        const sources = new Map(edges.map((e) => [e.target, e.source]));
        const docs: RoiRunDoc[] = [];
        for (const node of nodes) {
            const sourceRid = sources.get(node['@rid']);
            if (!sourceRid || !node.path) continue;
            let labels: string[];
            try { labels = NerService.labelsOf(await readJson(node.path)); } catch { continue; }
            if (!labels.length) continue;
            docs.push({ nerRid: node['@rid'], sourceRid, owner: userRid, project: projectRid, serviceId: node.service_id || null, task: node.task || null, model: node.model || null, labels });
        }
        await this.solr.indexRoiRuns(docs);
        return { runs: nodes.length, indexed: docs.length };
    }

    /** GET /api/tags/ner/labels: the labels of the ROI data of the given desks, from the Solr index. */
    async indexedLabels(userRid: string, scope: NerScope & { offset?: unknown; limit?: unknown } = {}): Promise<{ items: any[]; hasMore: boolean }> {
        if (!this.solr) return { items: [], hasMore: false };
        return this.solr.roiLabels(userRid, { projects: projectRidsFrom(scope), search: String(scope.search || ''), offset: Number(scope.offset) || 0, limit: Number(scope.limit) || 200 });
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
        const edges = await this.db.edgesOf('out', 'DERIVED_FROM', nodes.map((n) => n['@rid']), ['cruncher', 'task']);
        const byRid = new Map(edges.map((e) => [e.target, e]));
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
            const source = { rid: (await this.db.edgesOf('out', 'DERIVED_FROM', [node['@rid']]))[0]?.source };
            if (!source.rid || seen.has(source.rid)) continue;
            seen.add(source.rid);
            const file = await this.db.firstByRid('@rid AS rid, label, path, type', source.rid, "@type = 'File'");
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
