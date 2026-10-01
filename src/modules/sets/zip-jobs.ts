// Set export as a ZIP: the md-zip_fs service builds the archive into <DATA_DIR>/tmp, the UI polls
// the job and downloads it once it exists. Job records are small JSON files next to the archive.

import Boom from '@hapi/boom';
import { randomUUID } from 'node:crypto';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { stripHash } from '../../platform/ids.ts';
import { exists, readJson, writeJson } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { SERVICE } from '../../shared/service-ids.ts';
import type { FilesService } from '../files/files.ts';
import type { Publisher } from '../queue/publisher.ts';

export interface ZipJob {
    id: string;
    set_rid: string;
    user_rid: string;
    status: string;
    requested_at: number;
    zip_output_name: string;
    zip_path: string;
}

export class ZipJobs {
    private readonly layout: DataLayout;
    private readonly files: FilesService;
    private readonly publisher: Publisher;
    private readonly ttlMs: number;

    constructor(layout: DataLayout, files: FilesService, publisher: Publisher, ttlMs: number) {
        this.layout = layout;
        this.files = files;
        this.publisher = publisher;
        this.ttlMs = ttlMs;
    }

    private jobPath(id: string): string {
        return path.resolve(this.layout.tmpDir, `set_zip_job_${id}.json`);
    }

    urls(setRid: string, jobId: string): { status_url: string; download_url: string } {
        const status = `/api/sets/${stripHash(setRid)}/files/zip/jobs/${jobId}`;
        return { status_url: status, download_url: `${status}/download` };
    }

    async create(setRid: string, userRid: string): Promise<ZipJob> {
        const listing = await this.files.setFiles(setRid, userRid, { limit: 10000 });
        if (!listing.files.length) throw Boom.notFound('No files found in set');
        const files = listing.files.filter((f: any) => f.path);
        if (!files.length) throw Boom.notFound('No valid file paths found');
        const id = randomUUID();
        const name = `files_${stripHash(setRid).replace(':', '_')}_${id.slice(0, 8)}.zip`;
        const job: ZipJob = { id, set_rid: setRid, user_rid: userRid, status: 'queued', requested_at: Date.now(), zip_output_name: name, zip_path: path.resolve(this.layout.tmpDir, name) };
        await writeJson(this.layout.tmpDir, `set_zip_job_${id}.json`, job);
        await this.publisher.publish(SERVICE.ZIP, {
            service: { id: SERVICE.ZIP },
            task: { id: 'zip', params: { compression: 0 }, name: 'Zip Set' },
            file: { '@rid': setRid, '@type': 'Set', type: 'set', label: `Set ${setRid}` },
            set_rid: setRid,
            db_name: path.basename(this.layout.dataDir),
            zip_output_name: name,
            set_files: files.map((f: any) => ({ '@rid': f['@rid'], path: f.path, label: f.label, original_filename: f.original_filename })),
            userId: userRid,
        });
        return job;
    }

    async load(setRid: string, userRid: string, jobId: string): Promise<ZipJob | null> {
        if (!/^[a-f0-9-]{36}$/i.test(jobId)) return null;
        const file = this.jobPath(jobId);
        if (!(await exists(file))) return null;
        const job = await readJson(file);
        return job.set_rid === setRid && job.user_rid === userRid ? job : null;
    }

    async status(job: ZipJob): Promise<{ code: number; body: any }> {
        if (await exists(job.zip_path)) return { code: 200, body: { job_id: job.id, status: 'ready', download_url: this.urls(job.set_rid, job.id).download_url } };
        if (Date.now() - job.requested_at > this.ttlMs) {
            await this.cleanup(job);
            return { code: 504, body: { job_id: job.id, status: 'failed', message: 'Zip generation timed out' } };
        }
        return { code: 200, body: { job_id: job.id, status: 'processing' } };
    }

    async ready(job: ZipJob): Promise<boolean> {
        return exists(job.zip_path);
    }

    async cleanup(job: ZipJob): Promise<void> {
        await Promise.allSettled([fsp.unlink(job.zip_path), fsp.unlink(this.jobPath(job.id))]);
    }
}
