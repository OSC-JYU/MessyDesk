import Graph from '../graph.mjs';
import media from '../media.mjs';
import nats from '../queue.mjs';
import { send2UI } from '../index.mjs';

export default [
    {
        method: 'POST',
        path: '/api/projects',
        handler: async (request) => {
            const me = await Graph.myId(request.headers.mail);
            if (!request.payload.label) {
                throw new Error('label required');
            }
            const project = await Graph.createProject(request.payload, me.rid);
            await media.createProjectDir(project, process.env.DATA_DIR || 'data');
            return project;
        }
    },
    {
        method: 'GET',
        path: '/api/projects',
        handler: async (request) => {
            return await Graph.getProjects(request.headers.mail, process.env.DATA_DIR || 'data');
        }
    },
    {
        method: 'GET',
        path: '/api/projects/{rid}',
        handler: async (request) => {
            return await Graph.getProject_backup(
                Graph.sanitizeRID(request.params.rid),
                request.headers.mail
            );
        }
    },
    {
        method: 'DELETE',
        path: '/api/projects/{rid}',
        handler: async (request) => {
            return await Graph.deleteProject(
                Graph.sanitizeRID(request.params.rid),
                request.headers.mail,
                nats
            );
        }
    },
    {
        method: 'GET',
        path: '/api/projects/{rid}/files',
        handler: async (request) => {
            const result = await Graph.getProjectFiles(
                Graph.sanitizeRID(request.params.rid),
                request.headers.mail
            );
            return result.result;
        }
    }
]; 