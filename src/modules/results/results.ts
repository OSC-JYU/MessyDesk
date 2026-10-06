// Results coming back from consumers (the /api/nomad/process/* callbacks).
//
// A result message is the job message with `file.type/label/extension` describing the output
// while `file['@rid']` still names the input. It is one of:
//   - an EXIF rotation result (task rotate + role/kind internal_versioning): replaces the original
//   - a thumbnail (role thumbnail, md-thumbnailer, task thumbnail): saved next to the file
//   - a normal output: a new File node (or a reference to an existing file), counted into its batch
// /done finishes jobs without output files, /error records failures.

import Boom from '@hapi/boom';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Logger } from '../../platform/logger.ts';
import type { SseHub } from '../../platform/sse/hub.ts';
import { tryRid } from '../../platform/ids.ts';
import { exists, moveFile, writeJson } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { sourceFileOf, type GraphStore } from '../../shared/graph-store.ts';
import { ROLE, SERVICE } from '../../shared/service-ids.ts';
import { BatchState } from '../batches/batch-state.ts';
import { imageMetadata, textDescription } from '../files/metadata.ts';
import { usageTime } from '../usage/token-budget.ts';
import type { ImportPipeline } from '../import/import.ts';
import type { NodesService } from '../nodes/nodes.ts';
import type { ServiceRegistry } from '../services/registry.ts';
import type { TagsService } from '../tags/tags.ts';
import type { ThumbnailService } from '../thumbnails/thumbnails.ts';

const STOPPED = ['paused', 'cancelling', 'cancelled', 'done'];
const SPLITTERS = new Set<string>([SERVICE.PDF_SPLITTER_LEGACY, SERVICE.PDF_SPLITTER]);

function lower(value: unknown): string {
    return String(value || '').toLowerCase();
}

function isInternalVersioning(message: any): boolean {
    return lower(message?.role) === ROLE.INTERNAL_VERSIONING || lower(message?.process?.kind) === 'internal_versioning';
}

function isThumbnail(message: any): boolean {
    const role = lower(message?.role);
    if (role === ROLE.THUMBNAIL || role === ROLE.THUMBNAILS) return true;
    return lower(message?.topic?.id) === SERVICE.THUMBNAILER || lower(message?.service?.id) === SERVICE.THUMBNAILER
        || lower(message?.id) === SERVICE.THUMBNAILER || lower(message?.task?.id) === 'thumbnail';
}

function thumbnailFilename(message: any): string {
    const explicit = String(message?.thumb_name || '').trim();
    if (explicit) return path.basename(explicit);
    const label = lower(String(message?.file?.label || '').trim());
    const extension = lower(String(message?.file?.extension || '').trim());
    if ((label === 'preview' || label === 'thumbnail') && extension) return `${label}.${extension === 'jpeg' ? 'jpg' : extension}`;
    return 'preview.jpg';
}

function isSplitPdfOutput(message: any, node: any): boolean {
    if (node?.type !== 'pdf') return false;
    const service = message?.service?.id || message?.process?.service_id || '';
    const task = message?.task?.id || message?.process?.task || '';
    return SPLITTERS.has(service) && task === 'split';
}

function referenceRid(message: any): string | null {
    const explicit = tryRid(message?.ref_file_rid || message?.ref || message?.reference_rid);
    if (explicit) return explicit;
    return message?.isReference === true ? tryRid(message?.file?.['@rid']) : null;
}

function groupedLabel(message: any): string | null {
    const root = String(message?.root_source_label || message?.root_source?.label || '').trim();
    const ext = lower(String(message?.file?.extension || '').trim());
    if (!root || !ext) return null;
    return root.toLowerCase().endsWith(`.${ext}`) ? root : `${root}.${ext}`;
}

export interface ResultDeps {
    db: ArcadeClient;
    store: GraphStore;
    layout: DataLayout;
    nodes: NodesService;
    batches: BatchState;
    tags: TagsService;
    thumbnails: ThumbnailService;
    registry: ServiceRegistry;
    importPipeline: ImportPipeline;
    sse: SseHub;
    logger: Logger;
    apiUrl: string;
}

export class ResultsService {
    private readonly d: ResultDeps;

    constructor(deps: ResultDeps) {
        this.d = deps;
    }

    private thumbUrl(dir: string): string {
        return this.d.apiUrl + 'api/thumbnails/' + dir;
    }

