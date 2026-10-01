// The data directory layout (unchanged from the old backend):
//
//   <DATA_DIR>/projects/<project rid as 12_3>/{files,processes,sets,sources}/<shard>/...
//
// where <shard> for a UUIDv7 is "aa/bb/cc/<uuid without dashes>" (the first bytes are the
// timestamp, so files created close together share directories) and for a legacy RID is
// "<cluster>/<position div 1000>/<position>".

import path from 'node:path';
import { isUuid, ridToPathPart } from '../ids.ts';

export class DataLayout {
    readonly dataDir: string;

    constructor(dataDir: string) {
        this.dataDir = dataDir;
    }

    get tmpDir(): string {
        return path.resolve(this.dataDir, 'tmp');
    }

    get logsDir(): string {
        return path.join(this.dataDir, 'logs');
    }

    projectDir(projectRid: string | null | undefined): string {
        if (!projectRid) return this.dataDir;
        return path.join(this.dataDir, 'projects', ridToPathPart(projectRid));
    }

    static shard(identifier: string): string {
        if (isUuid(identifier)) {
            const id = identifier.toLowerCase().replace(/-/g, '');
            return path.join(id.slice(0, 2), id.slice(2, 4), id.slice(4, 6), id);
        }
        const [bucketStr, posStr] = identifier.replace('#', '').split(':');
        const bucket = Number(bucketStr);
        const pos = Number(posStr);
        if (Number.isNaN(bucket) || Number.isNaN(pos)) throw new Error('Invalid RID format');
        return path.join(String(bucket), String(Math.floor(pos / 1000)), String(pos));
    }

    fileDir(projectRid: string | null | undefined, id: string): string {
        return path.join(this.projectDir(projectRid), 'files', DataLayout.shard(id));
    }

    processDir(projectRid: string | null | undefined, id: string): string {
        return path.join(this.projectDir(projectRid), 'processes', DataLayout.shard(id));
    }

    /** Where a process keeps its output files; the Process node's `path` points here. */
    processFilesDir(projectRid: string | null | undefined, id: string): string {
        return path.join(this.processDir(projectRid, id), 'files');
    }

    setDir(projectRid: string | null | undefined, id: string): string {
        return path.join(this.projectDir(projectRid), 'sets', DataLayout.shard(id));
    }

    sourceDir(projectRid: string | null | undefined, id: string): string {
        return path.join(this.projectDir(projectRid), 'sources', DataLayout.shard(id));
    }

    filePath(projectRid: string | null | undefined, id: string, extension: string): string {
        const ext = (extension || '').replace('.', '').toLowerCase();
        const base = isUuid(id) ? id.toLowerCase().replace(/-/g, '') : ridToPathPart(id);
        return path.join(this.fileDir(projectRid, id), ext ? `${base}.${ext}` : base);
    }

    /** True when `candidate` resolves inside the data directory. */
    contains(candidate: string): boolean {
        const root = path.resolve(this.dataDir);
        const resolved = path.resolve(candidate);
        return resolved === root || resolved.startsWith(root + path.sep);
    }
}
