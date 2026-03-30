import { randomUUID } from 'crypto';
import Boom from '@hapi/boom';

import Graph from '../graph.mjs';
import services from '../services.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import media from '../media.mjs';
import path from 'path';
import { API_URL, DATA_DIR } from '../env.mjs';

async function dispatchSetFilesForBatch({service, task, files, setProcessRid, outputSetRid, userRid, totalFiles, startIndex = 1}) {
    let fileCount = startIndex;
    for(const file of files) {
        const fileMetadata = await Graph.getUserFileMetadata(file['@rid'], userRid);

        const msg = {
            service,
            task,
            file: fileMetadata,
            set_process: setProcessRid,
            process: { '@rid': setProcessRid },
            output_set: outputSetRid,
            total_files: totalFiles,
            current_file: fileCount,
            userId: userRid,
        };

        if(service.tasks?.[task.id]?.source == 'source_file') {
            const source = await Graph.getFileSource(file['@rid'], msg.file['@type']);
            if(source) {
                const sourceMetadata = await Graph.getUserFileMetadata(source['@rid'], userRid);
                msg.file.source = sourceMetadata;
            }
        }

        await nats.createSetProcessNodesAndPublish(msg);
        fileCount += 1;
    }

    return fileCount - startIndex;
}

function getFileSortName(file) {
    if (!file) return '';
    if (file.original_filename) return String(file.original_filename).toLowerCase();
    if (file.label) return String(file.label).toLowerCase();
    if (file.path) return path.basename(String(file.path)).toLowerCase();
    return '';
}

function sortFilesByFilename(files) {
    return [...(files || [])].sort((a, b) => {
        const aName = getFileSortName(a);
        const bName = getFileSortName(b);
        return aName.localeCompare(bName);
    });
}


