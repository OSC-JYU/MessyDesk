
import Graph from '../graph.mjs';
import nomad from '../nomad.mjs';
import services from '../services.mjs';
import db from '../db.mjs';
import nats from '../queue.mjs';
import logger from '../logger.mjs';
import media from '../media.mjs';

import path from 'path';

import { processFilesHandler, processFilesFromTmpHandler, processMetadataHandler, processCSVAppendHandler } from '../controllers/processFilesController.mjs';
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
            const hclOverride = request.payload?.nomad_hcl;

            const serviceConfig = { ...adapter };
            if (typeof hclOverride === 'string' && hclOverride.trim().length > 0) {
                serviceConfig.nomad_hcl = hclOverride;
                serviceConfig.nomad = true;
            }
            try {
                const service = await nomad.createService(serviceConfig);
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
                    const role = String(message?.role || '').toLowerCase();
                    const isThumbnailFailure = role === 'thumbnail'
                        || role === 'thumbnails'
                        || message?.task?.id === 'thumbnail'
                        || message?.topic?.id === 'md-thumbnailer'
                        || message?.service?.id === 'md-thumbnailer';
                    const processMarker = String(message?.process?.kind || message?.process || '').toLowerCase();
                    const isInternalVersioning = role === 'internal_versioning'
                        || role === 'exif_rotate'
                        || processMarker === 'internal_versioning';

                    if (isThumbnailFailure) {
                        logger.warn('Thumbnail processing failed (non-fatal), skipping error node creation', {
                            error,
                            process: message?.process?.['@rid'],
                            file: message?.file?.['@rid'],
                            service: message?.service?.id,
                            task: message?.task?.id,
                            role: message?.role,
                        });
                        return [];
                    }

                    if (isInternalVersioning) {
                        logger.warn('Internal versioning rotation failed (non-fatal), skipping error node creation', {
                            error,
                            process: message?.process,
                            file: message?.file?.['@rid'],
                            service: message?.service?.id,
                            task: message?.task?.id,
                            role: message?.role,
                        });
                        return [];
                    }
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
                            await Graph.incrementBatchFailed(targetNode);
                        }
                    } else if (message.set_process) {
                        await Graph.incrementBatchFailed(message.set_process);
                    }
                    if(targetNode) {
                        var error_count = await Graph.setNodeError(targetNode, error, message.userId);
                        await userManager.sendToUser(message.userId, {
                            command: 'update',
                            target: targetNode,
                            error: 'errors: ' + error_count
                        });

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
            
                var message = request.payload
                let target = null

                if (message.process && message.process['@rid']) {
                    target = message.process['@rid'];
                } else {
                    target = message.file['@rid'];
                }
                if(!target) {
                    logger.error('Target not found', { message: message });
                    return [];
                }
            
                // update UI if metadata is available
                if(message?.file?.metadata) {
                    const wsdata = {
                        command: 'update',
                        target: target,
                        node: {metadata: message.file.metadata}
                    };
                    await userManager.sendToUser(message.userId, wsdata);
                }

                if(message?.output_set) {
                    const wsdata = {
                        command: 'process_finished',
                        process: { ...message.process, status: 'done' },
                        metadata: message.file.metadata,
                        paths: message.paths
                    };
                    await userManager.sendToUser(message.userId, wsdata);
                }

                if(message?.set_process) {
                    const processRid = Graph.sanitizeRID(message.set_process);
                    const totalFiles = Number(message?.total_files || message?.batch_total_files || 0);
                    const currentFile = Number(message?.current_file || 0);

                    let batch = null;
                    if(totalFiles > 0 && currentFile > 0) {
                        batch = await Graph.incrementBatchProcessed(
                            processRid,
                            Number(message?.response?.time || 0),
                            totalFiles
                        );
                    }

                    if(message?.summary) {
                        const processNode = await Graph.getBatchProcess(processRid);
                        if(processNode) {
                            const processType = processNode['@type'] || 'Process';
                            await Graph.setNodeAttribute_old(processNode['@rid'], {
                                key: 'summary',
                                value: message.summary,
                            }, processType);
                        }
                    }

                    const batchStatus = batch?.status || batch?.state;
                    const isDone = batchStatus === 'done' || (totalFiles > 0 && currentFile >= totalFiles);
                    if(isDone) {
                        const wsdata = {
                            command: 'process_finished',
                            process: {
                                ...(message.process || {'@rid': processRid}),
                                '@rid': processRid,
                                status: 'done',
                            },
                            summary: message.summary || null,
                        };
                        await userManager.sendToUser(message.userId, wsdata);
                    }
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
                maxBytes: 500000000,
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
        path: '/api/nomad/process/files/tmp',
        options: {
            payload: {
                maxBytes: 10485760,
                output: 'data',
                parse: true
            }
        },
        handler: processFilesFromTmpHandler
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
