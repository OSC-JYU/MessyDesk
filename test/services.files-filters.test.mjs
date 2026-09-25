import { strict as assert } from 'assert';

import serviceRoutes from '../src/routes/services.mjs';
import Graph from '../src/graph.mjs';
import services from '../src/services.mjs';
import filters from '../src/filters.mjs';

function getServicesForFileRouteHandler() {
    const route = serviceRoutes.find(
        (item) => item.method === 'GET' && item.path === '/api/services/files/{rid}'
    );

    if (!route || typeof route.handler !== 'function') {
        throw new Error('GET /api/services/files/{rid} route handler not found');
    }

    return route.handler;
}

describe('Services file route filter matching', () => {
    const handler = getServicesForFileRouteHandler();

    let originalGetUserFileMetadata;
    let originalGetPrompts;
    let originalLoadFilters;
    let originalGetServicesForNode;

    beforeEach(() => {
        originalGetUserFileMetadata = Graph.getUserFileMetadata;
        originalGetPrompts = Graph.getPrompts;
        originalLoadFilters = filters.loadFilters;
        originalGetServicesForNode = services.getServicesForNode;

        Graph.getPrompts = async () => [];
        services.getServicesForNode = async () => ({ for_type: [], for_format: [] });
    });

    afterEach(() => {
        Graph.getUserFileMetadata = originalGetUserFileMetadata;
        Graph.getPrompts = originalGetPrompts;
        filters.loadFilters = originalLoadFilters;
        services.getServicesForNode = originalGetServicesForNode;
    });

    it('includes image filters for Set nodes based on set types/extensions', async () => {
        Graph.getUserFileMetadata = async () => ({
            '@rid': '#136:0',
            '@type': 'Set',
            type: '',
            extension: '',
            types: ['image'],
            extensions: ['jpg', 'png'],
        });

        filters.loadFilters = async () => ({
            'mdf-image-roi': {
                id: 'mdf-image-roi',
                type: 'filter',
                supported_types: ['image'],
                supported_formats: ['jpg', 'jpeg', 'png'],
            },
            'mdf-set-filter': {
                id: 'mdf-set-filter',
                type: 'filter',
                set_only: 1,
                supported_types: [],
                supported_formats: [],
            },
        });

        const request = {
            params: { rid: '136:0' },
            query: {},
            auth: { credentials: { user: { rid: '#49:0', service_groups: [] } } },
        };

        const response = await handler(request);
        const filterIds = (response.filters || []).map((item) => item.id);

        assert.ok(filterIds.includes('mdf-image-roi'));
        assert.ok(filterIds.includes('mdf-set-filter'));
    });
});
