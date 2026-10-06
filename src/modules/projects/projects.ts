// Projects ("desks"): create, list, rename, delete, sizes and the storage summary.

import Boom from '@hapi/boom';
import { cypherString, type ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { directorySizeBytes, ensureDir } from '../../platform/storage/fsutil.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';

const MAX_POSITION = 10000;

export class ProjectsService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly expirationDays: number;
    private readonly quotaGb: number;

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout, access: AccessService, opts: { expirationDays: number; quotaGb: number }) {
        this.db = db;
        this.store = store;
        this.layout = layout;
        this.access = access;
        this.expirationDays = opts.expirationDays;
        this.quotaGb = opts.quotaGb;
    }

    private async countByLabel(label: string, userRid: string): Promise<number> {
        if (this.db.legacy) {
            const res = await this.db.cypher(
                `MATCH (pr:Project)-[:HAS_OWNER]->(p:User) WHERE id(p) = ${cypherString(toRid(userRid))} AND pr.label = ${cypherString(label)} RETURN count(pr) as projects`,
            );
            return Number(res.result[0]?.projects || 0);
        }
        const row = await this.db.first(
            'SELECT count(*) AS projects FROM (SELECT expand(in("HAS_OWNER")) FROM :user) WHERE @type = "Project" AND label = :label',
            { user: toRid(userRid), label },
        );
        return Number(row?.projects || 0);
    }

    async create(data: Record<string, any>, userRid: string): Promise<any> {
        if (!data?.label) throw Boom.badRequest('label required');
        if (await this.countByLabel(data.label, userRid) > 0) throw Boom.conflict('Project with that name exists!');
        const expiration = new Date();
        expiration.setDate(expiration.getDate() + this.expirationDays);
        const project = await this.store.createVertex('Project', { ...data, expiration_date: expiration.toISOString().slice(0, 10) });
        await this.store.connect(project['@rid'], EDGE.HAS_OWNER, userRid);
        const dir = this.layout.projectDir(project['@rid']);
        for (const sub of ['files', 'processes', 'sets', 'sources']) await ensureDir(`${dir}/${sub}`);
        return project;
    }

    private async ownedProjects(userRid: string): Promise<any[]> {
        if (this.db.legacy) {
            const res = await this.db.cypher(`MATCH (pr:Project)-[r:HAS_OWNER]->(p:User) WHERE id(p) = ${cypherString(toRid(userRid))} RETURN pr`);
            // Cypher rows come back either nested ({pr: {...}}) or flat, with values sometimes wrapped in arrays.
            return (res.result || []).map((item: any) => {
                const pr = item?.pr && typeof item.pr === 'object' && !Array.isArray(item.pr) ? item.pr : item || {};
                const unwrap = (v: any) => (Array.isArray(v) ? (v[0] ?? null) : v);
                return { ...pr, '@rid': unwrap(pr['@rid']), label: unwrap(pr.label), name: unwrap(pr.name) };
            });
        }
        const rows = await this.db.rows('SELECT FROM (SELECT expand(in("HAS_OWNER")) FROM :user) WHERE @type = "Project"', { user: toRid(userRid) });
        return rows.map((row) => {
            const { '@cat': _cat, ...rest } = row;
            return rest;
        });
    }

    async list(userRid: string): Promise<any[]> {
        // A desk being deleted in the background is already gone for the user.
        const projects = (await this.ownedProjects(userRid)).filter((pr) => !pr._deleting);
        const data = [];
        for (const pr of projects) {
            let nodeCount = 0;
            let fileCount = 0;
            if (pr['@rid']) {
                const rows = await this.db.rows(
                    `MATCH {type:User, as:user, where:(@rid = :user)}<-HAS_OWNER-{type:Project, as:project, where:(@rid = :project)}.in()
                     {as:node, where:((@type="Set" OR @type="File" OR @type="Process" OR @type="SetProcess" OR @type="Source" OR @type="Filter") AND $depth > 0), while:($depth < 40)}
                     RETURN DISTINCT node.@rid AS rid, node.@type AS type`,
                    { user: toRid(userRid), project: toRid(pr['@rid']) },
                );
                nodeCount = rows.length;
                fileCount = rows.filter((r) => r.type === 'File').length;
            }
            data.push({ ...pr, node_count: nodeCount, file_count: fileCount });
        }
        data.sort((a, b) => {
            const x = String(a?.label || a?.name || '').toUpperCase();
            const y = String(b?.label || b?.name || '').toUpperCase();
            return x < y ? -1 : x > y ? 1 : 0;
        });
        return data;
    }

    async setAttribute(projectRid: string, data: { key?: string; value?: any }, userRid: string): Promise<any> {
        const rid = toRid(projectRid);
        if (!(await this.access.isProjectOwner(rid, userRid))) throw Boom.badRequest('You are not the owner of this project');
        if (data?.key === 'position') {
            const pos = data.value;
            if (typeof pos !== 'object' || pos === null || pos.x === undefined || pos.y === undefined) throw Boom.badRequest('Invalid position');
            for (const axis of ['x', 'y']) {
                const v = pos[axis];
                if (!Number.isInteger(v) || v > MAX_POSITION || v < -MAX_POSITION) {
                    throw Boom.badRequest(`Position ${axis} must be an integer between -${MAX_POSITION} and ${MAX_POSITION}`);
                }
            }
            return this.db.sql(`UPDATE ${rid} SET position = :position`, { position: { x: pos.x, y: pos.y } });
        }
        if (data?.key === 'description' || data?.key === 'label') {
            await this.db.sql(`UPDATE Project SET ${data.key} = :value WHERE @rid = :rid`, { value: data.value, rid });
            // The old route answered with the empty Vue Flow conversion of the update.
            return { nodes: [], edges: [] };
        }
        throw Boom.badRequest('Invalid data');
    }

    async updateSizes(userRid: string): Promise<any> {
        const projects = await this.ownedProjects(userRid);
        const updated = [];
        for (const project of projects) {
            const rid = project['@rid'];
            if (!rid) continue;
            const bytes = await directorySizeBytes(this.layout.projectDir(rid));
            const size = Math.round((bytes / 1024 / 1024) * 100) / 100;
            await this.db.sql('UPDATE Project SET size = :size WHERE @rid = :rid', { size, rid: toRid(rid) });
            updated.push({ rid, size, bytes });
        }
        return { updated: updated.length, projects: updated };
    }

    async storageSummary(userRid: string): Promise<any> {
        const projects = await this.list(userRid);
        let totalMb = 0;
        for (const p of projects) {
            const mb = Number(p.size_mb ?? p.sizeMB ?? p.sizeMb ?? p.total_size_mb ?? p.total_mb ?? p.size ?? 0);
            if (Number.isFinite(mb)) totalMb += mb;
        }
        const quotaMb = this.quotaGb * 1024;
        return {
            used_mb: Math.round(totalMb * 100) / 100,
            quota_gb: this.quotaGb,
            quota_mb: quotaMb,
            used_percent: Math.min(100, Math.round((totalMb / quotaMb) * 10000) / 100),
        };
    }
}