    /** Resolves `tmp_path` of a disk-mode callback to a file in <data root>/<db>/tmp. */
    resolveTmpFile(payload: any, message: any): string {
        const dataRoot = path.resolve(this.d.layout.dataDir, '..');
        let tmpRoot = path.resolve(dataRoot, 'tmp');
        const source = message?.file?.path;
        if (typeof source === 'string' && source) {
            const parts = source.replace(/\\/g, '/').split('/').filter(Boolean);
            for (let i = 0; i < parts.length - 1; i += 1) {
                if (parts[i] === 'data' && parts[i + 1]) {
                    tmpRoot = path.resolve(dataRoot, parts[i + 1], 'tmp');
                    break;
                }
            }
        }
        const fromPayload = payload?.tmp_file || payload?.tmp_path || payload?.content_file || payload?.content_path || payload?.file_path || payload?.path;
        const fromMessage = message?.tmp_file || message?.tmp_path || message?.content_file || message?.content_path || message?.file_path;
        const candidate = fromPayload || fromMessage;
        if (!candidate) throw Boom.badData('Missing tmp file reference');
        const name = path.basename(String(typeof candidate === 'object' && candidate?.path ? candidate.path : candidate));
        if (!name || name === '.' || name === '..') throw Boom.badData('Invalid tmp file name');
        const resolved = path.resolve(tmpRoot, name);
        if (resolved !== tmpRoot && !resolved.startsWith(tmpRoot + path.sep)) throw Boom.badData('Invalid tmp file path');
        if (!fs.existsSync(resolved)) throw Boom.notFound('Tmp file not found');
        return resolved;
    }

    /** One result file (multipart /files or disk-mode /tmp). */
    async handleFile(message: any, contentPath: string): Promise<void> {
        const isRotate = lower(message?.task?.id) === 'rotate';
        const internalRotate = message?.role === ROLE.EXIF_ROTATE || isInternalVersioning(message);
        if (isRotate && internalRotate) return this.handleRotation(message, contentPath);
        if (isThumbnail(message)) return this.handleThumbnail(message, contentPath);
        return this.handleOutput(message, contentPath);
    }

    /** The EXIF-rotated image replaces the original (kept as original.<ext>). */
    private async handleRotation(message: any, contentPath: string): Promise<void> {
        const file = message.file;
        await fsp.rename(file.path, path.join(path.dirname(file.path), 'original.' + file.extension));
        await moveFile(contentPath, file.path);
        const stats = await fsp.stat(file.path);
        let metadata: any = { size: Math.round(stats.size / 1024 / 1024 * 100) / 100 };
        if (file.type === 'image') metadata = { ...metadata, ...imageMetadata(file.path) };
        await this.d.store.setAttribute(file['@rid'], 'metadata', metadata);
        await this.d.thumbnails.afterRotate(file, message.userId);
        this.d.sse.send(message.userId, { command: 'update', target: file['@rid'], node: { metadata } });
    }

    private async setPreviewPaths(setRid: string, version: number): Promise<string[]> {
        const rows = await this.d.db.rows('SELECT @rid AS rid, path, type, metadata FROM File WHERE set = :set ORDER BY label LIMIT 20', { set: setRid });
        const thumbs: string[] = [];
        for (const item of rows) {
            if (item.type === 'pdf' && !(await this.pdfHasThumbnail(item))) {
                if (thumbs.length < 4) thumbs.push('__pdf_icon__');
                continue;
            }
            if (!item.path) continue;
            if (thumbs.length >= 4) break;
            thumbs.push(item.path.split('/').slice(0, -1).join('/').replace('data/', 'api/thumbnails/data/'));
        }
        return thumbs.map((e) => (e.includes('?') ? `${e}&v=${version}` : `${e}?v=${version}`));
    }

    private async pdfHasThumbnail(file: any): Promise<boolean> {
        const pages = Number(file?.metadata?.page_count);
        if (Number.isFinite(pages) && pages > 1) return false;
        const rid = tryRid(file.rid || file['@rid']);
        const source = rid ? await sourceFileOf(this.d.db, rid, 'type') : null;
        return Boolean(source?.type) && lower(source.type) !== 'zip';
    }

