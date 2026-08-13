import Boom from '@hapi/boom';

import Graph from '../graph.mjs';
import services from '../services.mjs';
import queue from '../queue.mjs';
import userManager from '../userManager.mjs';
import media from '../media.mjs';
import path from 'path';
import { API_URL, DATA_DIR } from '../env.mjs';

async function dispatchSetFilesForBatch({service, task, files, setProcessRid, inputSetRid = null, outputSetRid, userRid, totalFiles, startIndex = 1, searchOutput = false}) {
    let fileCount = startIndex;
    for(const file of files) {
        const fileMetadata = await Graph.getUserFileMetadata(file['@rid'], userRid);

        const msg = {
            service,
            task,
            file: fileMetadata,
            set_rid: inputSetRid,
            set_process: setProcessRid,
            process: { '@rid': setProcessRid },
            output_set: outputSetRid,
            total_files: totalFiles,
            current_file: fileCount,
            userId: userRid,
        };

        if(searchOutput) {
            msg.search_output = true;
            msg.search_source_set = inputSetRid;
        }

        if(service.tasks?.[task.id]?.source == 'source_file') {
            const source = await Graph.getFileSource(file['@rid'], msg.file['@type']);
            if(source) {
                const sourceMetadata = await Graph.getUserFileMetadata(source['@rid'], userRid);
                msg.file.source = sourceMetadata;
            }
        }

        await queue.createSetProcessNodesAndPublish(msg);
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

function getFilePageNumber(file) {
    if (!file) return null;
    const raw = Number(file.page_number);
    if (!Number.isFinite(raw)) return null;
    return raw;
}

function sortFilesByFilename(files) {
    return [...(files || [])].sort((a, b) => {
        const aPage = getFilePageNumber(a);
        const bPage = getFilePageNumber(b);
        if (aPage !== null && bPage !== null && aPage !== bPage) {
            return aPage - bPage;
        }
        if (aPage !== null && bPage === null) {
            return -1;
        }
        if (aPage === null && bPage !== null) {
            return 1;
        }

        const aName = getFileSortName(a);
        const bName = getFileSortName(b);
        return aName.localeCompare(bName);
    });
}

function shouldUseRootSourceGrouping({ service, task, isSearchOutput }) {
    const taskConfig = service?.tasks?.[task?.id] || {};

    if(task?.group_by_root_source === false || taskConfig?.group_by_root_source === false) {
        return { enabled: false, explicit: true };
    }

    if(task?.grouping_mode === 'group_by_root_source' || taskConfig?.grouping_mode === 'group_by_root_source') {
        return { enabled: true, explicit: true };
    }

    if(task?.group_by_root_source === true || taskConfig?.group_by_root_source === true) {
        return { enabled: true, explicit: true };
    }

    if(isSearchOutput) {
        return { enabled: false, explicit: false };
    }

    return { enabled: true, explicit: false };
}

async function resolveManyToOneDispatchGroups(service, task, files, isSearchOutput) {
    const orderedFiles = sortFilesByFilename(files);
    const inputFileRidSet = new Set(
        orderedFiles
            .map((file) => file?.['@rid'])
            .filter(Boolean)
            .map((rid) => Graph.sanitizeRID(rid))
    );
    const groupingDecision = shouldUseRootSourceGrouping({ service, task, isSearchOutput });

    if(!groupingDecision.enabled) {
        return [{ source_rid: null, label: null, type: null, path: null, files: orderedFiles }];
    }

    const resolvedGroups = await Graph.groupFilesByRootSource(orderedFiles, {
        boundary: 'pdf',
        excludeRootTypes: ['zip'],
    });

    if(!Array.isArray(resolvedGroups) || resolvedGroups.length === 0) {
        return [{ source_rid: null, label: null, type: null, path: null, files: orderedFiles }];
    }

    const groupsWithSourceInInputSet = resolvedGroups.filter((group) => {
        if(!group?.source_rid) return false;
        const cleanSourceRid = Graph.sanitizeRID(group.source_rid);
        return inputFileRidSet.has(cleanSourceRid);
    });

    if(groupsWithSourceInInputSet.length === 0) {
        // Only enable grouped outputs when grouping source files exist in the input set.
        return [{ source_rid: null, label: null, type: null, path: null, files: orderedFiles }];
    }

    const groupedFileRidSet = new Set();
    for(const group of groupsWithSourceInInputSet) {
        for(const file of group?.files || []) {
            if(file?.['@rid']) groupedFileRidSet.add(Graph.sanitizeRID(file['@rid']));
        }
    }

    const ungroupedFiles = orderedFiles.filter((file) => {
        if(!file?.['@rid']) return true;
        return !groupedFileRidSet.has(Graph.sanitizeRID(file['@rid']));
    });

    if(groupingDecision.explicit) {
        const normalizedGroups = groupsWithSourceInInputSet.map((group) => ({
            ...group,
            files: sortFilesByFilename(group.files),
        }));
        if(ungroupedFiles.length > 0) {
            normalizedGroups.push({ source_rid: null, label: null, type: null, path: null, files: ungroupedFiles });
        }
        return normalizedGroups;
    }

    // Auto mode: only enable grouping when traversal finds PDF roots.
    const hasPdfRoots = groupsWithSourceInInputSet.some((group) => String(group?.type || '').toLowerCase() === 'pdf');
    if(!hasPdfRoots) {
        return [{ source_rid: null, label: null, type: null, path: null, files: orderedFiles }];
    }

    const normalizedGroups = groupsWithSourceInInputSet.map((group) => ({
        ...group,
        files: sortFilesByFilename(group.files),
    }));
    if(ungroupedFiles.length > 0) {
        normalizedGroups.push({ source_rid: null, label: null, type: null, path: null, files: ungroupedFiles });
    }
    return normalizedGroups;
}


export default [

    // --- Consumer queue API ---

    {
        method: 'POST',
        path: '/api/queue/claim',
        handler: async (request) => {
            const { topic, adapter_id } = request.payload || {};
            if (!topic || !adapter_id) {
                throw Boom.badRequest('topic and adapter_id are required');
            }
            const job = queue.claim(topic, adapter_id);
            return { job }; // null if no work available
        }
    },

    {
        method: 'POST',
        path: '/api/queue/{job_id}/heartbeat',
        handler: async (request) => {
            const jobId = Number(request.params.job_id);
            const { adapter_id } = request.payload || {};
            if (!adapter_id) throw Boom.badRequest('adapter_id is required');
            const ok = queue.heartbeat(jobId, adapter_id);
            if (!ok) throw Boom.notFound('Job not found or not owned by this adapter');
            return { ok: true };
        }
    },

    {
        method: 'POST',
        path: '/api/queue/{job_id}/complete',
        handler: async (request) => {
            const jobId = Number(request.params.job_id);
            const { adapter_id } = request.payload || {};
            if (!adapter_id) throw Boom.badRequest('adapter_id is required');
            const ok = queue.complete(jobId, adapter_id);
            if (!ok) throw Boom.notFound('Job not found or not owned by this adapter');
            return { ok: true };
        }
    },

    {
        method: 'POST',
        path: '/api/queue/{job_id}/fail',
        handler: async (request) => {
            const jobId = Number(request.params.job_id);
            const { adapter_id, error } = request.payload || {};
            if (!adapter_id) throw Boom.badRequest('adapter_id is required');
            const ok = queue.fail(jobId, error || 'unknown error', adapter_id);
            if (!ok) throw Boom.notFound('Job not found or not owned by this adapter');
            return { ok: true };
        }
    },

    {
        method: 'GET',
        path: '/api/queue/jobs/active',
        handler: async () => {
            return queue.getActiveJobs();
        }
    },

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
                    queue.publish(line.params.topic, JSON.stringify(msg));
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
            const status = await queue.drainQueue(topic, process_rid);
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
                status: 'paused',
                paused_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
            });

            const queueStatus = await queue.pauseBatch(process_rid);

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_update',
                process: { '@rid': process_rid, status: 'paused' },
                batch: {
                    status: 'paused',
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

            const batchStatus = batch.status || batch.state;
            if(batchStatus !== 'paused') {
                throw Boom.conflict(`Batch is not paused (status: ${batchStatus || 'unknown'})`);
            }

            await queue.resumeBatch(process_rid);

            await Graph.updateBatchProcess(process_rid, {
                status: 'resuming',
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
            console.log('processedRids: ', processedRids);
            console.log('******************* pending files for resume *******************');
            const pendingFiles = setFiles.files.filter((file) => !processedRids.has(file['@rid']));

            const beforeDispatch = await Graph.getBatchProcess(process_rid);
            const beforeDispatchStatus = beforeDispatch?.status || beforeDispatch?.state;
            if(beforeDispatchStatus !== 'resuming' && beforeDispatchStatus !== 'running') {
                throw Boom.conflict(`Batch changed state before dispatch (status: ${beforeDispatchStatus || 'unknown'})`);
            }

            await dispatchSetFilesForBatch({
                service,
                task,
                files: pendingFiles,
                setProcessRid: process_rid,
                inputSetRid: batch.input_set,
                outputSetRid: batch.output_set,
                userRid: request.auth.credentials.user.rid,
                totalFiles: batch.total_files || setFiles.files.length,
                startIndex: Number(batch.processed_files || 0) + 1,
                searchOutput: batch.search_output === true,
            });

            const resumedBatch = await Graph.updateBatchProcess(process_rid, {
                status: 'running',
                updated_at: new Date().toISOString(),
            });

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_update',
                process: { '@rid': process_rid, status: 'running' },
                batch: {
                    status: 'running',
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
                status: 'cancelling',
                updated_at: new Date().toISOString(),
            });
            const queueStatus = await queue.cancelBatch(process_rid);
            const batch = await Graph.updateBatchProcess(process_rid, {
                status: 'cancelled',
                finished_at: new Date().toISOString(),
                updated_at: new Date().toISOString(),
                eta_sec: 0,
            });

            userManager.sendToUser(request.auth.credentials.user.rid, {
                command: 'process_finished',
                process: { '@rid': process_rid, status: 'cancelled' },
                batch: {
                    status: 'cancelled',
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
            const status = await queue.drainQueueByProcess(process_rid);
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
            const status = await queue.getQueueStatus(topic);
            return status;
        }
    },


    {
        method: 'GET', 
        path: '/api/queue/{topic}/flush',
        handler: async (request) => {
            const topic = request.params.topic;
            const status = await queue.flushQueue(topic);
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

                // For search-output tasks on a single file, create a search output Set upfront
                const isSearchOutput = Graph.isSearchOutputTask(service, request.payload);
                if(isSearchOutput && messages.length > 0) {
                    const msg = messages[0];
                    const file_rid = Graph.sanitizeRID(request.params.file_rid);
                    const project_rid = await Graph.getProjectRidForNode(file_rid);
                    const searchSetNode = await Graph.createProcessSetNode(msg.process['@rid'], {
                        input_set: file_rid,
                        search_output: true,
                        label: 'Search index',
                        project_rid
                    });
                    msg.output_set = searchSetNode['@rid'];
                    msg.search_output = true;
                    msg.set_node = searchSetNode;
                }

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
                    queue.publish(queue, JSON.stringify(msg));
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
                    if(service.tasks[task.id].description && !task.description)
                        task.description = service.tasks[task.id].description;
                    if(service.tasks[task.id].info && !task.info)
                        task.info = service.tasks[task.id].info;
                }
                var msg = {task: task}
                var task_name = task?.name || task?.id || topic;
               // var task_output = 'file';
                // LLM services have tasks defined in prompts
                if(service.external_tasks) {
                    msg.external = 'yes'
                    msg.task.params = task.system_params
                    task_name = task?.name || task?.id || topic
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
                var set_metadata = await Graph.getUserFileMetadata(set_rid, request.auth.credentials.user.rid);
                var set_files = await Graph.getSetFiles(set_rid, request.auth.credentials.user.rid, {limit: 10000});
                const behaviour = Graph.resolveTaskBehaviour(service, task)

                // in many-to-one outputs we do not create process nodes for each file 
                if(!service.external_tasks && behaviour === 'many-to-one') {
                    const isSearchOutput = Graph.isSearchOutputTask(service, task)
                    const dispatchGroups = await resolveManyToOneDispatchGroups(service, task, set_files.files, isSearchOutput);
                    var processNode = await Graph.createManyToOneProcessNode(task_name, service, task, set_metadata)
                    const outputSetNode = await Graph.createProcessSetNode(processNode['@rid'], {
                        input_set: set_rid,
                        label: `${task.name || task.id} output`,
                        project_rid: set_metadata.project_rid,
                        search_output: isSearchOutput,
                    })
                    await Graph.initBatchProcess(processNode['@rid'], {
                        topic: topic,
                        task_id: task.id,
                        input_set: set_rid,
                        output_set: outputSetNode?.['@rid'] || null,
                        total_files: set_files.files.length,
                        search_output: isSearchOutput,
                    });
                    // add node to UI
                    var wsdata = {command: 'add', type: 'process', input: set_rid, node:processNode, output: outputSetNode};
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);

                    if(set_files.files.length === 0) {
                        throw Boom.badRequest('Set has no files to process');
                    }

                    console.log('many-to-one batch dispatch');
                    await media.writeJSON(request.payload, 'params.json', path.join(path.dirname(processNode.path)));

                    const batchTotalFiles = set_files.files.length;
                    let batchIndex = 1;

                    for(const group of dispatchGroups) {
                        const groupFiles = Array.isArray(group?.files) ? group.files : [];
                        const groupSize = groupFiles.length;
                        let groupIndex = 1;

                        for(const file of groupFiles) {
                            const fileMetadata = await Graph.getUserFileMetadata(file['@rid'], request.auth.credentials.user.rid);

                            msg.process = processNode;
                            msg.project_rid = set_metadata.project_rid;
                            msg.set_rid = set_rid;
                            msg.input_set = set_rid;
                            msg.output_set = outputSetNode['@rid'];
                            msg.behaviour = behaviour;
                            msg.set_process = processNode['@rid'];
                            // Group counters are per combine run; batch counters track overall progress.
                            msg.total_files = groupSize;
                            msg.current_file = groupIndex;
                            msg.batch_total_files = batchTotalFiles;
                            msg.batch_current_file = batchIndex;
                            msg.userId = request.auth.credentials.user.rid;
                            msg.file = fileMetadata;

                            if(group?.source_rid) {
                                msg.root_source = {
                                    '@rid': group.source_rid,
                                    label: group.label || null,
                                    type: group.type || null,
                                    path: group.path || null,
                                };
                                msg.root_source_rid = group.source_rid;
                                msg.root_source_label = group.label || null;
                                msg.group_size = groupSize;
                            } else {
                                delete msg.root_source;
                                delete msg.root_source_rid;
                                delete msg.root_source_label;
                                delete msg.group_size;
                            }

                            if(isSearchOutput) {
                                msg.search_output = true;
                                msg.search_source_set = set_rid;
                            }

                            if(service.tasks[task.id]?.source == 'source_file') {
                                delete msg.source;
                                const source = await Graph.getFileSource(file['@rid']);
                                if(source) {
                                    msg.source = await Graph.getUserFileMetadata(source['@rid'], request.auth.credentials.user.rid);
                                }
                            }

                            queue.publish(topic + '_batch', JSON.stringify(msg));
                            groupIndex += 1;
                            batchIndex += 1;
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
                        inputSetRid: set_rid,
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
                queue.publish(topic + '_batch', JSON.stringify(msg));

                return source_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    }
];
