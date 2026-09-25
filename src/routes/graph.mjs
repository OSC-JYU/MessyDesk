import Graph from '../graph.mjs';
import userManager from '../userManager.mjs';
import Boom from '@hapi/boom';
export default [
    {
        method: 'GET',
        path: '/api/graph/traverse/{rid}/{direction}',
        handler: async (request, h) => {
            try {
                const traverse = await Graph.traverse(
                    Graph.sanitizeRID(request.params.rid),
                    request.params.direction,
                    request.auth.credentials.user.rid
                );
                if (!traverse) {
                    return h.response().code(404);
                }
                return traverse;
            } catch (e) {
                throw e;
            }
        }
    },
    {
        method: 'GET',
        path: '/api/graph/vertices/{rid}',
        handler: async (request) => {
            return await Graph.getNode(
                Graph.sanitizeRID(request.params.rid),
                request.auth.credentials.user.rid
            );
        }
    },
    {
        method: 'GET',
        path: '/api/graph/vertices/{rid}/init',
        handler: async (request) => {
            return await Graph.getSourceInit(Graph.sanitizeRID(request.params.rid), request.auth.credentials.user.rid);
        }
    },

    {
        method: 'POST',
        path: '/api/graph/vertices/{rid}',
        handler: async (request) => {
            const clean_rid = Graph.sanitizeRID(request.params.rid);
            const result = await Graph.setNodeAttribute(clean_rid, request.payload, request.auth.credentials.user.rid);
            
            if (request.payload.key && request.payload.key === 'description') {
                const wsdata = {
                    command: 'update',
                    target: clean_rid,
                    description: request.payload.value
                };
                userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
            }
            
            return result;
        }
    },
    {
        method: 'DELETE',
        path: '/api/graph/vertices/{rid}',
        handler: async (request) => {
            try {
                const rid = Graph.sanitizeRID(request.params.rid);

                // Deletion guard: prevent deleting nodes with active queue jobs
                const queue = (await import('../queue.mjs')).default;
                const db = queue._openDb();
                const activeJob = db.prepare(`
                    SELECT id FROM queue_jobs
                    WHERE (process_rid = ? OR set_process_rid = ?)
                      AND status IN ('queued', 'running')
                    LIMIT 1
                `).get(rid, rid);
                if (activeJob) {
                    throw Boom.conflict('Cannot delete a node with active queue jobs. Pause or cancel the batch first.');
                }

                const result = await Graph.deleteNode(
                    rid,
                    request.auth.credentials.user.rid
                );
                return result;
            } catch (error) {
                const message = String(error?.message || error || 'Delete failed');

                if (error?.isBoom) {
                    throw error;
                }

                if (/node not found|response code 404|not found/i.test(message)) {
                    throw Boom.notFound('Node not found');
                }

                if (/forbidden|owner|access/i.test(message)) {
                    throw Boom.forbidden('Not allowed to delete this node');
                }

                throw Boom.badImplementation(message);
            }
        }
    },

    {
        method: 'DELETE',
        path: '/api/graph/edges/{rid}',
        handler: async (request) => {
            return await Graph.deleteEdge(Graph.sanitizeRID(request.params.rid));
        }
    },
    {
        method: 'POST',
        path: '/api/graph/edges/{rid}',
        handler: async (request) => {
            return await Graph.setEdgeAttribute(
                Graph.sanitizeRID(request.params.rid),
                request.payload
            );
        }
    }
]; 