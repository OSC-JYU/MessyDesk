
import Graph from '../graph.mjs';
import nomad from '../nomad.mjs';
import services from '../services.mjs';
import web from '../web.mjs';
import nats from '../queue.mjs';
import logger from '../logger.mjs';

import { processFilesHandler } from '../controllers/processFilesController.mjs';
import userManager from '../userManager.mjs';
const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = 'http://localhost:8200/';


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
                logger.error('Error creating service', { error: e });
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
                logger.error('Error stopping service', { error: e });
                return h.response({error: e}).code(500);
            }
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
                    logger.error('Error processing files', { error: error, message: message });

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
                        await Graph.setNodeAttribute(targetNode, {key: 'node_error', value: 'error'}, 'File');
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
            } else {
                logger.error('Error processing files', { error: request.payload });
            }

            // if (error.status == 'created_duplicate_source') {
            //     console.log('DUPLICATE');
            // }

            return [];
        }
    },
    {
        method: 'GET',
        path: '/api/errors/{rid}',
        handler: async (request) => {
            return await web.getError(Graph.sanitizeRID(request.params.rid));
        }
    },

    {
        method: 'POST',
        path: '/api/nomad/process/files/done',
        handler: async (request, h) => {
            if (request.payload ) {
                console.log(request.payload)
            
                const message = request.payload
                let target = message.target;

                if (message.process && message.process['@rid']) {
                    target = message.process['@rid'];
                }
            
                // update UI if metadata is available
                if(message?.file?.metadata) {
                    const wsdata = {
                        command: 'update',
                        target: target,
                        metadata: message.file.metadata
                    };
                    await userManager.sendToUser(message.userId, wsdata);
                }

                // If target is a pdf, send thumbnail message to md-poppler
                if(message?.file?.type == 'pdf') {
                    // PDF page count

                    // write data to node
                    const targetNode = message.process && message.process['@rid'] ? message.process['@rid'] : target;

                    if(message?.file?.metadata?.page_count) {
                        await Graph.setNodeAttribute(targetNode, {key: 'metadata.page_count', value: message.file.metadata.page_count}, 'File');
                    }

                    message.task = 'pdf2images';
                    message.params = {
                        page: 1,
                        firstPageToConvert: '1',
                        lastPageToConvert: '1',
                        resolutionXYAxis: '80',
                        task: 'pdf2images'
                    };
                    message.role = 'thumbnail';
                    message.id = 'md-poppler';
                   
                    nats.publish(message.id, JSON.stringify(message));

                }
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
