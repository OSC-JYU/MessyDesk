// GET /api/projects/{rid}: the desk graph in the Vue Flow shape the UI renders.
//
// Nodes are the desk-level Sets, Files, SetProcesses and Sources (set members are not shown on
// the desk). Each DERIVED_FROM edge becomes two edges through a synthetic process node built
// from the edge's process_rid, so the UI shows "input -> process -> output". Set nodes get
// preview thumbnails, text samples, member types and the `processed` lock flag.

import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import { sourceFileOf } from '../../shared/graph-store.ts';

export const PDF_ICON_SENTINEL = '__pdf_icon__';

export interface VueFlowGraph {
    nodes: Array<{ data: Record<string, any> }>;
    edges: Array<{ data: Record<string, any> }>;
}

export class DeskGraph {
    private readonly db: ArcadeClient;
    private readonly apiUrl: string;

    constructor(db: ArcadeClient, apiUrl: string) {
        this.db = db;
        this.apiUrl = apiUrl;
    }

    async forProject(projectRid: string, userRid: string): Promise<VueFlowGraph> {
        const query = `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project, where:(@rid = :project)}.in()
            {as:node, where:((@type="Set" OR @type="File" OR @type="SetProcess" OR @type="Source") AND set IS NULL AND $depth > 0), while:($depth < 20)}
            RETURN node, node.outE() AS edges`;
        const response = await this.db.sql(query, { user: toRid(userRid), project: toRid(projectRid) }, { serializer: 'studio' });
        const graph = await this.toVueFlow(response.result as any);
        await this.decorateSets(graph);
        return graph;
    }

    private async processMeta(cache: Map<string, any>, rid: string | undefined): Promise<any> {
        if (!rid) return null;
        if (cache.has(rid)) return cache.get(rid);
        let record = null;
        try {
            record = await this.db.firstByRid(
                '@rid AS rid, @type AS node_type, label, task, service, service_id, info, description',
                toRid(rid), "@type IN ['Process', 'SetProcess']",
            );
        } catch {
            record = null;
        }
        cache.set(rid, record);
        return record;
    }

    async toVueFlow(result: { vertices?: any[]; edges?: any[] }): Promise<VueFlowGraph> {
        const nodes: VueFlowGraph['nodes'] = [];
        const edges: VueFlowGraph['edges'] = [];
        const nodeIds = new Set<string>();
        const edgeIds = new Set<string>();
        const cache = new Map<string, any>();

        for (const v of result?.vertices || []) {
            if (!v?.r || nodeIds.has(v.r)) continue;
            const vp = v.p || {};
            const data: Record<string, any> = {
                id: v.r,
                name: vp.label,
                uuid: vp.uuid,
                type: vp.type || v.t,
                info: vp.info,
                description: vp.description,
                roi_count: vp.roi_count,
                count: vp.count,
                _type: v.t,
            };
            if (vp.node_error) data.error = vp.node_error;
            if (vp.error_count) data.error_count = vp.error_count;
            if (vp.metadata) data.metadata = vp.metadata;
            if (vp.service) data.service = vp.service;
            if (vp.model) data.model = vp.model;
            if (v.t !== 'Process' && vp.path) data.image = path.join('/api/thumbnails', path.dirname(vp.path));
            nodes.push({ data });
            nodeIds.add(v.r);
        }

        for (const e of result?.edges || []) {
            if (!e?.r || edgeIds.has(e.r)) continue;
            edgeIds.add(e.r);
            const ep = e.p || {};
            // The UI draws edges source -> target the opposite way round from ArcadeDB.
            const source = e.i;
            const target = e.o;
            if (e.t === 'DERIVED_FROM') {
                const processRid = ep.process_rid;
                const meta = await this.processMeta(cache, processRid);
                if (!nodeIds.has(processRid)) {
                    nodes.push({
                        data: {
                            id: processRid,
                            name: meta?.label || ep.task || ep.process_id || ep.cruncher || e.t,
                            type: meta?.node_type || 'Process',
                            edge_type: e.t,
                            edge_rid: e.r,
                            process_rid: ep.process_rid,
                            process_id: ep.process_id,
                            service: meta?.service_id || meta?.service || ep.cruncher,
                            task: meta?.task || ep.task,
                            info: meta?.info || meta?.description,
                        },
                    });
                    nodeIds.add(processRid);
                }
                edges.push({ data: { id: `${e.r}:out`, source, target: processRid, type: e.t, edge_rid: e.r } });
                edges.push({ data: { id: `${e.r}:in`, source: processRid, target, type: e.t, edge_rid: e.r } });
                continue;
            }
            edges.push({ data: { id: e.r, source, target, type: e.t } });
        }
        return { nodes, edges };
    }

