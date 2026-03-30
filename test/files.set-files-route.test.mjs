import { strict as assert } from 'assert';

import filesRoutes from '../src/routes/files.mjs';
import Graph from '../src/graph.mjs';

function getSetFilesRouteHandler() {
    const route = filesRoutes.find((item) => item.method === 'GET' && item.path === '/api/sets/{rid}/files');
    if (!route || typeof route.handler !== 'function') {
        throw new Error('Set files route handler not found');
    }
    return route.handler;
}

describe('Files Route /api/sets/{rid}/files', () => {
    it('forwards grouped-boundary query params to Graph.getSetFiles', async () => {
        const handler = getSetFilesRouteHandler();

        const originalGetSetFiles = Graph.getSetFiles;
        const originalSanitizeRID = Graph.sanitizeRID;

        let capturedArgs = null;

        Graph.sanitizeRID = (rid) => {
            if (!String(rid).startsWith('#')) return `#${rid}`;
            return String(rid);
        };

        Graph.getSetFiles = async (...args) => {
            capturedArgs = args;
            return { grouped: true, mode: 'groups', groups: [], files: [], file_count: 0, group_count: 0 };
        };

        try {
            const request = {
                params: { rid: '12:34' },
                query: {
                    limit: '20',
                    skip: '10',
                    group_by_origin: 'true',
                    group_boundary: 'pdf',
                    source_rid: '1:2',
                },
                auth: {
                    credentials: {
                        user: { rid: '#9:9' },
                    },
                },
            };

            const h = {
                response(payload) {
                    return payload;
                },
            };

            const response = await handler(request, h);
            assert.equal(response.grouped, true);
            assert.ok(capturedArgs, 'Graph.getSetFiles should be called');

            const [setRid, userRid, params] = capturedArgs;

            assert.equal(setRid, '#12:34');
            assert.equal(userRid, '#9:9');

            assert.deepEqual(params, {
                thumbnails: true,
                limit: '20',
                skip: '10',
                group_by_origin: 'true',
                group_boundary: 'pdf',
                source_rid: '#1:2',
            });
        } finally {
            Graph.getSetFiles = originalGetSetFiles;
            Graph.sanitizeRID = originalSanitizeRID;
        }
    });
});
