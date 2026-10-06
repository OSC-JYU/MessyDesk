import Boom from '@hapi/boom';
import type { ServerRoute } from '@hapi/hapi';
import { currentUser, requireAdmin } from '../../platform/http/auth.ts';
import type { Deps } from '../../app/deps.ts';
import { validatePatch, withDefaults } from './settings.ts';

export function userRoutes({ users, tokenBudget }: Deps): ServerRoute[] {
    return [
        {
            method: 'GET',
            path: '/api/sso',
            options: { auth: false },
            handler: (request) => ({ mail: request.headers.mail, name: request.headers.displayname }),
        },
        {
            method: 'GET',
            path: '/api/me/usage',
            handler: (request) => tokenBudget.forUser(currentUser(request).rid),
        },
        {
            method: 'GET',
            path: '/api/me',
            handler: async (request) => {
                const user = currentUser(request);
                const me = await users.find(user.id);
                if (!me) throw Boom.unauthorized('User not found');
                return {
                    rid: me.rid,
                    group: me.group,
                    access: me.access,
                    id: user.id,
                    mode: process.env.MODE || 'production',
                    settings: withDefaults(me.settings),
                };
            },
        },
        {
            method: 'PUT',
            path: '/api/me/settings',
            handler: async (request) => {
                let patch;
                try {
                    patch = validatePatch(request.payload);
                } catch (error) {
                    throw Boom.badRequest((error as Error).message);
                }
                return withDefaults(await users.updateSettings(currentUser(request).rid, patch));
            },
        },
        {
            method: 'GET',
            path: '/api/users',
            handler: async (request) => {
                requireAdmin(request);
                return users.list();
            },
        },
        {
            method: 'POST',
            path: '/api/users',
            handler: async (request) => {
                requireAdmin(request);
                return users.create((request.payload || {}) as Record<string, unknown>);
            },
        },
        {
            method: 'PUT',
            path: '/api/users/{rid}/service-groups',
            handler: async (request) => {
                requireAdmin(request);
                return users.setServiceGroups(request.params.rid, (request.payload as any)?.service_groups);
            },
        },
        {
            method: 'GET',
            path: '/api/permissions/request',
            handler: async (request) => {
                requireAdmin(request);
                return users.listRequests();
            },
        },
        {
            method: 'DELETE',
            path: '/api/permissions/request/{rid}',
            handler: async (request) => {
                requireAdmin(request);
                return users.deleteRequest(request.params.rid);
            },
        },
        {
            method: 'POST',
            path: '/api/permissions/request',
            options: { auth: false },
            handler: async (request) => {
                const mail = request.headers.mail;
                if (!mail) throw Boom.badRequest('Missing user identification');
                await users.addRequest(String(mail), String(request.headers.displayname || mail));
                return { status: 'ok' };
            },
        },
    ];
}
