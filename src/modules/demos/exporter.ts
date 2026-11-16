// Exports a desk as a demo bundle: graph.json with the desk's nodes, edges and tags (RIDs and
// absolute paths replaced by bundle ids and relative paths) and the desk's files. The result is
// one zip (writeBundleZip); importing it is a separate step.

import Boom from '@hapi/boom';
import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import yazl from 'yazl';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { BUNDLE_FORMAT, Encoder, FILES_PREFIX, GRAPH_FILE, MANIFEST_FILE, type BundleDocument, type BundleEdge, type BundleNode, type Graph, type Manifest } from './bundle.ts';

const DOCUMENT_TYPES = ['TagLink', 'DeskTag'] as const;
const EDGE_PROPERTIES = ['@type AS edge_type', 'process_rid', 'process_id', 'cruncher', 'task'];

export interface DemoText {
    title: Record<string, string>;
    description: Record<string, string>;
}

export interface Bundle {
    manifest: Manifest;
    graph: Graph;
    projectDir: string;
    /** Paths of the desk's files, relative to the project directory. */
    files: string[];
    /** An image written to the zip as cover.<extension>. */
    cover?: { extension: string; data: Buffer };
}

async function listFiles(root: string, dir = ''): Promise<string[]> {
    let entries;
    try {
        entries = await fsp.readdir(path.join(root, dir), { withFileTypes: true });
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
        throw error;
    }
    const out: string[] = [];
    for (const entry of entries) {
        const relative = dir ? `${dir}/${entry.name}` : entry.name;
        if (entry.isDirectory()) out.push(...await listFiles(root, relative));
        else if (entry.isFile()) out.push(relative);
    }
    return out;
}

export class DemoExporter {
    private readonly db: ArcadeClient;
    private readonly layout: DataLayout;
    private readonly source: string;

    constructor(db: ArcadeClient, layout: DataLayout, source: string) {
        this.db = db;
        this.layout = layout;
        this.source = source;
    }

    async build(projectRid: string, text: DemoText): Promise<Bundle> {
        const project = toRid(projectRid);
        const projectRow = await this.db.firstByRid('*', project, "@type = 'Project' AND _deleting IS NULL");
        if (!projectRow) throw Boom.notFound('Project not found');

        // Everything that points at the desk (BELONGS_TO) or at something in it (DERIVED_FROM).
        const reached = await this.db.traverse<any>('in', ['BELONGS_TO', 'DERIVED_FROM'], project);
        const vertices = new Map<string, any>();
        for (const row of reached) {
            if (row._deleting) continue;
            vertices.set(String(row['@rid']), row);
        }
        vertices.set(project, projectRow);

        const documents = new Map<string, any[]>();
        for (const type of DOCUMENT_TYPES) {
            documents.set(type, await this.db.rows(`SELECT FROM ${type} WHERE project_rid = :project`, { project }));
        }
        const entityRids = new Set<string>();
        for (const rows of documents.values()) for (const row of rows) if (row.entity_rid) entityRids.add(String(row.entity_rid));
        const entities = await this.db.rowsByRids<any>('*', entityRids, "@type = 'Entity'");
        for (const entity of entities) vertices.set(String(entity['@rid']), entity);

        const ids = this.assignIds(vertices);
        const projectDir = this.layout.projectDir(project);
        const encoder = new Encoder(ids, projectDir);

        const nodes: BundleNode[] = [];
        for (const [rid, row] of vertices) {
            nodes.push({ id: ids.get(rid)!, type: String(row['@type']), props: encoder.properties(row) });
        }

        const edges: BundleEdge[] = [];
        const nodeRids = [...vertices.keys()].filter((rid) => !entityRids.has(rid));
        for (const edge of await this.db.edgesOf<any>('out', '', nodeRids, EDGE_PROPERTIES)) {
            const from = ids.get(String(edge.target));
            const to = ids.get(String(edge.source));
            if (!from || !to) continue;
            const { rid, target, source, edge_type: type, ...props } = edge;
            edges.push({ type: String(type), from, to, props: encoder.properties(props) });
        }

        const bundleDocuments: BundleDocument[] = [];
        for (const [type, rows] of documents) {
            for (const row of rows) bundleDocuments.push({ type, props: encoder.properties(row) });
        }

        const files = (await listFiles(projectDir)).sort();
        const manifest: Manifest = {
            format: BUNDLE_FORMAT,
            title: text.title,
            description: text.description,
            created: new Date().toISOString(),
            source: this.source,
            project: ids.get(project)!,
            files: files.length,
        };
        return { manifest, graph: { nodes, edges, documents: bundleDocuments }, projectDir, files };
    }

    /** A vertex is known by its uuid; one without a uuid, or sharing it, gets a numbered id. */
    private assignIds(vertices: Map<string, any>): Map<string, string> {
        const ids = new Map<string, string>();
        const used = new Set<string>();
        let counter = 0;
        for (const [rid, row] of vertices) {
            let id = typeof row.uuid === 'string' && row.uuid && !row.uuid.startsWith('@') ? row.uuid : '';
            if (!id || used.has(id)) {
                do id = `n${counter++}`; while (used.has(id));
            }
            used.add(id);
            ids.set(rid, id);
        }
        return ids;
    }
}

/** Writes the bundle as one zip. Files are streamed from disk, so a large desk is not held in memory. */
export async function writeBundleZip(bundle: Bundle, target: string): Promise<void> {
    await fsp.mkdir(path.dirname(target), { recursive: true });
    const zip = new yazl.ZipFile();
    zip.addBuffer(Buffer.from(JSON.stringify(bundle.manifest, null, 2)), MANIFEST_FILE);
    zip.addBuffer(Buffer.from(JSON.stringify(bundle.graph)), GRAPH_FILE);
    if (bundle.cover) zip.addBuffer(bundle.cover.data, `cover.${bundle.cover.extension}`);
    for (const file of bundle.files) zip.addFile(path.join(bundle.projectDir, file), `${FILES_PREFIX}${file}`);
    const temp = `${target}.part`;
    const output = createWriteStream(temp);
    const done = new Promise<void>((resolve, reject) => {
        output.on('close', resolve);
        output.on('error', reject);
        zip.outputStream.on('error', reject);
    });
    zip.outputStream.pipe(output);
    zip.end();
    try {
        await done;
        await fsp.rename(temp, target);
    } catch (error) {
        await fsp.rm(temp, { force: true });
        throw error;
    }
}
