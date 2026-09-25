import { strict as assert } from 'assert';

import queueRoutes from '../src/routes/queues.mjs';
import Graph from '../src/graph.mjs';
import services from '../src/services.mjs';
import queue from '../src/queue.mjs';
import userManager from '../src/userManager.mjs';
import media from '../src/media.mjs';

function getSetQueueHandler() {
    const route = queueRoutes.find(
        (item) => item.method === 'POST' && item.path === '/api/queue/{topic}/sets/{set_rid}'
    );

    if (!route || typeof route.handler !== 'function') {
        throw new Error('POST /api/queue/{topic}/sets/{set_rid} route handler not found');
    }

    return route.handler;
}

describe('Queue many-to-one root source grouping', () => {
    it('orders many-to-one files by page_number before filename', async () => {
        const handler = getSetQueueHandler();
        const published = [];

        const originalGetService = services.getServiceAdapterByName;
        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        const originalGetSetFiles = Graph.getSetFiles;
        const originalResolveTaskBehaviour = Graph.resolveTaskBehaviour;
        const originalCreateManyToOneProcessNode = Graph.createManyToOneProcessNode;
        const originalCreateProcessSetNode = Graph.createProcessSetNode;
        const originalInitBatchProcess = Graph.initBatchProcess;
        const originalIsSearchOutputTask = Graph.isSearchOutputTask;
        const originalGroupFilesByRootSource = Graph.groupFilesByRootSource;
        const originalPublish = queue.publish;
        const originalWriteJSON = media.writeJSON;
        const originalSendToUser = userManager.sendToUser;

        services.getServiceAdapterByName = () => ({
            id: 'md-text-base_fs',
            name: 'Text Base',
            external_tasks: false,
            tasks: {
                join_raw: {
                    name: 'Join raw',
                    behaviour: 'many-to-one',
                },
            },
        });

        Graph.getUserFileMetadata = async (rid) => {
            const clean = Graph.sanitizeRID(rid);
            if (clean === '#15:1') {
                return { '@rid': '#15:1', '@type': 'Set', project_rid: '#1:1', path: '/tmp/set' };
            }
            return {
                '@rid': clean,
                '@type': 'File',
                project_rid: '#1:1',
                type: 'text',
                extension: 'txt',
                label: `${clean}.txt`,
                path: `/tmp/${clean.replace('#', '').replace(':', '_')}.txt`,
            };
        };

        Graph.getSetFiles = async () => ({
            files: [
                { '@rid': '#25:1', label: 'renamed-z.txt', type: 'text', page_number: 2 },
                { '@rid': '#25:2', label: 'renamed-a.txt', type: 'text', page_number: 1 },
                { '@rid': '#25:3', label: 'renamed-b.txt', type: 'text', page_number: 3 },
            ],
        });

        Graph.resolveTaskBehaviour = () => 'many-to-one';
        Graph.createManyToOneProcessNode = async () => ({ '@rid': '#35:1', path: '/tmp/process' });
        Graph.createProcessSetNode = async () => ({ '@rid': '#35:2' });
        Graph.initBatchProcess = async () => ({ '@rid': '#35:1' });
        Graph.isSearchOutputTask = () => false;
        Graph.groupFilesByRootSource = async (files) => [
            {
                source_rid: '#25:2',
                label: 'source.pdf',
                type: 'pdf',
                files,
            },
        ];

        queue.publish = (topic, payload) => {
            published.push({ topic, payload: JSON.parse(payload) });
        };

        media.writeJSON = async () => {};
        userManager.sendToUser = () => {};

        try {
            const request = {
                params: { topic: 'md-text-base_fs', set_rid: '15:1' },
                payload: { id: 'join_raw' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request);
            assert.equal(response, '#15:1');
            assert.equal(published.length, 3);
            assert.deepEqual(
                published.map((entry) => entry.payload.file['@rid']),
                ['#25:2', '#25:1', '#25:3']
            );
        } finally {
            services.getServiceAdapterByName = originalGetService;
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
            Graph.getSetFiles = originalGetSetFiles;
            Graph.resolveTaskBehaviour = originalResolveTaskBehaviour;
            Graph.createManyToOneProcessNode = originalCreateManyToOneProcessNode;
            Graph.createProcessSetNode = originalCreateProcessSetNode;
            Graph.initBatchProcess = originalInitBatchProcess;
            Graph.isSearchOutputTask = originalIsSearchOutputTask;
            Graph.groupFilesByRootSource = originalGroupFilesByRootSource;
            queue.publish = originalPublish;
            media.writeJSON = originalWriteJSON;
            userManager.sendToUser = originalSendToUser;
        }
    });

    it('dispatches grouped batches with ZIP exclusion options and per-group counters', async () => {
        const handler = getSetQueueHandler();
        const published = [];
        let groupingOptions = null;

        const originalGetService = services.getServiceAdapterByName;
        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        const originalGetSetFiles = Graph.getSetFiles;
        const originalResolveTaskBehaviour = Graph.resolveTaskBehaviour;
        const originalCreateManyToOneProcessNode = Graph.createManyToOneProcessNode;
        const originalCreateProcessSetNode = Graph.createProcessSetNode;
        const originalInitBatchProcess = Graph.initBatchProcess;
        const originalIsSearchOutputTask = Graph.isSearchOutputTask;
        const originalGroupFilesByRootSource = Graph.groupFilesByRootSource;
        const originalPublish = queue.publish;
        const originalWriteJSON = media.writeJSON;
        const originalSendToUser = userManager.sendToUser;

        services.getServiceAdapterByName = () => ({
            id: 'md-text-base_fs',
            name: 'Text Base',
            external_tasks: false,
            tasks: {
                join_text: {
                    name: 'Join text',
                    behaviour: 'many-to-one',
                },
            },
        });

        Graph.getUserFileMetadata = async (rid) => {
            const clean = Graph.sanitizeRID(rid);
            if (clean === '#11:1') {
                return { '@rid': '#11:1', '@type': 'Set', project_rid: '#1:1', path: '/tmp/set' };
            }
            return {
                '@rid': clean,
                '@type': 'File',
                project_rid: '#1:1',
                type: 'text',
                extension: 'txt',
                label: `${clean}.txt`,
                path: `/tmp/${clean.replace('#', '').replace(':', '_')}.txt`,
            };
        };

        Graph.getSetFiles = async () => ({
            files: [
                { '@rid': '#20:1', label: 'page_001.txt', type: 'text' },
                { '@rid': '#20:2', label: 'page_002.txt', type: 'text' },
                { '@rid': '#20:3', label: 'page_001_other.txt', type: 'text' },
            ],
        });

        Graph.resolveTaskBehaviour = () => 'many-to-one';
        Graph.createManyToOneProcessNode = async () => ({ '@rid': '#30:1', path: '/tmp/process' });
        Graph.createProcessSetNode = async () => ({ '@rid': '#30:2' });
        Graph.initBatchProcess = async () => ({ '@rid': '#30:1' });
        Graph.isSearchOutputTask = () => false;
        Graph.groupFilesByRootSource = async (files, options) => {
            groupingOptions = options;
            return [
                {
                    source_rid: '#20:1',
                    label: 'file1.pdf',
                    type: 'pdf',
                    path: '/tmp/file1.pdf',
                    files: [files[0], files[1]],
                },
                {
                    source_rid: '#20:3',
                    label: 'file2.pdf',
                    type: 'pdf',
                    path: '/tmp/file2.pdf',
                    files: [files[2]],
                },
            ];
        };

        queue.publish = (topic, payload) => {
            published.push({ topic, payload: JSON.parse(payload) });
        };

        media.writeJSON = async () => {};
        userManager.sendToUser = () => {};

        try {
            const request = {
                params: { topic: 'md-text-base_fs', set_rid: '11:1' },
                payload: { id: 'join_text' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request);
            assert.equal(response, '#11:1');
            assert.equal(published.length, 3);
            assert.deepEqual(groupingOptions, { boundary: 'pdf', excludeRootTypes: ['zip'] });

            const first = published[0].payload;
            const second = published[1].payload;
            const third = published[2].payload;

            assert.equal(first.total_files, 2);
            assert.equal(first.current_file, 1);
            assert.equal(first.batch_total_files, 3);
            assert.equal(first.batch_current_file, 1);
            assert.equal(first.root_source_rid, '#20:1');
            assert.equal(first.root_source_label, 'file1.pdf');
            assert.equal(first.group_size, 2);

            assert.equal(second.total_files, 2);
            assert.equal(second.current_file, 2);
            assert.equal(second.batch_total_files, 3);
            assert.equal(second.batch_current_file, 2);
            assert.equal(second.root_source_rid, '#20:1');

            assert.equal(third.total_files, 1);
            assert.equal(third.current_file, 1);
            assert.equal(third.batch_total_files, 3);
            assert.equal(third.batch_current_file, 3);
            assert.equal(third.root_source_rid, '#20:3');
            assert.equal(third.root_source_label, 'file2.pdf');
            assert.equal(third.group_size, 1);
        } finally {
            services.getServiceAdapterByName = originalGetService;
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
            Graph.getSetFiles = originalGetSetFiles;
            Graph.resolveTaskBehaviour = originalResolveTaskBehaviour;
            Graph.createManyToOneProcessNode = originalCreateManyToOneProcessNode;
            Graph.createProcessSetNode = originalCreateProcessSetNode;
            Graph.initBatchProcess = originalInitBatchProcess;
            Graph.isSearchOutputTask = originalIsSearchOutputTask;
            Graph.groupFilesByRootSource = originalGroupFilesByRootSource;
            queue.publish = originalPublish;
            media.writeJSON = originalWriteJSON;
            userManager.sendToUser = originalSendToUser;
        }
    });

    it('falls back to legacy single-group dispatch when auto grouping has no PDF roots', async () => {
        const handler = getSetQueueHandler();
        const published = [];

        const originalGetService = services.getServiceAdapterByName;
        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        const originalGetSetFiles = Graph.getSetFiles;
        const originalResolveTaskBehaviour = Graph.resolveTaskBehaviour;
        const originalCreateManyToOneProcessNode = Graph.createManyToOneProcessNode;
        const originalCreateProcessSetNode = Graph.createProcessSetNode;
        const originalInitBatchProcess = Graph.initBatchProcess;
        const originalIsSearchOutputTask = Graph.isSearchOutputTask;
        const originalGroupFilesByRootSource = Graph.groupFilesByRootSource;
        const originalPublish = queue.publish;
        const originalWriteJSON = media.writeJSON;
        const originalSendToUser = userManager.sendToUser;

        services.getServiceAdapterByName = () => ({
            id: 'md-text-base_fs',
            name: 'Text Base',
            external_tasks: false,
            tasks: {
                join_text: {
                    name: 'Join text',
                    behaviour: 'many-to-one',
                },
            },
        });

        Graph.getUserFileMetadata = async (rid) => {
            const clean = Graph.sanitizeRID(rid);
            if (clean === '#12:1') {
                return { '@rid': '#12:1', '@type': 'Set', project_rid: '#1:1', path: '/tmp/set' };
            }
            return {
                '@rid': clean,
                '@type': 'File',
                project_rid: '#1:1',
                type: 'text',
                extension: 'txt',
                label: `${clean}.txt`,
                path: `/tmp/${clean.replace('#', '').replace(':', '_')}.txt`,
            };
        };

        Graph.getSetFiles = async () => ({
            files: [
                { '@rid': '#21:1', label: 'a.txt', type: 'text' },
                { '@rid': '#21:2', label: 'b.txt', type: 'text' },
                { '@rid': '#21:3', label: 'c.txt', type: 'text' },
            ],
        });

        Graph.resolveTaskBehaviour = () => 'many-to-one';
        Graph.createManyToOneProcessNode = async () => ({ '@rid': '#31:1', path: '/tmp/process' });
        Graph.createProcessSetNode = async () => ({ '@rid': '#31:2' });
        Graph.initBatchProcess = async () => ({ '@rid': '#31:1' });
        Graph.isSearchOutputTask = () => false;
        Graph.groupFilesByRootSource = async (files) => [
            {
                source_rid: '#6:1',
                label: 'root-a.txt',
                type: 'text',
                files: [files[0], files[1]],
            },
            {
                source_rid: '#6:2',
                label: 'root-b.txt',
                type: 'text',
                files: [files[2]],
            },
        ];

        queue.publish = (topic, payload) => {
            published.push({ topic, payload: JSON.parse(payload) });
        };

        media.writeJSON = async () => {};
        userManager.sendToUser = () => {};

        try {
            const request = {
                params: { topic: 'md-text-base_fs', set_rid: '12:1' },
                payload: { id: 'join_text' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request);
            assert.equal(response, '#12:1');
            assert.equal(published.length, 3);

            for (let i = 0; i < published.length; i += 1) {
                const msg = published[i].payload;
                assert.equal(msg.total_files, 3);
                assert.equal(msg.current_file, i + 1);
                assert.equal(msg.batch_total_files, 3);
                assert.equal(msg.batch_current_file, i + 1);
                assert.equal(msg.root_source_rid, undefined);
            }
        } finally {
            services.getServiceAdapterByName = originalGetService;
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
            Graph.getSetFiles = originalGetSetFiles;
            Graph.resolveTaskBehaviour = originalResolveTaskBehaviour;
            Graph.createManyToOneProcessNode = originalCreateManyToOneProcessNode;
            Graph.createProcessSetNode = originalCreateProcessSetNode;
            Graph.initBatchProcess = originalInitBatchProcess;
            Graph.isSearchOutputTask = originalIsSearchOutputTask;
            Graph.groupFilesByRootSource = originalGroupFilesByRootSource;
            queue.publish = originalPublish;
            media.writeJSON = originalWriteJSON;
            userManager.sendToUser = originalSendToUser;
        }
    });

    it('falls back to legacy single-group dispatch when root source files are not in input set', async () => {
        const handler = getSetQueueHandler();
        const published = [];
        let createOutputSetCalls = 0;

        const originalGetService = services.getServiceAdapterByName;
        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        const originalGetSetFiles = Graph.getSetFiles;
        const originalResolveTaskBehaviour = Graph.resolveTaskBehaviour;
        const originalCreateManyToOneProcessNode = Graph.createManyToOneProcessNode;
        const originalCreateProcessSetNode = Graph.createProcessSetNode;
        const originalInitBatchProcess = Graph.initBatchProcess;
        const originalIsSearchOutputTask = Graph.isSearchOutputTask;
        const originalGroupFilesByRootSource = Graph.groupFilesByRootSource;
        const originalPublish = queue.publish;
        const originalWriteJSON = media.writeJSON;
        const originalSendToUser = userManager.sendToUser;

        services.getServiceAdapterByName = () => ({
            id: 'md-text-base_fs',
            name: 'Text Base',
            external_tasks: false,
            tasks: {
                join_text: {
                    name: 'Join text',
                    behaviour: 'many-to-one',
                },
            },
        });

        Graph.getUserFileMetadata = async (rid) => {
            const clean = Graph.sanitizeRID(rid);
            if (clean === '#13:1') {
                return { '@rid': '#13:1', '@type': 'Set', project_rid: '#1:1', path: '/tmp/set' };
            }
            return {
                '@rid': clean,
                '@type': 'File',
                project_rid: '#1:1',
                type: 'text',
                extension: 'txt',
                label: `${clean}.txt`,
                path: `/tmp/${clean.replace('#', '').replace(':', '_')}.txt`,
            };
        };

        Graph.getSetFiles = async () => ({
            files: [
                { '@rid': '#22:1', label: 'a.txt', type: 'text' },
                { '@rid': '#22:2', label: 'b.txt', type: 'text' },
                { '@rid': '#22:3', label: 'c.txt', type: 'text' },
            ],
        });

        Graph.resolveTaskBehaviour = () => 'many-to-one';
        Graph.createManyToOneProcessNode = async () => ({ '@rid': '#32:1', path: '/tmp/process' });
        Graph.createProcessSetNode = async () => {
            createOutputSetCalls += 1;
            return { '@rid': '#32:2' };
        };
        Graph.initBatchProcess = async () => ({ '@rid': '#32:1' });
        Graph.isSearchOutputTask = () => false;
        Graph.groupFilesByRootSource = async (files) => [
            {
                source_rid: '#99:1',
                label: 'file1.pdf',
                type: 'pdf',
                files: [files[0], files[1]],
            },
            {
                source_rid: '#99:2',
                label: 'file2.pdf',
                type: 'pdf',
                files: [files[2]],
            },
        ];

        queue.publish = (topic, payload) => {
            published.push({ topic, payload: JSON.parse(payload) });
        };

        media.writeJSON = async () => {};
        userManager.sendToUser = () => {};

        try {
            const request = {
                params: { topic: 'md-text-base_fs', set_rid: '13:1' },
                payload: { id: 'join_text' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request);
            assert.equal(response, '#13:1');
            assert.equal(published.length, 3);
            assert.equal(createOutputSetCalls, 1);

            for (let i = 0; i < published.length; i += 1) {
                const msg = published[i].payload;
                assert.equal(msg.total_files, 3);
                assert.equal(msg.current_file, i + 1);
                assert.equal(msg.batch_total_files, 3);
                assert.equal(msg.batch_current_file, i + 1);
                assert.equal(msg.output_set, '#32:2');
                assert.equal(msg.root_source_rid, undefined);
                assert.equal(msg.group_size, undefined);
            }
        } finally {
            services.getServiceAdapterByName = originalGetService;
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
            Graph.getSetFiles = originalGetSetFiles;
            Graph.resolveTaskBehaviour = originalResolveTaskBehaviour;
            Graph.createManyToOneProcessNode = originalCreateManyToOneProcessNode;
            Graph.createProcessSetNode = originalCreateProcessSetNode;
            Graph.initBatchProcess = originalInitBatchProcess;
            Graph.isSearchOutputTask = originalIsSearchOutputTask;
            Graph.groupFilesByRootSource = originalGroupFilesByRootSource;
            queue.publish = originalPublish;
            media.writeJSON = originalWriteJSON;
            userManager.sendToUser = originalSendToUser;
        }
    });
});
