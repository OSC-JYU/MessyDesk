import { strict as assert } from 'assert';

import filesRoutes from '../src/routes/files.mjs';
import media from '../src/media.mjs';

describe('Files Route GET /api/thumbnails', () => {
    const handler = filesRoutes.find((r) => r.method === 'GET' && r.path === '/api/thumbnails/{param*}').handler;
    const h = {
        response(payload) {
            return { payload, statusCode: 200, code(c) { this.statusCode = c; return this; }, header() { return this; }, type() { return this; } };
        },
    };

    it('answers 404 when the thumbnail has not been made yet', async () => {
        assert.equal(await media.getThumbnail('data/messydesk/no/such/file'), null);
        const response = await handler({ params: { param: 'data/messydesk/no/such/file' } }, h);
        assert.equal(response.statusCode, 404);
    });
});
