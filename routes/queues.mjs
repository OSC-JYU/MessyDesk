import { v4 as uuidv4 } from 'uuid';

import Graph from '../graph.mjs';
import services from '../services.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import media from '../media.mjs';
import path from 'path';

const API_URL = process.env.API_URL || '/';


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


                // add Process node to UI
                if(messages.length > 0) {
                    var msg = messages[0];
                    if(request.params.roi) {
                        var wsdata = {command: 'add', type: 'process', input: msg.file['@rid'], node:msg.process};
                    } else {
                        var wsdata = {command: 'add', type: 'process', input: msg.file['@rid'], node:msg.process};
                    }
                    // there is output Set node, then add it too to UI
                    if(msg.set_node) {
                        wsdata.ouput = msg.set_node;
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
                var msg = JSON.parse(JSON.stringify(request.payload));
                var task_name = '';
                var task_output = 'file';
                // LLM services have tasks defined in prompts
                if(service.external_tasks) {
                    msg.external = 'yes';
                    msg.info = request.payload.info;
                    msg.params = request.payload.system_params;
                    task_name = request.payload.name;
                } else {
                    task_name = service.tasks[request.payload.task].name;
                }
                if(service.tasks[request.payload.task].output) {
                    task_output = service.tasks[request.payload.task].output;
                }

                var set_metadata = await Graph.getUserFileMetadata(set_rid, request.auth.credentials.user.rid);
                console.log('set_metadata: ', set_metadata);

                var set_files = await Graph.getSetFiles(set_rid, request.auth.credentials.user.rid, {limit:'500'});

            

                // in many-to-one outputs we do not create process nodes for each file 
                if(service.tasks[request.payload.task].output == 'many-to-one') {
                    var processNode = await Graph.createManyToOneProcessNode(task_name, service, request.payload, set_metadata)
                    // add node to UI
                    var wsdata = {command: 'add', type: 'process', input: set_rid, node:processNode};
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);

                    var file_count = 1;
                    const output_uuid = uuidv4()
                    for(var file of set_files.files) {
                        var file_metadata = await Graph.getUserFileMetadata(file['@rid'], request.auth.credentials.user.rid);

                        // do we need info about "parent" file? (when processing osd.json for example)
                        if(service.tasks[request.payload.task]?.source == 'source_file') {
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
                        msg.output = service.tasks[request.payload.task].output
                        msg.file = file_metadata;
                        msg.target = file_metadata['@rid'];
                        msg.total_files = set_files.files.length;
                        msg.current_file = file_count;
                        msg.userId = request.auth.credentials.user.rid;
                        nats.publish(topic + '_batch', JSON.stringify(msg));

                        file_count += 1;
                    }


                // normal "set to set" output
                } else {
                    var nodes = await Graph.createSetAndProcessNodes(task_name, service, request.payload, set_metadata, request.auth.credentials.user.rid);
                    // add node to UI
                    var wsdata = {command: 'add', type: 'process', input: set_rid, node:nodes.process, output:nodes.set};
                    userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
                    // normally we create process nodes for each file in set and put them in queue
                    var file_count = 1;
                    for(var file of set_files.files) {
                        var file_metadata = await Graph.getUserFileMetadata(file['@rid'], request.auth.credentials.user.rid);
                        console.log(file_metadata);
                        var processNode = await Graph.createProcessNode(task_name, service, request.payload, file_metadata, request.auth.credentials.user.rid, set_rid, nodes.process['@rid']);
                        await media.createProcessDir(processNode.path);

                        // do we need info about "parent" file? (when processing osd.json for example)
                        if(service.tasks[request.payload.task]?.source == 'source_file') {
                            const source = await Graph.getFileSource(file['@rid']);
                            console.log('source: ', source);
                            if(source) {
                                const source_metadata = await Graph.getUserFileMetadata(source['@rid'], request.auth.credentials.user.rid);
                                msg.source = source_metadata;
                            }
                        }

                        await media.writeJSON(request.payload, 'params.json', path.join(path.dirname(processNode.path)));

                        msg.process = processNode;
                        msg.file = file_metadata;
                        msg.target = file_metadata['@rid'];
                        msg.total_files = set_files.files.length;
                        msg.current_file = file_count;
                        msg.userId = request.auth.credentials.user.rid;
                        if(task_output !== 'always file') {
                            msg.output_set = nodes.set['@rid'];  // link file to output Set
                        }
                        nats.publish(topic + '_batch', JSON.stringify(msg));

                        file_count += 1;
                    }

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
                var msg = JSON.parse(JSON.stringify(request.payload));
                var task_name = service.tasks[request.payload.task].name;
                console.log('task_name: ', task_name);

                var source_metadata = await Graph.getUserFileMetadata(source_rid, request.auth.credentials.user.rid);
                console.log('source_metadata: ', source_metadata);

                const process_attrs = { label: topic, path:'' }
                process_attrs.service = service.name
                if(request.payload.info) {
                    process_attrs.info = request.payload.info
                }

                var processNode = await Graph.create('Process', process_attrs)
                var process_rid = processNode['@rid']
                await Graph.connect(source_rid, 'PROCESSED_BY', process_rid)
                // create process directory
                var process_path = path.join(source_metadata.path, 'process', media.rid2path(process_rid))
                await media.createProcessDir(process_path)
                await Graph.setNodeAttribute(process_rid, {'key':'path', 'value': process_path}, request.auth.credentials.user.rid)
                await media.writeJSON(request.payload, 'params.json', path.join(path.dirname(process_path)));

                // create output Set
                var setNode = await Graph.create('Set', {path: process_path})
                 // and link it to SetProcess
                await Graph.connect(process_rid, 'PRODUCED', setNode['@rid'])

                // add node to UI
                var wsdata = {command: 'add', type: 'process', target: source_rid, node:processNode, set_node:setNode, image:API_URL + 'icons/wait.gif'};
                userManager.sendToUser(request.auth.credentials.user.rid, wsdata);


                msg.process = processNode;
                msg.file = source_metadata;
                msg.target = source_metadata['@rid'];
                //msg.total_files = source_files.files.length;
                msg.current_file = 1;
                msg.userId = request.auth.credentials.user.rid;
                msg.output_set = setNode['@rid'];  // link file to output Set
                msg.source = source_metadata;
                nats.publish(topic + '_batch', JSON.stringify(msg));

                return source_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    }
];
