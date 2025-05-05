
import Graph from '../graph.mjs';
import services from '../services.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';


export default [
    {
        method: 'POST',
        path: '/api/pipeline/files/{file_rid}/{roi?}',
        handler: async (request) => {
            const clean_rid = Graph.sanitizeRID(request.params.file_rid);
            var clean_roi = '';
            if(request.params.roi) clean_roi = Graph.sanitizeRID(request.params.roi);
            let messages = [];
            
            var requests = await Graph.createRequestsFromPipeline(request.payload, clean_rid, clean_roi);
            
            for(var request of requests) {
                var service = services.getServiceAdapterByName(request.params.topic);
                messages = await Graph.createQueueMessages(service, request.payload, request.params.file_rid, request.headers.mail);
                for(var msg of messages) {
                    userManager.sendToUser(request.headers.mail, {
                        command: 'add', 
                        type: 'process', 
                        target: msg.file['@rid'], 
                        node:msg.process, 
                        image:process.env.API_URL + 'icons/wait.gif'});
                    nats.publish(request.params.topic, JSON.stringify(msg));
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
                var messages = await Graph.createQueueMessages(service, request.payload, request.params.file_rid, request.headers.mail, request.params.roi);
                const queue = Graph.getQueueName(service, request.payload, topic);

                // add Process node to UI
                if(messages.length > 0) {
                    var msg = messages[0];
                    if(request.params.roi) {
                        var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process};
                    } else {
                        var wsdata = {command: 'add', type: 'process', target: msg.file['@rid'], node:msg.process, image:process.env.API_URL + 'icons/wait.gif'};
                    }
                    // there is output Set node, then add it too to UI
                    if(msg.set_node) {
                        wsdata.set_node = msg.set_node;
                    }
                    userManager.sendToUser(request.headers.mail, wsdata);
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
                }
                return set_rid;
            } catch(e) {
                console.log('Queue failed!', e);
                throw e;
            }
        }
    }
];
