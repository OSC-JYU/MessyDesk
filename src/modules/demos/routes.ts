import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Readable } from 'node:stream';
import type { Deps } from '../../app/deps.ts';
import { currentUser, requireAdmin } from '../../platform/http/auth.ts';
import { tryRid } from '../../platform/ids.ts';
import { MAX_COVER_BYTES } from './reader.ts';
import { publicDemo, type DemoInput } from './demos.ts';

const GIGABYTE = 1024 * 1024 * 1024;
const ZIP_TYPES = ['application/zip', 'application/x-zip-compressed', 'application/octet-stream'];

function projectOf(payload: unknown): string {
    const rid = tryRid((payload as Record<string, unknown> | null)?.project);
    if (!rid) throw Boom.badRequest('project (a desk RID) is required');
    return rid;
}

/** Title, description and sharing of an upload come in the query string as JSON (the body is the zip). */
function inputOf(query: Record<string, unknown>): DemoInput {
    if (typeof query.meta !== 'string') return {};
    try {
        return JSON.parse(query.meta);
    } catch {
        throw Boom.badRequest('meta must be JSON');
    }
}

export function demoRoutes(deps: Deps): ServerRoute[] {
    const { demos } = deps;
    return [
        // ---- users ---------------------------------------------------------------------
        {
            method: 'GET',
            path: '/api/demos',
            handler: async (request) => (await demos.listFor(currentUser(request))).map(publicDemo),
        },
        {
            method: 'GET',
            path: '/api/demos/{id}/cover',
            handler: async (request, h) => {
                const user = currentUser(request);
                const meta = await demos.get(request.params.id);
                if (!(await demos.listFor(user)).some((d) => d.id === meta.id)) throw Boom.notFound('Demo not found');
                const cover = await demos.cover(meta.id);
                if (!cover) throw Boom.notFound('No cover');
                return h.file(cover.file, { confine: false }).type(cover.type);
            },
        },
        {
            method: 'POST',
            path: '/api/demos/{id}/import',
            handler: async (request) => demos.importFor(request.params.id, currentUser(request)),
        },
        // ---- admins --------------------------------------------------------------------
        {
            method: 'GET',
            path: '/api/admin/demos',
            handler: async (request) => {
                requireAdmin(request);
                return demos.list();
            },
        },
        {
            method: 'POST',
            path: '/api/admin/demos',
            handler: async (request) => {
                const admin = requireAdmin(request);
                const payload = (request.payload || {}) as Record<string, unknown>;
                return demos.createFromProject(projectOf(payload), payload, admin);
            },
        },
        {
            method: 'POST',
            path: '/api/admin/demos/upload',
            options: { payload: { maxBytes: 10 * GIGABYTE, output: 'stream', parse: false, allow: ZIP_TYPES, timeout: false } },
            handler: async (request) => {
                requireAdmin(request);
                return demos.createFromUpload(request.payload as Readable, inputOf(request.query as Record<string, unknown>));
            },
        },
        {
            method: 'PUT',
            path: '/api/admin/demos/{id}',
            handler: async (request) => {
                requireAdmin(request);
                return demos.update(request.params.id, (request.payload || {}) as DemoInput);
            },
        },
        {
            method: 'POST',
            path: '/api/admin/demos/{id}/export',
            handler: async (request) => {
                const admin = requireAdmin(request);
                return demos.reexport(request.params.id, projectOf(request.payload), admin);
            },
        },
        {
            method: 'PUT',
            path: '/api/admin/demos/{id}/cover',
            options: { payload: { maxBytes: MAX_COVER_BYTES, output: 'data', parse: false, allow: ['image/png', 'image/jpeg', 'image/webp'] } },
            handler: async (request) => {
                requireAdmin(request);
                return demos.setCover(request.params.id, request.payload as Buffer, String(request.headers['content-type']).split(';')[0]);
            },
        },
        {
            method: 'GET',
            path: '/api/admin/demos/{id}/bundle',
            handler: async (request, h) => {
                requireAdmin(request);
                const meta = await demos.get(request.params.id);
                return h.file(demos.bundlePath(meta.id), { confine: false, mode: 'attachment', filename: `demo-${meta.id}.zip` });
            },
        },
        {
            method: 'DELETE',
            path: '/api/admin/demos/{id}',
            handler: async (request) => {
                requireAdmin(request);
                await demos.remove(request.params.id);
                return { deleted: true };
            },
        },
    ];
}
