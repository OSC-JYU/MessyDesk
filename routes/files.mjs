import Graph from '../graph.mjs';
import media from '../media.mjs';
//import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import Boom from '@hapi/boom';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';

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
                const response = await Graph.getProject_old(request.params.rid, request.auth.credentials.user.id);
                if (response.result.length === 0) {
                    throw Boom.notFound('Project not found');
                }

                const project_rid = response.result[0]["@rid"];
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
                // For text files, get additional info
                // if (file_type === 'text') {
                //     try {
                //         file.info = await media.getTextDescription(file.path);
                //     } catch (error) {
                //         console.log('Error getting text description:', error);
                //         // Continue without text description
                //         file.info = null;
                //     }
                // }

                // Create file node in graph
                const filegraph = await Graph.createOriginalFileNode(
                    project_rid,
                    file,
                    file_type,
                    request.params.set,
                    process.env.DATA_DIR || 'data',
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
                        
                        // Get file size and store it
                        const stats = await fse.stat(filegraph.path);
                        filegraph.metadata.size = Math.round(stats.size / 1024 / 1024 * 100) / 100    // rounded to MB with 2 decimal places
                        try {
                            await Graph.setNodeAttribute_old(filegraph['@rid'], {
                                key: 'metadata.size',
                                value: filegraph.metadata.size
                            }, 'File');
                        } catch (error) {
                            console.log('Error setting node attribute:', error);
                        }
                        
                        // Process text file description if needed
                        if (file_type === 'text') {
                            try {
                                const info = await media.getTextDescription(filegraph.path);
                                await Graph.setNodeAttribute(filegraph['@rid'], {
                                    key: 'info',
                                    value: info
                                }, request.auth.credentials.user.rid);
                            } catch (error) {
                                console.log('Error getting text description:', error);
                            }
                        }

                        // Update metadata if available
                        // if (file.info) {
                        //     await Graph.setNodeAttribute(filegraph['@rid'], {
                        //         key: 'info',
                        //         value: file.info
                        //     }, 'File');
                        // }

                        // send message to thumbnailer or indexer depending on file type
                        // TEXT
                        if (file_type === 'text') {
                            const index_msg = {
                                id: 'solr',
                                task: 'index',
                                file: filegraph,
                                userId: request.auth.credentials.user.rid,
                                target: filegraph['@rid']
                            };
                            nats.publish(index_msg.id, JSON.stringify(index_msg));

                        // IMAGE    
                        } else if (file_type === 'image') {
                            const data = {
                                file: filegraph,
                                userId: request.auth.credentials.user.rid,
                                target: filegraph['@rid'],
                                task: 'thumbnail',
                                params: { width: 800, type: 'jpeg' },
                                id: 'md-thumbnailer'
                            };
                            
                            nats.publish(data.id, JSON.stringify(data));

                        // PDF
                        } else if (file_type === 'pdf') {
                            const data = {
                                file: filegraph,
                                userId: request.auth.credentials.user.rid,
                                target: filegraph['@rid'],
                                task: 'split',
                                params: {},
                                role: 'pdf-splitter',
                                id: 'pdf-splitter'
                            };
                            nats.publish(data.id, JSON.stringify(data));
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

                const src = fse.createReadStream(file_metadata.path);
                const response = h.response(src);

                if (file_metadata.type === 'pdf') {
                    response.header('Content-Disposition', `inline; filename=${file_metadata.label}`);
                    response.type('application/pdf');
                } else if (file_metadata.type === 'image') {
                    response.type('image/png');
                } else if (file_metadata.type === 'text' || file_metadata.type === 'data') {
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
                request.query
            );
            return h.response(n);
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files/zip',
        handler: async (request, h) => {
            try {
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