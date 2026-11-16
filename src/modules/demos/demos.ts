// The demo store and the operations on it. A demo is a directory under <DATA_DIR>/demos/<id>/
// with meta.json (titles, who may see it, version), bundle.zip (the bundle format, see
// wiki/proposals/demo-project-format.md) and an optional cover image. Re-exporting a demo
// replaces its zip and raises the version; desks already imported from it are not touched.

import Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import type { UserRecord } from '../../platform/http/auth.ts';
import { exists, readJson, writeJson, writeStream } from '../../platform/storage/fsutil.ts';
import type { AccessService } from '../access/access.ts';
import type { ProjectCovers } from '../projects/covers.ts';
import { GROUP_ID } from '../service-groups/service-groups.ts';
import { DemoExporter, writeBundleZip, type DemoText } from './exporter.ts';
import { DemoImporter } from './importer.ts';
import { COVER_TYPES, MAX_COVER_BYTES, readSummary } from './reader.ts';

const DEMO_ID = /^[a-f0-9-]{36}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})?$/;
const META_FILE = 'meta.json';
const BUNDLE_FILE = 'bundle.zip';

export interface DemoMeta {
    id: string;
    version: number;
    title: Record<string, string>;
    description: Record<string, string>;
    /** Empty lists for both mean every user. */
    service_groups: string[];
    users: string[];
    cover: string | null;
    files: number;
    size: number;
    created: string;
    updated: string;
}

export interface DemoInput {
    title?: unknown;
    description?: unknown;
    service_groups?: unknown;
    users?: unknown;
}

function texts(value: unknown, what: string, maxLength: number, required: boolean): Record<string, string> {
    if (value === undefined && !required) return {};
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw Boom.badRequest(`${what} must be an object of language code to text`);
    const entries = Object.entries(value as Record<string, unknown>);
    if (entries.length > 20) throw Boom.badRequest(`Too many languages in ${what}`);
    const out: Record<string, string> = {};
    for (const [language, text] of entries) {
        if (!LANGUAGE.test(language)) throw Boom.badRequest(`Invalid language code in ${what}: ${language}`);
        if (typeof text !== 'string' || text.length > maxLength) throw Boom.badRequest(`Invalid ${what} text for ${language}`);
        if (text.trim()) out[language] = text.trim();
    }
    if (required && !Object.keys(out).length) throw Boom.badRequest(`${what} is required`);
    return out;
}

function list(value: unknown, what: string, valid: (item: string) => boolean): string[] {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.length > 200) throw Boom.badRequest(`${what} must be a list`);
    const out = value.map(String);
    if (!out.every(valid)) throw Boom.badRequest(`Invalid ${what}`);
    return [...new Set(out)];
}

/** Admins see every demo; the others see those shared with everyone, with one of their service groups, or with them. */
export function canSeeDemo(meta: Pick<DemoMeta, 'service_groups' | 'users'>, user: Pick<UserRecord, 'id' | 'access' | 'service_groups'>): boolean {
    if (user.access === 'admin') return true;
    if (!meta.service_groups.length && !meta.users.length) return true;
    if (meta.users.includes(user.id)) return true;
    return (user.service_groups || []).some((group) => meta.service_groups.includes(group));
}

export function publicDemo(meta: DemoMeta): Omit<DemoMeta, 'service_groups' | 'users' | 'cover'> & { has_cover: boolean } {
    const { service_groups: _groups, users: _users, cover, ...rest } = meta;
    return { ...rest, has_cover: Boolean(cover) };
}

export interface DemosOptions {
    dataDir: string;
    access: AccessService;
    covers: ProjectCovers;
    exporter: DemoExporter;
    importer: DemoImporter;
}

export class DemosService {
    private readonly root: string;
    private readonly access: AccessService;
    private readonly covers: ProjectCovers;
    private readonly exporter: DemoExporter;
    private readonly importer: DemoImporter;

    constructor(options: DemosOptions) {
        this.root = path.resolve(options.dataDir, 'demos');
        this.access = options.access;
        this.covers = options.covers;
        this.exporter = options.exporter;
        this.importer = options.importer;
    }

    private dir(id: string): string {
        if (!DEMO_ID.test(id)) throw Boom.notFound('Demo not found');
        return path.join(this.root, id);
    }

    bundlePath(id: string): string {
        return path.join(this.dir(id), BUNDLE_FILE);
    }

    async get(id: string): Promise<DemoMeta> {
        const file = path.join(this.dir(id), META_FILE);
        if (!(await exists(file))) throw Boom.notFound('Demo not found');
        return readJson(file);
    }

    async list(): Promise<DemoMeta[]> {
        let ids: string[];
        try {
            ids = await fsp.readdir(this.root);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
            throw error;
        }
        const all: DemoMeta[] = [];
        for (const id of ids.filter((name) => DEMO_ID.test(name))) {
            try {
                all.push(await this.get(id));
            } catch (error) {
                if (!Boom.isBoom(error)) throw error;
            }
        }
        return all.sort((a, b) => (a.title.en || Object.values(a.title)[0] || '').localeCompare(b.title.en || Object.values(b.title)[0] || ''));
    }

    async listFor(user: UserRecord): Promise<DemoMeta[]> {
        return (await this.list()).filter((meta) => canSeeDemo(meta, user));
    }

    /** A new demo from a desk the admin owns. */
    async createFromProject(projectRid: string, input: DemoInput, admin: UserRecord): Promise<DemoMeta> {
        const text = this.text(input);
        const id = randomUUID();
        const meta = await this.exportInto(id, projectRid, text, admin, null);
        return this.save({ ...meta, ...this.sharing(input), id, version: 1, created: new Date().toISOString() });
    }

