import Graph from '../graph.mjs';
import Boom from '@hapi/boom';

export default [
    {
        method: 'POST',
        path: '/api/entities/{rid}/vertex/{vid}',
        handler: async (request) => {
            const result = await Graph.linkEntity(request.params.rid, request.params.vid, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'DELETE',
        path: '/api/entities/{rid}/vertex/{vid}',
        handler: async (request) => {
            const result = await Graph.unLinkEntity(request.params.rid, request.params.vid, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/entities',
        handler: async (request) => {
            const result = await Graph.createEntity(request.payload, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/entities/link/{rid}',
        handler: async (request) => {
            if(!Array.isArray(request.payload)) throw Boom.badRequest('Payload must be an array');
            const result = await Graph.createEntityAndLink(request.payload, request.params.rid, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/entities',
        handler: async (request) => {
            const result = await Graph.getEntityTypes(request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/entities/types',
        handler: async (request) => {
            const result = await Graph.getEntityTypeSchema(request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/entities/items',
        handler: async (request) => {
            const result = await Graph.getEntityItems(request.query.entities, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/entities/{rid}',
        handler: async (request) => {
            const result = await Graph.getEntity(request.params.rid, request.auth.credentials.user.rid);
            return result;
        }
    }
]; 