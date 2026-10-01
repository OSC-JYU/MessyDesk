// Generic node operations: attribute edits, lineage traversal, edge edits and cascade delete.

import Boom from '@hapi/boom';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { cypherString, type ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { removeNodePath } from '../../platform/storage/fsutil.ts';
import type { SolrClient } from '../../platform/solr/solr.ts';
import { assertIdentifier, type GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';
import type { TagsService } from '../tags/tags.ts';

/** Attributes a user may edit through POST /api/graph/vertices/{rid}. */
export const EDITABLE_ATTRIBUTES = ['description', 'label', 'info', 'expand', 'metadata', 'response', 'node_error', 'path', 'edited'];

// ner.json outputs are machine-tag provenance: deleting one removes the tags it created.
const AUTOTAG_SOURCE_FILE_TYPES = ['ner.json'];

export class GraphService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly access: AccessService;
    private readonly tags: TagsService;
    private readonly solr: SolrClient;
    private readonly layout: DataLayout;

    constructor(db: ArcadeClient, store: GraphStore, access: AccessService, tags: TagsService, solr: SolrClient, layout: DataLayout) {
        this.db = db;
        this.store = store;
        this.access = access;
        this.tags = tags;
        this.solr = solr;
        this.layout = layout;
    }

    /** Sets one editable attribute of an owned node; `null` removes it. */
    async setAttribute(rid: string, data: { key?: string; value?: unknown }, userRid: string): Promise<{ nodes: []; edges: [] }> {
        if (!(await this.access.canRead(rid, userRid))) throw Boom.badRequest('You are not the owner of this file');
        if (!data?.key || !EDITABLE_ATTRIBUTES.includes(data.key)) throw Boom.badRequest('Invalid data');
        if (data.value === null) await this.store.removeAttribute(rid, data.key);
        else await this.store.setAttribute(rid, data.key, data.value);
        // The old route answered with an empty Vue Flow conversion of the update.
        return { nodes: [], edges: [] };
    }

    /** Lineage from a node along DERIVED_FROM ('out' = towards the sources). */
    async traverse(rid: string, direction: string, userRid: string): Promise<any[] | null> {
        if (!['in', 'out', 'both'].includes(direction)) throw Boom.badRequest('direction must be in, out or both');
        if (!(await this.access.canRead(rid, userRid))) return null;
        return this.db.traverse(direction as 'in' | 'out' | 'both', ['DERIVED_FROM'], toRid(rid));
    }

    /** Source chain of a file, nearest first, up to `maxDepth` steps. */
    async ancestors(fileRid: string, userRid: string, maxDepth = 40): Promise<any[] | null> {
        if (!(await this.access.canRead(fileRid, userRid))) return null;
        const out = [];
        let current = toRid(fileRid);
        for (let depth = 0; depth < maxDepth; depth += 1) {
            const row = await this.db.first(
                'MATCH {type:File, as:target, where:(@rid = :rid)}-DERIVED_FROM->{type:File, as:source} RETURN source.@rid AS rid, source.label AS label, source.type AS type, source.extension AS extension, source.path AS path, source.@type AS node_type',
                { rid: current },
            );
            if (!row?.rid) break;
            out.push({ '@rid': row.rid, label: row.label, type: row.type, extension: row.extension, path: row.path, '@type': row.node_type });
            current = row.rid;
        }
        return out;
    }

    private async edgeEnds(rid: string): Promise<{ out: string; in: string } | null> {
        const row = await this.db.first(`SELECT @out AS o, @in AS i FROM ${toRid(rid)}`).catch(() => null);
        return row ? { out: row.o, in: row.i } : null;
    }

    private async requireOwnedEdge(rid: string, userRid: string): Promise<void> {
        const ends = await this.edgeEnds(rid);
        if (!ends || !(await this.access.canRead(ends.out, userRid)) || !(await this.access.canRead(ends.in, userRid))) {
            throw Boom.notFound('Edge not found');
        }
    }

    async deleteEdge(rid: string, userRid: string): Promise<any> {
        await this.requireOwnedEdge(rid, userRid);
        if (this.db.legacy) return this.db.cypher(`MATCH (from)-[r]->(to) WHERE id(r) = ${cypherString(toRid(rid))} DELETE r`);
        return this.db.sql(`DELETE FROM ${toRid(rid)}`);
    }

    async setEdgeAttribute(rid: string, data: { name?: string; value?: unknown }, userRid: string): Promise<any> {
        await this.requireOwnedEdge(rid, userRid);
        const name = assertIdentifier(String(data?.name || ''));
        const value = Array.isArray(data.value) ? data.value.map((v) => String(v)) : data.value;
        if (this.db.legacy) {
            const literal = Array.isArray(value) ? `[${value.map(cypherString).join(',')}]`
                : typeof value === 'number' || typeof value === 'boolean' ? String(value) : cypherString(value ?? '');
            return this.db.cypher(`MATCH (from)-[r]->(to) WHERE id(r) = ${cypherString(toRid(rid))} SET r.${name} = ${literal}`);
        }
        return this.db.sql(`UPDATE ${toRid(rid)} SET ${name} = :value`, { value });
    }

    /** A File's own directory is named after its uuid (or legacy rid); shared directories are not. */
    private ownsDirectory(node: any): boolean {
        const dir = path.basename(path.dirname(String(node.path)));
        if (node.uuid && dir === String(node.uuid).toLowerCase().replace(/-/g, '')) return true;
        const pos = String(node['@rid']).split(':')[1];
        return dir === pos;
    }

    /**
     * Deletes a node and everything derived from it: outputs (DERIVED_FROM in-edges), outputs of a
     * deleted process (process_rid on edges), members of a deleted set and processes of a deleted
     * set process. Sources upstream are kept. Search docs, TagLinks and directories go too.
     */
    async deleteNode(rid: string, userRid: string): Promise<{ path: string | null; deleted: number }> {
        const root = toRid(rid);
        if (!(await this.access.canRead(root, userRid))) throw Boom.notFound('Node not found');
        const queue: string[] = [root];
        const visited = new Set<string>();
        const toDelete = new Set<string>();
        const solrProcesses = new Set<string>();
        const paths = new Set<string>();
        const nerRuns = new Set<string>();
        const files = new Set<string>();
        const singleFiles = new Set<string>();
        const enqueue = (value: unknown) => {
            const clean = tryRid(value);
            if (clean && !visited.has(clean)) queue.push(clean);
        };
        while (queue.length) {
            const current = queue.pop()!;
            if (visited.has(current)) continue;
            visited.add(current);
            const node = await this.db.first(`SELECT @rid, @type, path, uuid, service, ref, type AS file_type, service_id, task FROM ${current}`).catch((error) => {
                if (/404|not found/i.test(String(error?.message) + String(error?.detail))) return null;
                throw error;
            });
            if (!node?.['@rid']) continue;
            toDelete.add(node['@rid']);
            if (node.service === 'Solr') solrProcesses.add(node['@rid']);
            if (node['@type'] === 'File') {
                files.add(node['@rid']);
                if (AUTOTAG_SOURCE_FILE_TYPES.includes(node.file_type)) nerRuns.add(node['@rid']);
            }
            const isReference = node['@type'] === 'File' && Boolean(node.ref);
            if (node.path && node['@type'] !== 'Filter' && !isReference) {
                if (node['@type'] === 'File' && !this.ownsDirectory(node)) {
                    // e.g. roi.json, stored next to its image: remove only the file, never the
                    // image's directory (the old backend removed the whole directory).
                    singleFiles.add(node.path);
                } else {
                    paths.add(node['@type'] === 'Process' && path.basename(node.path) === 'files' ? path.dirname(node.path) : node.path);
                }
            }
            for (const rel of await this.db.rows('SELECT @out AS rid, process_rid FROM DERIVED_FROM WHERE @in = :rid', { rid: current })) {
                enqueue(rel.rid);
                enqueue(rel.process_rid);
            }
            for (const rel of await this.db.rows('SELECT @out AS rid FROM DERIVED_FROM WHERE process_rid = :rid', { rid: current })) enqueue(rel.rid);
            for (const edge of await this.db.rows('SELECT process_rid FROM DERIVED_FROM WHERE @in = :rid OR @out = :rid', { rid: current })) enqueue(edge.process_rid);
            if (node['@type'] === 'Set') {
                for (const f of await this.db.rows('SELECT @rid AS rid FROM File WHERE set = :rid', { rid: current })) enqueue(f.rid);
            }
            if (node['@type'] === 'SetProcess') {
                for (const p of await this.db.rows('SELECT @rid AS rid FROM Process WHERE set_process = :rid', { rid: current })) enqueue(p.rid);
            }
        }

        for (const processRid of solrProcesses) await this.solr.dropProcessIndex(processRid);
        for (const nerRid of nerRuns) {
            const source = await this.db.first('SELECT @in AS rid FROM DERIVED_FROM WHERE @out = :rid', { rid: nerRid });
            if (!source?.rid) continue;
            const run = await this.db.first(`SELECT service_id, task FROM ${nerRid}`);
            await this.tags.removeMachineLinksOfRun(source.rid, run?.service_id || null, run?.task || null);
            if (!toDelete.has(source.rid)) await this.tags.reindexFileTags(source.rid, userRid);
        }
        await this.tags.removeLinksOf([...toDelete]);
        for (const fileRid of files) await this.solr.dropFileIndex(fileRid);
        for (const target of toDelete) await this.db.sql(`DELETE FROM ${target}`);
        for (const p of singleFiles) await fsp.rm(p, { force: true }).catch(() => {});
        const sorted = [...paths].sort((a, b) => b.length - a.length);
        for (const p of sorted) await removeNodePath(p, this.layout.dataDir).catch(() => {});
        return { path: sorted[0] || null, deleted: toDelete.size };
    }
}
