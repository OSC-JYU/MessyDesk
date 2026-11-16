// Desk covers: the picture a desk has on the front page and in the demo list.
//
// A desk has at most one of two settings on its Project node:
//   cover_upload  the name of an image kept in the project directory (cover.png), set by an upload
//   cover_file    the RID of an image file of the desk, whose thumbnail is the cover
// With neither, the first image of the desk is the cover. `cover_version` changes with every
// change so that browsers load the new picture.

import Boom from '@hapi/boom';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import { projectRidVariants } from '../../platform/solr/solr.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import type { GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';

export const COVER_TYPES: Record<string, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' };
export const MAX_COVER_BYTES = 2 * 1024 * 1024;
const MIME_OF_EXTENSION: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', webp: 'image/webp' };
const COVER_FILE = /^cover\.(png|jpg|webp)$/;

export interface Cover {
    kind: 'upload' | 'file' | 'first-image';
    url: string;
    /** The image file behind a cover of kind file or first-image. */
    file?: string;
}

export class ProjectCovers {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly apiUrl: string;

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout, access: AccessService, apiUrl: string) {
        this.db = db;
        this.store = store;
        this.layout = layout;
        this.access = access;
        this.apiUrl = apiUrl;
    }

    private thumbnailUrl(filePath: string): string {
        return `${this.apiUrl}api/thumbnails/${filePath.split('/').slice(0, -1).join('/')}`;
    }

    /** The cover of each project (null for a desk without an image), in the order of the projects. */
    async describe(projects: any[]): Promise<Array<Cover | null>> {
        const covers: Array<Cover | null> = [];
        for (const project of projects) covers.push(await this.coverOf(project));
        return covers;
    }

    private async coverOf(project: any): Promise<Cover | null> {
        const rid = String(project['@rid']);
        if (project.cover_upload && COVER_FILE.test(project.cover_upload)) {
            return { kind: 'upload', url: `${this.apiUrl}api/projects/${rid.replace('#', '')}/cover?v=${project.cover_version || 0}` };
        }
        if (project.cover_file) {
            const file = await this.db.firstByRid<any>('@rid, path', project.cover_file, "@type = 'File' AND _deleting IS NULL");
            if (file?.path) return { kind: 'file', url: this.thumbnailUrl(file.path), file: String(file['@rid']) };
        }
        const first = await this.db.first<any>(
            "SELECT @rid AS rid, path FROM File WHERE project_rid IN :projects AND type = 'image' AND _deleting IS NULL ORDER BY created LIMIT 1",
            { projects: projectRidVariants(rid) },
        );
        return first?.path ? { kind: 'first-image', url: this.thumbnailUrl(first.path), file: String(first.rid) } : null;
    }

    async setUpload(projectRid: string, data: Buffer, contentType: string, userRid: string): Promise<void> {
        const rid = await this.owned(projectRid, userRid);
        const extension = COVER_TYPES[contentType];
        if (!extension) throw Boom.unsupportedMediaType('The cover must be a PNG, JPEG or WebP image');
        if (!data.length || data.length > MAX_COVER_BYTES) throw Boom.badRequest('The cover must be an image of at most 2 MB');
        await this.removeUpload(rid);
        const name = `cover.${extension}`;
        const dir = this.layout.projectDir(rid);
        await fsp.mkdir(dir, { recursive: true });
        await fsp.writeFile(path.join(dir, name), data);
        await this.store.setAttributes(rid, { cover_upload: name, cover_version: Date.now() });
        await this.store.removeAttribute(rid, 'cover_file');
    }

    /** Uses the thumbnail of an image file of the desk as the cover. */
    async setFile(projectRid: string, fileRid: unknown, userRid: string): Promise<void> {
        const rid = await this.owned(projectRid, userRid);
        const owned = await this.access.findOwned(fileRid, userRid);
        if (!owned || owned.projectRid !== rid || owned.node['@type'] !== 'File') throw Boom.notFound('File not found');
        if (owned.node.type !== 'image') throw Boom.badRequest('The cover must be an image file');
        await this.removeUpload(rid);
        await this.store.setAttributes(rid, { cover_file: toRid(owned.node['@rid']), cover_version: Date.now() });
        await this.store.removeAttribute(rid, 'cover_upload');
    }

    /** Back to the default: the first image of the desk. */
    async reset(projectRid: string, userRid: string): Promise<void> {
        const rid = await this.owned(projectRid, userRid);
        await this.removeUpload(rid);
        await this.store.removeAttribute(rid, 'cover_upload');
        await this.store.removeAttribute(rid, 'cover_file');
        await this.store.setAttribute(rid, 'cover_version', Date.now());
    }

    /** The uploaded cover image, for GET /api/projects/{rid}/cover. */
    async uploaded(projectRid: string, userRid: string): Promise<{ file: string; type: string } | null> {
        const rid = await this.owned(projectRid, userRid);
        const project = await this.db.firstByRid<any>('cover_upload', rid, "@type = 'Project'");
        const name = project?.cover_upload;
        if (!name || !COVER_FILE.test(name)) return null;
        return { file: path.join(this.layout.projectDir(rid), name), type: MIME_OF_EXTENSION[name.split('.')[1]] };
    }

    /** The image for a demo made from this desk: the upload, or the thumbnail of the cover file. */
    async imageFor(projectRid: string): Promise<{ extension: string; data: Buffer } | null> {
        const rid = toRid(projectRid);
        const project = await this.db.firstByRid<any>('*', rid, "@type = 'Project'");
        if (!project) return null;
        const cover = await this.coverOf(project);
        try {
            if (cover?.kind === 'upload') {
                return { extension: project.cover_upload.split('.')[1], data: await fsp.readFile(path.join(this.layout.projectDir(rid), project.cover_upload)) };
            }
            if (cover?.file) {
                const file = await this.db.firstByRid<any>('path', cover.file, "@type = 'File'");
                return { extension: 'jpg', data: await fsp.readFile(path.join(path.dirname(file.path), 'thumbnail.jpg')) };
            }
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        return null;
    }

    private async owned(projectRid: string, userRid: string): Promise<string> {
        const rid = toRid(projectRid);
        if (!(await this.access.isProjectOwner(rid, userRid))) throw Boom.notFound('Project not found');
        return rid;
    }

    private async removeUpload(rid: string): Promise<void> {
        const dir = this.layout.projectDir(rid);
        for (const extension of Object.values(COVER_TYPES)) await fsp.rm(path.join(dir, `cover.${extension}`), { force: true });
    }
}
