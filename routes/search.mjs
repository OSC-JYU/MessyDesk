import solr from '../solr.mjs';
import Boom from '@hapi/boom';

export default [
    {
        method: 'POST',
        path: '/api/search',
        handler: async (request) => {
            const result = await solr.search(request.payload, request.auth.credentials.user.rid);
            return result;
        }
    }
]; 