    /** Preview thumbnails, text samples, member types and the processed flag of Set nodes. */
    private async decorateSets(graph: VueFlowGraph): Promise<void> {
        const setNodes = graph.nodes.filter((n) => n.data?.type === 'Set' && n.data?.id);
        if (!setNodes.length) return;
        const setIds = setNodes.map((n) => String(n.data.id));
        const files = await this.db.rows(
            'SELECT @rid AS rid, set, path, label, type, info, metadata FROM File WHERE set IN :sets ORDER BY label',
            { sets: setIds },
        );
        const processed = await this.processedSetRids(setIds);
        const thumbs = new Map<string, string[]>();
        const types = new Map<string, Set<string>>();
        const samples = new Map<string, Array<{ label: string; text: string }>>();
        for (const item of files) {
            if (!item?.set || !item?.path) continue;
            const type = String(item.type || '').toLowerCase();
            if (!types.has(item.set)) types.set(item.set, new Set());
            if (type) types.get(item.set)!.add(type);
            if (type === 'text') {
                if (!samples.has(item.set)) samples.set(item.set, []);
                const list = samples.get(item.set)!;
                const raw = String(item.info || '').trim();
                if (list.length < 2 && raw) list.push({ label: item.label || '', text: raw.length > 280 ? `${raw.slice(0, 280)}...` : raw });
            }
            if (type !== 'image' && type !== 'pdf') continue;
            if (!thumbs.has(item.set)) thumbs.set(item.set, []);
            const list = thumbs.get(item.set)!;
            if (list.length >= 2) continue;
            if (item.type === 'pdf' && !(await this.usePdfThumbnail(item))) {
                list.push(PDF_ICON_SENTINEL);
                continue;
            }
            const dir = item.path.split('/').slice(0, -1).join('/');
            list.push(this.apiUrl + 'api/thumbnails/' + dir + '/thumbnail.jpg');
        }
        for (const node of setNodes) {
            const id = node.data.id;
            node.data.paths = thumbs.get(id) || [];
            node.data.text_samples = samples.get(id) || [];
            node.data.types = Array.from(types.get(id) || []);
            node.data.processed = processed.has(id);
        }
    }

    /** Sets used as the input of a batch run (they no longer accept uploads). */
    async processedSetRids(setRids: string[]): Promise<Set<string>> {
        const clean = [...new Set(setRids.map((r) => toRid(r)))];
        if (!clean.length) return new Set();
        const rows = await this.db.edgesOf('in', 'DERIVED_FROM', clean, [], 'process_rid IS NOT NULL');
        return new Set(rows.map((r) => r.source));
    }

    /**
     * Multi-page PDFs and PDFs extracted from a ZIP have no rendered cover, so the UI shows a
     * PDF icon for them instead of a thumbnail.
     */
    async usePdfThumbnail(file: any): Promise<boolean> {
        if (!file || file.type !== 'pdf') return true;
        const pages = Number(file?.metadata?.page_count);
        if (Number.isFinite(pages) && pages > 1) return false;
        const rid = file.rid || file['@rid'];
        if (!rid) return false;
        const source = await sourceFileOf(this.db, toRid(rid), 'type');
        const sourceType = source?.type ? String(source.type).toLowerCase() : null;
        return Boolean(sourceType) && sourceType !== 'zip';
    }
}
