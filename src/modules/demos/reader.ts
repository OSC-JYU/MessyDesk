// Reads a demo bundle zip: checks it and unpacks the desk's files into a temporary directory.
// A bundle comes from an upload, so nothing in it is trusted: entry names, sizes, counts and the
// JSON are all checked before they are used.

import { createWriteStream } from 'node:fs';
import fsp from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import Boom from '@hapi/boom';
import yauzl from 'yauzl';
import { BUNDLE_FORMAT, FILES_PREFIX, GRAPH_FILE, MANIFEST_FILE, isSafeBundlePath, type Graph, type Manifest } from './bundle.ts';

export interface ReadLimits {
    maxEntries: number;
    maxTotalBytes: number;
    maxJsonBytes: number;
}

export const DEFAULT_LIMITS: ReadLimits = {
    maxEntries: 500_000,
    maxTotalBytes: 20 * 1024 ** 3,
    maxJsonBytes: 200 * 1024 ** 2,
};

export interface ReadBundle {
    manifest: Manifest;
    graph: Graph;
    /** Unpacked files, relative to `filesDir` (the project directory layout). */
    files: string[];
    filesDir: string;
}

function openZip(file: string): Promise<yauzl.ZipFile> {
    return new Promise((resolve, reject) => {
        yauzl.open(file, { lazyEntries: true, strictFileNames: true }, (error, zip) => (error || !zip ? reject(Boom.badRequest('Not a valid zip file')) : resolve(zip)));
    });
}

function openEntry(zip: yauzl.ZipFile, entry: yauzl.Entry) {
    return new Promise<NodeJS.ReadableStream>((resolve, reject) => {
        zip.openReadStream(entry, (error, stream) => (error || !stream ? reject(error ?? new Error('Cannot read entry')) : resolve(stream)));
    });
}

async function readJsonEntry(zip: yauzl.ZipFile, entry: yauzl.Entry, maxBytes: number): Promise<unknown> {
    const stream = await openEntry(zip, entry);
    const chunks: Buffer[] = [];
    let size = 0;
    for await (const chunk of stream) {
        size += (chunk as Buffer).length;
        if (size > maxBytes) throw Boom.badRequest(`${entry.fileName} is too large`);
        chunks.push(chunk as Buffer);
    }
    try {
        return JSON.parse(Buffer.concat(chunks).toString('utf8'));
    } catch {
        throw Boom.badRequest(`${entry.fileName} is not valid JSON`);
    }
}

/** Sets are described by set.json files that the importer writes again from the new nodes. */
function isSetManifest(relative: string): boolean {
    return relative.startsWith('sets/') && relative.endsWith('/set.json');
}

function checkGraph(graph: any): asserts graph is Graph {
    if (!graph || !Array.isArray(graph.nodes) || !Array.isArray(graph.edges) || !Array.isArray(graph.documents)) {
        throw Boom.badRequest('graph.json has no nodes, edges and documents');
    }
}

function checkManifest(manifest: any): asserts manifest is Manifest {
    if (!manifest || typeof manifest !== 'object') throw Boom.badRequest('manifest.json is missing');
    if (!Number.isInteger(manifest.format) || manifest.format < 1) throw Boom.badRequest('Unknown bundle format');
    if (manifest.format > BUNDLE_FORMAT) throw Boom.badRequest(`Bundle format ${manifest.format} is newer than this server understands (${BUNDLE_FORMAT})`);
    if (typeof manifest.project !== 'string') throw Boom.badRequest('manifest.json has no project');
}

export async function readBundle(zipFile: string, workDir: string, limits: ReadLimits = DEFAULT_LIMITS): Promise<ReadBundle> {
    const zip = await openZip(zipFile);
    const filesDir = path.join(workDir, 'files');
    await fsp.mkdir(filesDir, { recursive: true });
    let manifest: unknown;
    let graph: unknown;
    const files: string[] = [];
    let entries = 0;
    let total = 0;

    try {
        await new Promise<void>((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', (entry: yauzl.Entry) => {
                handle(entry).then(() => zip.readEntry(), reject);
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }

    async function handle(entry: yauzl.Entry): Promise<void> {
        if (++entries > limits.maxEntries) throw Boom.badRequest('Too many entries in the bundle');
        const name = entry.fileName;
        if (name.endsWith('/')) return;
        if (!isSafeBundlePath(name)) throw Boom.badRequest(`Unsafe path in the bundle: ${name}`);
        if (name === MANIFEST_FILE) manifest = await readJsonEntry(zip, entry, limits.maxJsonBytes);
        else if (name === GRAPH_FILE) graph = await readJsonEntry(zip, entry, limits.maxJsonBytes);
        else if (name.startsWith(FILES_PREFIX)) {
            const relative = name.slice(FILES_PREFIX.length);
            if (!relative || isSetManifest(relative)) return;
            const target = path.join(filesDir, relative);
            await fsp.mkdir(path.dirname(target), { recursive: true });
            const stream = await openEntry(zip, entry);
            // The sizes in a zip header can lie, so the bytes are counted as they are written.
            stream.on('data', (chunk: Buffer) => {
                total += chunk.length;
                if (total > limits.maxTotalBytes) (stream as any).destroy(Boom.badRequest('The bundle is too large'));
            });
            await pipeline(stream, createWriteStream(target));
            files.push(relative);
        }
    }

    checkManifest(manifest);
    checkGraph(graph);
    return { manifest, graph, files, filesDir };
}

export const COVER_TYPES: Record<string, string> = { png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', webp: 'image/webp' };
export const MAX_COVER_BYTES = 2 * 1024 * 1024;

export interface BundleSummary {
    manifest: Manifest;
    cover: { extension: string; data: Buffer } | null;
}

/** The manifest and the cover image of a bundle, without unpacking its files. */
export async function readSummary(zipFile: string): Promise<BundleSummary> {
    const zip = await openZip(zipFile);
    let manifest: unknown;
    let cover: BundleSummary['cover'] = null;
    try {
        await new Promise<void>((resolve, reject) => {
            zip.on('error', reject);
            zip.on('end', resolve);
            zip.on('entry', (entry: yauzl.Entry) => {
                const name = entry.fileName;
                const extension = name.match(/^cover\.(\w+)$/)?.[1]?.toLowerCase();
                const work = async () => {
                    if (name === MANIFEST_FILE) manifest = await readJsonEntry(zip, entry, DEFAULT_LIMITS.maxJsonBytes);
                    else if (extension && COVER_TYPES[extension] && entry.uncompressedSize <= MAX_COVER_BYTES) {
                        const chunks: Buffer[] = [];
                        for await (const chunk of await openEntry(zip, entry)) chunks.push(chunk as Buffer);
                        cover = { extension, data: Buffer.concat(chunks) };
                    }
                };
                work().then(() => zip.readEntry(), reject);
            });
            zip.readEntry();
        });
    } finally {
        zip.close();
    }
    checkManifest(manifest);
    return { manifest, cover };
}
