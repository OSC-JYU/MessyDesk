import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';

export function semanticRoutes({ semantic }: Deps): ServerRoute[] {
    return [
        {
            method: 'GET',
            path: '/api/search/semantic/indexes',
            handler: (request) => semantic.indexes(currentUser(request).rid),
        },
        {
            method: 'POST',
            path: '/api/search/semantic',
            handler: (request, h) => semantic.start(currentUser(request).rid, request.payload || {}).then((r) => h.response(r).code(202)),
        },
        {
            method: 'GET',
            path: '/api/search/semantic/{id}',
            handler: (request) => semantic.get(request.params.id, currentUser(request).rid),
        },
    ];
}
