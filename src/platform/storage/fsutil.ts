// Small file system helpers shared by the modules.

import fs from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import type { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

export async function exists(p: string): Promise<boolean> {
    try {
        await fsp.access(p);
        return true;
    } catch {
        return false;
    }
}

export async function ensureDir(dir: string): Promise<void> {
    await fsp.mkdir(dir, { recursive: true });
}

/** Reads and parses JSON; returns {} when the file is missing or broken (old behaviour). */
export async function readJsonOrEmpty(p: string): Promise<any> {
    try {
        return JSON.parse(await fsp.readFile(p, 'utf8'));
    } catch {
        return {};
    }
}

/** Reads and parses JSON, throwing on failure. */
export async function readJson(p: string): Promise<any> {
    return JSON.parse(await fsp.readFile(p, 'utf8'));
}

export async function writeJson(dir: string, filename: string, data: unknown): Promise<void> {
    await ensureDir(dir);
    await fsp.writeFile(path.join(dir, filename), JSON.stringify(data, null, 2));
}

export async function writeStream(source: Readable, target: string): Promise<void> {
    await ensureDir(path.dirname(target));
    await pipeline(source, fs.createWriteStream(target));
}

/** Moves a file, falling back to copy+unlink across devices. */
export async function moveFile(from: string, to: string): Promise<void> {
    await ensureDir(path.dirname(to));
    try {
        await fsp.rename(from, to);
    } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'EXDEV') throw error;
        await fsp.copyFile(from, to);
        await fsp.unlink(from);
    }
}

export async function fileSizeMb(p: string): Promise<number> {
    const stats = await fsp.stat(p);
    return Number((stats.size / (1024 * 1024)).toFixed(1));
}

export async function directorySizeBytes(dir: string): Promise<number> {
    if (!dir || !(await exists(dir))) return 0;
    let total = 0;
    for (const entry of await fsp.readdir(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) total += await directorySizeBytes(full);
        else if (entry.isFile()) total += (await fsp.stat(full)).size;
    }
    return total;
}

const PROTECTED_DIRS = ['data', 'data/projects', 'data/uploads', 'data/layouts', 'data/files', 'data/processes', 'data/sets'];

/**
 * Removes the directory of a node. A path with a file extension removes its parent directory
 * (each file lives in its own directory). Data roots are never removed. Errors are logged by the
 * caller's choice and otherwise ignored, as before.
 */
export async function removeNodePath(target: string, dataDir: string): Promise<void> {
    if (!target) return;
    const clean = path.normalize(target);
    const dir = path.parse(clean).ext ? path.dirname(clean) : clean;
    const normalized = dir.replace(/\\/g, '/').replace(/\/$/, '');
    const root = path.resolve(dataDir);
    const resolved = path.resolve(dir);
    if (PROTECTED_DIRS.includes(normalized) || resolved === root || !(resolved.startsWith(root + path.sep))) return;
    await fsp.rm(dir, { recursive: true, force: true });
}
