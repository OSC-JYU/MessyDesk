import services from '../services.mjs';
import nomad from '../nomad.mjs';
import Graph from '../graph.mjs';

export default [
    {
        method: 'GET',
        path: '/api/services',
        handler: async () => {
            return await services.getServices();
        }
    },
    {
        method: 'POST',
        path: '/api/services/reload',
        handler: async (request, h) => {
            try {
                await services.loadServiceAdapters();
                return { status: 'ok', service: services };
            } catch (e) {
                console.log(e);
                return h.response({ error: e }).code(500);
            }
        }
    },
    {
        method: 'POST',
        path: '/api/services/{service}/consumer/{id}',
        handler: async (request) => {
            return await services.addConsumer(request.params.service, request.params.id);
        }
    },
    {
        method: 'DELETE', 
        path: '/api/services/{service}/consumer/{id}',
        handler: async (request) => {
            const adapter = await services.getServiceAdapterByName(request.params.service);
            const response = await services.removeConsumer(request.params.service, request.params.id);
            await nomad.stopService(adapter);
            return response;
        }
    },
    {
        method: 'GET',
        path: '/api/services/files/{rid}',
        handler: async (request) => {
            const file = await Graph.getUserFileMetadata(
                request.params.rid,
                request.auth.credentials.user.rid
            );
            const prompts = await Graph.getPrompts(request.auth.credentials.user.rid);

            if (file) {
                return await services.getServicesForNode(
                    file,
                    request.query.filter,
                    request.auth.credentials.user,
                    prompts
                );
            }
            return [];
        }
    }
]; 