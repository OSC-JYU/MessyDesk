import Graph from '../graph.mjs';
import media from '../media.mjs';
//import fs from 'fs';
import fse from 'fs-extra';
import path from 'path';
import { randomUUID } from 'crypto';
import Boom from '@hapi/boom';
import nats from '../queue.mjs';
import userManager from '../userManager.mjs';
import { DATA_DIR } from '../env.mjs';

const SET_ZIP_JOB_TTL_MS = Number(process.env.SET_ZIP_JOB_TTL_MS || 30 * 60 * 1000);
const MAX_VERSION_TEXT_BYTES = Number(process.env.MAX_VERSION_TEXT_BYTES || 10 * 1024 * 1024);

function getTmpDir() {
    return path.resolve(DATA_DIR, 'tmp');
}

function createSetZipJobRecord(setRid, userRid) {
    const requestId = randomUUID();
    const shortId = requestId.slice(0, 8);
    const setId = String(setRid).replace('#', '').replace(':', '_');
    const zipOutputName = `files_${setId}_${shortId}.zip`;
    const tmpDir = getTmpDir();
    return {
        id: requestId,
        set_rid: setRid,
        user_rid: userRid,
        status: 'queued',
        requested_at: Date.now(),
        zip_output_name: zipOutputName,
        zip_path: path.resolve(tmpDir, zipOutputName),
    };
}

function getSetZipJobPath(jobId) {
    return path.resolve(getTmpDir(), `set_zip_job_${jobId}.json`);
}

async function saveSetZipJob(job) {
    await fse.outputJson(getSetZipJobPath(job.id), job);
}

async function loadSetZipJob(setRid, userRid, jobId) {
    if (!/^[a-f0-9-]{36}$/i.test(jobId)) {
        return null;
    }
    const jobPath = getSetZipJobPath(jobId);
    if (!(await fse.pathExists(jobPath))) {
        return null;
    }
    const job = await fse.readJson(jobPath);
    if (job.set_rid !== setRid || job.user_rid !== userRid) {
        return null;
    }
    return job;
}

async function cleanupSetZipJob(job) {
    await Promise.allSettled([
        fse.unlink(job.zip_path),
        fse.unlink(getSetZipJobPath(job.id)),
    ]);
}

async function queueSetZipJob(request, setRid) {
    request.query.limit = '10000';
    const filesResponse = await Graph.getSetFiles(setRid, request.auth.credentials.user.rid, request.query);

    if (!filesResponse || !filesResponse.files || filesResponse.files.length === 0) {
        throw Boom.notFound('No files found in set');
    }

    const fileList = filesResponse.files.filter((file) => file.path);
    if (fileList.length === 0) {
        throw Boom.notFound('No valid file paths found');
    }

    const job = createSetZipJobRecord(setRid, request.auth.credentials.user.rid);
    await saveSetZipJob(job);

    const dbName = path.basename(DATA_DIR);
    const payload = {
        service: { id: 'md-zip_fs' },
        task: { id: 'zip', params: { compression: 0 }, name: 'Zip Set' },
        file: { '@rid': setRid, '@type': 'Set', type: 'set', label: `Set ${setRid}` },
        set_rid: setRid,
        db_name: dbName,
        zip_output_name: job.zip_output_name,
        set_files: fileList.map((file) => ({
            '@rid': file['@rid'],
            path: file.path,
            label: file.label,
            original_filename: file.original_filename,
        })),
        userId: request.auth.credentials.user.rid,
    };

    await nats.publish('md-zip_fs', JSON.stringify(payload));

    return job;
}

function getBackupPath(filePath) {
    return `${filePath}.original`;
}

function resolveManagedFilePath(filePath) {
    const absoluteDataDir = path.resolve(DATA_DIR);
    const absoluteFilePath = path.resolve(filePath);
    if (!absoluteFilePath.startsWith(absoluteDataDir + path.sep) && absoluteFilePath !== absoluteDataDir) {
        throw Boom.forbidden('File path is outside managed data directory');
    }
    return absoluteFilePath;
}

async function saveUploadStreamToPath(fileStream, targetPath) {
    await fse.ensureDir(path.dirname(targetPath));
    await new Promise((resolve, reject) => {
        const writeStream = fse.createWriteStream(targetPath);
        writeStream.on('error', reject);
        fileStream.on('error', reject);
        writeStream.on('finish', resolve);
        fileStream.pipe(writeStream);
    });
}

