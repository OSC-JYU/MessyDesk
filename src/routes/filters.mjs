import Graph from '../graph.mjs';
import Boom from '@hapi/boom';

export default [
    {
        method: 'POST',
        path: '/api/filters/{type}/files/{node_id}',
        handler: async (request) => {
            const result = await Graph.createFilter(request.params.type, request.params.node_id, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'DELETE',
        path: '/api/filters/{type}/files/{node_id}',
        handler: async (request) => {
            const result = await Graph.removeFilter(request.params.type, request.params.node_id, request.auth.credentials.user.rid);
            return result;
        }
    }
];