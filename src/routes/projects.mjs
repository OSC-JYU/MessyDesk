import Graph from '../graph.mjs';
import media from '../media.mjs';
import queue from '../queue.mjs';
import services from '../services.mjs';
import solr from '../solr.mjs';
import { DATA_DIR, DISK_QUOTA_GB } from '../env.mjs';

import Boom from '@hapi/boom';

async function dispatchSetFilesForReindex({service, task, files, setProcessRid, inputSetRid, outputSetRid, userRid, totalFiles, searchOutput = false}) {
    let fileCount = 1;
    for (const file of files) {
        const fileMetadata = await Graph.getUserFileMetadata(file['@rid'], userRid);
        if (!fileMetadata) {
            fileCount += 1;
            continue;
        }

        const msg = {
            service,
            task,
            file: fileMetadata,
            set_rid: inputSetRid,
            set_process: setProcessRid,
            process: { '@rid': setProcessRid },
            output_set: outputSetRid,
            total_files: totalFiles,
            current_file: fileCount,
            userId: userRid,
        };

        if(searchOutput) {
            msg.search_output = true;
            msg.search_source_set = inputSetRid;
        }

        if (service.tasks?.[task.id]?.source == 'source_file') {
            const source = await Graph.getFileSource(file['@rid'], msg.file['@type']);
            if (source) {
                const sourceMetadata = await Graph.getUserFileMetadata(source['@rid'], userRid);
                if (sourceMetadata) msg.file.source = sourceMetadata;
            }
        }

        await queue.createSetProcessNodesAndPublish(msg);
        fileCount += 1;
    }

    return fileCount - 1;
}

