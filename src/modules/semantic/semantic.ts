// Semantic search over vector indexes (Search tab), and similarity search over TF-IDF indexes
// (Search tab and the index file's viewer, where a pasted text is compared with the index).
//
// A search is a short job on the single-file queue of the service that built the index (the
// file-based index is searched by md-embeddings or md-gensim itself; another backend, e.g. a
// vector database service, answers the same job). The service sends its hits back with /done; they are checked
// against the user's ownership, given labels and snippets, kept here for a few minutes and
// announced over SSE. The UI polls GET /api/search/semantic/{id} (or reacts to the SSE event).

import Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import type { Logger } from '../../platform/logger.ts';
import type { SseHub } from '../../platform/sse/hub.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import type { AccessService } from '../access/access.ts';
import type { Publisher } from '../queue/publisher.ts';
import type { ServiceRegistry } from '../services/registry.ts';

export const SEMANTIC_ROLE = 'semantic_search';
export const INDEX_TYPE = 'vector_index';
export const SIMILARITY_INDEX_TYPE = 'similarity_index';
export const INDEX_TYPES = [INDEX_TYPE, SIMILARITY_INDEX_TYPE];
const DEFAULT_SERVICE: Record<string, string> = { [INDEX_TYPE]: 'md-embeddings', [SIMILARITY_INDEX_TYPE]: 'md-gensim' };
/** A similarity index is also queried with whole pasted texts (text reuse). */
const MAX_QUERY_CHARS: Record<string, number> = { [INDEX_TYPE]: 2000, [SIMILARITY_INDEX_TYPE]: 50000 };
const KEEP_MS = 10 * 60 * 1000;
const MAX_K = 100;
const SNIPPET_CHARS = 400;
/** Above this many rows a file index is noticeably slow: every search reads all of it. */
export const LARGE_INDEX_ROWS = 200_000;

interface PendingSearch {
    id: string;
    userRid: string;
    indexRid: string;
    indexType: string;
    query: string;
    level: string;
    k: number;
    status: 'queued' | 'done' | 'failed';
    created: number;
    finished?: number;
    hits?: any[];
    model?: any;
    /** How the service compared the texts (passage length, overlap, query passages matched). */
    comparison?: any;
    error?: string;
}

export interface IndexInfo {
    rid: string;
    label: string;
    type: string;
    project_rid: string;
    project_label: string | null;
    source_set: string | null;
    source_set_label: string | null;
    service_id: string;
    kind: string;
    model: any;
    rows: number | null;
    files: number | null;
    created: string | null;
    large: boolean;
}

/** The JSON header of a safetensors file (the index metadata lives in `__metadata__`). */
export async function readSafetensorsHeader(file: string): Promise<any | null> {
    const handle = await fsp.open(file, 'r');
    try {
        const head = Buffer.alloc(8);
        await handle.read(head, 0, 8, 0);
        const size = Number(head.readBigUInt64LE(0));
        if (!size || size > 100 * 1024 * 1024) return null;
        const body = Buffer.alloc(size);
        await handle.read(body, 0, size, 8);
        return JSON.parse(body.toString('utf8'));
    } catch {
        return null;
    } finally {
        await handle.close();
    }
}

export class SemanticSearch {
    private readonly d: { db: ArcadeClient; access: AccessService; registry: ServiceRegistry; publisher: Publisher; sse: SseHub; layout: DataLayout; logger: Logger };
    private readonly pending = new Map<string, PendingSearch>();
    private readonly headers = new Map<string, { mtime: number; info: any }>();

    constructor(deps: SemanticSearch['d']) {
        this.d = deps;
    }

    private absolute(nodePath: string): string {
        // Node paths are relative to the backend's working directory (data/<db>/...).
        return path.isAbsolute(nodePath) ? nodePath : path.resolve(nodePath);
    }

    private async indexMeta(nodePath: string): Promise<any> {
        const file = this.absolute(nodePath);
        try {
            const stat = await fsp.stat(file);
            const cached = this.headers.get(file);
            if (cached && cached.mtime === stat.mtimeMs) return cached.info;
            const header = await readSafetensorsHeader(file);
            const meta = header?.__metadata__ || {};
            let model: any = null;
            let files: number | null = null;
            try { model = JSON.parse(meta.model || 'null'); } catch { model = null; }
            try { files = JSON.parse(meta.files || '[]').length; } catch { files = null; }
            const info = { format: meta.format || null, model, rows: Number(meta.rows) || null, files, created: meta.created || null };
            this.headers.set(file, { mtime: stat.mtimeMs, info });
            return info;
        } catch {
            return { format: null, model: null, rows: null, files: null, created: null };
        }
    }

