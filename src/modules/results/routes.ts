import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import fsp from 'node:fs/promises';
import type { Deps } from '../../app/deps.ts';
import { SEMANTIC_ROLE } from '../semantic/semantic.ts';

const SERVICE_ONLY = { strategy: 'service' };

/** The `message` part: a temp file (multipart output 'file'), a JSON string or an object. */
async function parseMessage(part: any): Promise<any> {
    if (!part) return {};
    if (part.path) return JSON.parse(await fsp.readFile(part.path, 'utf8'));
    if (typeof part === 'string') return JSON.parse(part);
    return part;
}

export function resultRoutes({ results, semantic, logger }: Deps): ServerRoute[] {
    const filePayload = (maxBytes: number) => ({ maxBytes, output: 'file' as const, parse: true, multipart: { output: 'file' as const } });
    return [
        {
            method: 'POST',
            path: '/api/nomad/process/files',
            options: { auth: SERVICE_ONLY, payload: filePayload(500000000) },
            handler: async (request) => {
                const payload = (request.payload || {}) as any;
                try {
                    const message = await parseMessage(payload.message);
                    if (!payload.message || !payload.content?.path) throw Boom.badData('File processing failed');
                    await results.handleFile(message, payload.content.path);
                } catch (error) {
                    logger.error('Result file failed', { error: (error as Error).message, stack: (error as Error).stack });
                    throw Boom.badData((error as Error).message);
                }
                return { success: true, message: 'Files processed successfully' };
            },
        },
        {
            method: 'POST',
            path: '/api/nomad/process/files/tmp',
            options: { auth: SERVICE_ONLY, payload: { maxBytes: 10485760, output: 'data', parse: true } },
            handler: async (request) => {
                const payload = (request.payload || {}) as any;
                try {
                    const message = await parseMessage(payload.message);
                    await results.handleFile(message, results.resolveTmpFile(payload, message));
                } catch (error) {
                    logger.error('Result tmp file failed', { error: (error as Error).message });
                    throw Boom.badData((error as Error).message);
                }
                return { success: true, message: 'Files processed successfully' };
            },
        },
        {
            method: 'POST',
            path: '/api/nomad/process/files/done',
            options: { auth: SERVICE_ONLY },
            handler: async (request) => {
                const payload = request.payload as any;
                if (payload?.role === SEMANTIC_ROLE) await semantic.deliver(payload);
                else if (payload) await results.handleDone(payload);
                return [];
            },
        },
        {
            method: 'POST',
            path: '/api/nomad/process/files/error',
            options: { auth: SERVICE_ONLY },
            handler: async (request) => {
                const payload = (request.payload || {}) as any;
                if (payload.message?.role === SEMANTIC_ROLE) semantic.fail(payload.message, payload.error);
                else if (payload.error && payload.message) await results.handleError(payload.error, payload.message);
                else logger.error('Error processing files', { error: payload });
                return [];
            },
        },
        {
            method: 'POST',
            path: '/api/nomad/process/files/metadata',
            options: { auth: SERVICE_ONLY, payload: filePayload(209715200) },
            handler: async (request) => {
                const payload = (request.payload || {}) as any;
                try {
                    if (payload.message && payload.content?.path) await results.handleMetadata(await parseMessage(payload.message), payload.content.path);
                } catch (error) {
                    logger.warn('Metadata result failed', { error: (error as Error).message });
                }
                return { success: true, message: 'Files processed successfully' };
            },
        },
    ];
}