    private async handleThumbnail(message: any, contentPath: string): Promise<void> {
        const base = path.dirname(message.file.path);
        const name = thumbnailFilename(message);
        const version = Date.now();
        const internal = isInternalVersioning(message);
        await moveFile(contentPath, path.join(base, name));
        try {
            await this.mirrorSplitCover(message, path.join(base, name), name, version);
        } catch (error) {
            this.d.logger.warn('Failed to mirror split cover thumbnail to source PDF', { error: (error as Error).message });
        }
        const isMain = name.toLowerCase() === 'thumbnail.jpg';
        const isBatch = Boolean(message?.output_set);
        const isLast = isBatch && Number(message?.current_file) === Number(message?.total_files);
        // Single files notify on the final thumbnail; batches only once at the end.
        if (!(internal || (!isBatch && isMain) || isLast)) return;
        if (message.output_set && isLast) {
            this.d.sse.send(message.userId, { command: 'update', target: message.output_set, node: { paths: await this.setPreviewPaths(message.output_set, version), count: message.current_file, thumbnail_version: version } });
            return;
        }
        if (message.output_set) return;
        this.d.sse.send(message.userId, { command: 'update', target: message.file['@rid'], node: { image: this.thumbUrl(base), thumb: this.thumbUrl(base), thumbnail_version: version } });
        // Edits and reverts also refresh the preview grid of the file's set.
        if (internal && isMain) {
            const node = await this.d.store.getNode(message.file['@rid']);
            const setRid = tryRid(node?.set);
            if (setRid) this.d.sse.send(message.userId, { command: 'update', target: setRid, node: { paths: await this.setPreviewPaths(setRid, version), thumbnail_version: version } });
        }
    }

    /** The cover (first page) thumbnail of a split PDF also becomes the original PDF's thumbnail. */
    private async mirrorSplitCover(message: any, saved: string, name: string, version: number): Promise<void> {
        if (name.toLowerCase() !== 'preview.jpg' && name.toLowerCase() !== 'thumbnail.jpg') return;
        if (![SERVICE.POPPLER, SERVICE.POPPLER_FS].includes(lower(message?.service?.id) as any) || lower(message?.task?.id) !== 'thumbnail') return;
        const current = Number(message?.current_file || 0);
        const page = Number(message?.file?.page_number || 0);
        if (!((current === 0 || current === 1) && (page === 0 || page === 1))) return;
        let sourceRid = tryRid(message?.process?.file_rid);
        if (!sourceRid && message?.process?.['@rid']) sourceRid = tryRid((await this.d.store.getNode(message.process['@rid']))?.file_rid);
        if (!sourceRid) return;
        const source = await this.d.store.getNode(sourceRid);
        if (typeof source?.path !== 'string' || !source.path) return;
        const sourceBase = path.dirname(source.path);
        const target = path.resolve(path.join(sourceBase, name.toLowerCase()));
        if (path.resolve(saved) === target) return;
        await fsp.copyFile(path.resolve(saved), target);
        if (message?.userId) {
            this.d.sse.send(message.userId, { command: 'update', target: sourceRid, node: { image: this.thumbUrl(sourceBase), thumb: this.thumbUrl(sourceBase), thumbnail_version: version } });
        }
    }