function queueThumbnailRefresh(file, userId) {
    if (!file || !file.type) return;

    if (file.type === 'image') {
        const data = {
            file,
            userId,
            role: 'internal_versioning',
            process: {kind: 'internal_versioning'},
            target: file['@rid'],
            task: { id: 'thumbnail', params: { width: 800, type: 'jpeg' } },
            id: 'md-thumbnailer'
        };
        nats.publish(data.id, JSON.stringify(data));
    } else if (file.type === 'pdf') {
        const data = {
            file,
            userId,
            process: {kind: 'internal_versioning'},
            target: file['@rid'],
            task: {
                id: 'thumbnail',
                params: {
                    page: 1,
                    previewResolution: 150,
                    thumbnailResolution: 80
                }
            },
            role: 'thumbnail',
            id: 'md-poppler'
        };
        nats.publish(data.id, JSON.stringify(data));
    }
}

async function updateFileMetadata(file, userRid) {
    const stats = await fse.stat(file.path);
    const metadata = {
        ...(file.metadata || {}),
        size: Number((stats.size / (1024 * 1024)).toFixed(1)),
    };

    if (file.type === 'image') {
        const imageMetadata = await media.getImageSize(file.path);
        Object.assign(metadata, imageMetadata || {});
    }

    await Graph.setNodeAttribute(file['@rid'], {
        key: 'metadata',
        value: metadata,
    }, userRid);

    if (['text', 'html', 'json', 'csv'].includes(file.type)) {
        const info = await media.getTextDescription(file.path, file.type);
        await Graph.setNodeAttribute(file['@rid'], {
            key: 'info',
            value: info,
        }, userRid);
    }
}

function sendFileUpdate(userRid, fileRid, edited) {
    userManager.sendToUser(userRid, {
        command: 'update',
        target: fileRid,
        node: {
            edited,
        },
    });
}

