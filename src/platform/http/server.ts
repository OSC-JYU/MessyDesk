import './hapi-types.ts';
// Hapi server setup: CORS, error logging, static files.

import fs from 'node:fs';
import path from 'node:path';
import Hapi from '@hapi/hapi';
import type { Server, ServerRoute } from '@hapi/hapi';
import Inert from '@hapi/inert';
import type { Logger } from '../logger.ts';
import Boom from '@hapi/boom';
import { ValidationError } from '../../shared/graph-store.ts';
import { InvalidRidError } from '../ids.ts';
import { AUTH_HEADER } from './auth.ts';

export async function createServer(port: number, publicDir: string): Promise<Server> {
    const server = Hapi.server({
        port,
        host: '0.0.0.0',
        routes: { cors: true, files: { relativeTo: publicDir } },
    });
    await server.register(Inert);
    registerUiFallback(server, publicDir);
    return server;
}

/**
 * When a built UI is in public/ (the local compose image puts it there), a GET that found nothing
 * gets its index.html, so deep links into the UI's history-mode router survive a reload.
 * Registered before the error logging, so these are not logged as 404s.
 */
function registerUiFallback(server: Server, publicDir: string): void {
    const uiIndex = path.join(publicDir, 'index.html');
    server.ext('onPreResponse', (request, h) => {
        const response = request.response as any;
        if (request.method === 'get' && response?.isBoom && response.output.statusCode === 404
            && isUiRoute(request.path) && fs.existsSync(uiIndex)) {
            return h.file('index.html');
        }
        return h.continue;
    });
}

export function registerErrorLogging(server: Server, logger: Logger): void {
    server.ext('onPreResponse', (request, h) => {
        const response = request.response as any;
        // Invalid input that reached the data layer is the caller's error, not a 500.
        if (response instanceof ValidationError || response instanceof InvalidRidError) {
            return Boom.badRequest(response.message);
        }
        if (response && response.isBoom) {
            const status = response.output?.statusCode;
            const entry = {
                user: request.headers[AUTH_HEADER],
                message: response.message,
                params: request.params,
                path: request.path,
                status,
            };
            if (status >= 500) logger.error({ ...entry, error: response.stack });
            else logger.warn(entry);
        }
        return h.continue;
    });
}

// Paths that belong to the API even when nothing matches them, so they stay 404 instead of
// getting the UI's index.html.
const API_PREFIXES = ['/api/', '/events', '/images/', '/icons/'];

/** A missing path the UI router may own: not an API path and not a file name. */
export function isUiRoute(requestPath: string): boolean {
    if (API_PREFIXES.some((prefix) => requestPath.startsWith(prefix))) return false;
    const last = requestPath.split('/').pop() ?? '';
    return !last.includes('.');
}

/** The repository's `public/` directory (favicon, icons, maintenance page, built help). */
export function staticRoute(): ServerRoute {
    return {
        method: 'GET',
        path: '/{param*}',
        handler: { directory: { path: '.', redirectToSlash: true, index: true } },
        options: { auth: false },
    };
}
