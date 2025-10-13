
import Graph from '../graph.mjs';
import nomad from '../nomad.mjs';
import services from '../services.mjs';
import db from '../db.mjs';
import nats from '../queue.mjs';
import logger from '../logger.mjs';
import media from '../media.mjs';

import path from 'path';

import { processFilesHandler, processMetadataHandler, processCSVAppendHandler } from '../controllers/processFilesController.mjs';
import userManager from '../userManager.mjs';
import { DATA_DIR, API_URL } from '../env.mjs';


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
                    //logger.error('Error processing files', { error: error, message: message });
                    logger.error('Error processing files', { error: error, message: message });
                    console.log(message)


                    if (message.process && message.process['@rid']) {
                        target = message.process['@rid'];
                    }                  

                    // write error to node, send update to UI and create error node
                    // if processed file is part of set, then we need to update the setProcess node
                    var targetNode = message.process && message.process['@rid'] ? message.process['@rid'] : target;
                    if(message.output_set) {
                        const setProcessNode = await Graph.getSetProcessNode(message.output_set, message.userId);
                        if(setProcessNode) {
                            console.log('setProcessNode', setProcessNode)
                            targetNode = setProcessNode['setprocess']['@rid'];
                        }
                    }
                    var error_count = await Graph.setNodeError(targetNode, error, message.userId);
                    await userManager.sendToUser(message.userId, {
                        command: 'update',
                        target: targetNode,
                        error: 'errors: ' + error_count
                    });
                    
                    // create error node and update UI
                    const errornode = await Graph.createErrorNode(error, message, DATA_DIR);
        
                    // write error to error node file
                    const log = {info: 'Something went wrong with the file processing.', 
                        timestamp: new Date().toISOString(), 
                        file: message.file,
                        task: message.task,
                        message: message,
                        error: error
                    };  
                    await media.createProcessDir(path.dirname(errornode.path))
                    await media.writeJSON(log, 'error.json', path.dirname(errornode.path));
                    if(!message.output_set) {
                        await userManager.sendToUser(message.userId, {
                            command: 'add',
                            input: message.process['@rid'],
                            type: 'error',
                            process: { '@rid': message.process['@rid'], status: 'finished' },
                            node: errornode
                        })
                    }

                    
                }
            } else {
                logger.error('Error processing files', { error: request.payload });
            }

            return [];
        }
    },
    {
        method: 'GET',
        path: '/api/errors/{rid}',
        handler: async (request) => {
            return await db.getError(Graph.sanitizeRID(request.params.rid));
        }
    },

    {
        method: 'POST',
        path: '/api/nomad/process/files/done',
        handler: async (request, h) => {
            if (request.payload ) {
                console.log('POST /api/nomad/process/files/done')
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

                if(message?.output_set) {
                    const wsdata = {
                        command: 'process_finished',
                        target: target,
                        metadata: message.file.metadata,
                        paths: message.paths
                    };
                    await userManager.sendToUser(message.userId, wsdata);
                }
                // If target is a pdf, send cover page thumbnail message to md-poppler
                if(message?.file?.type == 'pdf') {
                    // PDF page count

                    // write data to node
                    const targetNode = message.process && message.process['@rid'] ? message.process['@rid'] : target;

                    if(message?.file?.metadata?.page_count) {
                        await Graph.setNodeAttribute_old(targetNode, {key: 'metadata.page_count', value: message.file.metadata.page_count}, 'File');
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
    },
    {
        method: 'POST',
        path: '/api/nomad/process/csv/append',
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
        handler: processCSVAppendHandler
    },

    {
        method: 'POST',
        path: '/api/nomad/process/files/metadata',
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
        handler: processMetadataHandler
    }
];
