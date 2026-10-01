import Boom from '@hapi/boom';
import type { ResponseToolkit, ServerRoute } from '@hapi/hapi';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import type { Readable } from 'node:stream';
import type { Deps } from '../../app/deps.ts';
import { credentials, currentUser } from '../../platform/http/auth.ts';
import { tryRid } from '../../platform/ids.ts';
import type { UploadPart } from './files.ts';
import { contentTypeFor } from './metadata.ts';

const GIGABYTE = 1000 * 1024 * 1024;

function rid(value: string): string {
    const r = tryRid(value);
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

function truthy(value: unknown): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value === 'number') return value === 1;
    if (typeof value !== 'string') return false;
    return ['1', 'true', 'yes', 'on'].includes(value.trim().toLowerCase());
}

async function readStreamText(stream: Readable): Promise<string> {
    const chunks: Buffer[] = [];
    for await (const chunk of stream) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    return Buffer.concat(chunks).toString('utf8');
}

/** JSON bodies may arrive as a stream on routes that also accept multipart. */
async function normalizePayload(raw: any): Promise<any> {
    if (raw && typeof raw.pipe === 'function') {
        const text = await readStreamText(raw);
        if (!text.trim()) return {};
        try {
            const parsed = JSON.parse(text);
            return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
        } catch {
            return {};
        }
    }
    return raw || {};
}

function stream(h: ResponseToolkit, filePath: string) {
    const src = fs.createReadStream(filePath);
    src.on('error', () => src.destroy());
    return h.response(src);
}

