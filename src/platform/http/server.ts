import './hapi-types.ts';
// Hapi server setup: CORS, error logging, static files.

import Hapi from '@hapi/hapi';
import type { Server, ServerRoute } from '@hapi/hapi';
import Inert from '@hapi/inert';
import type { Logger } from '../logger.ts';
import { AUTH_HEADER } from './auth.ts';

export async function createServer(port: number, publicDir: string): Promise<Server> {
    const server = Hapi.server({
        port,
        host: '0.0.0.0',
        routes: { cors: true, files: { relativeTo: publicDir } },
    });
    await server.register(Inert);
    return server;
}

export function registerErrorLogging(server: Server, logger: Logger): void {
    server.ext('onPreResponse', (request, h) => {
        const response = request.response as any;
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

/** The repository's `public/` directory (favicon, icons, maintenance page, built help). */
export function staticRoute(): ServerRoute {
    return {
        method: 'GET',
        path: '/{param*}',
        handler: { directory: { path: '.', redirectToSlash: true, index: true } },
        options: { auth: false },
    };
}
