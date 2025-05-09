import fs from 'fs';
import path from 'path';
import fse from 'fs-extra';
import Graph from '../graph.mjs';
import media from '../media.mjs';
import web from '../web.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';

const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = process.env.API_URL || '/';
const AUTH_HEADER = 'mail';

export async function processFilesHandler(request, h) {
    console.log('save process file call...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};

    try {
        if (request.payload.request) {
            infoFilepath = request.payload.request.path;
            const info = await fse.readFile(infoFilepath);
            message = JSON.parse(info);
            console.log(message);
        }

        if (request.payload.content) {
            contentFilepath = request.payload.content.path;
        }

        // check if this is thumbnail ('role' is for PDF thumbnail via Poppler)
        if (message.id === 'md-thumbnailer' || message.role === 'thumbnail') {
            const filepath = message.file.path;
            const base_path = path.dirname(filepath);
            const filename = message.thumb_name || 'preview.jpg';

            try {
                //console.log('saving thumbnail to', base_path, filename);
                await media.saveThumbnail(contentFilepath, base_path, filename);
                if (filename == 'thumbnail.jpg' || message.role === 'thumbnail') {
                    //console.log('sending thumbnail WS', filename);
                    const wsdata = {
                        command: 'update',
                        type: 'image', 
                        target: message.file['@rid']
                    };
                    // direct link to thumbnail
                    wsdata.image = API_URL + 'api/thumbnails/' + base_path;
                    userManager.sendToUser(message.userId, wsdata);
                }
            } catch (e) {
                throw('Could not move file!' + e);
            }

        } else if (infoFilepath && contentFilepath) {
            // if this is "info" task then we save metadata to file node
            if (message.task == 'info') {
                try {
                    const info = await fse.readFile(contentFilepath);
                    const info_json = JSON.parse(info);
                    if (message.file.type == 'image') {
                        // image info
                        await Graph.setNodeAttribute(message.file['@rid'], {
                            key: 'metadata',
                            value: {width: info_json.width, height: info_json.height}
                        }, 'File');
                    } else {
                        // nextcloud directory info
                        await Graph.setNodeAttribute(message.file['@rid'], {
                            key: 'metadata',
                            value: info_json
                        }, 'File');
                        const filepath = message.file.path;
                        const base_path = path.dirname(filepath);
                        await media.uploadFile(contentFilepath, {path: message.file.path + '/source.json'});
                        const wsdata = {
                            command: 'update',
                            type: message.file.type,
                            target: message.file['@rid'],
                            count: info_json.count,
                            description: info_json.size + ' MB'
                        };
                        userManager.sendToUser(message.userId, wsdata);
                    }
                } catch (e) {
                    console.log('file metadata failed!', e.message);
                }
            // if this is response file then we save it to the process node directory and not in the graph
            } else if (message.file.type == 'response') {
                const process_rid = message.process['@rid'];
                const process_dir = path.dirname(message.process.path);
                await media.uploadFile(contentFilepath, {path: process_dir + '/response.json'});
                await Graph.setNodeAttribute(process_rid, {key: 'response', value: message.file.path}, 'Process');
            // else save content to processFileNode
            } else {
                let info = '';
                // for text nodes we create a description from the content of the file
                if (message.file.type == 'text' || message.file.type == 'osd.json' || message.file.type == 'ner.json') {
                    info = await media.getTextDescription(contentFilepath, message.file.type);
                }

                const process_rid = message.process['@rid'];
                const fileNode = await Graph.createProcessFileNode(process_rid, message, '', info);

                await media.uploadFile(contentFilepath, fileNode, DATA_DIR);

                // for images and pdf files we create normal thumbnails
                if (message.file.type == 'image' || message.file.type == 'pdf') {
                    const th = {
                        id: 'md-thumbnailer',
                        task: 'thumbnail',
                        file: fileNode,
                        userId: message.userId,
                        target: fileNode['@rid'],
                        params: {width: 800, type: 'jpeg'}
                    };
                    nats.publish(th.id, JSON.stringify(th));

                    // image resolution info
                    if (message.file.type == 'image') {
                        const info = {
                            id: 'md-imaginary',
                            task: 'info',
                            file: fileNode,
                            userId: message.userId,
                            target: fileNode['@rid'],
                            params: {task: 'info'}
                        };
                        nats.publish(info.id, JSON.stringify(info));
                        console.log(`published info task\nservice: ${info.id}\ntarget: ${info.target}`);
                    }
                }

                // send to indexer queue if text
                if (message.file.type == 'text') {
                    const index_msg = {
                        id: 'solr',
                        task: 'index',
                        file: fileNode,
                        userId: message.userId,
                        target: fileNode['@rid']
                    };
                    console.log(`published info task\nservice: ${info.id}\ntarget: ${info.target}`);
                    nats.publish(index_msg.id, JSON.stringify(index_msg));
                }

                // create ROIs for ner.json and human.json
                if (message.file.type == 'ner.json' || message.file.type == 'human.json') {
                    console.log('ner file detected');
                    await Graph.createROIsFromJSON(process_rid, message, fileNode);
                }

                // update set file count or add file to visual graph
                if (message.userId) {
                    let wsdata;
                    // update set's file count if file is part of set
                    if (message.output_set) {
                        const count = await Graph.updateFileCount(message.output_set);
                        wsdata = {
                            command: 'update',
                            type: 'set',
                            target: message.output_set,
                            count: count
                        };
                    // otherwise add node to visual graph
                    } else {
                        wsdata = {
                            command: 'add',
                            type: message.file.type,
                            target: process_rid,
                            node: fileNode
                        };
                    }
                    userManager.sendToUser(message.userId, wsdata);
                }

                // finally check if there is pipeline in message
                if (message.pipeline && message.pipeline.length > 0) {
                    // if file_count and file_total are integers and they are equal, then call pipeline
                    if (Number.isInteger(message.file_count) && Number.isInteger(message.file_total) && message.file_total == message.file_count) {
                        console.log('\n\n\n\n--------------PIPELINE detected');
                        console.log(message.file_total, message.file_count);
                        console.log('pipeline target: ', fileNode['@rid']);
                        console.log(message.pipeline);

                        let messages = [];

                        const requests = await Graph.createRequestsFromPipeline(message, fileNode['@rid'].replace('#', ''));
                        
                        for (const request of requests) {
                            const service = services.getServiceAdapterByName(request.params.topic);
                            messages = await Graph.createQueueMessages(service, request.body, fileNode['@rid'].replace('#', ''), request.headers[AUTH_HEADER]);
                            for (const msg of messages) {
                                const wsdata = {
                                    command: 'add',
                                    type: 'process',
                                    target: msg.file['@rid'],
                                    node: msg.process,
                                    image: API_URL + 'icons/wait.gif'
                                };
                                userManager.sendToUser(request.auth.credentials.user.id, wsdata);
                                nats.publish(request.params.topic, JSON.stringify(msg));
                            }
                        }
                    }
                }
            }
        // something went wrong in file processing
        } else {
            console.log(infoFilepath, contentFilepath);
            console.log('PROCESS FAILED!');
            console.log(request.payload);
        }
    } catch (e) {
        console.log(e);
    }

    return 's';
} 