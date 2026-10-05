// The one place that decides whether a user may see a node.
//
// A node belongs to a user when following its outgoing DERIVED_FROM and BELONGS_TO edges reaches
// a Project that HAS_OWNER the user. Uploaded files, sets and processes point at the project with
// BELONGS_TO; outputs, output sets, ROIs and error nodes point at their source with DERIVED_FROM.
// This is the same reachability the old backend checked in four different ways.

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';

export interface OwnedNode {
    node: any;
    projectRid: string;
}

export class AccessService {
    private readonly db: ArcadeClient;

    constructor(db: ArcadeClient) {
        this.db = db;
    }

    /** The node and its project when the user owns it, otherwise null. Invalid rids give null. */
    async findOwned(rid: unknown, userRid: string): Promise<OwnedNode | null> {
        const clean = tryRid(rid);
        if (!clean || !userRid) return null;
        // Walk up from the node (outgoing edges, up to 40 levels) to the projects it belongs to
        // and check their owners. The same reachability as matching from the user's projects
        // downwards, which read the user's whole graph on every request.
        const user = toRid(userRid);
        let projects: Array<{ rid: string; owners: unknown }>;
        try {
            projects = await this.db.rows(`SELECT @rid AS rid, out('HAS_OWNER').@rid AS owners FROM (TRAVERSE out() FROM ${clean} MAXDEPTH 40) WHERE @type = 'Project'`);
        } catch (error) {
            if (/not found/i.test(`${(error as Error)?.message} ${(error as any)?.detail}`)) return null;
            throw error;
        }
        const project = projects.find((p) => Array.isArray(p.owners) && p.owners.map(String).includes(user));
        if (!project) return null;
        const node = await this.db.first(`SELECT FROM ${clean}`);
        if (!node) return null;
        return { node, projectRid: project.rid };
    }

    async canRead(rid: unknown, userRid: string): Promise<boolean> {
        return (await this.findOwned(rid, userRid)) !== null;
    }

    /** Throws 404 (not 403, so other users' rids are not confirmed to exist). */
    async requireOwned(rid: unknown, userRid: string, what = 'Node'): Promise<OwnedNode> {
        const owned = await this.findOwned(rid, userRid);
        if (!owned) throw Boom.notFound(`${what} not found`);
        return owned;
    }

    async isProjectOwner(projectRid: unknown, userRid: string): Promise<boolean> {
        const clean = tryRid(projectRid);
        if (!clean) return false;
        const row = await this.db.first(
            `MATCH {type:Project, as:project, where:(@rid = :rid)}-HAS_OWNER->{type:User, as:p, where:(@rid = :user)} RETURN project.@rid AS rid`,
            { rid: clean, user: toRid(userRid) },
        );
        return Boolean(row?.rid);
    }
}