export function fileRoutes({ files, thumbnails, zipJobs, registry, store, ner, access, graph }: Deps): ServerRoute[] {
    return [
        {
            method: 'POST',
            path: '/api/projects/{rid}/upload/{set?}',
            options: { payload: { maxBytes: GIGABYTE, output: 'stream', parse: true, multipart: true, allow: 'multipart/form-data' } },
            handler: async (request) => {
                const query = request.query as Record<string, unknown>;
                const payload = (request.payload || {}) as Record<string, any>;
                const raw = payload.file;
                if (!raw) throw Boom.badRequest('No file uploaded');
                const parts = (Array.isArray(raw) ? raw : [raw]) as UploadPart[];
                const noThumbnails = ['no-thumbnails', 'no_thumbnails', 'noThumbnails'].some((k) => truthy(query[k]) || truthy(payload[k]));
                return files.upload(rid(request.params.rid), request.params.set, parts, currentUser(request).rid, {
                    noThumbnails,
                    deleteOriginal: query.delete_original !== 'false',
                });
            },
        },
        {
            method: 'GET',
            path: '/api/documents/{rid}',
            handler: async (request, h) => {
                const doc = await files.document(rid(request.params.rid), currentUser(request).rid);
                return doc || h.response({}).code(404);
            },
        },
        {
            method: 'GET',
            path: '/api/files/{rid}',
            options: { auth: { strategies: ['mail', 'service'] } },
            handler: async (request, h) => {
                const creds = credentials(request);
                const fileRid = tryRid(request.params.rid);
                let file: any = null;
                if (fileRid) {
                    if (creds.user) file = await files.metadata(fileRid, creds.user.rid);
                    else if (creds.service) file = await store.getNode(fileRid);
                }
                if (!file || !file.path) return h.response({ error: 'File not found' }).code(404);
                if (String(file['@type'] || '').toLowerCase() !== 'file') return h.response({ error: 'RID does not point to a file node' }).code(400);
                const content = await files.contentPath(file);
                if (!content) return h.response().code(404);
                if (!(await fsp.stat(content.path)).isFile()) return h.response({ error: 'Requested RID path is not a file' }).code(400);
                const response = stream(h, content.path);
                if (content.errorJson) return response.type('application/json').header('Content-Disposition', `inline; filename=${file.label}`);
                const meta = contentTypeFor(file);
                if (meta.type) response.type(meta.type);
                if (meta.disposition) response.header('Content-Disposition', meta.disposition);
                return response;
            },
        },
        {
            method: 'GET',
            path: '/api/files/{rid}/source',
            handler: async (request, h) => {
                const user = currentUser(request);
                const source = await files.source(rid(request.params.rid), user.rid);
                if (!source?.path) return h.response().code(404);
                const meta = await files.metadata(source['@rid'], user.rid);
                if (!meta?.path || !fs.existsSync(meta.path)) return h.response().code(404);
                if (!(await fsp.stat(meta.path)).isFile()) return h.response({ error: 'Source path is not a file' }).code(400);
                const response = stream(h, meta.path);
                const type = contentTypeFor(meta);
                if (type.type) response.type(type.type);
                if (meta.type === 'pdf') response.header('Content-Disposition', `inline; filename=${meta.label}`);
                else if (!type.type) response.header('Content-Disposition', `attachment; filename=${meta.label}`);
                return response;
            },
        },
        {
            method: 'GET',
            path: '/api/files/{rid}/ancestors',
            handler: async (request, h) => {
                const list = await graph.ancestors(rid(request.params.rid), currentUser(request).rid);
                return list === null ? h.response().code(403) : list;
            },
        },
        {
            method: 'GET',
            path: '/api/files/{rid}/ner',
            handler: async (request, h) => {
                const fileRid = rid(request.params.rid);
                if (!(await access.canRead(fileRid, currentUser(request).rid))) return h.response({ error: 'File not found' }).code(404);
                return ner.regionsOfFile(fileRid);
            },
        },
        {
            method: 'POST',
            path: '/api/files/{rid}/version',
            options: { payload: { maxBytes: GIGABYTE, output: 'stream', parse: true, multipart: true, allow: ['application/json', 'multipart/form-data'] } },
            handler: async (request) => files.createVersion(rid(request.params.rid), await normalizePayload(request.payload), currentUser(request).rid),
        },
        {
            method: 'POST',
            path: '/api/files/{rid}/revert',
            handler: (request) => files.revert(rid(request.params.rid), currentUser(request).rid),
        },
        {
            method: 'POST',
            path: '/api/files/{rid}/thumbnail',
            handler: async (request, h) => {
                const user = currentUser(request);
                const file = await files.metadata(rid(request.params.rid), user.rid);
                if (!file) return h.response().code(403);
                if (file.type === 'image' && !registry.hasActiveConsumer('md-thumbnailer')) {
                    throw Boom.serverUnavailable('Thumbnailer service is not running. Start the md-thumbnailer consumer first.');
                }
                if (file.type === 'pdf' && !registry.hasActiveConsumer('md-poppler')) {
                    throw Boom.serverUnavailable('Poppler service is not running. Start the md-poppler consumer first.');
                }
                await thumbnails.request(file, user.rid);
                return file;
            },
        },
        {
            method: 'GET',
            path: '/api/thumbnails/{param*}',
            handler: async (request, h) => {
                const notReady = () => h.response({ error: 'Thumbnail not ready' }).code(404).header('Cache-Control', 'no-store');
                const found = await thumbnails.resolve(request.params.param);
                if (!found) return notReady();
                const id = thumbnails.fileIdForDir(found);
                const node = id?.uuid
                    ? await store.db.first('SELECT @rid FROM File WHERE uuid = :uuid LIMIT 1', { uuid: id.uuid })
                    : id?.rid ? { '@rid': id.rid } : null;
                if (!node || !(await access.canRead(node['@rid'], currentUser(request).rid))) return notReady();
                return h.response(thumbnails.stream(found))
                    .type('image/jpeg')
                    .header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate')
                    .header('Pragma', 'no-cache')
                    .header('Expires', '0')
                    .header('Surrogate-Control', 'no-store');
            },
        },
        {
            method: 'GET',
            path: '/api/sets/{rid}/files',
            handler: (request) => {
                const q = request.query as Record<string, unknown>;
                return files.setFiles(rid(request.params.rid), currentUser(request).rid, { thumbnails: true, limit: q.limit, skip: q.skip });
            },
        },
        {
            method: 'POST',
            path: '/api/sets/{rid}/thumbnails',
            handler: async (request, h) => {
                const limit = Math.max(1, Number((request.query as any).limit) || 1000);
                return h.response(await files.requeueSetThumbnails(rid(request.params.rid), currentUser(request).rid, limit)).code(202);
            },
        },
        ...(['POST:/api/sets/{rid}/files/zip/jobs', 'GET:/api/sets/{rid}/files/zip'] as const).map((spec): ServerRoute => {
            const [method, path] = spec.split(':') as ['GET' | 'POST', string];
            return {
                method,
                path,
                options: { auth: { strategies: ['mail', 'service'] } },
                handler: async (request, h) => {
                    const user = currentUser(request);
                    const setRid = rid(request.params.rid);
                    const job = await zipJobs.create(setRid, user.rid);
                    const body: Record<string, unknown> = { job_id: job.id, status: 'queued' };
                    if (method === 'GET') body.message = 'Zip generation started. Poll status_url until ready.';
                    return h.response({ ...body, ...zipJobs.urls(setRid, job.id) }).code(202);
                },
            };
        }),
        {
            method: 'GET',
            path: '/api/sets/{rid}/files/zip/jobs/{job_id}',
            handler: async (request, h) => {
                const job = await zipJobs.load(rid(request.params.rid), currentUser(request).rid, request.params.job_id);
                if (!job) return h.response({ message: 'Zip job not found' }).code(404);
                const status = await zipJobs.status(job);
                return h.response(status.body).code(status.code);
            },
        },
        {
            method: 'GET',
            path: '/api/sets/{rid}/files/zip/jobs/{job_id}/download',
            handler: async (request, h) => {
                const setRid = rid(request.params.rid);
                const job = await zipJobs.load(setRid, currentUser(request).rid, request.params.job_id);
                if (!job) return h.response('Zip job not found').code(404);
                if (!(await zipJobs.ready(job))) return h.response('Zip not ready').code(409);
                const response = h.file(job.zip_path, { filename: `files_${setRid.replace('#', '').replace(':', '_')}.zip`, mode: 'attachment', confine: false });
                response.events.on('finish', () => { void zipJobs.cleanup(job); });
                return response;
            },
        },
    ];
}