export default [
    // pipeline
    {
        method: 'POST',
        path: '/api/pipeline/files/{file_rid}/{roi?}',
        handler: async (request) => {
            const clean_rid = Graph.sanitizeRID(request.params.file_rid);
            var clean_roi = '';
            if(request.params.roi) clean_roi = Graph.sanitizeRID(request.params.roi);
            let messages = [];
            
            var pipelineLines = await Graph.createRequestsFromPipeline(request.payload, clean_rid, clean_roi);
            
            for(var line of pipelineLines) {
                var service = services.getServiceAdapterByName(line.params.topic);
                messages = await Graph.createQueueMessages(service, line.payload, request.params.file_rid, request.auth.credentials.user.rid );
                for(var msg of messages) {
                    nats.publish(line.params.topic, JSON.stringify(msg));
                }
            }
            return messages;
        }
    },

    {
        method: 'GET', 
        path: '/api/queue/{topic}/drain/{process_rid?}',
        handler: async (request) => {
            const topic = request.params.topic;
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            console.log('process_rid: ', process_rid);
            const status = await nats.drainQueue(topic, process_rid);
            var wsdata = {
                command: 'process_finished',
                process: { '@rid': process_rid, status: 'finished'}
            }
            userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
            return status;
        }
    },

    {
        method: 'GET',
        path: '/api/batches/{process_rid}',
        handler: async (request) => {
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            return await Graph.getBatchProcess(process_rid);
        }
    },

    {
        method: 'POST',
        path: '/api/batches/{process_rid}/pause',
        handler: async (request) => {
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            const batch = await Graph.updateBatchProcess(process_rid, {
                state: 'paused',
                paused_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });

            const queueStatus = await nats.pauseBatch(process_rid);

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_update',
                process: { '@rid': process_rid, status: 'paused' },
                batch: {
                    state: 'paused',
                    processed_files: batch?.processed_files || 0,
                    failed_files: batch?.failed_files || 0,
                    total_files: batch?.total_files || 0,
                    avg_sec_per_file: batch?.avg_sec_per_file || 0,
                    eta_sec: batch?.eta_sec ?? null,
                }
            });

            return { ...queueStatus, batch };
        }
    },

    {
        method: 'POST',
        path: '/api/batches/{process_rid}/resume',
        handler: async (request) => {
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            const batch = await Graph.getBatchProcess(process_rid);
            if(!batch) {
                throw Boom.notFound('Batch not found');
            }
            if(!batch.input_set || !batch.topic || !batch.task_id || !batch.output_set) {
                throw Boom.badRequest('Batch resume is currently supported for set-to-set batches only');
            }

            await nats.resumeBatch(process_rid);

            await Graph.updateBatchProcess(process_rid, {
                state: 'resuming',
                updated_at: new Date().toISOString(),
            });

            const service = services.getServiceAdapterByName(batch.topic);
            if(!service) {
                throw Boom.badRequest(`Service not found for topic ${batch.topic}`);
            }

            let taskPayload = { id: batch.task_id };
            if(batch.task_payload_json) {
                try {
                    taskPayload = JSON.parse(batch.task_payload_json);
                } catch {
                    taskPayload = { id: batch.task_id };
                }
            }
            if(!taskPayload.id) {
                taskPayload.id = batch.task_id;
            }

            const task = JSON.parse(JSON.stringify(taskPayload));
            if(service.external_tasks) {
                task.name = task.name || task.id;
            } else {
                if(!service.tasks[task.id]) {
                    throw Boom.badRequest('Task not found in service');
                }
                task.name = service.tasks[task.id].name;
            }

            if(service.external_tasks) {
                task.params = task.system_params || task.params || {};
                if(service.models && task.model) {
                    const modelId = typeof task.model === 'string' ? task.model : task.model.id;
                    if(modelId && service.models[modelId]) {
                        task.model = structuredClone(service.models[modelId]);
                        task.model.id = modelId;
                    }
                }
            }

            const setFiles = await Graph.getSetFiles(batch.input_set, request.auth.credentials.user.rid, {limit: 10000});
            const processedRids = new Set(await Graph.getProcessedInputFileRidsForBatch(process_rid));
            const pendingFiles = setFiles.files.filter((file) => !processedRids.has(file['@rid']));

            await dispatchSetFilesForBatch({
                service,
                task,
                files: pendingFiles,
                setProcessRid: process_rid,
                outputSetRid: batch.output_set,
                userRid: request.auth.credentials.user.rid,
                totalFiles: batch.total_files || setFiles.files.length,
                startIndex: Number(batch.processed_files || 0) + 1,
            });

            const resumedBatch = await Graph.updateBatchProcess(process_rid, {
                state: 'running',
                updated_at: new Date().toISOString(),
            });

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_update',
                process: { '@rid': process_rid, status: 'running' },
                batch: {
                    state: 'running',
                    processed_files: resumedBatch?.processed_files || 0,
                    failed_files: resumedBatch?.failed_files || 0,
                    total_files: resumedBatch?.total_files || 0,
                    avg_sec_per_file: resumedBatch?.avg_sec_per_file || 0,
                    eta_sec: resumedBatch?.eta_sec ?? null,
                    pending_files: pendingFiles.length,
                }
            });

            return {status: 'running', process_rid, resumed_messages: pendingFiles.length, batch: resumedBatch};
        }
    },

    {
        method: 'POST',
        path: '/api/batches/{process_rid}/cancel',
        handler: async (request) => {
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            await Graph.updateBatchProcess(process_rid, {
                state: 'cancelling',
                updated_at: new Date().toISOString(),
            });
            const queueStatus = await nats.cancelBatch(process_rid);
            const batch = await Graph.updateBatchProcess(process_rid, {
                state: 'cancelled',
                finished_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                eta_sec: 0,
            });

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_finished',
                process: { '@rid': process_rid, status: 'cancelled' },
                batch: {
                    state: 'cancelled',
                    processed_files: batch?.processed_files || 0,
                    failed_files: batch?.failed_files || 0,
                    total_files: batch?.total_files || 0,
                    avg_sec_per_file: batch?.avg_sec_per_file || 0,
                    eta_sec: 0,
                }
            });

            return {...queueStatus, batch};
        }
    },

    {
        method: 'GET',
        path: '/api/queue/drain/{process_rid}',
        handler: async (request) => {
            const process_rid = Graph.sanitizeRID(request.params.process_rid);
            const status = await nats.drainQueueByProcess(process_rid);
            var wsdata = {
                command: 'process_finished',
                process: { '@rid': process_rid, status: 'finished'}
            }
            userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
            return status;
        }
    },


    {
        method: 'GET', 
        path: '/api/queue/{topic}/status',
        handler: async (request) => {
            const topic = request.params.topic;
            const status = await nats.getQueueStatus(topic);
            return status;
        }
    },


    {
        method: 'GET', 
        path: '/api/queue/{topic}/flush',
        handler: async (request) => {
            const topic = request.params.topic;
            const status = await nats.flushQueue(topic);
            return status;
        }
    },


    // single queue
    {
        method: 'POST',
        path: '/api/queue/{topic}/files/{file_rid}/{roi?}',
        handler: async (request) => {
            try {
                const topic = request.params.topic;
                const service = services.getServiceAdapterByName(topic);
                var messages = await Graph.createQueueMessages(service, request.payload, request.params.file_rid, request.auth.credentials.user.rid, request.params.roi);
                const queue = Graph.getQueueName(service, request.payload, topic);
                //console.log('messages: ', messages);


                // add Process node to UI
                if(messages.length > 0) {
                    var msg = messages[0];
                    if(request.params.roi) {
                        var wsdata = {command: 'add', type: 'process', input: msg.file['@rid'], node:msg.process};
                    } else {
                        var wsdata = {command: 'add', type: 'process', input: msg.file['@rid'], node:msg.process};
                    }
                    // there is output Set node (one-to-many), then add it too to UI
                    if(msg.set_node) {
                        wsdata.output = msg.set_node;
                        wsdata.set_process = msg.process['@rid'];
                    }
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
                }

                for(var msg of messages) {    
                    // send message to queue
                    nats.publish(queue, JSON.stringify(msg));
                }

                return request.params.file_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    },
    
    // set queue
    {
        method: 'POST',
        path: '/api/queue/{topic}/sets/{set_rid}',
        handler: async (request) => {
            const topic = request.params.topic;
            const set_rid = Graph.sanitizeRID(request.params.set_rid);
            try {
                console.log('****************** set queue ******************');
                const service = services.getServiceAdapterByName(topic);
                //console.log('request.payload: ', request.payload);
                //console.log('service.tasks: ', service.tasks);
                const task = JSON.parse(JSON.stringify(request.payload));
                if(!service.external_tasks && !service.tasks[task.id]) {
                    throw new Error('Task not found in service')
                }
                
                if(service.external_tasks) {
                    task.name = task.name;
                } else {
                    task.name = service.tasks[task.id].name;
                }
                var msg = {task: task}
                var task_name = '';
               // var task_output = 'file';
                // LLM services have tasks defined in prompts
                if(service.external_tasks) {
                    msg.external = 'yes'
                    msg.task.params = task.system_params
                    // add model information if service has models
                    if(service.models && task.model) {
                        // task.model could be either a string ID or the entire model object
                        let modelId = typeof task.model === 'string' ? task.model : task.model.id
                        if(modelId && service.models[modelId]) {
                            msg.task.model = structuredClone(service.models[modelId])
                            msg.task.model.id = modelId
                        }
                    }
                } 



                // if(service.tasks[task.id].output) {
                //     task_output = service.tasks[task.id].output;
                // }

                var set_metadata = await Graph.getUserFileMetadata(set_rid, request.auth.credentials.user.rid);
                var set_files = await Graph.getSetFiles(set_rid, request.auth.credentials.user.rid, {limit: 10000});

                // in many-to-one outputs we do not create process nodes for each file 
                if(!service.external_tasks && service.tasks[task.id].output == 'many-to-one') {
                    var processNode = await Graph.createManyToOneProcessNode(task_name, service, request.payload, set_metadata)
                    const outputSetNode = await Graph.createProcessSetNode(processNode['@rid'], {
                        input_set: set_rid,
                        label: `${task.name || task.id} output`,
                        project_rid: set_metadata.project_rid,
                    })
                    await Graph.initBatchProcess(processNode['@rid'], {
                        topic: topic,
                        task_id: task.id,
                        input_set: set_rid,
                        output_set: outputSetNode['@rid'],
                        total_files: set_files.files.length,
                    });
                    // add node to UI
                    var wsdata = {command: 'add', type: 'process', input: set_rid, node:processNode, output: outputSetNode};
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);

                    var set_type = ''
                    if(set_files.files.length > 0) {
                        set_type = set_files.files[0].type;
                    }
                    if(set_type.includes('json') || set_type == 'csv') {
                        console.log('just one request');

                        var file_metadata = await Graph.getUserFileMetadata(set_files.files[0]['@rid'], request.auth.credentials.user.rid);
                        msg.file = file_metadata;
                        msg.process = processNode;
                        msg.input_set = set_rid;  // processing endpoint should ask all files at once as a zip file
                        msg.output_set = outputSetNode['@rid'];
             
                        msg.output = service.tasks[task.id].output;
                        msg.set_process = processNode['@rid'];
                        msg.total_files = set_files.files.length;
                   
                        msg.userId = request.auth.credentials.user.rid;
                        nats.publish(topic + '_batch', JSON.stringify(msg));

                    } else {
                        console.log('many-to-one grouped output');
                        const groupedFiles = await Graph.groupFilesByRootSource(set_files.files, {
                            boundary: 'pdf',
                            excludeRootTypes: ['zip'],
                        });

                        let batchFileCount = 1;
                        for(const group of groupedFiles) {
                            const output_uuid = randomUUID()
                            let groupFileCount = 1
                            const orderedGroupFiles = sortFilesByFilename(group.files)
                            for(const file of orderedGroupFiles) {
                            var file_metadata = await Graph.getUserFileMetadata(file['@rid'], request.auth.credentials.user.rid);
    
                            // do we need info about "parent" file? (when processing osd.json for example)
                            if(service.tasks[task.id]?.source == 'source_file') {
                                const source = await Graph.getFileSource(file['@rid']);
                                console.log('source: ', source);
                                if(source) {
                                    const source_metadata = await Graph.getUserFileMetadata(source['@rid'], request.auth.credentials.user.rid);
                                    msg.source = source_metadata;
                                }
                            }
    
                            await media.writeJSON(request.payload, 'params.json', path.join(path.dirname(processNode.path)));
    
                            msg.process = processNode;
                            msg.output_uuid = output_uuid // we need this to identify the output file in processing endpoint
                            msg.output = service.tasks[task.id].output
                            msg.file = file_metadata;
                            msg.output_set = outputSetNode['@rid'];
                            msg.root_source = {
                                '@rid': group.source_rid,
                                label: group.label,
                                type: group.type,
                                path: group.path,
                            }
                            msg.set_process = processNode['@rid'];
                            // per-group counters for many-to-one combine behavior
                            msg.total_files = group.files.length;
                            msg.current_file = groupFileCount;
                            // aggregated counters for backend progress tracking
                            msg.batch_total_files = set_files.files.length;
                            msg.batch_current_file = batchFileCount;
                            msg.userId = request.auth.credentials.user.rid;
                            nats.publish(topic + '_batch', JSON.stringify(msg));
    
                            groupFileCount += 1;
                            batchFileCount += 1;
                            }
                        }
                    }

                // normal "set to set" output
                } else {
                    console.log('**************** Creating set and process nodes *********');
                    var nodes = await Graph.createSetAndProcessNodes(service, task, set_metadata, request.auth.credentials.user.rid);
                    await Graph.initBatchProcess(nodes.process['@rid'], {
                        topic: topic,
                        task_id: task.id,
                        input_set: set_rid,
                        output_set: nodes.set ? nodes.set['@rid'] : null,
                        task_payload_json: JSON.stringify(request.payload),
                        total_files: set_files.files.length,
                    });
                    // add nodes (Process and Set) to UI
                    //console.log('nodes: ', nodes);
                    var wsdata = {command: 'add', type: 'process', input: set_rid, node:nodes.process, output:nodes.set};
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
                    //console.log('set_files: ', set_files);
                    
                    const dispatched = await dispatchSetFilesForBatch({
                        service,
                        task,
                        files: set_files.files,
                        setProcessRid: nodes.process['@rid'],
                        outputSetRid: nodes.set['@rid'],
                        userRid: request.auth.credentials.user.rid,
                        totalFiles: set_files.files.length,
                        startIndex: 1,
                    });

                    console.log('All files queued for processing: ', dispatched);
                    
                }


                return set_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    },

    // source queue
    {
        method: 'POST',
        path: '/api/queue/{topic}/sources/{source_rid}',
        handler: async (request) => {
            const topic = request.params.topic;
            const source_rid = Graph.sanitizeRID(request.params.source_rid);
            try {
                console.log('****************** source queue ******************');
                const service = services.getServiceAdapterByName(topic);
                console.log('request.payload: ', request.payload);
                console.log('service.tasks: ', service.tasks);
                var task = JSON.parse(JSON.stringify(request.payload));
                console.log('task: ', task);
                var task_name = service.tasks[task.id].name;
                console.log('task_name: ', task_name);

                // we need to add source URL to task params
                var source_metadata = await Graph.getUserFileMetadata(source_rid, request.auth.credentials.user.rid);
                console.log('source_metadata: ', source_metadata);
                const source_url = source_metadata.url;
                console.log('source_url: ', source_url);
                task.params.url = source_url;

                const process_attrs = { label: topic, path:'' }
                process_attrs.service = service.name
                process_attrs.project_rid = source_metadata.project_rid
                if(request.payload.info) {
                    process_attrs.info = request.payload.info
                }

                var processNode = await Graph.create('Process', process_attrs)
                var process_rid = processNode['@rid']
                await Graph.connect(source_metadata.project_rid, 'HAS_PROCESS', process_rid)
                // create process directory
                var process_path = media.getProcessFilesDir(DATA_DIR, source_metadata.project_rid, processNode.uuid || process_rid)
                await media.createProcessDir(process_path)
                await Graph.setNodeAttribute(process_rid, {'key':'path', 'value': process_path}, request.auth.credentials.user.rid)
                await media.writeJSON(request.payload, 'params.json', path.join(path.dirname(process_path)));

                // create output Set
                var setNode = await Graph.create('Set', {project_rid: source_metadata.project_rid})
                const set_path = media.getSetDir(DATA_DIR, source_metadata.project_rid, setNode.uuid || setNode['@rid'])
                await media.createProcessDir(set_path)
                await Graph.setNodeAttribute(setNode['@rid'], {'key':'path', 'value': set_path}, request.auth.credentials.user.rid)
                setNode.path = set_path
                await Graph.connectDerivedFrom(setNode['@rid'], source_rid, process_rid)
                await Graph.syncSetManifest(setNode['@rid'])

                // add node to UI
                var wsdata = {command: 'add', type: 'process', target: source_rid, node:processNode, set_node:setNode, image:API_URL + 'icons/wait.gif'};
                userManager.sendToUser(request.auth.credentials.user.rid, wsdata);

                var msg = {
                    process: processNode,
                    task: task,
                    file: source_metadata,
                    target: source_metadata['@rid'],
                    userId: request.auth.credentials.user.rid,
                    output_set: setNode['@rid']  // link file to output Set
                }
                //console.log('msg: ', msg);
                nats.publish(topic + '_batch', JSON.stringify(msg));

                return source_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    }
];
