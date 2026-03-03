import Graph from '../graph.mjs';
import Boom from '@hapi/boom';

export default [
    {
        method: 'POST',
        path: '/api/graph/files/{rid}/rois',
        handler: async (request) => {
            const n = await Graph.createROIs(Graph.sanitizeRID(request.params.rid), request.payload)
            //const wsdata = {command: 'update', type: 'image', target: '#'+request.params.rid, roi_count: n}
            //userManager.sendToUser(request.auth.credentials.user.rid, wsdata)
            return n
        }
    }
];