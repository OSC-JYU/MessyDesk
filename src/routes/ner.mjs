import Graph from '../graph.mjs';

export default [
    {
        method: 'POST',
        path: '/api/files/{rid}/sets/{set_rid}/ner',
        handler: async (request) => {
            const result = await Graph.createNerRegions(
                request.params.rid,
                request.params.set_rid,
                request.payload,
                request.auth.credentials.user.rid,
                {service_id: request.query.service_id, task: request.query.task}
            );
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/files/{rid}/ner',
        handler: async (request) => {
            const result = await Graph.getNerRegions(request.params.rid, request.auth.credentials.user.rid);
            return result;
        }
    }
];
