// Imports a demo bundle as a new desk for a user. Nothing is run: nodes, edges, tags and files
// are copied, with new RIDs and new uuids (so a bundle can be imported many times, and a node's
// uuid stays unique in the database).

import Boom from '@hapi/boom';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { uuidv7 } from '../../platform/ids.ts';
import { ensureDir, moveFile } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';
import type { ProjectsService } from '../projects/projects.ts';
import { Decoder, type BundleNode } from './bundle.ts';
import { DEFAULT_LIMITS, readBundle, type ReadLimits } from './reader.ts';

const NODE_TYPES = new Set(['File', 'Set', 'Process', 'SetProcess', 'Source', 'ErrorNode']);
const EDGE_TYPES = new Set<string>([EDGE.BELONGS_TO, EDGE.DERIVED_FROM, EDGE.HAS_PROCESS]);
const DOCUMENT_TYPES = new Set(['TagLink', 'DeskTag']);
// Set by the database or by the importer.
const SKIPPED_PROPERTIES = new Set(['uuid', 'created', 'expiration_date']);
const HEX_UUID = /([0-9a-f]{2}\/[0-9a-f]{2}\/[0-9a-f]{2}\/)?([0-9a-f]{32})/g;

export interface ImportOptions {
    zipFile: string;
    userRid: string;
    /** Recorded on the new desk as `demo_source`, e.g. "<template id>@<version>". */
    source?: string;
    limits?: ReadLimits;
}

export interface ImportResult {
    project: any;
    nodes: number;
    files: number;
}

export interface ImporterHooks {
    /** Writes a set's set.json (NodesService.syncSetManifest). */
    syncSetManifest?: (setRid: string) => Promise<unknown>;
    /** Queues the search index of the new desk (Processing.reindexProject). */
    reindex?: (projectRid: string, userRid: string) => Promise<unknown>;
    log?: (message: string) => void;
}

/** True when a value holds anything the Decoder changes ("@ref:", "@project/", "@@"). */
function isEncoded(value: unknown): boolean {
    if (typeof value === 'string') return value.startsWith('@');
    if (Array.isArray(value)) return value.some(isEncoded);
    if (value && typeof value === 'object') return Object.values(value).some(isEncoded);
    return false;
}

function compactUuid(uuid: string): string {
    return uuid.replace(/-/g, '').toLowerCase();
}

/** Renames the uuid parts of a project-relative path (shard directories and file names). */
export function uuidPathMapper(hexMap: Map<string, string>): (relative: string) => string {
    return (relative) => relative.replace(HEX_UUID, (match, prefix: string | undefined, hex: string) => {
        const next = hexMap.get(hex);
        if (!next) return match;
        return `${prefix ? `${next.slice(0, 2)}/${next.slice(2, 4)}/${next.slice(4, 6)}/` : ''}${next}`;
    });
}

