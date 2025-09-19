
import path from 'path';
import fse from 'fs-extra';
import Graph from '../graph.mjs';
import media from '../media.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import services from '../services.mjs';

const DATA_DIR = process.env.DATA_DIR || 'data';
const API_URL = process.env.API_URL || '/';

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
        
        // EXIF-ROTATE
        if(message?.role === 'exif_rotate') {
            console.log('rotate message detected');
            console.log(message);
            // exif_rotate replaces the original file with the rotated file
            const originalPath = path.join(path.dirname(message.file.path), 'original.' + message.file.extension);
            await fse.rename(message.file.path, originalPath);
            const metadata = await media.uploadFile(contentFilepath, message.file);
            if(metadata) {
                await Graph.setNodeAttribute_old(message.file['@rid'], {key: 'metadata', value: metadata}, 'File');
                //await Graph.setNodeAttribute_old(message.file['@rid'], {key: 'description', value: 'EXIF rotation applied'}, 'File');
            }
            const data = {
                file: message.file,
                userId: message.userId,
                target: message.file['@rid'],
                task: 'thumbnail',
                params: { width: 800, type: 'jpeg' },
                id: 'md-thumbnailer'
            };
            
            nats.publish(data.id, JSON.stringify(data));

            var wsdata = {
                command: 'update',
                target: message.file['@rid'],
                node: { metadata: metadata }
            };
            userManager.sendToUser(message.userId, wsdata);

        // THUMBNAIL
        // role' is for PDF thumbnail via Poppler)
        } else if (message?.id === 'md-thumbnailer' || message?.role === 'thumbnail') {
            const filepath = message.file.path;
            const base_path = path.dirname(filepath);
            const filename = message.thumb_name || 'preview.jpg';

            try {
                //console.log('saving thumbnail to', base_path, filename);
                let wsdata = {};
                await media.saveThumbnail(contentFilepath, base_path, filename);
                if (filename == 'thumbnail.jpg' || message.role === 'thumbnail') {
                    //console.log('sending thumbnail WS', filename);
                    wsdata = {
                        command: 'update',
                        target: message.file['@rid'],
                        node: {image: API_URL + 'api/thumbnails/' + base_path}
                    };
                    // if we are batch processing and this is the last file, send the updated Set thumbnails to the user
                    if(message.output_set && message.current_file == message.total_files) {
                        const set_thumbnails = await Graph.getSetThumbnailsForNode(message.output_set);
                        wsdata = {
                            command: 'update',
                            target: message.output_set,
                            node: { paths: set_thumbnails, count: message.current_file }
                        }
                        userManager.sendToUser(message.userId, wsdata);
                    // if we batch processing, don't send WS to user since this would create lot of traffic
                    }else if(!message.output_set) {
                        userManager.sendToUser(message.userId, wsdata);
                    }
                }
            } catch (e) {
                throw('Could not move file!' + e);
            }

 
        } else if (infoFilepath && contentFilepath) {

            console.log('creating file node', message.file.type)
            let info = '';
            // for text nodes we create a description from the content of the file
            if (message.file.type == 'text' || message.file.type == 'osd.json' || message.file.type == 'ner.json' || message.file.type == 'ocr.json') {
                info = await media.getTextDescription(contentFilepath, message.file.type);
            }

            const process_rid = message.process['@rid'];
            const fileNode = await Graph.createProcessFileNode(process_rid, message, '', info);

            fileNode.metadata = await media.uploadFile(contentFilepath, fileNode, DATA_DIR);
            console.log('METADATA: ', fileNode.metadata)
            
            if(fileNode.metadata) {
                await Graph.setNodeAttribute_old(fileNode['@rid'], {key: 'metadata', value: fileNode.metadata}, 'File');
            }


            // for image files we create normal thumbnails
            if (message.file.type == 'image') {
                const th = {
                    id: 'md-thumbnailer',
                    task: 'thumbnail',
                    file: fileNode,
                    userId: message.userId,
                    target: fileNode['@rid'],
                    total_files: message.total_files,
                    current_file: message.current_file,
                    output_set: message.output_set,
                    params: {width: 800, type: 'jpeg'}
                };
                nats.publish(th.id, JSON.stringify(th));
            }

            // update set file count or add file to visual graph
            if (message.userId) {
                let wsdata;
                // update set's file count if file is part of set
                if (message.output_set) {
                    console.log('updating set file count', message.output_set)
                    const count = await Graph.updateFileCount(message.output_set);
                    if(message.current_file == message.total_files) {
                        
                        wsdata = {
                            command: 'process_finished',
                            process: { '@rid': message.process.set_process, status: 'finished', info: 'Finished' },
                            set: { '@rid': message.output_set, status: 'finished', count: message.current_file  },
                            //paths: set_thumbnails,
                            current_file: message.current_file}
                            console.log('wsdata', wsdata)
                    } else {
                        wsdata = {
                            command: 'process_update',
                            node: { '@rid': message.process.set_process, status: 'running', info: 'Running...' },
                            set: { '@rid': message.output_set, status: 'running', count: message.current_file },
                            current_file: message.current_file,
                            total_files: message.total_files
                        };
                    }
                } else {
                    // single file processing
                    wsdata = {
                        command: 'add',
                        type: message.file.type,  // node type
                        input: process_rid,
                        node: fileNode,
                        process: { '@rid': process_rid, status: 'finished' } // process is finished after file is added
                    };
                }
                userManager.sendToUser(message.userId, wsdata);
            }

            // finally check if there is pipeline in message
            if (message.pipeline && message.pipeline.length > 0) {
                // if file_count and file_total are integers and they are equal, then call pipeline
                if (Number.isInteger(message.file_count) && Number.isInteger(message.file_total) && message.file_total == message.file_count) {
                    let messages = [];
                    const pipelineLines = await Graph.createRequestsFromPipeline(message, fileNode['@rid'].replace('#', ''));
                    for (const line of pipelineLines) {
                        const service = services.getServiceAdapterByName(line.params.topic);
                        messages = await Graph.createQueueMessages(service, line.payload, fileNode['@rid'].replace('#', ''), request.auth.credentials.user.rid);
                        for (const msg of messages) {
                            const wsdata = {
                                command: 'add',
                                type: 'process',
                                target: msg.file['@rid'],
                                node: msg.process,
                                image: API_URL + 'icons/wait.gif'
                            };
                            userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
                            nats.publish(line.params.topic, JSON.stringify(msg));
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

    return {
        success: true,
        message: 'Files processed successfully'
    };
} 

export async function processMetadataHandler(request, h) {
    console.log('save process metadata call...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};

    try {
        if (request.payload.request && request.payload.content) {
            infoFilepath = request.payload.request.path;
            const info = await fse.readFile(infoFilepath);
            message = JSON.parse(info);
            contentFilepath = request.payload.content.path;
            let usage = await fse.readFile(contentFilepath);
            usage = JSON.parse(usage);
        
            // response files are saved but not visible in the graph (azure-ai, gemini, init tasks, etc.)
            if (message.file.type == 'response') {
                const process_rid = message.process['@rid'];
                console.log('saving response file to', path.join(message.process.path, message.file.label))
                await media.uploadFile(contentFilepath, {path: path.join(message.process.path, message.file.label)});
                await Graph.writeUsage(usage, message.id, process_rid, message.userId);
                
            }
        } else {
            console.log('no request or content found');
        }


    } catch (e) {
        console.log(e);
    }

    return {
        success: true,
        message: 'Files processed successfully'
    };
} 