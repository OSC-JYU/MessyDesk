// Filters: instant "crunchers" that run in the backend without a service.
//
// mdf-set-filter makes a new Set of references to the files of a set that have (or lack) the
// selected tags. Any other filter id (mdf-image-roi) creates an empty region set ("My regions")
// for a file, where the user then draws regions.

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import { ensureDir } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';
import type { NodesService } from '../nodes/nodes.ts';

export const SET_FILTER = 'mdf-set-filter';

export class FiltersService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly nodes: NodesService;
    private filters: Record<string, any> = {};

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout, access: AccessService, nodes: NodesService) {
        this.db = db;
        this.store = store;
        this.layout = layout;
        this.access = access;
        this.nodes = nodes;
    }

    setFilters(filters: Record<string, any>): void {
        this.filters = filters;
    }

    list(): Record<string, any> {
        return this.filters;
    }

    async apply(filterId: string, nodeRid: string, userRid: string, params: any = {}): Promise<any> {
        const owned = await this.access.findOwned(nodeRid, userRid);
        if (!this.filters[filterId] || !owned) throw Boom.badRequest(`Filter or file not found: ${filterId} ${nodeRid}`);
        if (filterId === SET_FILTER) return this.tagFilterSet(owned.node, owned.projectRid, userRid, params);
        const project = owned.projectRid;
        const process = await this.store.createVertex('Process', { filter_id: filterId, label: 'Draw regions' });
        process.path = this.layout.processFilesDir(project, process.uuid);
        await this.store.connect(project, EDGE.BELONGS_TO, process['@rid']);
        const set = await this.store.createVertex('Set', { label: 'My regions', type: 'roi-set' });
        await this.store.connectDerivedFrom(set['@rid'], owned.node['@rid'], process['@rid']);
        return process;
    }

    private async tagFilterSet(node: any, projectRid: string, userRid: string, params: any): Promise<any> {
        const sourceSet = node['@type'] === 'Set' ? toRid(node['@rid']) : tryRid(node.set);
        if (!sourceSet) throw Boom.badRequest('Tag filter requires a Set node as input');
        const raw = String(params?.selection_mode || params?.mode || 'include').toLowerCase();
        const mode = ['include', 'exclude', 'untagged'].includes(raw) ? raw : 'include';
        const selected = [...new Set((Array.isArray(params?.selected_entity_rids) ? params.selected_entity_rids : []).map((r: unknown) => tryRid(String(r))).filter(Boolean))] as string[];
        if ((mode === 'include' || mode === 'exclude') && !selected.length) throw Boom.badRequest('No tags selected');
        const match = String(params?.match || 'or').toLowerCase() === 'and' ? 'and' : 'or';
        const project = node.project_rid || projectRid;
        const allFiles = await this.nodes.setFileRids(sourceSet);
        if (!allFiles.length) throw Boom.badRequest('Input set has no files');

        let labels: string[] = [];
        if (mode !== 'untagged') {
            const rows = await this.db.rowsByRids('@rid AS rid, label', selected, "@type = 'Entity' AND owner = :owner", { owner: userRid });
            if (rows.length !== selected.length) throw Boom.badRequest('One or more selected tags are invalid or inaccessible');
            const byRid = new Map(rows.map((r) => [r.rid, r.label]));
            labels = selected.map((r) => byRid.get(r)).filter(Boolean);
        }
        const info = mode === 'include' ? `Tag filter include (${match.toUpperCase()}): ${labels.join(', ')}`
            : mode === 'exclude' ? `Tag filter exclude: ${labels.join(', ')}` : 'Tag filter untagged files';
        const filterNode = await this.store.createVertex('SetProcess', {
            filter_id: SET_FILTER,
            label: 'Tag filter',
            project_rid: project || null,
            input_set: sourceSet,
            info,
            params: JSON.stringify({ selection_mode: mode, selected_entity_rids: selected, match }),
        });
        const processRid = filterNode['@rid'];
        const processPath = this.layout.processFilesDir(project, filterNode.uuid || processRid);
        await ensureDir(processPath);
        await this.store.setAttribute(processRid, 'path', processPath);
        filterNode.path = processPath;
        if (project) await this.store.connect(processRid, EDGE.BELONGS_TO, project);

        let matched: string[] = [];
        if (mode === 'untagged') {
            const tagged = new Set((await this.db.rows('SELECT DISTINCT target_rid FROM TagLink WHERE target_rid IN :files AND owner = :owner', { files: allFiles, owner: userRid })).map((r) => r.target_rid));
            matched = allFiles.filter((r) => !tagged.has(r));
        } else {
            const rows = await this.db.rows('SELECT target_rid AS file_rid, entity_rid FROM TagLink WHERE target_rid IN :files AND entity_rid IN :entities AND owner = :owner', { files: allFiles, entities: selected, owner: userRid });
            const byFile = new Map<string, Set<string>>();
            for (const row of rows) {
                if (!row.file_rid || !row.entity_rid) continue;
                if (!byFile.has(row.file_rid)) byFile.set(row.file_rid, new Set());
                byFile.get(row.file_rid)!.add(row.entity_rid);
            }
            if (mode === 'exclude') matched = allFiles.filter((r) => !byFile.has(r));
            else for (const [file, entities] of byFile) if (match === 'and' ? entities.size === selected.length : entities.size > 0) matched.push(file);
        }

        let label = typeof params?.set_label === 'string' ? params.set_label.trim() : '';
        if (!label) {
            label = mode === 'include' ? `Tags (${match.toUpperCase()}): ${labels.join(', ')}`
                : mode === 'exclude' ? `Without tags: ${labels.join(', ')}` : 'Untagged files';
        }
        const outputSet = await this.store.createVertex('Set', { label, project_rid: project || null });
        const setPath = this.layout.setDir(project, outputSet.uuid || outputSet['@rid']);
        await ensureDir(setPath);
        await this.store.setAttribute(outputSet['@rid'], 'path', setPath);
        outputSet.path = setPath;
        await this.store.connectDerivedFrom(outputSet['@rid'], sourceSet, processRid);
        if (matched.length) {
            const files = (await this.db.rowsByRids('@rid, project_rid, type, extension, label, info', matched, "@type = 'File'"))
                .sort((a, b) => (String(a.label ?? '') < String(b.label ?? '') ? -1 : String(a.label ?? '') > String(b.label ?? '') ? 1 : 0));
            for (const file of files) {
                const message = { file: { '@rid': file['@rid'], project_rid: file.project_rid || project, type: file.type, extension: file.extension, label: file.label }, output_set: outputSet['@rid'] };
                await this.nodes.createReferenceFile(processRid, message, file['@rid'], '', file.info || '');
            }
        }
        await this.nodes.updateFileCount(outputSet['@rid']);
        return { process: filterNode, output_set: outputSet, selection_mode: mode, matched_files: matched.length, match, selected_entity_rids: selected };
    }
}