export class DemoImporter {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly projects: ProjectsService;
    private readonly hooks: ImporterHooks;

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout, projects: ProjectsService, hooks: ImporterHooks = {}) {
        this.db = db;
        this.store = store;
        this.layout = layout;
        this.projects = projects;
        this.hooks = hooks;
    }

    async import(options: ImportOptions): Promise<ImportResult> {
        await ensureDir(this.layout.tmpDir);
        const workDir = await fsp.mkdtemp(path.join(this.layout.tmpDir, 'demo-import-'));
        const created: string[] = [];
        let project: any = null;
        try {
            const bundle = await readBundle(options.zipFile, workDir, options.limits ?? DEFAULT_LIMITS);
            const byId = new Map(bundle.graph.nodes.map((n) => [n.id, n]));
            const projectNode = byId.get(bundle.manifest.project);
            if (!projectNode || projectNode.type !== 'Project') throw Boom.badRequest('The bundle has no project node');

            project = await this.createProject(projectNode, options);
            const projectRid: string = project['@rid'];
            const projectDir = this.layout.projectDir(projectRid);

            const newUuids = new Map<string, string>();
            const hexMap = new Map<string, string>();
            for (const node of bundle.graph.nodes) {
                if (!NODE_TYPES.has(node.type) || typeof node.props.uuid !== 'string') continue;
                const uuid = uuidv7();
                newUuids.set(node.id, uuid);
                hexMap.set(compactUuid(node.props.uuid), compactUuid(uuid));
            }
            const mapPath = uuidPathMapper(hexMap);

            const rids = new Map<string, string>([[projectNode.id, projectRid]]);
            const deferred: Array<{ rid: string; props: Record<string, unknown> }> = [];
            for (const node of bundle.graph.nodes) {
                if (node.id === projectNode.id) continue;
                if (node.type === 'Entity') {
                    rids.set(node.id, await this.entity(node, options.userRid, created));
                    continue;
                }
                if (!NODE_TYPES.has(node.type)) continue;
                const plain: Record<string, unknown> = {};
                const refs: Record<string, unknown> = {};
                for (const [key, value] of Object.entries(node.props)) {
                    if (SKIPPED_PROPERTIES.has(key)) continue;
                    (isEncoded(value) ? refs : plain)[key] = value;
                }
                const vertex = await this.store.createVertexRaw(node.type, { ...plain, uuid: newUuids.get(node.id) ?? uuidv7() });
                created.push(vertex['@rid']);
                rids.set(node.id, vertex['@rid']);
                if (Object.keys(refs).length) deferred.push({ rid: vertex['@rid'], props: refs });
            }

            const decoder = new Decoder(rids, projectDir, mapPath);
            for (const item of deferred) {
                await this.store.setAttributes(item.rid, decoder.value(item.props) as Record<string, unknown>);
            }
            await this.edges(bundle.graph.edges, rids, new Map([...newUuids].map(([id, uuid]) => [rids.get(id)!, uuid])), decoder);
            await this.documents(bundle.graph.documents, decoder, options.userRid, projectRid);
            await this.moveFiles(bundle.filesDir, bundle.files, projectDir, mapPath);

            for (const node of bundle.graph.nodes) {
                if (node.type !== 'Set') continue;
                await this.hooks.syncSetManifest?.(rids.get(node.id)!);
            }
            await this.hooks.reindex?.(projectRid, options.userRid).catch((error) => this.hooks.log?.(`Search reindex of the imported desk failed: ${(error as Error).message}`));
            return { project, nodes: created.length, files: bundle.files.length };
        } catch (error) {
            await this.rollback(project?.['@rid'], created);
            throw error;
        } finally {
            await fsp.rm(workDir, { recursive: true, force: true });
        }
    }

    /** The desk keeps the demo's title; a user who already has a desk of that name gets "(2)", "(3)", … */
    private async createProject(node: BundleNode, options: ImportOptions): Promise<any> {
        const data: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(node.props)) {
            if (!SKIPPED_PROPERTIES.has(key) && key !== 'label' && key !== 'active' && typeof value !== 'object') data[key] = value;
        }
        if (options.source) data.demo_source = options.source;
        const label = String(node.props.label || 'Demo');
        for (let attempt = 1; attempt < 100; attempt++) {
            try {
                return await this.projects.create({ ...data, label: attempt === 1 ? label : `${label} (${attempt})` }, options.userRid);
            } catch (error) {
                if (!Boom.isBoom(error) || error.output.statusCode !== 409) throw error;
            }
        }
        throw Boom.conflict('Could not find a free name for the desk');
    }

    /** Tags are the user's own vocabulary: an entity of the same type and label is reused. */
    private async entity(node: BundleNode, userRid: string, created: string[]): Promise<string> {
        const { type, label } = node.props;
        const existing = await this.db.first<{ rid: string }>('SELECT @rid AS rid FROM Entity WHERE owner = :owner AND type = :type AND label = :label LIMIT 1', { owner: userRid, type: type ?? null, label: label ?? null });
        if (existing) return existing.rid;
        const content: Record<string, unknown> = { owner: userRid, uuid: uuidv7() };
        for (const [key, value] of Object.entries(node.props)) {
            if (!SKIPPED_PROPERTIES.has(key)) content[key] = value;
        }
        const vertex = await this.store.createVertexRaw('Entity', content);
        created.push(vertex['@rid']);
        return vertex['@rid'];
    }

    private async edges(edges: Array<{ type: string; from: string; to: string; props: Record<string, unknown> }>, rids: Map<string, string>, uuidByRid: Map<string, string>, decoder: Decoder): Promise<void> {
        for (const edge of edges) {
            const from = rids.get(edge.from);
            const to = rids.get(edge.to);
            if (!EDGE_TYPES.has(edge.type) || !from || !to) continue;
            const props = decoder.value(edge.props) as Record<string, unknown>;
            // process_id is the process's uuid; it has no @ref form, so it follows process_rid.
            const processUuid = uuidByRid.get(String(props.process_rid));
            if (processUuid) props.process_id = processUuid;
            await this.db.sql(`CREATE EDGE ${edge.type} FROM ${from} TO ${to} CONTENT :props`, { props });
        }
    }

    private async documents(documents: Array<{ type: string; props: Record<string, unknown> }>, decoder: Decoder, userRid: string, projectRid: string): Promise<void> {
        for (const document of documents) {
            if (!DOCUMENT_TYPES.has(document.type)) continue;
            const props = decoder.value(document.props) as Record<string, unknown>;
            await this.db.sql(`INSERT INTO ${document.type} CONTENT :props`, { props: { ...props, owner: userRid, project_rid: projectRid } });
        }
    }

    private async moveFiles(filesDir: string, files: string[], projectDir: string, mapPath: (relative: string) => string): Promise<void> {
        await ensureDir(projectDir);
        for (const relative of files) {
            const target = path.join(projectDir, mapPath(relative));
            if (!this.layout.contains(target)) throw Boom.badRequest(`Unsafe path in the bundle: ${relative}`);
            await moveFile(path.join(filesDir, relative), target);
        }
    }

    /** Removes what a failed import created; the nodes first, then the desk and its directory. */
    private async rollback(projectRid: string | undefined, created: string[]): Promise<void> {
        try {
            for (const rid of created) await this.db.sql(`DELETE VERTEX FROM ${rid}`);
            if (projectRid) {
                await this.db.sql('DELETE FROM TagLink WHERE project_rid = :p', { p: projectRid });
                await this.db.sql('DELETE FROM DeskTag WHERE project_rid = :p', { p: projectRid });
                await this.db.sql(`DELETE VERTEX FROM ${projectRid}`);
                await fsp.rm(this.layout.projectDir(projectRid), { recursive: true, force: true });
            }
        } catch (error) {
            this.hooks.log?.(`Cleanup of a failed demo import failed: ${(error as Error).message}`);
        }
    }
}
