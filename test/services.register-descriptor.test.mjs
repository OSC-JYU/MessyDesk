import { strict as assert } from 'assert';
import fs from 'fs';
import os from 'os';
import path from 'path';

import services from '../src/services.mjs';
import serviceRoutes from '../src/routes/services.mjs';

function getRegisterRouteHandler() {
    const route = serviceRoutes.find(
        (item) => item.method === 'POST' && item.path === '/api/services/register'
    );

    if (!route || typeof route.handler !== 'function') {
        throw new Error('Service register route handler not found');
    }

    return route.handler;
}

describe('Service descriptor registration', () => {
    let originalServiceList;
    let originalRegistryFilePath;
    let tmpDir;

    beforeEach(async () => {
        originalServiceList = services.service_list;
        originalRegistryFilePath = services.registry_file_path;
        services.service_list = {};
        tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'messydesk-services-test-'));
        services.setRegistryFilePath(path.join(tmpDir, 'service-registry.json'));
    });

    afterEach(async () => {
        services.service_list = originalServiceList;
        services.setRegistryFilePath(originalRegistryFilePath);
        await fs.promises.rm(tmpDir, { recursive: true, force: true });
    });

    it('creates then updates descriptor idempotently', () => {
        const created = services.registerServiceDescriptor({
            id: 'phase1-service',
            supported_types: ['Text'],
            tasks: {
                hello: {
                    behaviour: 'one-to-one',
                    supported_formats: ['TXT'],
                },
            },
        }, { source: 'test' });

        assert.equal(created.status, 'created');
        assert.equal(created.service.id, 'phase1-service');
        assert.equal(created.service.tasks.hello.behaviour, 'one-to-one');
        assert.deepEqual(created.service.supported_types, ['text']);
        assert.deepEqual(created.service.tasks.hello.supported_formats, ['txt']);
        assert.equal(created.service.registration.source, 'test');

        const updated = services.registerServiceDescriptor({
            id: 'phase1-service',
            tasks: {
                hello: {
                    behaviour: 'one-to-many',
                },
            },
        }, { source: 'test' });

        assert.equal(updated.status, 'updated');
        assert.equal(updated.service.tasks.hello.behaviour, 'one-to-many');
        assert.ok(updated.service.registration.registered_at);
        assert.ok(updated.service.registration.last_seen);
    });

    it('persists and reloads registry descriptors', async () => {
        await services.registerServiceDescriptorAndPersist({
            id: 'persisted-service',
            tasks: {
                hello: { behaviour: 'one-to-one' },
            },
        }, { source: 'runtime' });

        services.service_list = {};
        const registryServices = await services.loadServiceRegistry();

        assert.ok(registryServices['persisted-service']);
        assert.equal(registryServices['persisted-service'].tasks.hello.behaviour, 'one-to-one');
        assert.equal(registryServices['persisted-service'].registration.source, 'runtime');
        assert.ok(registryServices['persisted-service'].registration.last_seen);
    });

    it('overlays persisted registry over filesystem descriptors on startup', async () => {
        const serviceDir = path.join(tmpDir, 'services');
        const overlayDir = path.join(serviceDir, 'overlay-service');
        const fileOnlyDir = path.join(serviceDir, 'file-only-service');
        await fs.promises.mkdir(overlayDir, { recursive: true });
        await fs.promises.mkdir(fileOnlyDir, { recursive: true });

        await fs.promises.writeFile(
            path.join(overlayDir, 'service.json'),
            JSON.stringify({
                id: 'overlay-service',
                tasks: {
                    hello: { behaviour: 'one-to-one' },
                },
            }),
            'utf-8'
        );

        await fs.promises.writeFile(
            path.join(fileOnlyDir, 'service.json'),
            JSON.stringify({
                id: 'file-only-service',
                tasks: {
                    passthrough: { behaviour: 'one-to-one' },
                },
            }),
            'utf-8'
        );

        services.service_list = {};
        await services.registerServiceDescriptorAndPersist({
            id: 'overlay-service',
            tasks: {
                hello: { behaviour: 'one-to-many' },
            },
        }, { source: 'runtime' });

        await services.loadServiceAdapters(serviceDir, false);

        assert.equal(services.service_list['overlay-service'].tasks.hello.behaviour, 'one-to-many');
        assert.equal(services.service_list['overlay-service'].registration.source, 'runtime');
        assert.ok(services.service_list['overlay-service'].path);

        assert.ok(services.service_list['file-only-service']);
        assert.equal(services.service_list['file-only-service'].tasks.passthrough.behaviour, 'one-to-one');
    });

    it('rejects invalid descriptor shape', () => {
        assert.throws(() => {
            services.registerServiceDescriptor({
                id: 'bad-service',
                tasks: [],
            });
        }, (error) => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /tasks must be an object/);
            return true;
        });

        assert.throws(() => {
            services.registerServiceDescriptor({
                id: 'bad-service',
                tasks: {
                    hello: {
                        behaviour: 'invalid-mode',
                    },
                },
            });
        }, (error) => {
            assert.equal(error.statusCode, 400);
            assert.match(error.message, /behaviour is invalid/);
            return true;
        });
    });

    it('route returns 400 with validation message for invalid payload', async () => {
        const handler = getRegisterRouteHandler();

        const request = {
            payload: {
                id: 'route-bad',
                tasks: {
                    hello: { behaviour: 'not-valid' },
                },
            },
            query: {},
        };

        const h = {
            response(payload) {
                return {
                    payload,
                    code(statusCode) {
                        return { payload, statusCode };
                    },
                };
            },
        };

        const response = await handler(request, h);
        assert.equal(response.statusCode, 400);
        assert.match(response.payload.error, /behaviour is invalid/);
    });
});