export default [
    {
        method: 'POST',
        path: '/api/projects/{rid}/upload/{set?}',
        options: {
            payload: {
                maxBytes: 1000 * 1024 * 1024,
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
                await fse.ensureDir(filepath);

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
                            filegraph.metadata = {...filegraph.metadata, ...image_metadata}

	                        // ************** EXIF FIX **************
	                        // if file has EXIF orientation, then we need to rotate it
                            if(image_metadata.rotate) {

                                var rotatedata = {
                                    topic: {id: 'md-imaginary'},
                                    service: {id: 'md-imaginary'},
                                    task: {id: 'rotate', params: {rotate: `${image_metadata.rotate}`, stripmeta: 'true'}},
                                    file: filegraph,
                                    userId: request.auth.credentials.user.rid,
                                    role: 'internal_versioning',
                                    process: {kind: 'internal_versioning'}
                            
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

                        // Add file to UI
                        if (request.auth.credentials.user.id) {
                            filegraph._type = file_type
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
            const n = await Graph.getNodeAttributes(clean_rid, request.auth.credentials.user.rid);
            const entities = await Graph.getLinkedEntities(clean_rid, request.auth.credentials.user.rid);
            //const rois = await Graph.getROIs(clean_rid);

            if (n) {
                //n.rois = rois;
                n.entities = entities;
                return n;
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
            response.header('Cache-Control', 'no-store, no-cache, must-revalidate, proxy-revalidate');
            response.header('Pragma', 'no-cache');
            response.header('Expires', '0');
            response.header('Surrogate-Control', 'no-store');
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
                        userId: request.auth.credentials.user.rid,
                        target: file['@rid'],
                        task: { id: 'thumbnail', params: { width: 800, type: 'jpeg' } },
                        id: 'md-thumbnailer'
                    };
                    nats.publish(data.id, JSON.stringify(data));

                // PDF thumbnail is made by poppler
                } else if (file.type === 'pdf') {
                    const data = {
                        file: file,
                        userId: request.auth.credentials.user.rid,
                        target: file['@rid'],
                        task: {
                            id: 'thumbnail',
                            params: {
                                page: 1,
                                previewResolution: 150,
                                thumbnailResolution: 80
                            }
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
        method: 'POST',
        path: '/api/files/{file_rid}/version',
        options: {
            payload: {
                maxBytes: 1000 * 1024 * 1024,
                output: 'stream',
                parse: true,
                multipart: true,
                allow: ['application/json', 'multipart/form-data']
            }
        },
        handler: async (request, h) => {
            const fileRid = Graph.sanitizeRID(request.params.file_rid);
            const userRid = request.auth.credentials.user.rid;
            const userId = request.auth.credentials.user.rid;

            const file = await Graph.getUserFileMetadata(fileRid, userRid);
            if (!file) {
                throw Boom.notFound('File not found');
            }

            const managedPath = resolveManagedFilePath(file.path);
            if (!(await fse.pathExists(managedPath))) {
                throw Boom.notFound('File path not found');
            }

            const backupPath = getBackupPath(managedPath);
            const payload = request.payload || {};
            const upload = payload.file;
            const hasUpload = upload && typeof upload.pipe === 'function';
            const hasTextContent = typeof payload.content === 'string';

            if (!hasUpload && !hasTextContent) {
                throw Boom.badRequest('Missing edited file upload or content payload');
            }

            if (hasTextContent && Buffer.byteLength(payload.content, 'utf8') > MAX_VERSION_TEXT_BYTES) {
                throw Boom.badRequest('Text payload exceeds size limit');
            }

            if (await fse.pathExists(backupPath)) {
                await fse.remove(backupPath);
            }
            await fse.move(managedPath, backupPath, { overwrite: true });

            try {
                if (hasUpload) {
                    await saveUploadStreamToPath(upload, managedPath);
                } else {
                    if (!['text', 'html', 'json', 'csv'].includes(file.type)) {
                        throw Boom.badRequest('Content payload is only supported for text-like files');
                    }
                    await fse.writeFile(managedPath, payload.content, 'utf8');
                }
            } catch (error) {
                if (!(await fse.pathExists(managedPath)) && (await fse.pathExists(backupPath))) {
                    await fse.move(backupPath, managedPath, { overwrite: true });
                }
                throw error;
            }

            const edited = {
                task: hasUpload ? (payload.operation || 'upload-edit') : 'text-edit',
                time: new Date().toISOString(),
                user: userId,
            };

            await Graph.setNodeAttribute(fileRid, { key: 'edited', value: edited }, userRid);
            await updateFileMetadata(file, userRid);
            queueThumbnailRefresh(file, userId);
            sendFileUpdate(userRid, fileRid, edited);

            const updatedFile = await Graph.getUserFileMetadata(fileRid, userRid);
            updatedFile.edited = edited;
            return h.response(updatedFile).code(200);
        }
    },
    {
        method: 'POST',
        path: '/api/files/{file_rid}/revert',
        handler: async (request, h) => {
            const fileRid = Graph.sanitizeRID(request.params.file_rid);
            const userRid = request.auth.credentials.user.rid;
            const userId = request.auth.credentials.user.rid;

            const file = await Graph.getUserFileMetadata(fileRid, userRid);
            if (!file) {
                throw Boom.notFound('File not found');
            }

            const managedPath = resolveManagedFilePath(file.path);
            const backupPath = getBackupPath(managedPath);

            if (!(await fse.pathExists(backupPath))) {
                throw Boom.conflict('No original version exists to revert');
            }

            if (await fse.pathExists(managedPath)) {
                await fse.remove(managedPath);
            }
            await fse.move(backupPath, managedPath, { overwrite: true });

            await Graph.setNodeAttribute(fileRid, { key: 'edited', value: null }, userRid);
            await updateFileMetadata(file, userRid);
            queueThumbnailRefresh(file, userId);
            sendFileUpdate(userRid, fileRid, null);

            const updatedFile = await Graph.getUserFileMetadata(fileRid, userRid);
            return h.response(updatedFile).code(200);
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
                console.log(file_metadata)

                // we first check if file exist
                // if not, then we search for error.json
                // if error.json exists, then we return it
                // if not, then we return 404
                if (!fse.existsSync(file_metadata.path)) {
                    console.log('file does not exist')
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
                } else if (file_metadata.type.includes('.json')) {
                    response.type('application/json');
                } else {
                    // Make the filename URL safe using encodeURIComponent and fallback for non-ASCII characters
                    const safeLabel = encodeURIComponent(file_metadata.label).replace(/['()]/g, escape).replace(/\*/g, '%2A');
                    response.header('Content-Disposition', `attachment; filename="${safeLabel}"`);
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
        path: '/api/sets/{rid}/files',
        handler: async (request, h) => {
            const n = await Graph.getSetFiles(
                Graph.sanitizeRID(request.params.rid), 
                request.auth.credentials.user.rid, 
                {
                    thumbnails: true,
                    limit: request.query.limit,
                    skip: request.query.skip,
                    group_by_origin: request.query.group_by_origin,
                    group_boundary: request.query.group_boundary,
                    source_rid: request.query.source_rid ? Graph.sanitizeRID(request.query.source_rid) : null,
                }
            );
            return h.response(n);
        }
    },
    {
        method: 'POST',
        path: '/api/sets/{rid}/files/zip/jobs',
        handler: async (request, h) => {
            try {
                const setRid = Graph.sanitizeRID(request.params.rid);
                const job = await queueSetZipJob(request, setRid);
                return h.response({
                    job_id: job.id,
                    status: 'queued',
                    status_url: `/api/sets/${String(setRid).replace('#', '')}/files/zip/jobs/${job.id}`,
                    download_url: `/api/sets/${String(setRid).replace('#', '')}/files/zip/jobs/${job.id}/download`,
                }).code(202);
            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                console.error('Error creating set zip job:', err);
                throw Boom.internal('Error creating zip job');
            }
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files/zip/jobs/{job_id}',
        handler: async (request, h) => {
            try {
                const setRid = Graph.sanitizeRID(request.params.rid);
                const userRid = request.auth.credentials.user.rid;
                const job = await loadSetZipJob(setRid, userRid, request.params.job_id);

                if (!job) {
                    return h.response({ message: 'Zip job not found' }).code(404);
                }

                if (await fse.pathExists(job.zip_path)) {
                    return h.response({
                        job_id: job.id,
                        status: 'ready',
                        download_url: `/api/sets/${String(setRid).replace('#', '')}/files/zip/jobs/${job.id}/download`,
                    });
                }

                if (Date.now() - job.requested_at > SET_ZIP_JOB_TTL_MS) {
                    await cleanupSetZipJob(job);
                    return h.response({
                        job_id: job.id,
                        status: 'failed',
                        message: 'Zip generation timed out',
                    }).code(504);
                }

                return h.response({
                    job_id: job.id,
                    status: 'processing',
                });
            } catch (err) {
                console.error('Error checking set zip job:', err);
                return h.response({ message: 'Error checking zip job status' }).code(500);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files/zip/jobs/{job_id}/download',
        handler: async (request, h) => {
            try {
                const setRid = Graph.sanitizeRID(request.params.rid);
                const userRid = request.auth.credentials.user.rid;
                const job = await loadSetZipJob(setRid, userRid, request.params.job_id);

                if (!job) {
                    return h.response('Zip job not found').code(404);
                }

                if (!(await fse.pathExists(job.zip_path))) {
                    return h.response('Zip not ready').code(409);
                }

                const setId = String(setRid).replace('#', '').replace(':', '_');
                const filename = `files_${setId}.zip`;
                const response = h.file(job.zip_path, {
                    filename,
                    mode: 'attachment',
                    confine: false,
                });

                response.events.on('finish', async () => {
                    await cleanupSetZipJob(job);
                });

                return response;
            } catch (err) {
                console.error('Error downloading set zip job output:', err);
                return h.response('Error downloading zip file').code(500);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/sets/{rid}/files/zip',
        handler: async (request, h) => {
            try {
                const setRid = Graph.sanitizeRID(request.params.rid);
                const job = await queueSetZipJob(request, setRid);
                return h.response({
                    job_id: job.id,
                    status: 'queued',
                    message: 'Zip generation started. Poll status_url until ready.',
                    status_url: `/api/sets/${String(setRid).replace('#', '')}/files/zip/jobs/${job.id}`,
                    download_url: `/api/sets/${String(setRid).replace('#', '')}/files/zip/jobs/${job.id}/download`,
                }).code(202);

            } catch (err) {
                if (Boom.isBoom(err)) {
                    throw err;
                }
                console.error('Error creating zip:', err);
                return h.response('Error creating zip file').code(500);
            }
        }
    }
]; 