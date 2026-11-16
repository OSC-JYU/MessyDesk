import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import { COVER_TYPES, MAX_COVER_BYTES } from './covers.ts';

function rid(value: string): string {
    const r = tryRid(value);
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

export function projectRoutes({ projects, covers, deskGraph, access, nodes, graph, processing, tags, ner, deletes }: Deps): ServerRoute[] {
    return [
        {
            method: 'POST',
            path: '/api/projects',
            handler: (request) => projects.create((request.payload || {}) as Record<string, unknown>, currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/projects',
            handler: async (request) => {
                const list = await projects.list(currentUser(request).rid);
                const found = await covers.describe(list);
                return list.map((project, i) => ({ ...project, cover: found[i] }));
            },
        },
        {
            method: 'GET',
            path: '/api/projects/{rid}/cover',
            handler: async (request, h) => {
                const cover = await covers.uploaded(rid(request.params.rid), currentUser(request).rid);
                if (!cover) throw Boom.notFound('No uploaded cover');
                return h.file(cover.file, { confine: false }).type(cover.type);
            },
        },
        {
            method: 'PUT',
            path: '/api/projects/{rid}/cover',
            options: { payload: { maxBytes: MAX_COVER_BYTES, output: 'data', parse: false, allow: Object.keys(COVER_TYPES) } },
            handler: async (request) => {
                const type = String(request.headers['content-type']).split(';')[0];
                await covers.setUpload(rid(request.params.rid), request.payload as Buffer, type, currentUser(request).rid);
                return { updated: true };
            },
        },
        {
            method: 'PUT',
            path: '/api/projects/{rid}/cover-file',
            handler: async (request) => {
                await covers.setFile(rid(request.params.rid), (request.payload as any)?.file, currentUser(request).rid);
                return { updated: true };
            },
        },
        {
            method: 'DELETE',
            path: '/api/projects/{rid}/cover',
            handler: async (request) => {
                await covers.reset(rid(request.params.rid), currentUser(request).rid);
                return { updated: true };
            },
        },
        {
            method: 'POST',
            path: '/api/projects/update-size',
            handler: (request) => projects.updateSizes(currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/projects/storage-summary',
            handler: (request) => projects.storageSummary(currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/projects/{rid}',
            handler: (request) => deskGraph.forProject(rid(request.params.rid), currentUser(request).rid),
        },
        {
            method: 'PUT',
            path: '/api/projects/{rid}',
            handler: (request) => projects.setAttribute(rid(request.params.rid), (request.payload || {}) as any, currentUser(request).rid),
        },
        {
            method: 'DELETE',
            path: '/api/projects/{rid}',
            handler: async (request) => {
                const user = currentUser(request);
                const project = rid(request.params.rid);
                if (!(await access.isProjectOwner(project, user.rid))) throw Boom.notFound('Project not found or access denied');
                // Answers at once; the desk is hidden and deleted in the background (decisions G5).
                await deletes.start(project, user.rid);
                return project;
            },
        },
        {
            method: 'POST',
            path: '/api/projects/{rid}/sets',
            handler: async (request) => {
                const user = currentUser(request);
                const project = rid(request.params.rid);
                if (!(await access.isProjectOwner(project, user.rid))) throw Boom.badRequest('Set creation failed! Project not found!');
                return nodes.createSet(project, (request.payload || {}) as Record<string, unknown>);
            },
        },
        {
            method: 'POST',
            path: '/api/projects/{rid}/sources',
            handler: (request) => processing.createSource(rid(request.params.rid), request.payload || {}, currentUser(request).rid),
        },
        {
            method: 'POST',
            path: '/api/projects/{rid}/reindex-search',
            handler: (request) => {
                const user = currentUser(request);
                return processing.reindexProject(toRid(rid(request.params.rid)), user.rid, (fileRid) => tags.reindexFileTags(fileRid, user.rid), () => ner.reindexProject(user.rid, toRid(rid(request.params.rid))));
            },
        },
    ];
}
