// Thumbnails: the jobs that make them and serving them.
//
// A file's previews live next to it: <file dir>/preview.jpg (large) and thumbnail.jpg (small).
// Images go to the md-thumbnailer topic, PDFs to md-poppler (uploads, versions and split pages;
// (split pages). Each job variant keeps the exact fields the old backend sent, because consumers
// and the result handler recognise them by role / process.kind / topic.

import fs from 'node:fs';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { exists } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { PDF_THUMBNAIL_PARAMS, ROLE, SERVICE, THUMBNAIL_PARAMS } from '../../shared/service-ids.ts';
import type { Publisher } from '../queue/publisher.ts';

export class ThumbnailService {
    private readonly publisher: Publisher;
    private readonly layout: DataLayout;

    constructor(publisher: Publisher, layout: DataLayout) {
        this.publisher = publisher;
        this.layout = layout;
    }

    /** After an upload: thumbnail an image, or first fix its EXIF rotation (which then thumbnails it). */
    async forUpload(file: any, userRid: string, rotate?: number): Promise<void> {
        if (rotate) {
            await this.publisher.publish(SERVICE.SHARP, {
                topic: { id: SERVICE.SHARP },
                service: { id: SERVICE.SHARP },
                task: { id: 'rotate', params: { rotate: `${rotate}`, stripmeta: 'true' } },
                file,
                userId: userRid,
                role: ROLE.INTERNAL_VERSIONING,
                process: { kind: 'internal_versioning' },
            });
            return;
        }
        await this.publisher.publish(SERVICE.THUMBNAILER, {
            topic: { id: SERVICE.THUMBNAILER },
            service: { id: SERVICE.THUMBNAILER },
            task: { id: 'thumbnail', params: { ...THUMBNAIL_PARAMS } },
            file,
            userId: userRid,
        });
    }

    /** After the EXIF rotation result replaced the original. */
    async afterRotate(file: any, userRid: string): Promise<void> {
        await this.publisher.publish(SERVICE.THUMBNAILER, {
            topic: { id: SERVICE.THUMBNAILER },
            service: { id: SERVICE.THUMBNAILER },
            task: { id: 'thumbnail', params: { ...THUMBNAIL_PARAMS } },
            file,
            userId: userRid,
            role: ROLE.INTERNAL_VERSIONING,
            process: { kind: 'internal_versioning' },
        });
    }

    /** After a file version or revert. Returns false for types without thumbnails. */
    async refresh(file: any, userRid: string): Promise<boolean> {
        if (file?.type === 'image') {
            await this.publisher.publish(SERVICE.THUMBNAILER, {
                file,
                userId: userRid,
                role: ROLE.INTERNAL_VERSIONING,
                process: { kind: 'internal_versioning' },
                target: file['@rid'],
                task: { id: 'thumbnail', params: { ...THUMBNAIL_PARAMS } },
                id: SERVICE.THUMBNAILER,
            });
            return true;
        }
        if (file?.type === 'pdf') {
            await this.publisher.publish(SERVICE.POPPLER, {
                file,
                userId: userRid,
                process: { kind: 'internal_versioning' },
                target: file['@rid'],
                task: { id: 'thumbnail', params: { ...PDF_THUMBNAIL_PARAMS } },
                role: ROLE.THUMBNAIL,
                id: SERVICE.POPPLER,
            });
            return true;
        }
        return false;
    }

    /** POST /api/files/{rid}/thumbnail. */
    async request(file: any, userRid: string): Promise<void> {
        if (file.type === 'image') {
            await this.publisher.publish(SERVICE.THUMBNAILER, {
                file,
                userId: userRid,
                target: file['@rid'],
                task: { id: 'thumbnail', params: { ...THUMBNAIL_PARAMS } },
                service: { id: SERVICE.THUMBNAILER },
                id: SERVICE.THUMBNAILER,
            });
        } else if (file.type === 'pdf') {
            await this.publisher.publish(SERVICE.POPPLER, {
                file,
                userId: userRid,
                target: file['@rid'],
                task: { id: 'thumbnail', params: { ...PDF_THUMBNAIL_PARAMS } },
                role: ROLE.THUMBNAIL,
                service: { id: SERVICE.POPPLER },
                id: SERVICE.POPPLER,
            });
        }
    }

    /** For an image produced by a process. */
    async forOutputImage(fileNode: any, message: any): Promise<void> {
        await this.publisher.publish(SERVICE.THUMBNAILER, {
            topic: { id: SERVICE.THUMBNAILER },
            service: { id: SERVICE.THUMBNAILER },
            task: { id: 'thumbnail', params: { ...THUMBNAIL_PARAMS } },
            file: fileNode,
            userId: message.userId,
            total_files: message.total_files,
            current_file: message.current_file,
            output_set: message.output_set,
            process: message.process,
            set_process: message.set_process,
            role: ROLE.THUMBNAIL,
        });
    }

    /** For a page produced by the PDF splitter. */
    async forSplitPage(fileNode: any, message: any): Promise<void> {
        await this.publisher.publish(SERVICE.POPPLER, {
            service: { id: SERVICE.POPPLER },
            task: { id: 'thumbnail', params: { ...PDF_THUMBNAIL_PARAMS, task: 'thumbnail' } },
            file: fileNode,
            process: message.process,
            output_set: message.output_set,
            userId: message.userId,
            role: ROLE.THUMBNAIL,
            total_files: message.total_files,
            current_file: message.current_file,
        });
    }

    /**
     * The file behind GET /api/thumbnails/{path}. `param` is the file's directory (preview.jpg is
     * served) or the directory plus "preview.jpg"/"thumbnail.jpg"; a missing thumbnail.jpg falls
     * back to preview.jpg. Returns null when nothing is there yet or the path leaves DATA_DIR.
     */
    async resolve(param: string): Promise<string | null> {
        if (!param) return null;
        let base = path.dirname(param);
        const name = path.basename(param);
        let thumb = 'preview.jpg';
        if (name.includes('.')) {
            if (name === 'preview.jpg' || name === 'thumbnail.jpg') thumb = name;
        } else {
            base = path.join(base, name);
        }
        base = base.replace('/api/thumbnails/', './');
        let full = path.join(base, thumb);
        if (!this.layout.contains(full)) return null;
        if (await exists(full)) return full;
        if (thumb === 'thumbnail.jpg') {
            full = path.join(base, 'preview.jpg');
            if (await exists(full)) return full;
        }
        return null;
    }

    /**
     * The File node a thumbnail directory belongs to: the last directory segment is the file's
     * uuid without dashes (or "<cluster>/<block>/<position>" for old RID-based paths).
     */
    fileIdForDir(thumbnailPath: string): { uuid?: string; rid?: string } | null {
        const dir = path.dirname(thumbnailPath).split(path.sep);
        const last = dir[dir.length - 1] || '';
        if (/^[0-9a-f]{32}$/i.test(last)) {
            const h = last.toLowerCase();
            return { uuid: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}` };
        }
        const [cluster, , position] = dir.slice(-3);
        if (/^\d+$/.test(cluster || '') && /^\d+$/.test(position || '')) return { rid: `#${cluster}:${position}` };
        return null;
    }

    stream(filePath: string): Readable {
        return fs.createReadStream(filePath);
    }
}
