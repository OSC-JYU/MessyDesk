import { strict as assert } from 'assert';

import nomadRoutes from '../src/routes/nomad.mjs';
import Graph from '../src/graph.mjs';
import userManager from '../src/userManager.mjs';
import media from '../src/media.mjs';

function getErrorRouteHandler() {
    const route = nomadRoutes.find((item) => item.method === 'POST' && item.path === '/api/nomad/process/files/error');
    if (!route || typeof route.handler !== 'function') {
        throw new Error('Nomad error route handler not found');
    }
    return route.handler;
}

describe('Nomad Error Route', () => {
    it('skips error node creation for thumbnail failures', async () => {
        const handler = getErrorRouteHandler();

        const originalSetNodeError = Graph.setNodeError;
        const originalCreateErrorNode = Graph.createErrorNode;
        const originalIncrementBatchFailed = Graph.incrementBatchFailed;
        const originalGetSetProcessNode = Graph.getSetProcessNode;
        const originalSendToUser = userManager.sendToUser;
        const originalWriteJSON = media.writeJSON;
        const originalCreateProcessDir = media.createProcessDir;

        let setNodeErrorCalls = 0;
        let createErrorNodeCalls = 0;
        let incrementBatchFailedCalls = 0;
        let getSetProcessNodeCalls = 0;
        let sendToUserCalls = 0;
        let writeJSONCalls = 0;
        let createProcessDirCalls = 0;

        Graph.setNodeError = async () => {
            setNodeErrorCalls += 1;
            return 1;
        };
        Graph.createErrorNode = async () => {
            createErrorNodeCalls += 1;
            return { path: '/tmp/fake/error.json' };
        };
        Graph.incrementBatchFailed = async () => {
            incrementBatchFailedCalls += 1;
        };
        Graph.getSetProcessNode = async () => {
            getSetProcessNodeCalls += 1;
            return { setprocess: { '@rid': '#100:1' } };
        };
        userManager.sendToUser = async () => {
            sendToUserCalls += 1;
        };
        media.writeJSON = async () => {
            writeJSONCalls += 1;
        };
        media.createProcessDir = async () => {
            createProcessDirCalls += 1;
        };

        try {
            const request = {
                payload: {
                    error: { message: 'thumbnail generation failed', code: 'THUMBNAIL_FAIL' },
                    message: {
                        role: 'thumbnail',
                        service: { id: 'md-poppler' },
                        task: { id: 'pdf2images' },
                        topic: { id: 'md-poppler' },
                        file: { '@rid': '#10:1', label: 'page_001.pdf' },
                        process: { '@rid': '#20:1' },
                        output_set: '#30:1',
                        userId: '#40:1',
                    },
                },
            };

            const response = await handler(request, {});
            assert.deepEqual(response, []);

            assert.equal(createErrorNodeCalls, 0, 'thumbnail errors must not create error nodes');
            assert.equal(setNodeErrorCalls, 0, 'thumbnail errors must not mark process as error');
            assert.equal(incrementBatchFailedCalls, 0, 'thumbnail errors must not increment batch failed counters');
            assert.equal(getSetProcessNodeCalls, 0, 'thumbnail errors must not query set process node for error update');
            assert.equal(sendToUserCalls, 0, 'thumbnail errors must not send error update messages');
            assert.equal(writeJSONCalls, 0, 'thumbnail errors must not write error.json files');
            assert.equal(createProcessDirCalls, 0, 'thumbnail errors must not create error directories');
        } finally {
            Graph.setNodeError = originalSetNodeError;
            Graph.createErrorNode = originalCreateErrorNode;
            Graph.incrementBatchFailed = originalIncrementBatchFailed;
            Graph.getSetProcessNode = originalGetSetProcessNode;
            userManager.sendToUser = originalSendToUser;
            media.writeJSON = originalWriteJSON;
            media.createProcessDir = originalCreateProcessDir;
        }
    });

    it('skips error node creation for internal versioning messages without process rid', async () => {
        const handler = getErrorRouteHandler();

        const originalSetNodeError = Graph.setNodeError;
        const originalCreateErrorNode = Graph.createErrorNode;
        const originalIncrementBatchFailed = Graph.incrementBatchFailed;
        const originalGetSetProcessNode = Graph.getSetProcessNode;
        const originalSendToUser = userManager.sendToUser;
        const originalWriteJSON = media.writeJSON;
        const originalCreateProcessDir = media.createProcessDir;

        let setNodeErrorCalls = 0;
        let createErrorNodeCalls = 0;
        let incrementBatchFailedCalls = 0;
        let getSetProcessNodeCalls = 0;
        let sendToUserCalls = 0;
        let writeJSONCalls = 0;
        let createProcessDirCalls = 0;

        Graph.setNodeError = async () => {
            setNodeErrorCalls += 1;
            return 1;
        };
        Graph.createErrorNode = async () => {
            createErrorNodeCalls += 1;
            return { path: '/tmp/fake/error.json' };
        };
        Graph.incrementBatchFailed = async () => {
            incrementBatchFailedCalls += 1;
        };
        Graph.getSetProcessNode = async () => {
            getSetProcessNodeCalls += 1;
            return { setprocess: { '@rid': '#100:1' } };
        };
        userManager.sendToUser = async () => {
            sendToUserCalls += 1;
        };
        media.writeJSON = async () => {
            writeJSONCalls += 1;
        };
        media.createProcessDir = async () => {
            createProcessDirCalls += 1;
        };

        try {
            const request = {
                payload: {
                    error: { message: 'rotate failed', code: 'ROTATE_FAIL' },
                    message: {
                        role: 'internal_versioning',
                        service: { id: 'md-imaginary' },
                        task: { id: 'rotate' },
                        file: { '@rid': '#10:1', label: 'scan.png' },
                        process: { kind: 'internal_versioning' },
                        userId: '#40:1',
                    },
                },
            };

            const response = await handler(request, {});
            assert.deepEqual(response, []);

            assert.equal(createErrorNodeCalls, 0, 'internal versioning errors must not create error nodes');
            assert.equal(setNodeErrorCalls, 0, 'internal versioning errors must not mark process as error');
            assert.equal(incrementBatchFailedCalls, 0, 'internal versioning errors must not increment batch failed counters');
            assert.equal(getSetProcessNodeCalls, 0, 'internal versioning errors must not query set process node');
            assert.equal(sendToUserCalls, 0, 'internal versioning errors must not send error update messages');
            assert.equal(writeJSONCalls, 0, 'internal versioning errors must not write error.json files');
            assert.equal(createProcessDirCalls, 0, 'internal versioning errors must not create error directories');
        } finally {
            Graph.setNodeError = originalSetNodeError;
            Graph.createErrorNode = originalCreateErrorNode;
            Graph.incrementBatchFailed = originalIncrementBatchFailed;
            Graph.getSetProcessNode = originalGetSetProcessNode;
            userManager.sendToUser = originalSendToUser;
            media.writeJSON = originalWriteJSON;
            media.createProcessDir = originalCreateProcessDir;
        }
    });
});
