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
        const row = await this.db.first(
            `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project}<--{as:node, where:(@rid = :rid), while:($depth < 40)} RETURN node, project.@rid AS project_rid LIMIT 1`,
            { user: toRid(userRid), rid: clean },
        );
        if (row?.node) return { node: row.node, projectRid: row.project_rid };
        // A project itself.
        const project = await this.db.first(
            `MATCH {type:Project, as:project, where:(@rid = :rid)}-HAS_OWNER->{type:User, where:(@rid = :user)} RETURN project`,
            { user: toRid(userRid), rid: clean },
        );
        if (project?.project) return { node: project.project, projectRid: project.project['@rid'] };
        return null;
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
