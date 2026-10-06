// Service groups: admin-managed ids that gate which users see which services and tasks
// (`service_groups` in service.json and on User). A group can have a logo, resized to 200x200 by
// calling md-sharp's /process directly (a one-off admin action, not a queued job). A group can
// also have token limits for the LLM services it gives access to (usage/token-budget.ts).

import Boom from '@hapi/boom';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import type { GraphStore } from '../../shared/graph-store.ts';
import { SERVICE } from '../../shared/service-ids.ts';
import type { ServiceRegistry } from '../services/registry.ts';
import { normalizeTokenLimits, parseStoredLimits } from '../usage/token-budget.ts';

export const GROUP_ID = /^[A-Za-z0-9_-]{1,64}$/;
const FIELDS = '@rid AS rid, id, name, description, logo, logo_version, token_limits';

function withLimits(row: any): any {
    if (!row) return row;
    return { ...row, token_limits: parseStoredLimits(row.token_limits) };
}
export const ALLOWED_LOGO_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };

export class ServiceGroupsService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly registry: ServiceRegistry;
    private readonly dataDir: string;

    constructor(db: ArcadeClient, store: GraphStore, registry: ServiceRegistry, dataDir: string) {
        this.db = db;
        this.store = store;
        this.registry = registry;
        this.dataDir = dataDir;
    }

    static requireId(id: unknown): string {
        if (!GROUP_ID.test(String(id || ''))) throw Boom.badRequest('Invalid service group id');
        return String(id);
    }

    logoDir(id: string): string {
        return path.resolve(this.dataDir, 'uploads', 'service-groups', ServiceGroupsService.requireId(id));
    }

    async list(): Promise<any[]> {
        return (await this.db.rows(`SELECT ${FIELDS} FROM ServiceGroup ORDER BY id`)).map(withLimits);
    }

    async get(id: string): Promise<any | null> {
        return withLimits(await this.db.first(`SELECT ${FIELDS} FROM ServiceGroup WHERE id = :id`, { id: String(id) }));
    }

    async create(data: any): Promise<any> {
        const id = String(data?.id || '').trim();
        if (!id) throw Boom.badRequest('ServiceGroup id is required');
        if (!GROUP_ID.test(id)) throw Boom.badRequest('ServiceGroup id may only contain letters, numbers, "_" and "-"');
        if (await this.get(id)) throw Boom.badRequest(`ServiceGroup "${id}" already exists`);
        const content: Record<string, unknown> = { id, name: data.name ? String(data.name) : id };
        if (data.description) content.description = String(data.description);
        const limits = normalizeTokenLimits(data.token_limits);
        if (limits) content.token_limits = limits;
        await this.db.first('CREATE VERTEX ServiceGroup CONTENT :content', { content });
        return this.get(id);
    }

    async update(id: string, patch: any = {}): Promise<any> {
        const group = await this.get(id);
        if (!group) throw Boom.badRequest(`ServiceGroup "${id}" not found`);
        for (const key of ['name', 'description', 'logo']) {
            if (patch[key] !== undefined) await this.store.setAttribute(group.rid, key, String(patch[key]));
        }
        if (patch.token_limits !== undefined) {
            const limits = normalizeTokenLimits(patch.token_limits);
            await this.db.sql(`UPDATE ${group.rid} ${limits ? 'SET token_limits = :limits' : 'REMOVE token_limits'}`, limits ? { limits } : undefined);
        }
        return this.get(id);
    }

    async remove(id: string): Promise<void> {
        const group = await this.get(id);
        if (!group) throw Boom.badRequest(`ServiceGroup "${id}" not found`);
        await this.db.sql(`DELETE FROM ${group.rid}`);
        await fsp.rm(this.logoDir(id), { recursive: true, force: true });
    }

    async uploadLogo(id: string, filePath: string, contentType: string): Promise<any> {
        ServiceGroupsService.requireId(id);
        const group = await this.get(id);
        if (!group) throw Boom.notFound(`ServiceGroup "${id}" not found`);
        const extension = ALLOWED_LOGO_TYPES[contentType];
        if (!extension) throw Boom.badRequest('Logo must be a PNG, JPEG or WEBP image');
        const sharp = this.registry.get(SERVICE.SHARP);
        const baseUrl = String(sharp?.url || sharp?.local_url || '').replace(/\/$/, '');
        if (!baseUrl) throw Boom.serverUnavailable('md-sharp service is not registered');
        const form = new FormData();
        form.append('message', new Blob([JSON.stringify({ task: { id: 'fit', params: { width: 200, height: 200, type: 'png' } } })], { type: 'application/json' }), 'message.json');
        form.append('content', new Blob([await fsp.readFile(filePath)], { type: contentType }), `source.${extension}`);
        const processed = await fetch(`${baseUrl}/process`, { method: 'POST', body: form });
        if (!processed.ok) throw Boom.badGateway(`md-sharp resize failed (${processed.status})`);
        const uri = (await processed.json() as any)?.response?.uri?.[0]?.uri;
        if (!uri) throw Boom.badGateway('md-sharp returned no output');
        const image = await fetch(`${baseUrl}${uri}`);
        if (!image.ok) throw Boom.badGateway('Failed to fetch resized logo from md-sharp');
        const dir = this.logoDir(id);
        await fsp.rm(dir, { recursive: true, force: true });
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, 'logo.png'), Buffer.from(await image.arrayBuffer()));
        await this.store.setAttributes(group.rid, { logo: 'logo.png', logo_version: Number(group.logo_version || 0) + 1 });
        return this.get(id);
    }
}