export default [
    {
        method: 'POST',
        path: '/api/projects',
        handler: async (request) => {
            if (!request.payload.label) {
                throw new Error('label required');
            }
            const project = await Graph.createProject(request.payload, request.auth.credentials.user.rid);
            await media.createProjectDir(project, DATA_DIR);
            return project;
        }
    },
    {
        method: 'GET',
        path: '/api/projects',
        handler: async (request) => {
            return await Graph.getProjects(request.auth.credentials.user.rid, DATA_DIR);
        }
    },
    {
        method: 'POST',
        path: '/api/projects/update-size',
        handler: async (request) => {
            try {
                return await Graph.updateProjectSizes(
                    request.auth.credentials.user.rid,
                    DATA_DIR
                );
            } catch (error) {
                throw Boom.badRequest(error.message);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/projects/storage-summary',
        handler: async (request) => {
            const projects = await Graph.getProjects(request.auth.credentials.user.rid, DATA_DIR);
            let totalMb = 0;
            for (const p of projects) {
                const mb = Number(p.size_mb ?? p.sizeMB ?? p.sizeMb ?? p.total_size_mb ?? p.total_mb ?? p.size ?? 0);
                if (Number.isFinite(mb)) totalMb += mb;
            }
            return {
                used_mb: Math.round(totalMb * 100) / 100,
                quota_gb: DISK_QUOTA_GB,
                quota_mb: DISK_QUOTA_GB * 1024,
                used_percent: Math.min(100, Math.round((totalMb / (DISK_QUOTA_GB * 1024)) * 10000) / 100),
            };
        }
    },
    {
        method: 'GET',
        path: '/api/projects/{rid}',
        handler: async (request) => {
            return await Graph.getProject(
                Graph.sanitizeRID(request.params.rid),
                request.auth.credentials.user.rid
            );
        }
    },
    {
        method: 'PUT',
        path: '/api/projects/{rid}',
        handler: async (request) => {
            try {
                return await Graph.setProjectAttribute(
                    Graph.sanitizeRID(request.params.rid),
                    request.payload,
                    request.auth.credentials.user.rid
                );
            } catch (error) {
                console.log(error)
                throw Boom.badRequest(error.message);
            }
        }
    },
    {
        method: 'DELETE',
        path: '/api/projects/{rid}',
        handler: async (request) => {
            return await Graph.deleteProject(
                Graph.sanitizeRID(request.params.rid),
                request.auth.credentials.user.rid
            );
        }
    },
    {
        method: 'GET',
        path: '/api/projects/{rid}/files',
        handler: async (request) => {
            const result = await Graph.getProjectFiles(
                Graph.sanitizeRID(request.params.rid),
                request.auth.credentials.user.rid
            );
            return result.result;
        }
    },
    {
        method: 'POST',
        path: '/api/projects/{rid}/sets',
        handler: async (request) => {
            const result = await Graph.createSet(
                Graph.sanitizeRID(request.params.rid),
                request.payload,
                request.auth.credentials.user.rid
            );
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/projects/{rid}/sources',
        handler: async (request) => {
            const result = await Graph.createSource(
                Graph.sanitizeRID(request.params.rid),
                request.payload,
                request.auth.credentials.user.rid
            );
            return result;
        }
    },
    {
        method: 'POST',
        path: '/api/projects/{rid}/reindex-search',
        handler: async (request) => {
            const projectRid = Graph.sanitizeRID(request.params.rid);
            const userRid = request.auth.credentials.user.rid;
            const ownerOk = await Graph.isProjectOwner(projectRid, userRid);
            if (!ownerOk) {
                throw Boom.forbidden('Project not found or access denied');
            }

            const service = services.getServiceAdapterByName('md-solr');
            if (!service?.tasks?.index) {
                throw Boom.badRequest('md-solr index task is not available');
            }

            await solr.dropProjectIndex(userRid, projectRid);

            const sources = await Graph.getProjectSolrReindexSources(projectRid, userRid);
            let requeuedSets = 0;
            let requeuedFiles = 0;
            const warnings = [];

            for (const source of sources) {
                try {
                    const setRid = Graph.sanitizeRID(source.input_set);
                    const setMetadata = await Graph.getUserFileMetadata(setRid, userRid);
                    if (!setMetadata) {
                        warnings.push({ set_rid: setRid, reason: 'set metadata not found' });
                        continue;
                    }

                    const setFiles = await Graph.getSetFiles(setRid, userRid, { limit: 10000 });
                    const files = setFiles?.files || [];
                    if (files.length === 0) {
                        warnings.push({ set_rid: setRid, reason: 'set has no files' });
                        continue;
                    }

                    const task = { id: 'index', name: service.tasks.index.name || 'Search index' };
                    const isSearchOutput = Graph.isSearchOutputTask(service, task);

                    const processNode = await Graph.createManyToOneProcessNode(task.name, service, task, setMetadata);
                    const outputSetNode = await Graph.createProcessSetNode(processNode['@rid'], {
                        input_set: setRid,
                        label: `${task.name || task.id} output`,
                        project_rid: setMetadata.project_rid,
                        search_output: isSearchOutput,
                    });

                    await Graph.initBatchProcess(processNode['@rid'], {
                        topic: 'md-solr',
                        task_id: 'index',
                        input_set: setRid,
                        output_set: outputSetNode ? outputSetNode['@rid'] : null,
                        task_payload_json: JSON.stringify(task),
                        total_files: files.length,
                        search_output: isSearchOutput,
                    });

                    const dispatched = await dispatchSetFilesForReindex({
                        service,
                        task,
                        files,
                        setProcessRid: processNode['@rid'],
                        inputSetRid: setRid,
                        outputSetRid: outputSetNode ? outputSetNode['@rid'] : null,
                        userRid,
                        totalFiles: files.length,
                        searchOutput: isSearchOutput,
                    });

                    requeuedSets += 1;
                    requeuedFiles += dispatched;
                } catch (error) {
                    warnings.push({ set_rid: source.input_set, reason: error.message || 'requeue failed' });
                }
            }

            return {
                project_rid: projectRid,
                deleted: true,
                source_sets_found: sources.length,
                requeued_sets: requeuedSets,
                requeued_files: requeuedFiles,
                warnings,
            };
        }
    }
]; 

