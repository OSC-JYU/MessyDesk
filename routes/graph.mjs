import Graph from '../graph.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
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
    // {
    //     method: 'POST',
    //     path: '/api/graph/query',
    //     handler: async (request) => {
    //         return await Graph.getGraph(request.payload, request);
    //     }
    // },
    {
        method: 'POST',
        path: '/api/graph/vertices',
        handler: async (request) => {
            const type = request.payload.type;
            const result = await Graph.create(type, request.payload);
            console.log(result);
            return result;
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
        method: 'POST',
        path: '/api/graph/vertices/{rid}/rois',
        handler: async (request) => {
            const n = await Graph.createROIs(Graph.sanitizeRID(request.params.rid), request.payload)
            const wsdata = {command: 'update', type: 'image', target: '#'+request.params.rid, roi_count: n}
            await userManager.sendToUser(request.auth.credentials.user.id, wsdata)
            return n
        }
    },
    {
        method: 'POST',
        path: '/api/graph/vertices/{rid}',
        handler: async (request) => {
            const clean_rid = Graph.sanitizeRID(request.params.rid);
            const result = await Graph.setNodeAttribute(clean_rid, request.payload);
            
            if (request.payload.key && request.payload.key === 'description') {
                const wsdata = {
                    command: 'update',
                    target: clean_rid,
                    description: request.payload.value
                };
                await userManager.sendToUser(request.auth.credentials.user.id, wsdata);
            }
            
            return result;
        }
    },
    {
        method: 'DELETE',
        path: '/api/graph/vertices/{rid}',
        handler: async (request) => {
            const result = await Graph.deleteNode(
                Graph.sanitizeRID(request.params.rid),
                nats
            );
            console.log(result);
            if (result.path) {
                // TODO: delete path
                console.log(result.path);
            }
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/graph/edges',
        handler: async (request) => {
            return await Graph.connect(
                request.payload.from,
                request.payload.relation,
                request.payload.to
            );
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