    /** The service that built an index (its producing process), and that therefore searches it. */
    private async serviceOf(indexRid: string, indexType: string): Promise<string> {
        const edge = (await this.d.db.edgesOf('out', 'DERIVED_FROM', [toRid(indexRid)], ['process_rid']))[0];
        const processRid = tryRid(edge?.process_rid);
        if (processRid) {
            const process = await this.d.db.first(`SELECT service_id FROM ${processRid}`);
            if (process?.service_id) return String(process.service_id);
        }
        return DEFAULT_SERVICE[indexType] || DEFAULT_SERVICE[INDEX_TYPE];
    }

    /** A set's label; unlabelled output sets are named after the process that made them. */
    private async setLabel(setRid: string): Promise<string | null> {
        const set = await this.d.db.first(`SELECT label FROM ${toRid(setRid)}`);
        if (set?.label) return String(set.label);
        const edge = (await this.d.db.edgesOf('out', 'DERIVED_FROM', [toRid(setRid)], ['process_rid']))[0];
        const processRid = tryRid(edge?.process_rid);
        const process = processRid ? await this.d.db.first(`SELECT label FROM ${processRid}`) : null;
        return process?.label ? `${process.label} output` : null;
    }

    /** The user's vector and similarity indexes, for the Search tab. */
    async indexes(userRid: string): Promise<IndexInfo[]> {
        const projects = await this.d.db.rows(
            'MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project} RETURN project.@rid AS rid, project.label AS label',
            { user: toRid(userRid) },
        );
        if (!projects.length) return [];
        const projectLabels = new Map(projects.map((p: any) => [String(p.rid), p.label ?? null]));
        const files = await this.d.db.rows(
            'SELECT @rid AS rid, label, type, path, project_rid, created FROM File WHERE type IN :types AND project_rid IN :projects',
            { types: INDEX_TYPES, projects: projects.map((p: any) => p.rid) },
        );
        const out: IndexInfo[] = [];
        for (const file of files) {
            if (!file.path) continue;
            const meta = await this.indexMeta(file.path);
            const edge = (await this.d.db.edgesOf('out', 'DERIVED_FROM', [toRid(file.rid)]))[0];
            const sourceRid = tryRid(edge?.source);
            const source = sourceRid ? await this.setLabel(sourceRid) : null;
            out.push({
                rid: file.rid,
                label: file.label,
                type: file.type || INDEX_TYPE,
                project_rid: String(file.project_rid),
                project_label: projectLabels.get(String(file.project_rid)) ?? null,
                source_set: sourceRid,
                source_set_label: source,
                service_id: await this.serviceOf(file.rid, file.type || INDEX_TYPE),
                kind: 'file',
                model: meta.model,
                rows: meta.rows,
                files: meta.files,
                created: meta.created || file.created || null,
                large: Number(meta.rows || 0) > LARGE_INDEX_ROWS,
            });
        }
        return out;
    }

    private prune(): void {
        const now = Date.now();
        for (const [id, search] of this.pending) {
            if (now - search.created > KEEP_MS) this.pending.delete(id);
        }
    }

    /** POST /api/search/semantic: queues the search and answers at once with its id. */
    async start(userRid: string, body: any): Promise<{ search_id: string; status: string }> {
        this.prune();
        const query = String(body?.query || '').trim();
        if (!query) throw Boom.badRequest('Query is empty');
        const indexRid = tryRid(body?.index);
        if (!indexRid) throw Boom.badRequest('index must be an index rid');
        const owned = await this.d.access.findOwned(indexRid, userRid);
        if (!owned || owned.node['@type'] !== 'File' || !INDEX_TYPES.includes(owned.node.type)) throw Boom.notFound('Index not found');
        const indexType = String(owned.node.type);
        if (query.length > MAX_QUERY_CHARS[indexType]) throw Boom.badRequest(`Query is too long (at most ${MAX_QUERY_CHARS[indexType]} characters)`);
        const k = Math.max(1, Math.min(Number.parseInt(String(body?.k ?? 20), 10) || 20, MAX_K));
        const level = body?.level === 'doc' ? 'doc' : 'chunk';
        const params: any = { query, top_k: k, level };
        if (body?.threshold !== undefined && body?.threshold !== null && body?.threshold !== '') {
            const threshold = Number(body.threshold);
            if (!Number.isFinite(threshold) || threshold < 0 || threshold > 1) throw Boom.badRequest('threshold must be between 0 and 1');
            params.threshold = threshold;
        }
        const serviceId = await this.serviceOf(indexRid, indexType);
        if (!this.d.registry.hasActiveConsumer(serviceId)) throw Boom.serverUnavailable(`The search service (${serviceId}) is not running`);

        const id = randomUUID();
        this.pending.set(id, { id, userRid, indexRid, indexType, query, level, k, status: 'queued', created: Date.now() });
        await this.d.publisher.publish(serviceId, {
            service: { id: serviceId },
            task: { id: 'search', params },
            file: { ...owned.node, project_rid: owned.projectRid },
            project_rid: owned.projectRid,
            userId: userRid,
            role: SEMANTIC_ROLE,
            search_id: id,
            queue_options: { max_attempts: 2 },
        });
        return { search_id: id, status: 'queued' };
    }

