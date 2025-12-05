
import Graph from '../graph.mjs';
import Boom from '@hapi/boom';


export default [
    {
        method: 'GET',
        path: '/api/prompts',
        handler: async (request) => {
            return await Graph.getPrompts(request.auth.credentials.user.rid);
        }
    },
    {
        method: 'POST',
        path: '/api/prompts',
        handler: async (request) => {
            try {
                return await Graph.savePrompt(request.payload, request.auth.credentials.user.rid);
            } catch (e) {
                console.log('Error saving prompt:', e);
                throw Boom.badData(e.message);
            }
        }
    }
];