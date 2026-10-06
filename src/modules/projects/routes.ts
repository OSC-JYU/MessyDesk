import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';
import { toRid, tryRid } from '../../platform/ids.ts';

function rid(value: string): string {
    const r = tryRid(value);
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

export function projectRoutes({ projects, deskGraph, access, nodes, graph, processing, tags, deletes }: Deps): ServerRoute[] {
    return [
        {
            method: 'POST',
            path: '/api/projects',
            handler: (request) => projects.create((request.payload || {}) as Record<string, unknown>, currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/projects',
            handler: (request) => projects.list(currentUser(request).rid),
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
                return processing.reindexProject(toRid(rid(request.params.rid)), user.rid, (fileRid) => tags.reindexFileTags(fileRid, user.rid));
            },
        },
    ];
}
