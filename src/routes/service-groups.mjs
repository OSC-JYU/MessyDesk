import Graph from '../graph.mjs';
import Boom from '@hapi/boom';
import path from 'path';
import fse from 'fs-extra';
import Services from '../services.mjs';
import { DATA_DIR } from '../env.mjs';

const ALLOWED_LOGO_TYPES = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
const MAX_LOGO_UPLOAD_BYTES = 5 * 1024 * 1024;
// Mirrors graph.mjs SERVICE_GROUP_ID_PATTERN; re-checked here since these ids are used to build disk paths.
const SAFE_ID_PATTERN = /^[A-Za-z0-9_-]{1,64}$/

function requireAdmin(request) {
    if (request.auth.credentials.user.access !== 'admin') {
        throw Boom.forbidden('Admin access required');
    }
}

function requireSafeId(id) {
    if (!SAFE_ID_PATTERN.test(String(id || ''))) {
        throw Boom.badRequest('Invalid service group id');
    }
}

function logoSourceDir(id) {
    return path.resolve(DATA_DIR, 'uploads', 'service-groups', id);
}

export default [
    {
        method: 'GET',
        path: '/api/service-groups',
        handler: async (request) => {
            requireAdmin(request);
            return await Graph.getServiceGroups();
        }
    },
    {
        method: 'POST',
        path: '/api/service-groups',
        handler: async (request) => {
            requireAdmin(request);
            try {
                return await Graph.createServiceGroup(request.payload || {});
            } catch (e) {
                throw Boom.badRequest(e.message);
            }
        }
    },
    {
        method: 'PUT',
        path: '/api/service-groups/{id}',
        handler: async (request) => {
            requireAdmin(request);
            try {
                return await Graph.updateServiceGroup(request.params.id, request.payload || {});
            } catch (e) {
                throw Boom.badRequest(e.message);
            }
        }
    },
    {
        method: 'DELETE',
        path: '/api/service-groups/{id}',
        handler: async (request) => {
            requireAdmin(request);
            try {
                await Graph.deleteServiceGroup(request.params.id);
                await fse.remove(logoSourceDir(request.params.id));
                return { success: true };
            } catch (e) {
                throw Boom.badRequest(e.message);
            }
        }
    },
    {
        // Admin uploads the original image; MD-sharp is a standalone HTTP service (api_type "elg"),
        // so we call its /process endpoint directly and synchronously here - this is a one-off admin
        // action on a ServiceGroup, not a graph File node, so it doesn't go through the queue/consumer
        // pipeline. See wiki/service-descriptor-format.md#service-groups.
        method: 'POST',
        path: '/api/service-groups/{id}/logo',
        options: {
            payload: {
                maxBytes: MAX_LOGO_UPLOAD_BYTES,
                output: 'file',
                parse: true,
                multipart: true,
                allow: 'multipart/form-data'
            }
        },
        handler: async (request) => {
            requireAdmin(request);
            const id = request.params.id;
            requireSafeId(id);
            const group = await Graph.getServiceGroup(id);
            if (!group) throw Boom.notFound(`ServiceGroup "${id}" not found`);

            const file = request.payload?.file;
            if (!file) throw Boom.badRequest('No file uploaded');

            const contentType = file.headers?.['content-type'];
            const extension = ALLOWED_LOGO_TYPES[contentType];
            if (!extension) throw Boom.badRequest('Logo must be a PNG, JPEG or WEBP image');

            const svc = Services.getService('md-sharp');
            const baseUrl = String(svc?.url || svc?.local_url || '').replace(/\/$/, '');
            if (!baseUrl) throw Boom.serverUnavailable('md-sharp service is not registered');

            const form = new FormData();
            form.append('message', new Blob([JSON.stringify({ task: { id: 'fit', params: { width: 200, height: 200, type: 'png' } } })], { type: 'application/json' }), 'message.json');
            form.append('content', new Blob([await fse.readFile(file.path)], { type: contentType }), `source.${extension}`);

            const processResponse = await fetch(`${baseUrl}/process`, { method: 'POST', body: form });
            if (!processResponse.ok) {
                throw Boom.badGateway(`md-sharp resize failed (${processResponse.status})`);
            }
            const result = await processResponse.json();
            const uri = result?.response?.uri?.[0]?.uri;
            if (!uri) throw Boom.badGateway('md-sharp returned no output');

            const imageResponse = await fetch(`${baseUrl}${uri}`);
            if (!imageResponse.ok) throw Boom.badGateway('Failed to fetch resized logo from md-sharp');
            const buffer = Buffer.from(await imageResponse.arrayBuffer());

            const logoDir = logoSourceDir(id);
            await fse.ensureDir(logoDir);
            await fse.emptyDir(logoDir);
            await fse.writeFile(path.join(logoDir, 'logo.png'), buffer);

            return await Graph.setServiceGroupLogo(id, 'logo.png');
        }
    },
    {
        method: 'GET',
        path: '/api/service-groups/{id}/logo',
        handler: async (request, h) => {
            requireSafeId(request.params.id);
            const logoPath = path.join(logoSourceDir(request.params.id), 'logo.png');
            if (!(await fse.pathExists(logoPath))) throw Boom.notFound('No logo');
            const response = h.file(logoPath);
            response.type('image/png');
            return response;
        }
    }
];
