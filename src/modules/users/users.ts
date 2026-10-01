// Users, the current user, UI settings and permission requests.

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import type { UserRecord } from '../../platform/http/auth.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import type { GraphStore } from '../../shared/graph-store.ts';

export const DEFAULT_USER = 'local.user@localhost';
const EMAIL = /^[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}$/;
const USER_FIELDS = '@rid AS rid, group, access, service_groups, label, id, active, settings';

export class UsersService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly onCreated: (userRid: string) => Promise<void>;

    constructor(db: ArcadeClient, store: GraphStore, onCreated: (userRid: string) => Promise<void>) {
        this.db = db;
        this.store = store;
        this.onCreated = onCreated;
    }

    /** Looks a user up by e-mail, or by RID when the value starts with '#' (consumers send RIDs). */
    async find(mailOrRid: string): Promise<UserRecord | null> {
        if (!mailOrRid) return null;
        if (mailOrRid.startsWith('#')) {
            const rid = tryRid(mailOrRid);
            if (!rid) return null;
            return this.db.first<UserRecord>(`SELECT ${USER_FIELDS} FROM User WHERE @rid = :rid`, { rid });
        }
        return this.db.first<UserRecord>(`SELECT ${USER_FIELDS} FROM User WHERE id = :id`, { id: mailOrRid });
    }

    list(): Promise<any[]> {
        return this.db.rows('SELECT FROM User ORDER BY label');
    }

    async create(data: Record<string, any>): Promise<any> {
        const id = data?.id;
        if (!id) throw Boom.badRequest('Email not defined!');
        if (id !== DEFAULT_USER && !EMAIL.test(id)) throw Boom.badRequest('Invalid email address!');
        const existing = await this.db.first('SELECT count(*) AS users FROM User WHERE id = :id', { id });
        if (Number(existing?.users) > 0) throw Boom.conflict('User with that email already exists!');
        const content: Record<string, unknown> = { ...data };
        if (!content.group) content.group = 'user';
        if (!content.access) content.access = 'user';
        if (!content.service_groups) content.service_groups = ['OSC'];
        const user = await this.store.createVertex('User', content);
        await this.onCreated(user['@rid']);
        return user;
    }

    async ensureDefaultAdmin(): Promise<void> {
        if (await this.find(DEFAULT_USER)) return;
        await this.create({ id: DEFAULT_USER, label: 'Just human', access: 'admin', active: true });
    }

    async setServiceGroups(userRid: string, groups: unknown): Promise<any> {
        const rid = toRid(userRid);
        const clean = Array.isArray(groups) ? groups.map((g) => String(g).trim()).filter(Boolean) : [];
        await this.store.setAttribute(rid, 'service_groups', clean);
        return this.db.first('SELECT @rid AS rid, service_groups FROM User WHERE @rid = :rid', { rid });
    }

    async updateSettings(userRid: string, patch: Record<string, string>): Promise<Record<string, unknown>> {
        const rid = toRid(userRid);
        const current = await this.db.first('SELECT settings FROM User WHERE @rid = :rid', { rid });
        if (!current) throw Boom.notFound('User not found');
        const settings = { ...(current.settings || {}), ...patch };
        await this.db.sql(`UPDATE ${rid} SET settings = :settings`, { settings });
        return settings;
    }

    // ---- permission requests (people with an SSO identity but no MessyDesk account) -----

    listRequests(): Promise<any[]> {
        return this.db.rows('SELECT FROM Request');
    }

    async deleteRequest(rid: string): Promise<any> {
        return this.db.sql('DELETE FROM Request WHERE @rid = :rid', { rid: toRid(rid) });
    }

    async addRequest(mail: string, name: string): Promise<void> {
        const pending = await this.db.first('SELECT count(*) AS n FROM Request WHERE id = :id', { id: mail });
        const user = await this.find(mail);
        if (Number(pending?.n) > 0 || user) throw Boom.conflict('User has already requested or has access');
        await this.store.createVertex('Request', { id: mail, label: name, date: '[TIMESTAMP]' });
    }
}
