
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
                        var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process};
                    } else {
                        var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process, image:API_URL + 'icons/wait.gif'};
                    }
                    // there is output Set node, then add it too to UI
                    if(msg.set_node) {
                        wsdata.set_node = msg.set_node;
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
                // LLM services have tasks defined in prompts
                if(service.external_tasks) {
                    msg.external = 'yes';
                    msg.info = request.payload.info;
                    msg.params = request.payload.system_params;
                    task_name = request.payload.name;
                } else {
                    task_name = service.tasks[request.payload.task].name;
                }

                var set_metadata = await Graph.getUserFileMetadata(set_rid, request.auth.credentials.user.rid);
                console.log('set_metadata: ', set_metadata);

                var set_files = await Graph.getSetFiles(set_rid, request.auth.credentials.user.rid, {limit:'500'});
                var nodes = await Graph.createSetProcessNode(task_name, service, request.payload, set_metadata, request.auth.credentials.user.rid);


                // add node to UI
                var wsdata = {command: 'add', type: 'process', target: set_rid, node:nodes.process, set_node:nodes.set, image:API_URL + 'icons/wait.gif'};
                userManager.sendToUser(request.auth.credentials.user.rid, wsdata);

                if(service.output == 'always file') {
                    msg.process = processNode;
                    msg.file = file_metadata;
                    msg.total_files = set_files.files.length;
                    msg.current_file = file_count;
                    msg.userId = request.auth.credentials.user.rid;
                    console.log(msg)
                    nats.publish(topic + '_batch', JSON.stringify(msg));
                    return service
                }

                // next we create process nodes for each file in set and put them in queue
                var file_count = 1;
                for(var file of set_files.files) {
                    var file_metadata = await Graph.getUserFileMetadata(file['@rid'], request.auth.credentials.user.rid);
                    console.log(file_metadata);
                    var processNode = await Graph.createProcessNode(task_name, service, request.payload, file_metadata, request.auth.credentials.user.rid, set_rid);
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
                    msg.output_set = nodes.set['@rid'];  // link file to output Set
                    nats.publish(topic + '_batch', JSON.stringify(msg));

                    file_count += 1;
                }

                return set_rid;

            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    }
];