    private async handleOutput(message: any, contentPath: string): Promise<void> {
        const { store, nodes, batches, sse } = this.d;
        if (message.output_set) {
            const batchRid = message.set_process || message.process?.['@rid'];
            if (batchRid && STOPPED.includes(lower(BatchState.status(await batches.get(batchRid)) || 'running'))) {
                // A paused or cancelled batch drops results that still arrive.
                return;
            }
        }
        const grouped = String(message?.behaviour || '').toLowerCase() === 'many-to-one' && Boolean(message?.root_source_rid || message?.root_source?.['@rid']);
        if (grouped) {
            const label = groupedLabel(message);
            if (label) message.file.label = label;
        }
        const rootSource = tryRid(message?.root_source_rid || message?.root_source?.['@rid']);
        if (message.output_set && rootSource && Number(message?.current_file || 0) >= Number(message?.total_files || 0)) {
            if (await batches.outputFor(message.process['@rid'], rootSource, message.output_set)) return; // a retry of a finished group
        }
        const refRid = referenceRid(message);
        const refNode = refRid ? await store.getNode(refRid) : null;
        if (refRid && !refNode) throw Boom.badData(`Reference source file not found: ${refRid}`);
        let info = '';
        if (refRid && typeof refNode?.info === 'string') info = refNode.info;
        else if (message.file.type === 'text' || String(message.file.type).includes('json') || message.file.type === 'csv') info = (await textDescription(contentPath, message.file.type)) || '';
        const processRid = message.process['@rid'];

        let fileNode: any;
        if (message.output_rid && message.output_path) fileNode = await store.getNode(message.output_rid);
        else if (refRid) fileNode = await nodes.createReferenceFile(processRid, message, refRid, '', info);
        else fileNode = await nodes.createProcessFile(processRid, message, '', info);

        if (refRid) {
            fileNode.metadata = refNode?.metadata || null;
        } else {
            await moveFile(contentPath, fileNode.path);
            const stats = await fsp.stat(fileNode.path);
            fileNode.metadata = { size: Math.round(stats.size / 1024 / 1024 * 100) / 100 };
            if (fileNode.type === 'image') fileNode.metadata = { ...fileNode.metadata, ...imageMetadata(fileNode.path) };
        }
        if (fileNode.metadata) await store.setAttribute(fileNode['@rid'], 'metadata', fileNode.metadata);
        if (!refRid && fileNode.type === 'ner.json') {
            // Needed to browse NER label groups whether or not the task autotags.
            await store.setAttributes(fileNode['@rid'], { service_id: message.service?.id || null, task: message.task?.id || null });
        }
        if (!refRid && message.task?.autotag) {
            try {
                await this.d.tags.autotag(fileNode.path, message.file['@rid'], message);
            } catch (error) {
                this.d.logger.warn('autotag failed (non-fatal)', { error: (error as Error).message });
            }
        }
        if (rootSource) {
            const patch: Record<string, unknown> = { root_source_rid: rootSource };
            const rootLabel = message?.root_source_label || message?.root_source?.label;
            if (rootLabel) patch.root_source_label = rootLabel;
            if (Number.isFinite(Number(message?.group_size))) patch.group_size = Number(message.group_size);
            await store.setAttributes(fileNode['@rid'], patch);
        }
        if (Number.isFinite(Number(message?.file?.page_number))) await store.setAttribute(fileNode['@rid'], 'page_number', Number(message.file.page_number));
        if (message.file.forward) await store.setAttribute(fileNode['@rid'], 'forward', message.file.forward);
        if (message.response) {
            if (message.response.time) await store.setAttribute(processRid, 'time', message.response.time);
            if (message.response.url) await store.setAttribute(processRid, 'url', message.response.url);
        }
        if (!refRid && message.file.type === 'image' && this.d.registry.hasActiveConsumer(SERVICE.THUMBNAILER)) {
            await this.d.thumbnails.forOutputImage(fileNode, message);
        }
        if (!refRid && isSplitPdfOutput(message, fileNode)) await this.reportFailedPages(message, processRid);
        if (!refRid && isSplitPdfOutput(message, fileNode) && this.d.registry.hasActiveConsumer(SERVICE.POPPLER)) {
            await this.d.thumbnails.forSplitPage(fileNode, message);
        }
        if (!refRid && fileNode?.type === 'pdf' && !isSplitPdfOutput(message, fileNode)) {
            const service = message?.service?.id || message?.process?.service_id || '';
            // PDFs produced by other services must go through the splitter first.
            if (service && !SPLITTERS.has(service) && service !== SERVICE.ZIP) await store.setAttribute(fileNode['@rid'], 'processable', false);
            if (service === SERVICE.ZIP) await this.d.importPipeline.afterFileCreated(fileNode, { userId: message.userId, delete_original: true });
        }
        if (message.userId) await this.notifyOutput(message, fileNode, processRid);
    }

    /**
     * Pages the splitter could not write come with every page of the split (response.failed_pages,
     * [{page, error}]); they are recorded once on the import process and shown in its info.
     */
    private async reportFailedPages(message: any, processRid: string): Promise<void> {
        const failed = Array.isArray(message?.response?.failed_pages) ? message.response.failed_pages : [];
        if (!failed.length || !processRid) return;
        const node = await this.d.store.getNode(processRid);
        if (Array.isArray(node?.failed_pages) && node.failed_pages.length) return;
        const total = Number(message.response.page_count || 0);
        const pages = failed.map((f: any) => Number(f?.page)).filter(Number.isFinite);
        const shown = pages.slice(0, 20).join(', ') + (pages.length > 20 ? ', …' : '');
        const reason = String(failed[0]?.error || '').slice(0, 200);
        const info = `${pages.length}${total ? ` of ${total}` : ''} pages could not be split and are missing: ${shown}${reason ? ` (${reason})` : ''}`;
        await this.d.store.setAttributes(processRid, { failed_pages: failed.slice(0, 1000), info });
        if (message.userId) this.d.sse.send(message.userId, { command: 'update', target: processRid, node: { info, failed_pages: failed.length } });
    }

