import type { ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser } from '../../platform/http/auth.ts';
import { CodingService } from './coding.ts';

export function codingRoutes({ coding, users }: Deps): ServerRoute[] {
    const me = (r: any) => currentUser(r).rid;
    const p = (r: any) => r.params;
    return [
        // ---- owner: who codes in a ROI set ----
        { method: 'GET', path: '/api/sets/{rid}/coders', handler: (r) => coding.coders(p(r).rid, me(r)) },
        { method: 'POST', path: '/api/sets/{rid}/coders', handler: (r) => coding.assign(p(r).rid, (r.payload as any)?.user_rid, me(r)) },
        { method: 'PUT', path: '/api/sets/{rid}/coders/{user}', handler: (r) => coding.lock(p(r).rid, p(r).user, Boolean((r.payload as any)?.locked), me(r)) },
        { method: 'DELETE', path: '/api/sets/{rid}/coders/{user}', handler: (r) => coding.unassign(p(r).rid, p(r).user, me(r)) },
        { method: 'POST', path: '/api/coding/sets', handler: (r) => coding.createSetsForCoders((r.payload as any)?.source_rid, (r.payload as any)?.coder_rids, me(r), (r.payload as any)?.label) },
        { method: 'POST', path: '/api/sets/{rid}/copy', handler: (r) => coding.copySet(p(r).rid, me(r), (r.payload as any)?.label) },
        {
            method: 'GET',
            path: '/api/projects/{rid}/coding/export',
            handler: async (r, h) => {
                const exported = await coding.exportSegments(p(r).rid, me(r), { roi_set: (r.query as any).roi_set });
                if (String((r.query as any).format || 'json') === 'csv') {
                    return h.response(CodingService.toCsv(exported)).type('text/csv; charset=utf-8').header('content-disposition', 'attachment; filename="coding.csv"');
                }
                return h.response(exported).header('content-disposition', 'attachment; filename="coding.coding.json"');
            },
        },
        // Names only (no e-mail), for choosing a coder.
        {
            method: 'GET',
            path: '/api/users/names',
            handler: async (r) => (await users.list()).filter((u) => u.active !== false && u['@rid'] !== me(r)).map((u) => ({ rid: u['@rid'], name: u.label || 'User' })),
        },

        // ---- coder: only what the grant names ----
        { method: 'GET', path: '/api/coding/sets', handler: (r) => coding.mySets(me(r)) },
        { method: 'GET', path: '/api/coding/sets/{set}/texts', handler: (r) => coding.texts(p(r).set, me(r)) },
        {
            method: 'GET',
            path: '/api/coding/sets/{set}/texts/{text}/content',
            handler: async (r, h) => h.response(await coding.content(p(r).set, p(r).text, me(r))).type('text/plain; charset=utf-8'),
        },
        { method: 'GET', path: '/api/coding/sets/{set}/tags', handler: (r) => coding.deskTags(p(r).set, me(r)) },
        { method: 'GET', path: '/api/coding/sets/{set}/coverage', handler: (r) => coding.coverage(p(r).set, me(r)) },
        { method: 'GET', path: '/api/coding/sets/{set}/texts/{text}/rois', handler: (r) => coding.readRegions(p(r).set, p(r).text, me(r)) },
        { method: 'POST', path: '/api/coding/sets/{set}/texts/{text}/rois', handler: (r) => coding.saveRegions(p(r).set, p(r).text, r.payload, me(r)) },
        { method: 'POST', path: '/api/coding/sets/{set}/texts/{text}/regions/{region}/tags/{tag}', handler: (r) => coding.tagRegion(p(r).set, p(r).text, p(r).region, p(r).tag, me(r)) },
        { method: 'DELETE', path: '/api/coding/sets/{set}/texts/{text}/regions/{region}/tags/{tag}', handler: (r) => coding.untagRegion(p(r).set, p(r).text, p(r).region, p(r).tag, me(r)) },
    ];
}
