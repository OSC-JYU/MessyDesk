// Uploads, file content, in-place edits (versions) and set listings.

import Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import type { SseHub } from '../../platform/sse/hub.ts';
import { exists, fileSizeMb, moveFile, writeStream } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { sourceFileOf, type GraphStore } from '../../shared/graph-store.ts';
import { FILE_TYPE, SERVICE, isPdfType } from '../../shared/service-ids.ts';
import { entryWindow, flatSegments, isGrouped, sortGroups, type GroupRow } from './set-groups.ts';
import type { AccessService } from '../access/access.ts';
import type { NodesService } from '../nodes/nodes.ts';
import type { DeskGraph } from '../projects/desk-graph.ts';
import type { ServiceRegistry } from '../services/registry.ts';
import type { TagsService } from '../tags/tags.ts';
import type { ThumbnailService } from '../thumbnails/thumbnails.ts';
import { TEXT_LIKE_TYPES, detectType, imageMetadata, setTextSamples, textDescription } from './metadata.ts';

export interface UploadPart extends Readable {
    hapi: { filename: string; headers: Record<string, string> };
}

export interface UploadOptions {
    noThumbnails: boolean;
}

export class FilesService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly nodes: NodesService;
    private readonly tags: TagsService;
    private readonly thumbnails: ThumbnailService;
    private readonly registry: ServiceRegistry;
    private readonly deskGraph: DeskGraph;
    private readonly sse: SseHub;
    private readonly apiUrl: string;
    private readonly maxVersionTextBytes: number;

    constructor(deps: {
        db: ArcadeClient; store: GraphStore; layout: DataLayout; access: AccessService; nodes: NodesService; tags: TagsService;
        thumbnails: ThumbnailService; registry: ServiceRegistry; deskGraph: DeskGraph; sse: SseHub;
        apiUrl: string; maxVersionTextBytes: number;
    }) {
        this.db = deps.db;
        this.store = deps.store;
        this.layout = deps.layout;
        this.access = deps.access;
        this.nodes = deps.nodes;
        this.tags = deps.tags;
        this.thumbnails = deps.thumbnails;
        this.registry = deps.registry;
        this.deskGraph = deps.deskGraph;
        this.sse = deps.sse;
        this.apiUrl = deps.apiUrl;
        this.maxVersionTextBytes = deps.maxVersionTextBytes;
    }

    /** The node a user may see, with `project_rid`; a Set also gets its member types and extensions. */
    async metadata(rid: unknown, userRid: string): Promise<any | null> {
        const owned = await this.access.findOwned(rid, userRid);
        if (!owned) return null;
        const node = { ...owned.node, project_rid: owned.projectRid };
        const type = node['@type'];
        if (type === 'Set') {
            const rows = await this.db.rows('SELECT DISTINCT extension AS extension_group, type AS type_group FROM File WHERE set = :set', { set: node['@rid'] });
            node.extensions = rows.map((r) => r.extension_group);
            node.types = rows.map((r) => r.type_group);
            return node;
        }
        if (type === 'File' || type === 'Source') return node;
        return null;
    }

    // ---- upload ------------------------------------------------------------------------

    async upload(projectRid: string, setParam: string | undefined, parts: UploadPart[], userRid: string, opts: UploadOptions): Promise<any> {
        if (!(await this.access.isProjectOwner(projectRid, userRid))) throw Boom.notFound('Project not found');
        const project = toRid(projectRid);
        if (!parts.length) throw Boom.badRequest('No file uploaded');
        if (parts.length > 1 && !setParam) throw Boom.badRequest('Multiple file upload is only supported when uploading into a Set');

        let requiredType: string | null = null;
        if (setParam) {
            const set = await this.metadata(setParam, userRid);
            if (!set || set['@type'] !== 'Set') throw Boom.notFound('Set not found');
            // A batch can't be re-run or extended, so a set used as batch input is locked.
            if ((await this.deskGraph.processedSetRids([set['@rid']])).size) {
                throw Boom.conflict('This Set has already been processed and can no longer accept new files');
            }
            const types = [...new Set((set.types || []).map((t: unknown) => String(t || '').toLowerCase()).filter(Boolean))] as string[];
            if (types.length > 1) throw Boom.badRequest('Set contains mixed file types; new uploads are blocked until set type is normalized');
            if (types.length === 1) requiredType = types[0];
        }

        const uploaded = [];
        const failed = [];
        for (const part of parts) {
            const filename = part.hapi?.filename;
            try {
                const type = detectType(filename, part.hapi?.headers?.['content-type']);
                if (!type) throw Boom.badRequest(`Could not determine file type for ${filename}`);
                if (requiredType && type.toLowerCase() !== requiredType) throw Boom.badRequest(`Set accepts only ${requiredType} files`);
                uploaded.push(await this.uploadOne(project, setParam, part, type, userRid, opts));
                if (!requiredType) requiredType = type.toLowerCase();
            } catch (error) {
                part.resume();
                failed.push({ filename: filename || null, error: (error as Error)?.message || 'Upload failed' });
            }
        }
        // A single file keeps the old response shape: the node itself, or the error as 400.
        if (parts.length === 1) {
            if (failed.length) throw Boom.badRequest(failed[0].error);
            return uploaded[0];
        }
        return { uploaded, failed, total: parts.length };
    }

    private async uploadOne(projectRid: string, setParam: string | undefined, part: UploadPart, type: string, userRid: string, opts: UploadOptions): Promise<any> {
        const node = await this.nodes.createOriginalFile(projectRid, part.hapi.filename, type, setParam ? toRid(setParam) : null);
        await writeStream(part, node.path);
        node.metadata = { size: await fileSizeMb(node.path) };
        if (type === 'image') {
            const image = imageMetadata(node.path);
            node.metadata = { ...node.metadata, ...image };
            await this.store.setAttribute(node['@rid'], 'metadata', node.metadata);
            if (!opts.noThumbnails) await this.thumbnails.forUpload(node, userRid, image.rotate);
        } else {
            await this.store.setAttribute(node['@rid'], 'metadata', node.metadata);
        }
        if (TEXT_LIKE_TYPES.includes(type)) {
            node.info = await textDescription(node.path, type);
            await this.store.setAttribute(node['@rid'], 'info', node.info);
        }
        node._type = type;
        this.sse.send(userRid, { command: 'add', type, node, image: 'api/thumbnails', set: setParam });
        if (setParam && type === 'text') {
            const set = toRid(setParam);
            this.sse.send(userRid, { command: 'update', target: set, node: { text_samples: await setTextSamples(this.db, set) } });
        }
        return node;
    }

    // ---- reading -----------------------------------------------------------------------

    /** GET /api/documents/{rid}: node attributes plus file-level entities. */
    async document(rid: string, userRid: string): Promise<any | null> {
        const owned = await this.access.findOwned(rid, userRid);
        if (!owned) return null;
        const node = { ...owned.node };
        node.entities = await this.tags.linkedEntities(node['@rid'], userRid);
        return node;
    }

    /** Where the bytes of a file are: the file, or its sibling error.json when the job failed. */
    async contentPath(file: any): Promise<{ path: string; errorJson: boolean } | null> {
        const absolute = path.resolve(file.path);
        if (await exists(absolute)) return { path: absolute, errorJson: false };
        const errorJson = path.join(path.dirname(absolute), 'error.json');
        if (await exists(errorJson)) return { path: errorJson, errorJson: true };
        return null;
    }

    /** The file a file was derived from (GET /api/files/{rid}/source). */
    async source(fileRid: string, userRid: string): Promise<any | null> {
        if (!(await this.access.canRead(fileRid, userRid))) return null;
        return this.store.sourceFileOf(toRid(fileRid));
    }

    // ---- versions ----------------------------------------------------------------------

    private managedPath(filePath: string): string {
        const absolute = path.resolve(filePath);
        if (!this.layout.contains(absolute) || absolute === path.resolve(this.layout.dataDir)) throw Boom.forbidden('File path is outside managed data directory');
        return absolute;
    }

    private async refreshMetadata(file: any): Promise<void> {
        const metadata = { ...(file.metadata || {}), size: await fileSizeMb(file.path) };
        if (file.type === 'image') Object.assign(metadata, imageMetadata(file.path));
        await this.store.setAttribute(file['@rid'], 'metadata', metadata);
        if (TEXT_LIKE_TYPES.includes(file.type)) await this.store.setAttribute(file['@rid'], 'info', await textDescription(file.path, file.type));
    }

    /**
     * Replaces a file's bytes with an edited version (an uploaded file, or text `content` for
     * text-like files). The first edit keeps the original as <path>.original for revert.
     */
    async createVersion(fileRid: string, payload: any, userRid: string): Promise<any> {
        const file = await this.metadata(fileRid, userRid);
        if (!file || file['@type'] !== 'File') throw Boom.notFound('File not found');
        const managed = this.managedPath(file.path);
        if (!(await exists(managed))) throw Boom.notFound('File path not found');
        // A note is written in place: no original to revert to, and it is not an "edited" file.
        if (file.note === true && typeof payload?.content === 'string') return this.saveNote(file, managed, payload.content, userRid);
        const backup = `${managed}.original`;
        const upload = payload?.file;
        const hasUpload = upload && typeof upload.pipe === 'function';
        const hasText = typeof payload?.content === 'string';
        const hasContentField = payload && Object.prototype.hasOwnProperty.call(payload, 'content');
        const type = String(file.type || '').toLowerCase();
        const textLike = TEXT_LIKE_TYPES.includes(type) || type.endsWith('.json');
        if (hasUpload && hasContentField) throw Boom.badRequest('Provide either file upload or content payload, not both');
        if (!hasUpload && !hasText) throw Boom.badRequest('Missing edited file upload or content payload');
        if (!hasUpload && !textLike) throw Boom.badRequest('Content payload is only supported for text-like files');
        if (!hasUpload && Buffer.byteLength(payload.content, 'utf8') > this.maxVersionTextBytes) throw Boom.badRequest('Text payload exceeds size limit');
        if (!(await exists(backup))) await fsp.copyFile(managed, backup, fs.constants.COPYFILE_EXCL);
        const staging = `${managed}.editing.${randomUUID()}`;
        try {
            if (hasUpload) await writeStream(upload, staging);
            else await fsp.writeFile(staging, payload.content, 'utf8');
            await fsp.rename(staging, managed);
        } catch (error) {
            await fsp.rm(staging, { force: true });
            if (!(await exists(managed)) && (await exists(backup))) await fsp.copyFile(backup, managed);
            throw error;
        }
        const edited = { task: hasUpload ? (payload.operation || 'upload-edit') : 'text-edit', time: new Date().toISOString(), user: userRid };
        await this.store.setAttribute(file['@rid'], 'edited', edited);
        await this.tags.setSystemTag(file['@rid'], 'edited', userRid, true).catch(() => null);
        await this.refreshMetadata(file);
        await this.thumbnails.refresh(file, userRid);
        this.sse.send(userRid, { command: 'update', target: file['@rid'], node: { edited, thumbnail_version: Date.now() } });
        const updated = await this.metadata(file['@rid'], userRid);
        updated.edited = edited;
        return updated;
    }

    private async saveNote(note: any, managed: string, content: string, userRid: string): Promise<any> {
        if (Buffer.byteLength(content, 'utf8') > this.maxVersionTextBytes) throw Boom.badRequest('Text payload exceeds size limit');
        const staging = `${managed}.editing.${randomUUID()}`;
        try {
            await fsp.writeFile(staging, content, 'utf8');
            await fsp.rename(staging, managed);
        } catch (error) {
            await fsp.rm(staging, { force: true });
            throw error;
        }
        await this.refreshMetadata(note);
        await this.syncNoteTag(note, managed, userRid);
        return this.metadata(note['@rid'], userRid);
    }

    /** The file a note is about has the system tag "Has note" while the note has text. */
    private async syncNoteTag(note: any, notePath: string, userRid: string): Promise<void> {
        try {
            const parent = await sourceFileOf<any>(this.db, note['@rid'], '@rid AS rid');
            if (!parent?.rid) return;
            const hasText = (await fsp.readFile(notePath, 'utf8')).trim().length > 0;
            await this.tags.setSystemTag(parent.rid, 'Has note', userRid, hasText);
        } catch {
            // The tag is a convenience: a failure must not fail saving the note.
        }
    }

    async revert(fileRid: string, userRid: string): Promise<any> {
        const file = await this.metadata(fileRid, userRid);
        if (!file || file['@type'] !== 'File') throw Boom.notFound('File not found');
        const managed = this.managedPath(file.path);
        const backup = `${managed}.original`;
        if (!(await exists(backup))) throw Boom.conflict('No original version exists to revert');
        await fsp.rm(managed, { force: true });
        await moveFile(backup, managed);
        await this.store.removeAttribute(file['@rid'], 'edited');
        await this.tags.setSystemTag(file['@rid'], 'edited', userRid, false).catch(() => null);
        await this.refreshMetadata(file);
        await this.thumbnails.refresh(file, userRid);
        this.sse.send(userRid, { command: 'update', target: file['@rid'], node: { edited: null, thumbnail_version: Date.now() } });
        return this.metadata(file['@rid'], userRid);
    }

    // ---- sets --------------------------------------------------------------------------

    /** GET /api/sets/{rid}/files: a page of members ordered by label, with thumbnails and entities. */
    async setFiles(setRid: string, userRid: string, params: { skip?: unknown; limit?: unknown; thumbnails?: boolean; group?: unknown; origin?: unknown; order?: unknown }): Promise<any> {
        if (params.group === 'origin') return this.groupedSetFiles(setRid, userRid, params);
        const skip = /^-?\d+$/.test(String(params.skip ?? '')) ? Number(params.skip) : 0;
        const limit = /^-?\d+$/.test(String(params.limit ?? '')) ? Number(params.limit) : 10;
        const rid = toRid(setRid);
        if (!(await this.access.canRead(rid, userRid))) throw Boom.notFound('Set not found');
        const count = await this.db.first('SELECT count(*) AS file_count FROM File WHERE set = :set', { set: rid });
        const files = await this.db.rows('SELECT FROM File WHERE set = :set ORDER BY label SKIP :skip LIMIT :limit', { set: rid, skip, limit });
        if (params.thumbnails) await this.decorate(files);
        return { file_count: Number(count?.file_count || 0), limit, skip, files };
    }

    /** Adds the thumbnail url and the tags to the files of a listing. */
    private async decorate(files: any[]): Promise<void> {
        const entities = await this.tags.entitiesForFiles(files.map((f) => f['@rid']));
        const passages = await this.tags.passageCounts(files.map((f) => f['@rid']));
        for (const file of files) {
            if (passages.get(file['@rid'])) file.passages = passages.get(file['@rid']);
            if (file.path && (!isPdfType(file.type) || await this.deskGraph.usePdfThumbnail(file))) {
                file.thumb = this.apiUrl + 'api/thumbnails/' + file.path.split('/').slice(0, -1).join('/');
            }
            file.entities = entities.get(file['@rid']) || [];
        }
    }

    /**
     * The set browser's grouped listing (`group=origin`): one card per original PDF with its
     * first page as the cover, then the files that come from no PDF. `origin` lists the files of
     * one PDF; `order=flat` lists the whole set in the grouped order (what the file viewer steps
     * through). A set that is not worth grouping answers like the flat listing, with `grouped: false`.
     */
    private async groupedSetFiles(setRid: string, userRid: string, params: { skip?: unknown; limit?: unknown; origin?: unknown; order?: unknown }): Promise<any> {
        const skip = /^\d+$/.test(String(params.skip ?? '')) ? Number(params.skip) : 0;
        const limit = /^\d+$/.test(String(params.limit ?? '')) ? Number(params.limit) : 10;
        const rid = toRid(setRid);
        if (!(await this.access.canRead(rid, userRid))) throw Boom.notFound('Set not found');
        const groupRows = await this.db.rows(
            'SELECT origin_rid, origin_label, count(*) AS n FROM File WHERE set = :set AND origin_rid IS NOT NULL GROUP BY origin_rid, origin_label',
            { set: rid },
        );
        const groups = sortGroups(groupRows.map((r) => ({ ...r, count: r.n })));
        const ungrouped = Number((await this.db.first('SELECT count(*) AS n FROM File WHERE set = :set AND origin_rid IS NULL', { set: rid }))?.n || 0);
        const total = groups.reduce((sum, g) => sum + g.count, 0) + ungrouped;
        const pages = 'ORDER BY page_number, label SKIP :skip LIMIT :limit';

        if (params.origin) {
            const origin = toRid(String(params.origin));
            const group = groups.find((g) => g.origin_rid === origin);
            const files = group && limit > 0 ? await this.db.rows(`SELECT FROM File WHERE set = :set AND origin_rid = :origin ${pages}`, { set: rid, origin, skip, limit }) : [];
            await this.decorate(files);
            // `offset`: where the group starts in the whole set (the position of its first file in the flat order)
            const offset = groups.slice(0, groups.indexOf(group as GroupRow)).reduce((sum, g) => sum + g.count, 0);
            return { grouped: true, file_count: group?.count || 0, set_total: total, limit, skip, files, offset, origin: group ? { rid: group.origin_rid, label: group.origin_label } : null };
        }

        // The whole set in the grouped order: what the file viewer steps through, and the listing
        // of a set that is not grouped (so its order is the same).
        if (params.order === 'flat' || !isGrouped(groups, ungrouped)) {
            const files: any[] = [];
            for (const segment of flatSegments(groups, ungrouped, skip, limit)) {
                files.push(...await this.db.rows(
                    segment.origin
                        ? `SELECT FROM File WHERE set = :set AND origin_rid = :origin ${pages}`
                        : 'SELECT FROM File WHERE set = :set AND origin_rid IS NULL ORDER BY label SKIP :skip LIMIT :limit',
                    { set: rid, origin: segment.origin, skip: segment.skip, limit: segment.limit },
                ));
            }
            await this.decorate(files);
            return { grouped: isGrouped(groups, ungrouped), file_count: total, limit, skip, files };
        }
        const window = entryWindow(groups, ungrouped, skip, limit);
        const entries: any[] = [];
        for (const group of window.groups) {
            const cover = await this.db.first('SELECT FROM File WHERE set = :set AND origin_rid = :origin ORDER BY page_number, label LIMIT 1', { set: rid, origin: group.origin_rid });
            if (cover) await this.decorate([cover]);
            entries.push({ kind: 'group', origin_rid: group.origin_rid, origin_label: group.origin_label, count: group.count, cover });
        }
        if (window.fileLimit > 0) {
            const files = await this.db.rows('SELECT FROM File WHERE set = :set AND origin_rid IS NULL ORDER BY label SKIP :skip LIMIT :limit', { set: rid, skip: window.fileSkip, limit: window.fileLimit });
            await this.decorate(files);
            entries.push(...files);
        }
        // `files_offset`: the position of the first file without an origin in the whole set
        return { grouped: true, file_count: total, entries_total: groups.length + ungrouped, groups_total: groups.length, files_offset: total - ungrouped, limit, skip, entries };
    }

    /** Re-queues thumbnails for every image and PDF of a set. */
    async requeueSetThumbnails(setRid: string, userRid: string, pageSize: number): Promise<any> {
        const rid = toRid(setRid);
        let skip = 0;
        let total = 0;
        let queued = 0;
        let skipped = 0;
        const byType = { image: 0, pdf: 0 };
        const seen = new Set<string>();
        for (;;) {
            const page = await this.setFiles(rid, userRid, { skip, limit: pageSize });
            if (!total) total = page.file_count;
            if (!page.files.length) break;
            for (const file of page.files) {
                if (!file['@rid'] || seen.has(file['@rid'])) continue;
                seen.add(file['@rid']);
                if (await this.thumbnails.refresh(file, userRid)) {
                    queued += 1;
                    if (file.type === 'image') byType.image += 1;
                    if (file.type === FILE_TYPE.PDF) byType.pdf += 1;
                } else skipped += 1;
            }
            skip += page.files.length;
            if (skip >= page.file_count) break;
        }
        return { set_rid: rid, total_files: total, scanned_files: seen.size, queued, skipped, queued_by_type: byType };
    }
}
