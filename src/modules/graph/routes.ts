import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';
import { tryRid } from '../../platform/ids.ts';
import { readJsonOrEmpty } from '../../platform/storage/fsutil.ts';

function rid(value: string): string {
    const r = tryRid(value);
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

export function graphRoutes({ graph, access, queue, sse, deletes }: Deps): ServerRoute[] {
    return [
        {
            method: 'GET',
            path: '/api/graph/traverse/{rid}/{direction}',
            handler: async (request, h) => {
                const result = await graph.traverse(rid(request.params.rid), request.params.direction, currentUser(request).rid);
                return result ?? h.response().code(404);
            },
        },
        {
            // Source init data (DSpace collections and fields) written by the source's init task.
            method: 'GET',
            path: '/api/graph/vertices/{rid}/init',
            handler: async (request) => {
                const owned = await access.findOwned(rid(request.params.rid), currentUser(request).rid);
                if (!owned?.node?.path) return {};
                return readJsonOrEmpty(owned.node.path + '/init.json');
            },
        },
        {
            method: 'POST',
            path: '/api/graph/vertices/{rid}',
            handler: async (request) => {
                const user = currentUser(request);
                const node = rid(request.params.rid);
                const payload = (request.payload || {}) as { key?: string; value?: unknown };
                const result = await graph.setAttribute(node, payload, user.rid);
                if (payload.key === 'description') sse.send(user.rid, { command: 'update', target: node, description: payload.value });
                return result;
            },
        },
        {
            method: 'DELETE',
            path: '/api/graph/vertices/{rid}',
            handler: async (request) => {
                const node = rid(request.params.rid);
                if (queue.hasActiveJobsFor(node)) throw Boom.conflict('Cannot delete a node with active queue jobs. Pause or cancel the batch first.');
                // Answers at once; the delete finishes in the background (plan/decisions.md G5).
                await deletes.start(node, currentUser(request).rid);
                return { path: null, deleted: null, status: 'deleting' };
            },
        },
        {
            method: 'DELETE',
            path: '/api/graph/edges/{rid}',
            handler: (request) => graph.deleteEdge(rid(request.params.rid), currentUser(request).rid),
        },
        {
            method: 'POST',
            path: '/api/graph/edges/{rid}',
            handler: (request) => graph.setEdgeAttribute(rid(request.params.rid), (request.payload || {}) as any, currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/errors/{rid}',
            handler: async (request, h) => {
                const owned = await access.findOwned(rid(request.params.rid), currentUser(request).rid);
                return owned ? owned.node : h.response({ error: 'Not found' }).code(404);
            },
        },
    ];
}
