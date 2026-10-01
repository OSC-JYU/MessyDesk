// Authentication.
//
// `mail` (default strategy): an upstream proxy (Shibboleth etc.) sets the `mail` header and the
// backend trusts it, as before. In development mode (MODE=development) every request acts as
// DEV_USER whatever it sends.
//
// `service`: consumers (MD-consumers) send `Authorization: Bearer <SERVICE_TOKEN>`. Until the
// consumers are updated, SERVICE_AUTH_LEGACY_MAIL=true also accepts the `mail` header of an admin
// user (they send local.user@localhost) and logs a warning (plan/decisions.md B8).

import Boom from '@hapi/boom';
import type { Request, ResponseToolkit, Server } from '@hapi/hapi';
import { timingSafeEqual } from 'node:crypto';
import type { Logger } from '../logger.ts';

export interface UserRecord {
    rid: string;
    id: string;
    label?: string;
    group?: string;
    access?: string;
    active?: boolean;
    service_groups?: string[];
    settings?: Record<string, unknown>;
}

export interface Credentials {
    user: UserRecord | null;
    service?: boolean;
}

export type UserLookup = (mailOrRid: string) => Promise<UserRecord | null>;

export const AUTH_HEADER = 'mail';

function tokenMatches(given: string, expected: string): boolean {
    if (!expected) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(expected);
    return a.length === b.length && timingSafeEqual(a, b);
}

export function credentials(request: Request): Credentials {
    return request.auth.credentials as unknown as Credentials;
}

/** The authenticated user; throws 401 for service calls that carry no user. */
export function currentUser(request: Request): UserRecord {
    const user = credentials(request)?.user;
    if (!user) throw Boom.unauthorized('User required');
    return user;
}

export function requireAdmin(request: Request): UserRecord {
    const creds = credentials(request);
    if (creds?.service && !creds.user) return { rid: '', id: 'service', access: 'admin' };
    const user = currentUser(request);
    if (user.access !== 'admin') throw Boom.forbidden('Admin access required');
    return user;
}

export interface AuthOptions {
    development: boolean;
    devUser: string;
    serviceToken: string;
    legacyMail: boolean;
    lookup: UserLookup;
    logger: Logger;
}

export async function registerAuth(server: Server, opts: AuthOptions): Promise<void> {
    async function lookupOrFail(mail: string): Promise<UserRecord> {
        let user: UserRecord | null;
        try {
            user = await opts.lookup(mail);
        } catch {
            throw Boom.unauthorized('Authentication failed');
        }
        if (!user) throw Boom.unauthorized('User not found');
        return user;
    }

    if (opts.development) {
        // Same as before: every request is the development user, even on routes without auth.
        server.ext('onRequest', async (request, h) => {
            request.headers[AUTH_HEADER] = opts.devUser;
            let user: UserRecord | null;
            try {
                user = await opts.lookup(opts.devUser);
            } catch {
                throw Boom.serverUnavailable('DB is not available');
            }
            if (!user) throw Boom.unauthorized('User not found');
            (request as any).plugins.devUser = user;
            return h.continue;
        });
    }

    server.auth.scheme('mail-auth', () => ({
        authenticate: async (request: Request, h: ResponseToolkit) => {
            if (opts.development) return h.authenticated({ credentials: { user: (request as any).plugins.devUser } as any });
            const mail = request.headers[AUTH_HEADER];
            if (!mail) throw Boom.unauthorized('Missing mail header');
            const user = await lookupOrFail(String(mail));
            return h.authenticated({ credentials: { user } as any });
        },
    }));

    server.auth.scheme('service-auth', () => ({
        authenticate: async (request: Request, h: ResponseToolkit) => {
            const header = String(request.headers.authorization || '');
            const mail = request.headers[AUTH_HEADER];
            if (header.toLowerCase().startsWith('bearer ')) {
                if (!tokenMatches(header.slice(7).trim(), opts.serviceToken)) throw Boom.unauthorized('Invalid service token');
                // A consumer may name the user it acts for (file downloads use `mail: msg.userId`).
                let user: UserRecord | null = null;
                if (mail) user = await opts.lookup(String(mail)).catch(() => null);
                return h.authenticated({ credentials: { user, service: true } as any });
            }
            if (opts.development) return h.authenticated({ credentials: { user: (request as any).plugins.devUser, service: true } as any });
            if (opts.legacyMail && mail) {
                const user = await lookupOrFail(String(mail));
                if (user.access === 'admin') {
                    opts.logger.warn('Consumer authenticated with the legacy mail header; set SERVICE_TOKEN in MD-consumers', { path: request.path, mail });
                    return h.authenticated({ credentials: { user, service: true } as any });
                }
            }
            throw Boom.unauthorized('Service credential required');
        },
    }));

    server.auth.strategy('mail', 'mail-auth');
    server.auth.strategy('service', 'service-auth');
    server.auth.default('mail');
}
