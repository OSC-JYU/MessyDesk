
import path from 'path';
import fse from 'fs-extra';
import Graph from '../graph.mjs';
import media from '../media.mjs';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import services from '../services.mjs';
import Boom from '@hapi/boom';
import { DATA_DIR, API_URL } from '../env.mjs';

function parseMessagePayload(payloadMessage) {
    if (!payloadMessage) {
        return {};
    }

    if (payloadMessage.path) {
        return fse.readFile(payloadMessage.path).then((info) => JSON.parse(info));
    }

    if (typeof payloadMessage === 'string') {
        return Promise.resolve(JSON.parse(payloadMessage));
    }

    return Promise.resolve(payloadMessage);
}

function resolveTmpFilePath(payload, message) {
    console.log('Resolving tmp file path...');
    console.log('message:', message);
    const dataRoot = path.resolve(DATA_DIR, '..');
    const sourcePath = message?.file?.path;
    let tmpRoot = path.resolve(dataRoot, 'tmp');

    if (typeof sourcePath === 'string' && sourcePath) {
        const normalized = sourcePath.replace(/\\/g, '/');
        const parts = normalized.split('/').filter(Boolean);
        for (let i = 0; i < parts.length - 1; i += 1) {
            if (parts[i] === 'data' && parts[i + 1]) {
                tmpRoot = path.resolve(dataRoot, parts[i + 1], 'tmp');
                break;
            }
        }
    }

    const fromPayload = payload?.tmp_file
        || payload?.tmp_path
        || payload?.content_file
        || payload?.content_path
        || payload?.file_path
        || payload?.path;
    const fromMessage = message?.tmp_file
        || message?.tmp_path
        || message?.content_file
        || message?.content_path
        || message?.file_path;

    const candidateRaw = fromPayload || fromMessage;
    if (!candidateRaw) {
        throw Boom.badData('Missing tmp file reference');
    }

    const candidate = typeof candidateRaw === 'object' && candidateRaw?.path
        ? candidateRaw.path
        : candidateRaw;

    const filename = path.basename(String(candidate || ''));
    if (!filename || filename === '.' || filename === '..') {
        throw Boom.badData('Invalid tmp file name');
    }

    const resolvedPath = path.resolve(tmpRoot, filename);

    if (resolvedPath !== tmpRoot && !resolvedPath.startsWith(tmpRoot + path.sep)) {
        throw Boom.badData('Invalid tmp file path');
    }

    if (!fse.existsSync(resolvedPath)) {
        throw Boom.notFound('Tmp file not found');
    }

    return resolvedPath;
}

function shouldCreateSplitPdfThumbnail(message, fileNode) {
    if (fileNode?.type !== 'pdf') {
        return false;
    }

    const serviceId = message?.service?.id || message?.process?.service_id || '';
    const taskId = message?.task?.id || message?.process?.task || '';

    // Support both current and legacy splitter service ids.
    const splitterServices = new Set(['md-pdf-splitter_fs', 'md-pypdf_fs']);
    return splitterServices.has(serviceId) && taskId === 'split';
}

function isThumbnailRole(message) {
    const role = String(message?.role || '').toLowerCase();
    return role === 'thumbnail' || role === 'thumbnails';
}

function isThumbnailMessage(message) {
    if (isThumbnailRole(message)) return true;

    const topicId = String(message?.topic?.id || '').toLowerCase();
    const serviceId = String(message?.service?.id || '').toLowerCase();
    const queueId = String(message?.id || '').toLowerCase();
    const taskId = String(message?.task?.id || '').toLowerCase();

    if (topicId === 'md-thumbnailer') return true;
    if (serviceId === 'md-thumbnailer') return true;
    if (queueId === 'md-thumbnailer') return true;
    if (taskId === 'thumbnail') return true;

    return false;
}

