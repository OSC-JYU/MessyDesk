import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { credentials, currentUser, requireAdmin } from '../../platform/http/auth.ts';
import { DescriptorError } from './registry.ts';
import { filterMatchesNode, servicesForNode } from './matching.ts';

const INSTALL_KINDS = ['nomad', 'external', 'local'];
const SERVICE_ID = /^[a-z0-9][a-z0-9_-]*$/i;

function serviceId(raw: unknown): string {
    const id = String(raw || '').trim();
    if (!id) throw Boom.badRequest('Missing service id');
    if (!SERVICE_ID.test(id)) throw Boom.badRequest('Invalid service id');
    return id;
}

function parseDescriptor(raw: unknown): any {
    if (raw === undefined || raw === null) return {};
    if (typeof raw === 'string') {
        if (!raw.trim()) return {};
        try {
            return JSON.parse(raw);
        } catch (error) {
            throw Boom.badRequest(`Invalid service.json: ${(error as Error).message}`);
        }
    }
    if (typeof raw === 'object' && !Array.isArray(raw)) return raw;
    throw Boom.badRequest('service descriptor must be a JSON object or string');
}

/** The descriptor of an admin-installed service (POST /api/services/install). */
function installDescriptor(payload: any): any {
    const kind = String(payload?.kind || '').trim().toLowerCase();
    if (!INSTALL_KINDS.includes(kind)) throw Boom.badRequest(`kind must be one of: ${INSTALL_KINDS.join(', ')}`);
    const d: any = { ...parseDescriptor(payload?.service || payload?.descriptor) };
    if (payload?.id && String(payload.id).trim()) d.id = String(payload.id).trim();
    if (!d.id) throw Boom.badRequest('service id is required (in payload.id or descriptor.id)');
    d.id = serviceId(d.id);
    if (payload?.name) d.name = String(payload.name);
    if (payload?.description) d.description = String(payload.description);
    d.kind = kind;
    if (kind === 'nomad') {
        const hcl = String(payload?.nomad_hcl || '').trim();
        if (!hcl) throw Boom.badRequest('nomad_hcl is required for kind "nomad"');
        Object.assign(d, { nomad_hcl: hcl, nomad: true, location: d.location || 'on-premise' });
    } else if (kind === 'external') {
        const url = String(payload?.url || d.url || d.local_url || '').trim();
        if (!url) throw Boom.badRequest('url is required for kind "external"');
        Object.assign(d, { local_url: url, nomad: false, location: d.location || 'external' });
    } else {
        const url = String(payload?.dev_url || payload?.url || d.local_url || '').trim();
        if (!url) throw Boom.badRequest('dev_url is required for kind "local"');
        Object.assign(d, { local_url: url, nomad: false, location: d.location || 'on-premise' });
    }
    return d;
}

function nomadEnabled(): boolean {
    return ['1', 'true', 'yes', 'on'].includes(String(process.env.NOMAD || '').toLowerCase());
}

