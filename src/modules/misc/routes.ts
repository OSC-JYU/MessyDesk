// The API root, the event stream, the static help pages and search.

import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';

const SLUG = /^[a-z0-9-]+$/i;

function inside(root: string, rawPath: string, what: string): string {
    if (!rawPath) throw Boom.badRequest(`Missing help ${what} path`);
    const resolved = path.resolve(path.join(root, path.normalize(String(rawPath)).replace(/^[\\/]+/, '')));
    if (resolved !== root && !resolved.startsWith(root + path.sep)) throw Boom.forbidden(`Help ${what} path is outside allowed directory`);
    return resolved;
}

export function miscRoutes({ sse, config, solr }: Deps): ServerRoute[] {
    const helpDir = path.resolve(config.helpDir);
    const imageDir = path.join(helpDir, 'images');
    const styleDir = path.join(helpDir, 'styles');
    return [
        { method: 'GET', path: '/api', handler: () => 'MessyDesk API' },
        {
            method: 'GET',
            path: '/events',
            handler: (request, h) => {
                const user = currentUser(request);
                const connection = sse.open(user.rid);
                sse.write(connection, { message: 'Welcome to MessyDesk!' });
                request.raw.req.on('close', () => sse.close(connection));
                return h.response(connection.stream)
                    .type('text/event-stream; charset=utf-8')
                    .header('Cache-Control', 'no-cache')
                    .header('Connection', 'keep-alive')
                    .header('Content-Encoding', 'identity');
            },
        },
        {
            method: 'GET',
            path: '/api/help/images/{assetPath*}',
            options: { auth: false },
            handler: (request, h) => {
                const file = inside(imageDir, request.params.assetPath, 'image');
                if (!fs.existsSync(file)) throw Boom.notFound('Help image not found');
                return h.file(file, { confine: false });
            },
        },
        {
            method: 'GET',
            path: '/api/help/styles/{assetPath*}',
            options: { auth: false },
            handler: (request, h) => {
                const file = inside(styleDir, request.params.assetPath, 'style');
                if (!fs.existsSync(file)) throw Boom.notFound('Help style not found');
                return h.file(file, { confine: false });
            },
        },
        {
            method: 'GET',
            path: '/api/help/{slug?}',
            options: { auth: false },
            handler: async (request, h) => {
                const raw = request.params.slug ? String(request.params.slug).trim().toLowerCase() : 'index';
                const slug = raw || 'index';
                if (slug !== 'index' && !SLUG.test(slug)) throw Boom.badRequest('Invalid help page slug');
                const file = path.join(helpDir, `${slug}.html`);
                if (!fs.existsSync(file)) throw Boom.notFound('Help page not found');
                return h.response(await fsp.readFile(file, 'utf8')).type('text/html; charset=utf-8');
            },
        },
        {
            method: 'POST',
            path: '/api/search',
            handler: (request) => solr.search(request.payload || {}, currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/search/info',
            handler: async (request) => {
                try {
                    return await solr.projectDocCounts(currentUser(request).rid);
                } catch {
                    return { total_docs: 0, project_count: 0, project_counts: [], available: false, message: 'Failed to load search index info' };
                }
            },
        },
    ];
}