    private batchSummary(batch: any, fallbackProcessed: number, fallbackTotal: number, grouped: boolean, finished: boolean): any {
        if (!batch) return undefined;
        const status = batch.status || batch.state || (finished ? 'done' : 'running');
        return {
            status,
            state: status,
            processed_files: batch.processed_files || fallbackProcessed,
            failed_files: batch.failed_files || 0,
            total_files: batch.total_files || fallbackTotal,
            avg_sec_per_file: batch.avg_sec_per_file || 0,
            eta_sec: grouped ? null : (batch.eta_sec ?? (finished ? 0 : null)),
        };
    }

    private async notifyOutput(message: any, fileNode: any, processRid: string): Promise<void> {
        const { store, nodes, batches, sse } = this.d;
        if (!message.output_set) {
            await store.setAttribute(processRid, 'status', 'finished');
            sse.send(message.userId, { command: 'add', type: message.file.type, input: processRid, node: fileNode, process: { '@rid': processRid, status: 'finished' } });
            return;
        }
        const count = await nodes.updateFileCount(message.output_set, 'later');
        const total = message.batch_total_files || message.total_files;
        const batchRid = message.set_process || message.process['@rid'];
        const outputTotal = Number(message.file_total || 0);
        const outputIndex = Number(message.file_count || 0);
        const isImport = message.role === ROLE.IMPORT || message.process?.role === ROLE.IMPORT;
        // A job with several outputs advances the batch once, on its last output.
        const advance = isImport || !(outputTotal > 1) || outputIndex >= outputTotal;
        let batch = await batches.get(batchRid);
        if (STOPPED.includes(BatchState.status(batch) || 'running')) return;
        if (advance) batch = await batches.incrementProcessed(batchRid, message?.response?.time, total);
        const processed = batch?.processed_files ?? message.current_file;
        const batchTotal = batch?.total_files ?? total;
        const finished = BatchState.status(batch) === 'done' || (batchTotal && processed >= batchTotal);
        const grouped = message.behaviour === 'many-to-one' || Number(message.batch_total_files || 0) > Number(message.total_files || 0);
        if (finished) {
            await nodes.flushSetManifest(message.output_set);
            if (isImport) await this.d.importPipeline.complete(message);
            sse.send(message.userId, {
                command: 'process_finished',
                process: { '@rid': batchRid, status: 'done' },
                set: { '@rid': message.output_set, status: 'finished', count },
                batch: this.batchSummary(batch, processed, batchTotal, grouped, true),
                current_file: processed,
            });
        } else if (advance && processed % 10 === 0) {
            sse.send(message.userId, {
                command: 'process_update',
                process: { '@rid': batchRid, status: 'running' },
                set: { '@rid': message.output_set, status: 'running', count },
                batch: this.batchSummary(batch, processed, batchTotal, grouped, false),
                current_file: processed,
                total_files: batchTotal,
            });
        }
    }

    /** /done: a job finished without (more) output files. */
    async handleDone(message: any): Promise<void> {
        const { batches, store, sse } = this.d;
        const target = message?.process?.['@rid'] || message?.file?.['@rid'];
        if (!target) {
            this.d.logger.error('Target not found', { message });
            return;
        }
        if (message?.file?.metadata) sse.send(message.userId, { command: 'update', target, node: { metadata: message.file.metadata } });
        if (message?.output_set) {
            sse.send(message.userId, { command: 'process_finished', process: { ...message.process, status: 'done' }, metadata: message.file?.metadata, paths: message.paths });
        }
        if (!message?.set_process) return;
        const batchRid = tryRid(message.set_process);
        if (!batchRid) return;
        const total = Number(message?.total_files || message?.batch_total_files || 0);
        const current = Number(message?.current_file || 0);
        let batch = null;
        if (total > 0 && current > 0) batch = await batches.incrementProcessed(batchRid, Number(message?.response?.time || 0), total);
        if (message?.summary) {
            const node = await batches.get(batchRid);
            if (node) await store.setAttribute(node['@rid'], 'summary', message.summary);
        }
        if (BatchState.status(batch) === 'done' || (total > 0 && current >= total)) {
            if (message.output_set) await this.d.nodes.flushSetManifest(message.output_set);
            sse.send(message.userId, { command: 'process_finished', process: { ...(message.process || {}), '@rid': batchRid, status: 'done' }, summary: message.summary || null });
        }
    }

