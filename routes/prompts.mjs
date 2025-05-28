
import Graph from '../graph.mjs';
import logger from '../logger.mjs';

const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = 'http://localhost:8200/';


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
            return await Graph.savePrompt(request.payload, request.auth.credentials.user.rid);
        }
    }
];