function shouldNotifyThumbnailUpdate(message, filename) {
    const normalizedFilename = String(filename || '').toLowerCase();
    const isMainThumbnail = normalizedFilename === 'thumbnail.jpg';
    const isInternal = String(message?.role || '').toLowerCase() === 'internal_versioning'
        || String(message?.process?.kind || '').toLowerCase() === 'internal_versioning';
    const isBatch = Boolean(message?.output_set);
    const isLastBatchFile = isBatch && Number(message?.current_file) === Number(message?.total_files);

    // Always allow internal edit flow updates for immediate UI feedback.
    if (isInternal) return true;
    // For normal single-file flow, notify only on final thumbnail artifact.
    if (!isBatch && isMainThumbnail) return true;
    // For batch flow, notify only once at the end (set update event).
    if (isLastBatchFile) return true;

    return false;
}

function normalizeRid(value) {
    if (!value) return null;
    const raw = String(value).trim();
    if (!raw) return null;
    if (!/^#?\d+:\d+$/.test(raw)) return null;
    return raw.startsWith('#') ? raw : `#${raw}`;
}

function getReferenceSourceRid(message) {
    const explicitRefRid = normalizeRid(
        message?.ref_file_rid
        || message?.ref
        || message?.reference_rid
    );
    if (explicitRefRid) return explicitRefRid;
    if (message?.isReference === true) {
        return normalizeRid(message?.file?.['@rid']);
    }
    return null;
}

async function processFilesCore(request, infoFilepath, contentFilepath, message) {
    const isRotateTask = String(message?.task?.id || '').toLowerCase() === 'rotate';
    const isInternalRotate = message?.role === 'exif_rotate'
        || message?.role === 'internal_versioning'
        || message?.process?.kind === 'internal_versioning';

    // EXIF/internal rotate should only run for rotate task payloads.
    if(isRotateTask && isInternalRotate) {
        console.log('rotate message detected');
        //console.log(message);
        // exif_rotate replaces the original file with the rotated file
        const originalPath = path.join(path.dirname(message.file.path), 'original.' + message.file.extension);
        await fse.rename(message.file.path, originalPath);
        const metadata = await media.uploadFile(contentFilepath, message.file);
        if(metadata) {
            await Graph.setNodeAttribute_old(message.file['@rid'], {key: 'metadata', value: metadata}, 'File');
            //await Graph.setNodeAttribute_old(message.file['@rid'], {key: 'description', value: 'EXIF rotation applied'}, 'File');
        }
        const data = {
            topic: {id: 'md-thumbnailer'},
            service: {id: 'md-thumbnailer'},
            task: {id: 'thumbnail', params: { width: 800, type: 'jpeg' }},
            file: message.file,
            userId: message.userId,
            role: 'internal_versioning',
            process: {kind: 'internal_versioning'}
        };
        
        nats.publish(data.topic.id, JSON.stringify(data));

        var wsdata = {
            command: 'update',
            target: message.file['@rid'],
            node: { metadata: metadata }
        };
        userManager.sendToUser(message.userId, wsdata);

    // THUMBNAIL
    // role' is for PDF thumbnail via Poppler)
    } else if (isThumbnailMessage(message)) {
        const filepath = message.file.path;
        const base_path = path.dirname(filepath);
        const filename = message.thumb_name || 'preview.jpg';
        const cacheBuster = Date.now();
        const isInternalVersioning = String(message?.role || '').toLowerCase() === 'internal_versioning'
            || String(message?.process?.kind || '').toLowerCase() === 'internal_versioning';
        //console.log('THUMBNAIL MESSAGE: ', message);

        try {
            //console.log('saving thumbnail to', base_path, filename);
            let wsdata = {};
            await media.saveThumbnail(contentFilepath, base_path, filename);
            if (shouldNotifyThumbnailUpdate(message, filename)) {
                console.log('sending thumbnail WS', filename);
                wsdata = {
                    command: 'update',
                    target: message.file['@rid'],
                    node: {
                        image: API_URL + 'api/thumbnails/' + base_path,
                        thumb: API_URL + 'api/thumbnails/' + base_path,
                        thumbnail_version: cacheBuster,
                    }
                };
                // if we are batch processing and this is the last file, send the updated Set thumbnails to the user
                if(message.output_set && Number(message.current_file) === Number(message.total_files)) {
                    const set_thumbnails = await Graph.getSetThumbnailsForNode(message.output_set);
                    const setThumbnailsWithVersion = set_thumbnails.map((entry) => {
                        if(typeof entry !== 'string') return entry;
                        return entry.includes('?') ? `${entry}&v=${cacheBuster}` : `${entry}?v=${cacheBuster}`;
                    });
                    wsdata = {
                        command: 'update',
                        target: message.output_set,
                        node: {
                            paths: setThumbnailsWithVersion,
                            count: message.current_file,
                            thumbnail_version: cacheBuster,
                        }
                    }
                    userManager.sendToUser(message.userId, wsdata);
                // if we batch processing, don't send WS to user since this would create lot of traffic
                }else if(!message.output_set) {
                    userManager.sendToUser(message.userId, wsdata);

                    // Internal version/revert updates should also refresh parent Set node preview grid.
                    if(isInternalVersioning && String(filename).toLowerCase() === 'thumbnail.jpg') {
                        const parentSet = await Graph.getFileSet(message.file['@rid']);
                        if(parentSet && parentSet['@rid']) {
                            const setThumbnails = await Graph.getSetThumbnailsForNode(parentSet['@rid']);
                            const setThumbnailsWithVersion = setThumbnails.map((entry) => {
                                if(typeof entry !== 'string') return entry;
                                return entry.includes('?') ? `${entry}&v=${cacheBuster}` : `${entry}?v=${cacheBuster}`;
                            });
                            const setWsData = {
                                command: 'update',
                                target: parentSet['@rid'],
                                node: {
                                    paths: setThumbnailsWithVersion,
                                    thumbnail_version: cacheBuster,
                                }
                            };
                            userManager.sendToUser(message.userId, setWsData);
                        }
                    }
                }
            }
        } catch (e) {
            throw('Could not move file!' + e);
        }


    } else if (infoFilepath && contentFilepath) {

        if (message.output_set) {
            const setProcessRid = message.set_process || message.process?.['@rid'];
            if (setProcessRid) {
                const currentBatch = await Graph.getBatchProcess(setProcessRid);
                const currentBatchStatus = String(currentBatch?.status || currentBatch?.state || 'running').toLowerCase();
                if (['paused', 'cancelling', 'cancelled', 'done'].includes(currentBatchStatus)) {
                    console.log('Skipping cancelled/paused batch output materialization', {
                        setProcessRid,
                        status: currentBatchStatus,
                        file: message?.file?.label,
                    });
                    return;
                }
            }
        }

        console.log('creating file node', message.file.type)
        const referenceSourceRid = getReferenceSourceRid(message);
        const isReferenceOutput = Boolean(referenceSourceRid);
        let referenceSourceNode = null;
        if (isReferenceOutput) {
            referenceSourceNode = await Graph.getNodeByRid(referenceSourceRid);
            if (!referenceSourceNode) {
                throw Boom.badData(`Reference source file not found: ${referenceSourceRid}`);
            }
        }
        let info = '';
        // Reference outputs reuse source info and do not materialize new bitstreams.
        if (isReferenceOutput && typeof referenceSourceNode?.info === 'string') {
            info = referenceSourceNode.info;
        // for text nodes we create a description from the content of the file
        } else if (message.file.type == 'text' || message.file.type.includes('json') || message.file.type == 'csv') {
            info = await media.getTextDescription(contentFilepath, message.file.type);
        }
        //console.log(message)
        const process_rid = message.process['@rid'];

        // if we have output_rid and output_path set in message, then output node and path are already created
        let fileNode = null;
        if(message.output_rid && message.output_path) {
            console.log('SET: output node and path already created')
            fileNode = await Graph.getNodeByRid(message.output_rid)
        } else {
            if (isReferenceOutput) {
                fileNode = await Graph.createReferenceFileNode(process_rid, message, referenceSourceRid, '', info)
            } else {
                fileNode = await Graph.createProcessFileNode(process_rid, message, '', info)
            }
        }
        if (isReferenceOutput) {
            fileNode.metadata = referenceSourceNode?.metadata || null;
        } else {
            fileNode.metadata = await media.uploadFile(contentFilepath, fileNode, DATA_DIR);
        }
        //console.log('METADATA: ', fileNode.metadata)
        
        if(fileNode.metadata) {
            await Graph.setNodeAttribute_old(fileNode['@rid'], {key: 'metadata', value: fileNode.metadata}, 'File');
        }
        // Add "parent" file metadata to file node (like id or url of the original file)
        if(message.file.forward) {
            await Graph.setNodeAttribute_old(fileNode['@rid'], {key: 'forward', value: message.file.forward}, 'File');
        }
        // update processing time to Process node
        if(message.response) {
            const processType = (message.set_process || message.output_set) ? 'SetProcess' : 'Process';
            if(message.response.time) {
            await Graph.setNodeAttribute_old(message.process['@rid'], {key: 'time', value: message.response.time}, processType);
            }
            if(message.response.url) {
                await Graph.setNodeAttribute_old(message.process['@rid'], {key: 'url', value: message.response.url}, processType);
            }
        }


        // for image files we create normal thumbnails
        if (!isReferenceOutput && message.file.type == 'image') {
            const th = {
                topic: {id: 'md-thumbnailer'},
                service: {id: 'md-thumbnailer'},
                task: {id: 'thumbnail', params: {width: 800, type: 'jpeg'}},
                file: fileNode,
                userId: message.userId,
                total_files: message.total_files,
                current_file: message.current_file,
                output_set: message.output_set,
                
            };
            nats.publish(th.service.id, JSON.stringify(th));
        }

        // Only split-task PDFs get automatic poppler thumbnails.
        if (!isReferenceOutput && shouldCreateSplitPdfThumbnail(message, fileNode)) {
            console.log('Scheduling thumbnail creation for split PDF file', fileNode['@rid']);
            const thumbMsg = {
                service: { id: 'md-poppler' },
                task: {
                    id: 'thumbnail',
                    params: {
                        page: 1,
                        previewResolution: 150,
                        thumbnailResolution: 80,
                        task: 'thumbnail'
                    }
                },
                file: fileNode,
                process: message.process,
                output_set: message.output_set,
                userId: message.userId,
                role: 'thumbnail',
                total_files: message.total_files,
                current_file: message.current_file,
            };
            nats.publish('md-poppler', JSON.stringify(thumbMsg));
        }

        // update set file count or add file to visual graph
        if (message.userId) {
            let wsdata;
            // update set's file count if file is part of set
            if (message.output_set) {
                console.log('** updating set file count **', message.output_set)
                const count = await Graph.updateFileCount(message.output_set);
                const effectiveBatchTotal = message.batch_total_files || message.total_files;
                const setProcessRid = message.set_process || message.process['@rid'];
                const outputFileTotal = Number(message.file_total || 0);
                const outputFileIndex = Number(message.file_count || 0);
                const shouldAdvanceBatchCounter = !(outputFileTotal > 1) || outputFileIndex >= outputFileTotal;
                const currentBatch = await Graph.getBatchProcess(setProcessRid);
                const currentBatchStatus = currentBatch?.status || currentBatch?.state || 'running';
                if(['paused', 'cancelling', 'cancelled', 'done'].includes(currentBatchStatus)) {
                    wsdata = null;
                } else {
                let batch = currentBatch;
                if(shouldAdvanceBatchCounter) {
                    batch = await Graph.incrementBatchProcessed(
                        setProcessRid,
                        message?.response?.time,
                        effectiveBatchTotal
                    );
                }
                const batchProcessed = batch?.processed_files ?? message.current_file;
                const batchTotal = batch?.total_files ?? effectiveBatchTotal;
                const batchStatus = batch?.status || batch?.state;
                const isBatchFinished = batchStatus === 'done' || (batchTotal && batchProcessed >= batchTotal);
                const isGroupedManyToOne = message.output === 'many-to-one' || Number(message.batch_total_files || 0) > Number(message.total_files || 0);
                // check if current file is the last file -> we are done!
                if(isBatchFinished) {
                    
                    wsdata = {
                        command: 'process_finished',
                        process: { '@rid': setProcessRid, status: 'done'},
                        set: { '@rid': message.output_set, status: 'finished', count: count },
                        batch: batch ? {
                            status: batch.status || batch.state || 'done',
                            state: batch.status || batch.state || 'done',
                            processed_files: batch.processed_files || batchProcessed,
                            failed_files: batch.failed_files || 0,
                            total_files: batch.total_files || batchTotal,
                            avg_sec_per_file: batch.avg_sec_per_file || 0,
                            eta_sec: isGroupedManyToOne ? null : (batch.eta_sec ?? 0),
                        } : undefined,
                        //paths: set_thumbnails,
                        current_file: batchProcessed}
                        console.log('wsdata', wsdata)
                } else {
                    // Send update message only every 10th file
                    if(shouldAdvanceBatchCounter && batchProcessed % 10 === 0) {
                        wsdata = {
                            command: 'process_update',
                            process: { '@rid': setProcessRid, status: 'running'},
                            set: { '@rid': message.output_set, status: 'running', count: count },
                            batch: batch ? {
                                status: batch.status || batch.state || 'running',
                                state: batch.status || batch.state || 'running',
                                processed_files: batch.processed_files || batchProcessed,
                                failed_files: batch.failed_files || 0,
                                total_files: batch.total_files || batchTotal,
                                avg_sec_per_file: batch.avg_sec_per_file || 0,
                                eta_sec: isGroupedManyToOne ? null : (batch.eta_sec ?? null),
                            } : undefined,
                            current_file: batchProcessed,
                            total_files: batchTotal
                        };
                    } else {
                        wsdata = null; // Don't send message for non-10th files
                    }
                }
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
            // Only send WebSocket message if wsdata is not null
            if(wsdata) {
                userManager.sendToUser(message.userId, wsdata);
            }
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
        throw Boom.badData('File processing failed');
    }
}

export async function processFilesHandler(request, h) {
    console.log('save process file call...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};

    try {
        if (request.payload.message) {
            infoFilepath = request.payload.message.path;
            message = await parseMessagePayload(request.payload.message);
        }

        if (request.payload.content) {
            contentFilepath = request.payload.content.path;
        }

        await processFilesCore(request, infoFilepath, contentFilepath, message);
    } catch (e) {
        console.log(e);
        throw Boom.badData(e.message);
    }

    return {
        success: true,
        message: 'Files processed successfully'
    };
} 

export async function processFilesFromTmpHandler(request, h) {
    console.log('save process file call from tmp...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};

    try {
        if (request.payload.message) {
            if (request.payload.message.path) {
                infoFilepath = request.payload.message.path;
            }
            message = await parseMessagePayload(request.payload.message);
        }

        // No multipart content is expected for this endpoint. File is already in DATA_DIR/tmp.
        contentFilepath = resolveTmpFilePath(request.payload, message);

        if (!infoFilepath) {
            infoFilepath = contentFilepath;
        }

        await processFilesCore(request, infoFilepath, contentFilepath, message);
    } catch (e) {
        console.log(e);
        throw Boom.badData(e.message);
    }

    return {
        success: true,
        message: 'Files processed successfully'
    };
}

// HOW THIS SHOULD WORK:
// 1. Get the request and content files
// 2. check that 
export async function processCSVAppendHandler(request, h) {
    console.log('append process file call...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};


    
    try {
        if (request.payload.request && request.payload.content) {
            infoFilepath = request.payload.request.path;
            const info = await fse.readFile(infoFilepath);
            message = JSON.parse(info);
            contentFilepath = request.payload.content.path;
            let content = await fse.readFile(contentFilepath, 'utf8');
            console.log(content);
        }
    } catch (e) {
        console.log(e);
        throw Boom.badData(e.message);
    }

    return {
        success: true,
        message: 'Files appended successfully'
    };
}

export async function processMetadataHandler(request, h) {
    console.log('save process metadata call...');
    let infoFilepath = null;
    let contentFilepath = null;
    let message = {};

    try {
        if (request.payload.message && request.payload.content) {
            infoFilepath = request.payload.message.path;
            const info = await fse.readFile(infoFilepath);
            message = JSON.parse(info);
            contentFilepath = request.payload.content.path;
            let usage = await fse.readFile(contentFilepath);
            usage = JSON.parse(usage);
        
            // response files are saved but not visible in the graph (azure-ai, gemini, init tasks, etc.)
            if (message.file.type == 'response') {
                await media.uploadFile(contentFilepath, {path: path.join(message.process.path, message.file.label)});
                await Graph.writeUsage(usage, message);
                
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