import solr from '../solr.mjs';

export default [
    {
        method: 'POST',
        path: '/api/search',
        handler: async (request) => {
            const result = await solr.search(request.payload, request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/search/info',
        handler: async (request) => {
            try {
                return await solr.getUserProjectDocCounts(request.auth.credentials.user.rid);
            } catch (error) {
                return {
                    total_docs: 0,
                    project_count: 0,
                    project_counts: [],
                    available: false,
                    message: 'Failed to load search index info'
                };
            }
        }
    }
]; 