import { strict as assert } from 'assert';

import filesRoutes from '../src/routes/files.mjs';
import Graph from '../src/graph.mjs';

function getFileRouteHandler() {
    const route = filesRoutes.find((item) => item.method === 'GET' && item.path === '/api/files/{file_rid}');
    if (!route || typeof route.handler !== 'function') {
        throw new Error('GET /api/files/{file_rid} route handler not found');
    }
    return route.handler;
}

function createH() {
    return {
        response(payload) {
            return {
                payload,
                statusCode: 200,
                code(nextStatusCode) {
                    this.statusCode = nextStatusCode;
                    return this;
                },
                header() {
                    return this;
                },
                type() {
                    return this;
                },
            };
        },
    };
}

describe('Files Route GET /api/files/{file_rid} Guards', () => {
    it('returns 400 when RID does not point to a File node', async () => {
        const handler = getFileRouteHandler();

        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        Graph.getUserFileMetadata = async () => ({
            '@rid': '#1:1',
            '@type': 'Set',
            type: 'set',
            label: 'not-a-file',
            path: '/tmp',
        });

        try {
            const request = {
                params: { file_rid: '1:1' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request, createH());
            assert.equal(response.statusCode, 400);
            assert.equal(response.payload.error, 'RID does not point to a file node');
        } finally {
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
        }
    });

    it('returns 400 when file metadata path points to a directory', async () => {
        const handler = getFileRouteHandler();

        const originalGetUserFileMetadata = Graph.getUserFileMetadata;
        Graph.getUserFileMetadata = async () => ({
            '@rid': '#1:2',
            '@type': 'File',
            type: 'text',
            label: 'directory-path',
            path: '/tmp',
        });

        try {
            const request = {
                params: { file_rid: '1:2' },
                auth: { credentials: { user: { rid: '#49:0' } } },
            };

            const response = await handler(request, createH());
            assert.equal(response.statusCode, 400);
            assert.equal(response.payload.error, 'Requested RID path is not a file');
        } finally {
            Graph.getUserFileMetadata = originalGetUserFileMetadata;
        }
    });
});