    /** A new version from a desk: later imports use it, desks imported earlier stay as they are. */
    async reexport(id: string, projectRid: string, admin: UserRecord): Promise<DemoMeta> {
        const current = await this.get(id);
        const meta = await this.exportInto(id, projectRid, { title: current.title, description: current.description }, admin, current.cover);
        return this.save({ ...current, files: meta.files, size: meta.size, version: current.version + 1 });
    }

    /** A demo from a bundle exported by another instance (or by this one). */
    async createFromUpload(stream: Readable, input: DemoInput): Promise<DemoMeta> {
        const id = randomUUID();
        const dir = this.dir(id);
        await fsp.mkdir(dir, { recursive: true });
        try {
            const target = path.join(dir, BUNDLE_FILE);
            await writeStream(stream, target);
            const { manifest, cover } = await readSummary(target);
            const hasText = input.title !== undefined;
            const text = hasText ? this.text(input) : { title: texts(manifest.title, 'title', 200, true), description: texts(manifest.description, 'description', 5000, false) };
            const coverFile = cover ? `cover.${cover.extension}` : null;
            if (cover) await fsp.writeFile(path.join(dir, coverFile!), cover.data);
            return await this.save({
                ...text, ...this.sharing(input), id, version: 1, cover: coverFile, files: Number(manifest.files) || 0,
                size: (await fsp.stat(target)).size, created: new Date().toISOString(),
            } as DemoMeta);
        } catch (error) {
            await fsp.rm(dir, { recursive: true, force: true });
            throw error;
        }
    }

    async update(id: string, input: DemoInput): Promise<DemoMeta> {
        const current = await this.get(id);
        const next = { ...current };
        if (input.title !== undefined) next.title = texts(input.title, 'title', 200, true);
        if (input.description !== undefined) next.description = texts(input.description, 'description', 5000, false);
        if (input.service_groups !== undefined || input.users !== undefined) {
            const sharing = this.sharing(input);
            if (input.service_groups !== undefined) next.service_groups = sharing.service_groups;
            if (input.users !== undefined) next.users = sharing.users;
        }
        return this.save(next);
    }

    async setCover(id: string, data: Buffer, contentType: string): Promise<DemoMeta> {
        const current = await this.get(id);
        const extension = Object.entries(COVER_TYPES).find(([ext, type]) => type === contentType && ext !== 'jpeg')?.[0];
        if (!extension) throw Boom.unsupportedMediaType('The cover must be a PNG, JPEG or WebP image');
        if (!data.length || data.length > MAX_COVER_BYTES) throw Boom.badRequest('The cover must be an image of at most 2 MB');
        const file = `cover.${extension}`;
        await fsp.writeFile(path.join(this.dir(id), file), data);
        if (current.cover && current.cover !== file) await fsp.rm(path.join(this.dir(id), current.cover), { force: true });
        return this.save({ ...current, cover: file });
    }

    async cover(id: string): Promise<{ file: string; type: string } | null> {
        const meta = await this.get(id);
        if (!meta.cover) return null;
        return { file: path.join(this.dir(id), meta.cover), type: COVER_TYPES[meta.cover.split('.').pop()!] };
    }

    async remove(id: string): Promise<void> {
        await this.get(id);
        await fsp.rm(this.dir(id), { recursive: true, force: true });
    }

    /** Copies the demo into a new desk of the user. */
    async importFor(id: string, user: UserRecord): Promise<{ project: any; nodes: number; files: number }> {
        const meta = await this.get(id);
        if (!canSeeDemo(meta, user)) throw Boom.notFound('Demo not found');
        return this.importer.import({ zipFile: this.bundlePath(id), userRid: user.rid, source: `${id}@${meta.version}` });
    }

    private text(input: DemoInput): DemoText {
        return { title: texts(input.title, 'title', 200, true), description: texts(input.description, 'description', 5000, false) };
    }

    private sharing(input: DemoInput): { service_groups: string[]; users: string[] } {
        return {
            service_groups: list(input.service_groups, 'service_groups', (g) => GROUP_ID.test(g)),
            users: list(input.users, 'users', (u) => u.length > 0 && u.length <= 320),
        };
    }

    private async exportInto(id: string, projectRid: string, text: DemoText, admin: UserRecord, cover: string | null): Promise<Pick<DemoMeta, 'title' | 'description' | 'files' | 'size' | 'updated' | 'cover'>> {
        if (!(await this.access.isProjectOwner(projectRid, admin.rid))) throw Boom.notFound('Project not found');
        const bundle = await this.exporter.build(projectRid, text);
        // A new demo takes the desk's cover; a new version keeps the demo's own.
        if (cover) bundle.cover = { extension: cover.split('.').pop()!, data: await fsp.readFile(path.join(this.dir(id), cover)) };
        else bundle.cover = (await this.covers.imageFor(projectRid)) ?? undefined;
        const target = this.bundlePath(id);
        await writeBundleZip(bundle, target);
        let coverFile = cover;
        if (!cover && bundle.cover) {
            coverFile = `cover.${bundle.cover.extension}`;
            await fsp.writeFile(path.join(this.dir(id), coverFile), bundle.cover.data);
        }
        return { ...text, files: bundle.files.length, size: (await fsp.stat(target)).size, updated: new Date().toISOString(), cover: coverFile };
    }

    private async save(meta: DemoMeta): Promise<DemoMeta> {
        const saved = { ...meta, updated: new Date().toISOString() };
        await writeJson(this.dir(meta.id), META_FILE, saved);
        return saved;
    }
}
