import Graph from '../graph.mjs';
import media from '../media.mjs';
//import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import Boom from '@hapi/boom';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import { DATA_DIR } from '../env.mjs';

export default [
    {
        method: 'POST',
        path: '/api/projects/{rid}/upload/{set?}',
        options: {
            payload: {
                maxBytes: 500 * 1024 * 1024,
                output: 'stream',
                parse: true,
                multipart: true,
                allow: 'multipart/form-data'
            }
        },
        handler: async (request, h) => {
            try {
                // Verify project exists and user has access
                const response = await Graph.getProjectMetadata(request.params.rid, request.auth.credentials.user.id);
                if (response.result.length === 0) {
                    throw Boom.notFound('Project not found');
                }

                const project_rid = response.result[0].project["@rid"];
                const file = request.payload.file;

                // Validate file exists in payload
                if (!file) {
                    throw Boom.badRequest('No file uploaded');
                }

                // Get original filename
                const originalFilename = file.hapi.filename;
                console.log('Uploading file:', originalFilename);

                // Get file type
                const file_type = await media.detectType(file);
                if (!file_type) {
                    throw Boom.badRequest('Could not determine file type');
                }

                // Create file node in graph
                const filegraph = await Graph.createOriginalFileNode(
                    project_rid,
                    file,
                    file_type,
                    request.params.set,
                    DATA_DIR,
                    originalFilename
                );

                // Upload file to storage
                var filepath = filegraph.path.split('/').slice(0, -1).join('/');
                await fse.ensureDir(path.join(filepath, 'process'));

                const filesave = fse.createWriteStream(filegraph.path);

                // Create a promise to handle the file upload completion
                const uploadPromise = new Promise((resolve, reject) => {
                    // Set up error handler before piping
                    filesave.on('error', (err) => {
                        console.error('File write error:', err);
                        reject(err);
                    });

                    file.pipe(filesave);
                    
                    filesave.on('finish', async () => {
                        console.log('file uploaded');
                        var base_metadata = {}
                        const stats = await fse.stat(filegraph.path);
                        base_metadata.size = Number((stats.size / (1024 * 1024)).toFixed(1));
                        filegraph.metadata = base_metadata
console.log('filetype', file_type);

                        // IMAGE
                        if (file_type === 'image') {

                            // Get image metadata
                            const image_metadata = await media.getImageSize(filegraph.path)
                            console.log('metadata', image_metadata);
                            filegraph.metadata = image_metadata

	                        // ************** EXIF FIX **************
	                        // if file has EXIF orientation, then we need to rotate it
                            if(image_metadata.rotate) {

                                var rotatedata = {
                                    topic: {id: 'md-imaginary'},
                                    service: {id: 'md-imaginary'},
                                    task: {id: 'rotate', params: {rotate: `${image_metadata.rotate}`, stripmeta: 'true'}},
                                    file: filegraph,
                                    userId: request.auth.credentials.user.rid,
                                    role: 'exif_rotate'
                            
                                }
                                nats.publish(rotatedata.topic.id, JSON.stringify(rotatedata));

                            // ************** EXIF FIX ENDS **************
                            } else {
                                // we save metadata for image (resolution, etc.)
                                try {
                                    await Graph.setNodeAttribute_old(filegraph['@rid'], {
                                        key: 'metadata',
                                        value: filegraph.metadata
                                    }, 'File');
                                } catch (error) {
                                    console.log('Error setting node attribute:', error);
                                }
    
                                const data = {
                                    topic: {id: 'md-thumbnailer'},
                                    service: {id: 'md-imaginary'},
                                    task: {id: 'thumbnail', params: { width: 800, type: 'jpeg' }},
                                    file: filegraph,
                                    userId: request.auth.credentials.user.rid
                                };
                                
                                nats.publish(data.topic.id, JSON.stringify(data));
                            }
                        } 

                        
                        // TEXT
                        if (['text', 'html', 'json', 'csv'].includes(file_type)) {
                            try {
                                const info = await media.getTextDescription(filegraph.path, file_type);
                                filegraph.info = info
                                await Graph.setNodeAttribute(filegraph['@rid'], {
                                    key: 'info',
                                    value: info
                                }, request.auth.credentials.user.rid);
                            } catch (error) {
                                console.log('Error getting text description:', error);
                            }
                        }


                        // PDF
                        if (file_type === 'pdf') {
                            const data = {
                                topic: {id: 'md-pdf-splitter_fs'},
                                service: {id: 'md-pdf-splitter_fs'},
                                task: {id: 'split', params: {}},
                                file: filegraph,
                                userId: request.auth.credentials.user.rid,
                                role: 'pdf-splitter'
                            };
                            nats.publish(data.topic.id, JSON.stringify(data));
                        }

                        // PDF
                        if (file_type === 'zip') {
                                // we save metadata for zip
                                try {
                                    await Graph.setNodeAttribute_old(filegraph['@rid'], {
                                        key: 'metadata',
                                        value: filegraph.metadata
                                    }, 'File');
                                } catch (error) {
                                    console.log('Error setting node attribute:', error);
                                }
                        }

                        // Add file to UI
                        if (request.auth.credentials.user.id) {
                            const wsdata = {
                                command: 'add',
                                type: file_type,
                                node: filegraph,
                                image: 'api/thumbnails',
                                set: request.params.set
                            };
                            userManager.sendToUser(request.auth.credentials.user.rid, wsdata);
                        }
                        resolve(filegraph);
                    });
                });

                // Wait for the upload to complete before returning
                return await uploadPromise;

            } catch (error) {
                console.error('File upload error:', error);
                if (error.isBoom) {
                    throw error;
                }
                throw Boom.badImplementation('Failed to process file upload');
            }
        }
    },
    {
        method: 'GET',
        path: '/api/documents/{rid}',
        handler: async (request, h) => {
            const clean_rid = Graph.sanitizeRID(request.params.rid);
            const n = await Graph.getNodeAttributes(clean_rid);
            const entities = await Graph.getLinkedEntities(clean_rid, request.auth.credentials.user.rid);
            const rois = await Graph.getROIs(clean_rid);

            if (n.result && n.result.length) {
                n.result[0].rois = rois;
                n.result[0].entities = entities;
                return n.result[0];
            } else {
                return h.response({}).code(404);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/thumbnails/{param*}',
        handler: async (request, h) => {
            const src = await media.getThumbnail(request.params.param);
            const response = h.response(src);
            response.type('image/jpeg');
            return response;
        }
    },
    {
        method: 'POST',
        path: '/api/files/{file_rid}/thumbnail',
        handler: async (request, h) => {
            try {
                const file_rid = request.params.file_rid
                const file = await Graph.getUserFileMetadata(
                    file_rid,
                    request.auth.credentials.user.rid
                );

                if (file.type === 'image') {
                    const data = {
                        file: file,
                        userId: request.auth.credentials.user.id,
                        target: file['@rid'],
                        task: 'thumbnail',
                        params: { width: 800, type: 'jpeg' },
                        id: 'md-thumbnailer'
                    };
                    nats.publish(data.id, JSON.stringify(data));

                // PDF thumbnail is made by poppler
                } else if (file.type === 'pdf') {
                    const data = {
                        file: file,
                        userId: request.auth.credentials.user.id,
                        target: file['@rid'],
                        task: 'pdf2images',
                        params: {
                            firstPageToConvert: '1',
                            lastPageToConvert: '1',
                            resolutionXYAxis: '80',
                            task: 'pdf2images'
                        },
                        role: 'thumbnail',
                        id: 'md-poppler'
                    };
                    nats.publish(data.id, JSON.stringify(data));
                }
                return file
            } catch (e) {
                return h.response().code(403);
            }
        }
    },
    {
        method: 'PUT',
        path: '/api/files/{file_rid}',
        handler: async (request, h) => {
            const file_rid = request.params.file_rid;
            const metadata = request.payload;
            const file = await Graph.getUserFileMetadata(file_rid, request.auth.credentials.user.rid);
            if (!file) {
                return h.response().code(404);
            }
            return file;
        }
    },
    {
        method: 'GET',
        path: '/api/files/{file_rid}',
        handler: async (request, h) => {
            try {
                const file_metadata = await Graph.getUserFileMetadata(
                    request.params.file_rid,
                    request.auth.credentials.user.rid
                );

                // we first check if file exist
                // if not, then we search for error.json
                // if error.json exists, then we return it
                // if not, then we return 404
                if (!fse.existsSync(file_metadata.path)) {
                    const error_json_path = path.join(path.dirname(file_metadata.path), 'error.json')
                    if (fse.existsSync(error_json_path)) {
                        const src = fse.createReadStream(error_json_path);
                        const response = h.response(src);
                        response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
                        response.type('application/json');
                        return response;
                    } else {
                        return h.response().code(404);
                    }
                }

                const src = fse.createReadStream(file_metadata.path);
                const response = h.response(src);

                if (file_metadata.type === 'pdf') {
                    response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
                    response.type('application/pdf');
                } else if (file_metadata.type === 'image') {
                    response.type('image/png');
                } else if (file_metadata.extension === 'csv') {
                    response.type('text/csv; charset=utf-8');
                } else if (file_metadata.type === 'text' || file_metadata.type === 'data') {
                    response.type('text/plain; charset=utf-8');
                } else if (file_metadata.type === 'error.json') {
                    response.type('application/json');
                } else {
                    response.header('Content-Disposition', `attachment; filename=${file_metadata.label}`);
                }

                return response;
            } catch (e) {
                return h.response().code(403);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/files/{file_rid}/source',
        handler: async (request, h) => {
            try {
                const source = await Graph.getFileSource(request.params.file_rid);
                if (!source) {
                    return h.response().code(404);
                }

                const file_metadata = await Graph.getUserFileMetadata(
                    source['@rid'],
                    request.auth.credentials.user.rid
                );

                const src = fse.createReadStream(path.join(DATA_DIR, file_metadata.path));
                const response = h.response(src);

                if (file_metadata.type === 'pdf') {
                    response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
                    response.type('application/pdf');
                } else if (file_metadata.type === 'image') {
                    response.type('image/png');
                } else if (file_metadata.type === 'text') {
                    response.type('text/plain; charset=utf-8');
                } else if (file_metadata.type === 'data') {
                    response.type('text/plain; charset=utf-8');
                } else {
                    response.header('Content-Disposition', `attachment; filename=${file_metadata.label}`);
                }

                return response;
            } catch (e) {
                return h.response().code(403);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/files/{file_rid}/pages/{page_number}',
        handler: async (request, h) => {
            try {
                const file_metadata = await Graph.getUserFileMetadata(
                    request.params.file_rid,
                    request.auth.credentials.user.rid
                );

                const pageFilename = path.join(
                    path.dirname(file_metadata.path),
                    'pages',
                    `page_${request.params.page_number}.pdf`
                );
                // Verify file exists before creating read stream
                try {
                    await fse.access(pageFilename);
                } catch (err) {
                    return h.response().code(404);
                }

                const src = fse.createReadStream(pageFilename);
                const response = h.response(src);

                // Only set PDF headers if original file was PDF
                if (file_metadata.type === 'pdf') {
                    const pageLabel = `page_${request.params.page_number}_${file_metadata.label}`;
                    response.header('Content-Disposition', `inline; filename=${pageLabel}`);
                    response.type('application/pdf');
                }

                return response;
            } catch (e) {
                console.error('Error accessing file:', e);
                return h.response().code(403);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files',
        handler: async (request, h) => {
            const n = await Graph.getSetFiles(
                Graph.sanitizeRID(request.params.rid), 
                request.auth.credentials.user.rid, 
                {thumbnails: true}
            );
            return h.response(n);
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files/zip',
        handler: async (request, h) => {
            try {
                // usually we want all files so set params to high number
                request.query.limit = '1000';
                // Get the set files with proper authentication
                const set_rid = Graph.sanitizeRID(request.params.rid);
                const n = await Graph.getSetFiles(set_rid, request.auth.credentials.user.rid, request.query);

                if (!n || !n.files || n.files.length === 0) {
                    return h.response('No files found in set').code(404);
                }

                const fileList = [];
                n.files.forEach(file => {
                    if (file.path) {
                        fileList.push(file);
                    }
                });

                if (fileList.length === 0) {
                    return h.response('No valid file paths found').code(404);
                }

                // Create and stream the zip file
                return await media.createZipAndStream(fileList, request, h, set_rid);

            } catch (err) {
                console.error('Error creating zip:', err);
                return h.response('Error creating zip file').code(500);
            }
        }
    }
]; 