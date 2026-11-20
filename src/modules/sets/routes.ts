import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';

export function setRoutes({ setMerge }: Deps): ServerRoute[] {
    return [
        {
            method: 'POST',
            path: '/api/sets/merge',
            handler: (request) => {
                const body = (request.payload || {}) as { set_rids?: unknown; label?: unknown };
                return setMerge.merge(body.set_rids, body.label, currentUser(request).rid);
            },
        },
    ];
}
