import Graph from '../graph.mjs';
import media from '../media.mjs';
import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import nats from '../queue.mjs';
import { send2UI } from '../index.mjs';

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
                const response = await Graph.getProject_old(request.params.rid, request.headers.mail);
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
                if (file_type === 'text') {
                    try {
                        file.info = await media.getTextDescription(file.path);
                    } catch (error) {
                        console.log('Error getting text description:', error);
                        // Continue without text description
                        file.info = null;
                    }
                }

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

                const filesave = fs.createWriteStream(filegraph.path);

                filesave.on('error', (err) => console.error(err));

                file.pipe(filesave);

                filesave.on('end', (err) => {
                    // Update metadata if available
                    if (file_info) {
                        Graph.setNodeAttribute(filegraph['@rid'], {
                            key: 'metadata',
                            value: file_info
                        });
                    }

                    // Handle different file types
                    if (file_type === 'text') {
                        const index_msg = {
                            id: 'solr',
                            task: 'index',
                            file: filegraph,
                            userId: request.auth.credentials.user.id,
                            target: filegraph['@rid']
                        };
                        nats.publish(index_msg.id, JSON.stringify(index_msg));
                    } else if (file_type === 'image') {
                        const data = {
                            file: filegraph,
                            userId: request.headers[AUTH_HEADER],
                            target: filegraph['@rid'],
                            task: 'thumbnail',
                            params: { width: 800, type: 'jpeg' },
                            id: 'md-thumbnailer'
                        };
                        nats.publish('md-thumbnailer', JSON.stringify(data));
                    } else if (file_type === 'pdf') {
                        const data = {
                            file: filegraph,
                            userId: request.headers[AUTH_HEADER],
                            target: filegraph['@rid'],
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
                        nats.publish('md-poppler', JSON.stringify(data));
                    }

                    // Notify UI if user is authenticated
                    if (request.headers[AUTH_HEADER]) {
                        const wsdata = {
                            command: 'add',
                            type: file_type,
                            node: filegraph,
                            set: request.params.set
                        };
                        send2UI(request.headers[AUTH_HEADER], wsdata);
                    }
                });

                return filegraph;

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
            console.log(request.auth.credentials.user);
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
        method: 'GET',
        path: '/api/files/{file_rid}',
        handler: async (request, h) => {
            try {
                const file_metadata = await Graph.getUserFileMetadata(
                    Graph.sanitizeRID(request.params.file_rid),
                    request.headers.mail
                );

                const src = fs.createReadStream(file_metadata.path);
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
    }
]; 