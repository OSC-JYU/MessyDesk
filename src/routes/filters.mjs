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
    },
    {
        method: 'POST',
        path: '/api/images/{rid}/sets/{set_rid}/rois',
        handler: async (request) => {
            const result = await Graph.createImageROIs(request.params.rid, request.params.set_rid, request.payload, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'PUT',
        path: '/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}',
        handler: async (request) => {
            const result = await Graph.editImageROIs(request.params.roi_rid, request.payload, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/images/{rid}/sets/{set_rid}/rois',
        handler: async (request) => {
            const result = await Graph.getImageROIs(request.params.rid, request.params.set_rid, request.auth.credentials.user.rid);
            return result;
        }
    }
];