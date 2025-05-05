import fs from 'fs';
import path from 'path';
import Graph from '../graph.mjs';
import nomad from '../nomad.mjs';
import services from '../services.mjs';
import media from '../media.mjs';
import web from '../web.mjs';
import fse from 'fs-extra';
import { processFilesHandler } from '../controllers/processFilesController.mjs';
import userManager from '../userManager.mjs';
const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = process.env.API_URL || '/';

export default [
    {
        method: 'GET',
        path: '/api/nomad/status',
        handler: async () => {
            return await nomad.getStatus();
        }
    },
    {
        method: 'POST', 
        path: '/api/nomad/service/{name}',
        handler: async (request, h) => {
            console.log('POST /api/nomad/service/{name}');
            console.log(request.params.name);
            const adapter = await services.getServiceAdapterByName(request.params.name);
            try {
                const service = await nomad.createService(adapter);
                return service;
            } catch(e) {
                console.log(e);
                return h.response({error: e}).code(500);
            }
        }
    },
    {
        method: 'DELETE',
        path: '/api/nomad/service/{name}',
        handler: async (request, h) => {
            const adapter = await services.getServiceAdapterByName(request.params.name);
            try {
                const service = await nomad.stopService(adapter);
                return service;
            } catch(e) {
                console.log(e);
                return h.response({error: e}).code(500);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/nomad/files/{file_rid}',
        handler: async (request, h) => {
            const clean_rid = Graph.sanitizeRID(request.params.file_rid);
            const file_metadata = await Graph.getUserFileMetadata(clean_rid, request.headers.mail);
            const src = fs.createReadStream(path.join(DATA_DIR, file_metadata.path));

            const response = h.response(src);

            if(file_metadata.type == 'pdf') {
                response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
                response.type('application/pdf');
            } else if(file_metadata.type == 'image') {
                response.type('image/png');
            } else if(file_metadata.type == 'text') {
                response.type('text/plain; charset=utf-8');
            } else if(file_metadata.type == 'data') {
                response.type('text/plain; charset=utf-8');
            } else {
                response.header('Content-Disposition', `attachment; filename=${file_metadata.label}`);
            }

            return response;
        }
    },
    {
        method: 'POST',
        path: '/api/nomad/process/files/error',
        handler: async (request, h) => {
            if (request.payload && request.payload.error) {
                const error = request.payload.error;
                if (request.payload.message) {
                    const message = request.payload.message;
                    let target = message.target;

                    if (message.task == 'index') {
                        return [];
                    } else {
                        if (message.process && message.process['@rid']) {
                            target = message.process['@rid'];
                        }
                        const wsdata = {
                            command: 'update',
                            target: target,
                            error: 'error'
                        };

                        // write error to node, send update to UI and index error
                        const targetNode = message.process && message.process['@rid'] ? message.process['@rid'] : target;
                        await Graph.setNodeAttribute(targetNode, {key: 'node_error', value: 'error'});
                        console.log('ERROR');
                        console.log(message);
                        await userManager.sendToUser(message.userId, wsdata);

                        const index_msg = [{
                            type: 'error',
                            id: target + '_error',
                            error_node: target,
                            error: JSON.stringify(error),
                            message: JSON.stringify(message),
                            owner: message.userId
                        }];
                        await web.indexDocuments(index_msg);
                    }
                }
            }

            if (error.status == 'created_duplicate_source') {
                console.log('DUPLICATE');
            }

            return [];
        }
    },
    {
        method: 'POST',
        path: '/api/nomad/process/files',
        options: {
            payload: {
                maxBytes: 209715200,
                output: 'file',
                parse: true,
                multipart: {
                    output: 'file'
                }
            }
        },
        handler: processFilesHandler
    }
];