export function serviceRoutes({ registry, files, prompts, filters, serviceHelp, nomad, logger }: Deps): ServerRoute[] {
    const either = { auth: { strategies: ['service', 'mail'] } };
    const serviceOnly = { auth: { strategy: 'service' } };
    return [
        {
            method: 'GET',
            path: '/api/services',
            handler: () => registry.all(),
        },
        {
            method: 'GET',
            path: '/api/services/{service}',
            options: either,
            handler: (request) => registry.get(request.params.service) ?? null,
        },
        {
            method: 'GET',
            path: '/api/services/files/{rid}',
            handler: async (request) => {
                const user = currentUser(request);
                const node = await files.metadata(request.params.rid, user.rid);
                const all = Object.values(filters.list()).filter((f: any) => f.category !== 'system');
                const offered = node ? all.filter((f) => filterMatchesNode(f, node)) : all;
                if (!node) return { for_type: [], for_format: [], filters: offered };
                const matches: any = servicesForNode(registry.all(), node, (request.query as any).filter, user, await prompts.list(user.rid));
                matches.filters = offered;
                return matches;
            },
        },
        {
            method: 'POST',
            path: '/api/services/register',
            options: serviceOnly,
            handler: async (request, h) => {
                try {
                    const payload = (request.payload || {}) as any;
                    const source = payload.source || (request.query as any).source || 'runtime';
                    return await registry.register(payload.service || payload, source);
                } catch (error) {
                    return h.response({ error: (error as Error).message }).code((error as DescriptorError).statusCode || 500);
                }
            },
        },
        {
            method: 'POST',
            path: '/api/services/install',
            handler: async (request, h) => {
                requireAdmin(request);
                const descriptor = installDescriptor(request.payload || {});
                try {
                    return await registry.register(descriptor, 'admin');
                } catch (error) {
                    return h.response({ error: (error as Error).message }).code((error as DescriptorError).statusCode || 400);
                }
            },
        },
        {
            method: 'POST',
            path: '/api/services/reload',
            handler: async (request) => {
                requireAdmin(request);
                await registry.load();
                return { status: 'ok', service: { service_list: registry.all() } };
            },
        },
        {
            method: 'DELETE',
            path: '/api/services/{service}',
            options: either,
            handler: (request) => {
                requireAdmin(request);
                return registry.forget(serviceId(request.params.service));
            },
        },
        {
            method: 'POST',
            path: '/api/services/{service}/adapter/{id}',
            options: serviceOnly,
            handler: (request, h) => {
                const response = registry.addAdapter(request.params.service, request.params.id);
                return response?.error ? h.response(response).code(404) : response;
            },
        },
        {
            method: 'DELETE',
            path: '/api/services/{service}/adapter/{id}',
            options: serviceOnly,
            handler: async (request) => {
                const service = registry.get(request.params.service);
                const response = registry.removeAdapter(request.params.service, request.params.id);
                const live = Array.isArray(response?.consumers) && response.consumers.length > 0;
                if (!live && service && (nomadEnabled() || service.nomad === true)) {
                    try {
                        await nomad.stop(service);
                    } catch (error) {
                        logger.warn(`Nomad stop failed for ${request.params.service}: ${(error as Error).message}`);
                    }
                }
                return response;
            },
        },
        {
            method: 'POST',
            path: '/api/services/{service}/help/ingest',
            options: either,
            handler: async (request) => {
                if (!credentials(request).service) requireAdmin(request);
                const id = serviceId(request.params.service);
                const config = registry.get(id);
                if (!config) throw Boom.notFound('Service not found');
                const content = (request.payload as any)?.content;
                if (typeof content === 'string') return serviceHelp.ingestMarkdown(id, content);
                return serviceHelp.ingest(id, config, (request.payload as any)?.help_url || (request.query as any)?.help_url);
            },
        },
        {
            method: 'GET',
            path: '/api/services/{service}/help',
            options: { auth: false },
            handler: async (request, h) => h.response(await serviceHelp.page(request.params.service)).type('text/html; charset=utf-8'),
        },
        {
            method: 'GET',
            path: '/api/services/{service}/help/assets/{assetPath*}',
            options: { auth: false },
            handler: async (request, h) => {
                const asset = await serviceHelp.asset(request.params.service, request.params.assetPath);
                return h.response(asset.body).type(asset.contentType);
            },
        },
        {
            method: 'POST',
            path: '/api/nomad/service/{name}',
            options: either,
            handler: async (request, h) => {
                requireAdmin(request);
                const hcl = (request.payload as any)?.nomad_hcl;
                const service: any = { ...(registry.get(request.params.name) || { id: request.params.name }) };
                if (typeof hcl === 'string' && hcl.trim()) Object.assign(service, { nomad_hcl: hcl, nomad: true });
                if (!service.nomad_hcl) {
                    return h.response({ error: `No Nomad spec found for service "${request.params.name}"`, message: 'Provide request payload field "nomad_hcl" or register service adapter with nomad_hcl.' }).code(400);
                }
                try {
                    return await nomad.start(service);
                } catch (error) {
                    logger.error('Error creating service', { error: (error as Error).message });
                    return h.response({ error: (error as Error).message }).code(500);
                }
            },
        },
        {
            method: 'DELETE',
            path: '/api/nomad/service/{name}',
            options: either,
            handler: async (request, h) => {
                requireAdmin(request);
                const service = registry.get(request.params.name) || { id: request.params.name };
                try {
                    return await nomad.stop(service);
                } catch (error) {
                    logger.error('Error stopping service', { error: (error as Error).message });
                    return h.response({ error: (error as Error).message }).code(500);
                }
            },
        },
    ];
}