    /** GET /api/search/semantic/{id}: the search's state and, when done, its hits. */
    get(id: string, userRid: string): any {
        const search = this.pending.get(String(id));
        if (!search || search.userRid !== userRid) throw Boom.notFound('Search not found (or expired)');
        return {
            search_id: search.id,
            status: search.status,
            query: search.query,
            index: search.indexRid,
            index_type: search.indexType,
            level: search.level,
            model: search.model ?? null,
            comparison: search.comparison ?? null,
            hits: search.hits ?? [],
            error: search.error ?? null,
            took_ms: search.finished ? search.finished - search.created : null,
        };
    }

    private async snippet(nodePath: string | undefined, start: number, end: number, texts: Map<string, string | null>): Promise<string | null> {
        if (!nodePath) return null;
        if (!texts.has(nodePath)) {
            let text: string | null = null;
            try {
                const file = this.absolute(nodePath);
                const stat = await fsp.stat(file);
                if (stat.size <= 20 * 1024 * 1024) text = await fsp.readFile(file, 'utf8');
            } catch {
                text = null;
            }
            texts.set(nodePath, text);
        }
        const text = texts.get(nodePath);
        if (!text) return null;
        const from = Math.max(0, Math.min(start, text.length));
        const to = Math.max(from, Math.min(end || from + SNIPPET_CHARS, text.length, from + SNIPPET_CHARS));
        return text.slice(from, to).replace(/\s+/g, ' ').trim() + (to < Math.min(end, text.length) ? ' …' : '');
    }

    /** /done of a search job. The user comes from the pending search, never from the message. */
    async deliver(message: any): Promise<void> {
        const search = this.pending.get(String(message?.search_id || ''));
        if (!search || search.status !== 'queued') return;
        const results = message?.response?.results || {};
        const docMap: string[] = Array.isArray(results.doc_map) ? results.doc_map : [];
        const owned = new Map<string, any | null>();
        const texts = new Map<string, string | null>();
        const hits: any[] = [];
        for (const match of Array.isArray(results.chunk_similarities) ? results.chunk_similarities : []) {
            const rid = tryRid(docMap[Number(match?.doc_index ?? -1)]);
            if (!rid) continue;
            if (!owned.has(rid)) owned.set(rid, await this.d.access.findOwned(rid, search.userRid));
            const node = owned.get(rid);
            if (!node) continue; // not the user's (or deleted since the index was built)
            const start = Number(match.text_start_char) || 0;
            const end = Number(match.text_end_char) || 0;
            hits.push({
                rid,
                label: node.node.label ?? match.doc_label ?? null,
                type: node.node.type ?? null,
                path: node.node.path ?? null,
                project_rid: node.projectRid,
                similarity: Number(match.similarity),
                chunk: match.chunk ?? null,
                start_char: start,
                end_char: end,
                // where the match is in the query (similarity indexes compare whole texts)
                query_start_char: match.query_start_char ?? null,
                query_end_char: match.query_end_char ?? null,
                query_start_token: match.query_start_token ?? null,
                snippet: match.chunk === -1 ? await this.snippet(node.node.path, 0, SNIPPET_CHARS, texts) : await this.snippet(node.node.path, start, end, texts),
            });
        }
        search.hits = hits;
        search.model = results.model ?? null;
        search.comparison = {
            window_size: results.window_size ?? null,
            overlap: results.overlap ?? null,
            threshold: results.threshold ?? null,
            query_windows: results.query_windows ?? null,
            matched_windows: results.matched_windows ?? null,
        };
        search.status = 'done';
        search.finished = Date.now();
        this.d.sse.send(search.userRid, { command: 'semantic_results', search_id: search.id, status: 'done', count: hits.length });
    }

    /** /error of a search job (after its last attempt). */
    fail(message: any, error: any): void {
        const search = this.pending.get(String(message?.search_id || ''));
        if (!search || search.status !== 'queued') return;
        search.status = 'failed';
        search.finished = Date.now();
        search.error = String(error?.details || error?.message || error || 'Search failed').slice(0, 500);
        this.d.logger.warn('Semantic search failed', { search: search.id, error: search.error });
        this.d.sse.send(search.userRid, { command: 'semantic_results', search_id: search.id, status: 'failed' });
    }
}
