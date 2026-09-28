import Graph from '../graph.mjs';

export default [
    {
        method: 'GET',
        path: '/api/tags',
        handler: async (request) => {
            const result = await Graph.getTags(request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/tags',
        handler: async (request) => {
            const result = await Graph.createTag(request.payload?.label, request.auth.credentials.user.rid, request.payload?.description);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/tags/machine',
        handler: async (request) => {
            const result = await Graph.getMachineTags(request.auth.credentials.user.rid);
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/tags/machine/{entity_rid}/files',
        handler: async (request) => {
            const result = await Graph.getMachineTagFiles(
                request.params.entity_rid,
                request.query.service_id,
                request.query.task,
                request.auth.credentials.user.rid
            );
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/tags/machine/{entity_rid}/mentions',
        handler: async (request) => {
            const result = await Graph.getMachineTagMentions(
                request.params.entity_rid,
                request.query.service_id,
                request.query.task,
                request.auth.credentials.user.rid,
                {search: request.query.search, page: request.query.page, pageSize: request.query.pageSize}
            );
            return result;
        }
    },
    {
        // NER never creates tags (tags.md \u00a71) - these read ner.json runs directly, no TagLink involved.
        method: 'GET',
        path: '/api/tags/ner/labels',
        handler: async (request) => {
            const result = await Graph.getNerLabelGroups(request.auth.credentials.user.rid, {
                search: request.query.search,
                project_rid: request.query.project_rid,
                project_rids: request.query.project_rids ? request.query.project_rids.split(',') : undefined,
                file_rids: request.query.file_rids ? request.query.file_rids.split(',') : undefined
            });
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/tags/ner/labels/files',
        handler: async (request) => {
            const result = await Graph.getNerLabelFiles(
                request.query.service_id,
                request.query.task,
                request.query.label,
                request.auth.credentials.user.rid,
                {
                    project_rid: request.query.project_rid,
                    project_rids: request.query.project_rids ? request.query.project_rids.split(',') : undefined,
                    file_rids: request.query.file_rids ? request.query.file_rids.split(',') : undefined
                }
            );
            return result;
        }
    },
    {
        method: 'GET',
        path: '/api/tags/ner/labels/mentions',
        handler: async (request) => {
            const result = await Graph.getNerLabelMentions(
                request.query.service_id,
                request.query.task,
                request.query.label,
                request.auth.credentials.user.rid,
                {
                    search: request.query.search,
                    page: request.query.page,
                    pageSize: request.query.pageSize,
                    project_rid: request.query.project_rid,
                    project_rids: request.query.project_rids ? request.query.project_rids.split(',') : undefined,
                    file_rids: request.query.file_rids ? request.query.file_rids.split(',') : undefined
                }
            );
            return result;
        }
    }
];