    /** /error: a job failed. Thumbnails and internal re-versioning fail silently. */
    async handleError(error: any, message: any): Promise<void> {
        const { logger, batches, nodes, sse, db } = this.d;
        const role = lower(message?.role);
        const thumbnailFailure = role === ROLE.THUMBNAIL || role === ROLE.THUMBNAILS || message?.task?.id === 'thumbnail'
            || message?.topic?.id === SERVICE.THUMBNAILER || message?.service?.id === SERVICE.THUMBNAILER;
        const marker = lower(message?.process?.kind || (typeof message?.process === 'string' ? message.process : ''));
        const internalFailure = role === ROLE.INTERNAL_VERSIONING || role === ROLE.EXIF_ROTATE || marker === 'internal_versioning';
        if (thumbnailFailure || internalFailure) {
            logger.warn(`${thumbnailFailure ? 'Thumbnail' : 'Internal versioning'} processing failed (non-fatal)`, { error, file: message?.file?.['@rid'], service: message?.service?.id, task: message?.task?.id });
            return;
        }
        logger.error('Error processing files', { error, message });
        if (role === ROLE.IMPORT || lower(message?.process?.role) === ROLE.IMPORT) await this.failImport(error, message);
        let target = tryRid(message?.process?.['@rid']) || tryRid(message?.target);
        if (message.output_set) {
            const setProcess = await batches.processOfSet(message.output_set);
            if (setProcess) {
                target = setProcess['@rid'];
                await batches.incrementFailed(setProcess['@rid']);
            }
        } else if (message.set_process) {
            await batches.incrementFailed(message.set_process);
        }
        if (!target) return;
        const current = await db.first(`SELECT error_count FROM ${target}`).catch(() => null);
        const errorCount = Number(current?.error_count || 0) + 1;
        await db.sql(`UPDATE ${target} SET node_error = 'error', timestamp = :timestamp, error_count = :count`, { timestamp: new Date().toISOString(), count: errorCount });
        sse.send(message.userId, { command: 'update', target, error: 'errors: ' + errorCount });
        if (!message.process?.['@rid'] || !message.file) return;
        const node = await nodes.createErrorNode(error, message);
        await writeJson(path.dirname(node.path), 'error.json', {
            info: 'Something went wrong with the file processing.',
            timestamp: new Date().toISOString(),
            file: message.file,
            task: message.task,
            message,
            error,
        });
        if (!message.output_set) {
            sse.send(message.userId, { command: 'add', input: message.process['@rid'], type: 'error', process: { '@rid': message.process['@rid'], status: 'finished' }, node });
        }
    }

    /** A failed split: the PDF is no longer "importing", and the import process says why. */
    private async failImport(error: any, message: any): Promise<void> {
        const sourceRid = tryRid(message?.file?.['@rid']);
        const processRid = tryRid(message?.process?.['@rid']);
        const reason = String(error?.details || error?.message || error || 'unknown error').slice(0, 500);
        if (sourceRid) await this.d.store.setAttribute(sourceRid, '_status', 'import_failed');
        if (processRid) await this.d.store.setAttributes(processRid, { status: 'failed', info: `The PDF could not be split into pages: ${reason}` });
        if (message.userId && sourceRid) this.d.sse.send(message.userId, { command: 'update', target: sourceRid, node: { _status: 'import_failed' } });
    }

    /**
     * /metadata: AI usage figures. Always stored as a Usage row (token limits sum them); the
     * `response` file is kept next to the process's files when it has a directory (single-file
     * runs; batch jobs carry only the SetProcess rid, and before this every batch job's usage was
     * lost on the missing path).
     */
    async handleMetadata(message: any, contentPath: string): Promise<void> {
        const usage = JSON.parse(await fsp.readFile(contentPath, 'utf8'));
        if (message?.file?.type !== 'response') return;
        if (message.process?.path && message.file.label) {
            const target = path.join(message.process.path, message.file.label);
            if (!(await exists(target))) await moveFile(contentPath, target);
        }
        const meta = usage?.metadata || {};
        const tokens = meta.tokens || {};
        await this.d.db.sql('INSERT INTO Usage CONTENT :content', {
            content: {
                user: message.userId || 'unknown',
                process: message.process?.['@rid'] || 'unknown',
                in: tokens.in?.count || 0,
                out: tokens.out?.count || 0,
                model: meta.model || 'unknown',
                service: message.service?.id || 'unknown',
                in_modality: tokens.in?.modality || 'UNKNOWN',
                out_modality: tokens.out?.modality || 'UNKNOWN',
                total: tokens.total || 0,
                service_group: message.task?.token_budget?.service_group || null,
                time: usageTime(),
            },
        });
    }
}
