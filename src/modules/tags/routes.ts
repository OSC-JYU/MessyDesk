import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser, requireAdmin } from '../../platform/http/auth.ts';
import { ALLOWED_LOGO_TYPES, ServiceGroupsService } from '../service-groups/service-groups.ts';

function split(value: unknown): string[] | undefined {
    return value ? String(value).split(',') : undefined;
}

function scope(query: any): Record<string, unknown> {
    return {
        search: query.search,
        project_rid: query.project_rid,
        project_rids: split(query.project_rids),
        file_rids: split(query.file_rids),
        page: query.page,
        pageSize: query.pageSize,
    };
}

export function tagRoutes({ tags, ner, filters, prompts, rois, serviceGroups, config }: Deps): ServerRoute[] {
    return [
        // ---- entities and tags ------------------------------------------------------------
        { method: 'GET', path: '/api/entities', handler: (r) => tags.groupedEntities(currentUser(r).rid, scope(r.query)) },
        { method: 'POST', path: '/api/entities', handler: async (r) => (await tags.createEntity(r.payload || {}, currentUser(r).rid)) ?? null },
        { method: 'GET', path: '/api/entities/types', handler: (r) => tags.entityTypeSchema(currentUser(r).rid) },
        { method: 'GET', path: '/api/entities/items', handler: (r) => tags.entityItems((r.query as any).entities, currentUser(r).rid, scope(r.query), config.apiUrl) },
        { method: 'GET', path: '/api/entities/sets/{rid}', handler: (r) => tags.setEntities(r.params.rid, currentUser(r).rid) },
        { method: 'POST', path: '/api/entities/{rid}/vertex/{vid}', handler: async (r) => (await tags.link(r.params.rid, r.params.vid, currentUser(r).rid)) ?? null },
        { method: 'DELETE', path: '/api/entities/{rid}/vertex/{vid}', handler: async (r) => (await tags.unlink(r.params.rid, r.params.vid, currentUser(r).rid)) ?? null },
        {
            method: 'POST',
            path: '/api/entities/link/{rid}',
            options: { auth: { strategies: ['service', 'mail'] } },
            handler: (r) => {
                if (!Array.isArray(r.payload)) throw Boom.badRequest('Payload must be an array');
                return tags.createEntitiesAndLink(r.payload, r.params.rid, currentUser(r).rid);
            },
        },
        { method: 'GET', path: '/api/tags', handler: (r) => tags.tags(currentUser(r).rid) },
        { method: 'POST', path: '/api/tags', handler: async (r) => (await tags.createTag(r.payload?.label, currentUser(r).rid, r.payload?.description)) ?? null },
        { method: 'GET', path: '/api/tags/machine', handler: (r) => tags.machineTags(currentUser(r).rid) },
        { method: 'GET', path: '/api/tags/ner/labels', handler: (r) => ner.labelGroups(currentUser(r).rid, scope(r.query)) },
        {
            method: 'GET',
            path: '/api/tags/ner/labels/mentions',
            handler: (r) => {
                const q = r.query as any;
                return ner.labelMentions(q.service_id, q.task, q.label, currentUser(r).rid, scope(q));
            },
        },

        // ---- filters, prompts -------------------------------------------------------------
        { method: 'POST', path: '/api/filters/{type}/files/{rid}', handler: (r) => filters.apply(r.params.type, r.params.rid, currentUser(r).rid, r.payload || {}) },
        { method: 'GET', path: '/api/prompts', handler: (r) => prompts.list(currentUser(r).rid) },
        { method: 'POST', path: '/api/prompts', handler: (r) => prompts.save(r.payload || {}, currentUser(r).rid) },

        // ---- regions of interest ----------------------------------------------------------
        { method: 'GET', path: '/api/images/{rid}/sets/{set_rid}/rois', handler: (r) => rois.read(r.params.rid, r.params.set_rid, currentUser(r).rid) },
        { method: 'POST', path: '/api/images/{rid}/sets/{set_rid}/rois', handler: (r) => rois.save(r.params.rid, r.params.set_rid, r.payload, currentUser(r).rid) },
        { method: 'PUT', path: '/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}', handler: (r) => rois.update(r.params.roi_rid, r.payload, currentUser(r).rid) },
        { method: 'DELETE', path: '/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}', handler: (r) => rois.remove(r.params.rid, r.params.set_rid, r.params.roi_rid, currentUser(r).rid) },

        // ---- service groups (admin) -------------------------------------------------------
        { method: 'GET', path: '/api/service-groups', handler: (r) => { requireAdmin(r); return serviceGroups.list(); } },
        { method: 'POST', path: '/api/service-groups', handler: (r) => { requireAdmin(r); return serviceGroups.create(r.payload || {}); } },
        { method: 'PUT', path: '/api/service-groups/{id}', handler: (r) => { requireAdmin(r); return serviceGroups.update(r.params.id, r.payload || {}); } },
        {
            method: 'DELETE',
            path: '/api/service-groups/{id}',
            handler: async (r) => {
                requireAdmin(r);
                await serviceGroups.remove(r.params.id);
                return { success: true };
            },
        },
        {
            method: 'POST',
            path: '/api/service-groups/{id}/logo',
            options: { payload: { maxBytes: 5 * 1024 * 1024, output: 'file', parse: true, multipart: true, allow: 'multipart/form-data' } },
            handler: (r) => {
                requireAdmin(r);
                const file = (r.payload as any)?.file;
                if (!file) throw Boom.badRequest('No file uploaded');
                const type = file.headers?.['content-type'];
                if (!ALLOWED_LOGO_TYPES[type]) throw Boom.badRequest('Logo must be a PNG, JPEG or WEBP image');
                return serviceGroups.uploadLogo(r.params.id, file.path, type);
            },
        },
        {
            method: 'GET',
            path: '/api/service-groups/{id}/logo',
            handler: async (r, h) => {
                const logo = `${serviceGroups.logoDir(ServiceGroupsService.requireId(r.params.id))}/logo.png`;
                const fs = await import('node:fs');
                if (!fs.existsSync(logo)) throw Boom.notFound('No logo');
                return h.file(logo, { confine: false }).type('image/png');
            },
        },
    ];
}
