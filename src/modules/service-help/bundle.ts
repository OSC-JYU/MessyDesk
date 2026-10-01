// Service help bundles: a consumer asks the backend to fetch its service's help (markdown, HTML,
// or a tar archive) and the backend stores it as a static bundle under public/help/services/<id>,
// rewriting links so pages and assets are served from /api/services/<id>/help[/assets/...].
//
// Ported from the old routes/services.mjs; behaviour is unchanged.

import Boom from '@hapi/boom';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { marked } from 'marked';
import * as tar from 'tar';

const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const SERVICE_HELP_BUNDLE_DIR = 'bundle';
let SERVICE_HELP_DIR = '';
let MAX_HELP_BUNDLE_FILES = 120;
let MAX_HELP_ARCHIVE_BYTES = 25 * 1024 * 1024;
let MAX_HELP_ARCHIVE_ENTRIES = 500;

const fse = {
    copyFile: (a: string, b: string) => fsp.copyFile(a, b),
    emptyDir: async (dir: string) => { await fsp.rm(dir, { recursive: true, force: true }); await fsp.mkdir(dir, { recursive: true }); },
    ensureDir: (dir: string) => fsp.mkdir(dir, { recursive: true }),
    existsSync: (p: string) => fs.existsSync(p),
    mkdtemp: (prefix: string) => fsp.mkdtemp(prefix),
    pathExists: async (p: string) => fs.existsSync(p),
    readdir: (p: string, opts: any) => fsp.readdir(p, opts) as Promise<any[]>,
    readFile: (p: string, enc?: any) => fsp.readFile(p, enc) as Promise<any>,
    remove: (p: string) => fsp.rm(p, { recursive: true, force: true }),
    writeFile: (p: string, data: any, enc?: any) => fsp.writeFile(p, data, enc),
};

async function fetchHelp(url: string, asBuffer: boolean): Promise<{ body: any; headers: Record<string, string> }> {
    const response = await fetch(url, { headers: { accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1' } });
    if (!response.ok) {
        const error: any = new Error(`Response code ${response.status}`);
        error.response = { statusCode: response.status };
        throw error;
    }
    const headers: Record<string, string> = {};
    response.headers.forEach((value, key) => { headers[key] = value; });
    const body = asBuffer ? Buffer.from(await response.arrayBuffer()) : await response.text();
    return { body, headers };
}

function normalizeServiceId(rawServiceId: any) {
        const serviceId = String(rawServiceId || '').trim();
        if (!serviceId) {
                throw Boom.badRequest('Missing service id');
        }
        if (!SERVICE_ID_PATTERN.test(serviceId)) {
                throw Boom.badRequest('Invalid service id');
        }
        return serviceId;
}

function resolveServiceHelpPath(serviceId: any) {
        const resolvedServiceDir = path.resolve(path.join(SERVICE_HELP_DIR, serviceId));
        if (!resolvedServiceDir.startsWith(SERVICE_HELP_DIR + path.sep) && resolvedServiceDir !== SERVICE_HELP_DIR) {
                throw Boom.forbidden('Service help path is outside allowed directory');
        }

        const htmlPath = path.join(resolvedServiceDir, 'index.html');
        return { resolvedServiceDir, htmlPath };
}

    function resolveServiceHelpAssetPath(serviceId: any, assetPath: any) {
        const { resolvedServiceDir } = resolveServiceHelpPath(serviceId);
        const bundleDir = path.join(resolvedServiceDir, SERVICE_HELP_BUNDLE_DIR);
        const requestedAsset = String(assetPath || '').replace(/^\/+/, '');
        if (!requestedAsset) {
            throw Boom.badRequest('Missing asset path');
        }

        const resolvedAssetPath = path.resolve(path.join(resolvedServiceDir, requestedAsset));
        if (!resolvedAssetPath.startsWith(resolvedServiceDir + path.sep) && resolvedAssetPath !== resolvedServiceDir) {
            throw Boom.forbidden('Asset path is outside allowed directory');
        }

        const legacyBundleAssetPath = path.resolve(path.join(bundleDir, requestedAsset));
        if (!legacyBundleAssetPath.startsWith(bundleDir + path.sep) && legacyBundleAssetPath !== bundleDir) {
            throw Boom.forbidden('Asset path is outside allowed directory');
        }

        return { bundleDir, resolvedAssetPath, legacyBundleAssetPath };
    }

    function encodePathSegments(relativePath: any) {
        return String(relativePath || '')
            .split('/')
            .filter(Boolean)
            .map((segment) => encodeURIComponent(segment))
            .join('/');
    }

    function sanitizePathSegment(segment: any) {
        return String(segment || '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'item';
    }

    function normalizePathnameToRelative(pathnameValue: any) {
        const cleaned = String(pathnameValue || '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleaned) return 'index';
        return cleaned
            .split('/')
            .filter(Boolean)
            .map((segment) => sanitizePathSegment(segment))
            .join('/');
    }

    function stripServiceHelpPathPrefix(relativePath: any) {
        const normalized = String(relativePath || '').replace(/^\/+/, '');
        if (!normalized) return normalized;

        if (normalized === 'help' || normalized === 'help/index' || normalized === 'help/index.html' || normalized === 'help/index.md') {
            return 'index';
        }

        if (normalized.startsWith('help/files/')) {
            return normalized.slice('help/files/'.length);
        }

        if (normalized.startsWith('help/')) {
            return normalized.slice('help/'.length);
        }

        return normalized;
    }

    function asBundleAssetUrl(serviceId: any, relativePath: any) {
        return `/api/services/${encodeURIComponent(serviceId)}/help/assets/${encodePathSegments(relativePath)}`;
    }

    function asBundlePageUrl(serviceId: any, relativePath: any) {
        const encodedServiceId = encodeURIComponent(serviceId);
        const encodedAssetPath = encodePathSegments(relativePath);
        return `/help/services/${encodedServiceId}/${encodedAssetPath}`;
    }

    function toRelativePageHref(fromRelativePath: any, toRelativePath: any) {
        const fromDir = path.posix.dirname(String(fromRelativePath || 'index.html'));
        const target = String(toRelativePath || 'index.html');
        let rel = path.posix.relative(fromDir, target);
        if (!rel) {
            rel = path.posix.basename(target);
        }
        return rel;
    }

    function stripHashFromUrl(urlValue: any) {
        if (!urlValue) return urlValue;
        const hashIndex = String(urlValue).indexOf('#');
        if (hashIndex < 0) return String(urlValue);
        return String(urlValue).slice(0, hashIndex);
    }

    function guessSourceFormat(urlValue: any, contentType: any) {
        const ct = String(contentType || '').toLowerCase();
        if (ct.includes('text/markdown') || ct.includes('text/plain')) return 'markdown';
        if (ct.includes('text/html') || ct.includes('application/xhtml+xml')) return 'html';

        try {
            const pathnameValue = new URL(urlValue).pathname || '';
            const ext = path.extname(pathnameValue).toLowerCase();
            if (ext === '.md' || ext === '.markdown') return 'markdown';
            if (ext === '.html' || ext === '.htm') return 'html';
        } catch (_error) {
            // ignore
        }

        return 'markdown';
    }

    function wrapOrNormalizeHelpHtml({ serviceId, htmlOrMarkdown, sourceFormat, sourceUrl }: any) {
        if (sourceFormat === 'html') {
            return String(htmlOrMarkdown);
        }

        const markdownText = String(htmlOrMarkdown || '');
        const title = extractMarkdownTitle(markdownText, serviceId);
        const contentHtml = marked.parse(markdownText);
        return wrapServiceHelpHtml({
            serviceId,
            title,
            content: contentHtml,
        });
    }

    function shouldFetchLinkedResource(candidateUrl: any, rootOrigin: any) {
        const href = String(candidateUrl || '').trim();
        if (!href) return false;
        if (href.startsWith('#')) return false;
        if (/^(mailto:|tel:|javascript:|data:)/i.test(href)) return false;

        try {
            const parsed = new URL(href);
            return parsed.origin === rootOrigin;
        } catch (_error) {
            return false;
        }
    }

    function classifyLinkTarget(attrName: any, parsedUrl: any) {
        if (attrName === 'src') {
            return 'asset';
        }

        const ext = path.extname(parsedUrl.pathname || '').toLowerCase();
        if (ext === '.md' || ext === '.markdown' || ext === '.html' || ext === '.htm') {
            return 'page';
        }

        if (!ext || (parsedUrl.pathname || '').endsWith('/')) {
            return 'page';
        }

        return 'asset';
    }

    function toLocalBundlePath(parsedUrl: any, targetType: any) {
        const pathnameValue = parsedUrl.pathname || '';
        const normalized = stripServiceHelpPathPrefix(normalizePathnameToRelative(pathnameValue));
        const safeNormalized = normalized || 'index';
        const ext = path.extname(safeNormalized).toLowerCase();

        if (targetType === 'page') {
            if (ext === '.md' || ext === '.markdown' || ext === '.htm' || ext === '.html') {
                return safeNormalized.replace(/\.(md|markdown|htm|html)$/i, '.html');
            }
            if (!ext) {
                return `${safeNormalized}.html`;
            }
            return `${safeNormalized}.html`;
        }

        if (!ext) {
            return `${safeNormalized}.bin`;
        }

        return safeNormalized;
    }

    function rewriteAndCollectHelpLinks({ html, currentUrl, currentLocalPath, serviceId, rootOrigin, addPendingResource }: any) {
        const sourceHtml = String(html || '');
        const attrRegex = /(href|src)=(["'])([^"']+)\2/gi;

        return sourceHtml.replace(attrRegex, (fullMatch, attrName, quote, rawValue) => {
            const raw = String(rawValue || '').trim();
            if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:)/i.test(raw)) {
                return fullMatch;
            }

            if (raw.startsWith('/api/')) {
                return fullMatch;
            }

            let resolvedUrl;
            try {
                resolvedUrl = new URL(raw, currentUrl);
            } catch (_error) {
                return fullMatch;
            }

            if (!shouldFetchLinkedResource(resolvedUrl.toString(), rootOrigin)) {
                return fullMatch;
            }

            const targetType = classifyLinkTarget(String(attrName).toLowerCase(), resolvedUrl);
            const localRelativePath = toLocalBundlePath(resolvedUrl, targetType);
            const cleanRemoteUrl = stripHashFromUrl(resolvedUrl.toString());
            addPendingResource({
                remoteUrl: cleanRemoteUrl,
                localRelativePath,
                targetType,
            });

            const bundleUrl = targetType === 'page'
                ? toRelativePageHref(currentLocalPath, localRelativePath)
                : asBundleAssetUrl(serviceId, localRelativePath);
            const hashSuffix = resolvedUrl.hash || '';
            return `${attrName}=${quote}${bundleUrl}${hashSuffix}${quote}`;
        });
    }

    async function ingestServiceHelpBundle({ serviceId, helpSourceUrl, helpBody, contentType, resolvedServiceDir }: any) {
        const bundleDir = resolvedServiceDir;
        await fse.remove(path.join(resolvedServiceDir, SERVICE_HELP_BUNDLE_DIR));
        await fse.emptyDir(bundleDir);

        const pending: any[] = [];
        const pendingKeySet = new Set();
        const visited = new Set();
        let fileCount = 0;

        function addPendingResource(item: any) {
            const key = `${item.targetType}:${item.remoteUrl}`;
            if (pendingKeySet.has(key) || visited.has(key)) return;
            pendingKeySet.add(key);
            pending.push(item);
        }

        const sourceFormat = guessSourceFormat(helpSourceUrl, contentType);
        let rootHtml = wrapOrNormalizeHelpHtml({
            serviceId,
            htmlOrMarkdown: helpBody,
            sourceFormat,
            sourceUrl: helpSourceUrl,
        });

        rootHtml = rewriteAndCollectHelpLinks({
            html: rootHtml,
            currentUrl: helpSourceUrl,
            currentLocalPath: 'index.html',
            serviceId,
            rootOrigin: new URL(helpSourceUrl).origin,
            addPendingResource,
        });

        const rootHtmlPath = path.join(resolvedServiceDir, 'index.html');
        await fse.writeFile(rootHtmlPath, rootHtml, 'utf8');
        fileCount += 1;

        while (pending.length > 0 && fileCount < MAX_HELP_BUNDLE_FILES) {
            const item = pending.shift();
            const key = `${item.targetType}:${item.remoteUrl}`;
            pendingKeySet.delete(key);
            if (visited.has(key)) continue;
            visited.add(key);

            const targetPath = path.join(bundleDir, item.localRelativePath);
            await fse.ensureDir(path.dirname(targetPath));

            try {
                const response = await fetchHelp(item.remoteUrl, item.targetType === 'asset');

                if (item.targetType === 'asset') {
                    await fse.writeFile(targetPath, response.body);
                    fileCount += 1;
                    continue;
                }

                const pageFormat = guessSourceFormat(item.remoteUrl, response.headers['content-type']);
                let pageHtml = wrapOrNormalizeHelpHtml({
                    serviceId,
                    htmlOrMarkdown: response.body,
                    sourceFormat: pageFormat,
                    sourceUrl: item.remoteUrl,
                });

                pageHtml = rewriteAndCollectHelpLinks({
                    html: pageHtml,
                    currentUrl: item.remoteUrl,
                    currentLocalPath: item.localRelativePath,
                    serviceId,
                    rootOrigin: new URL(helpSourceUrl).origin,
                    addPendingResource,
                });

                await fse.writeFile(targetPath, pageHtml, 'utf8');
                fileCount += 1;
            } catch (error: any) {
                console.log(`WARN: skipped bundled help resource for ${serviceId}: ${item.remoteUrl}`);
                console.log(error.message);
            }
        }

        return {
            source_format: sourceFormat,
            bundle_dir: `/public/help/services/${serviceId}/`,
            bundle_files: fileCount,
            bundle_truncated: pending.length > 0,
        };
    }

function getServiceBaseUrl(serviceConfig: any) {
        if (!serviceConfig) return null;
        const baseUrl = serviceConfig.url || serviceConfig.local_url;
        if (!baseUrl || typeof baseUrl !== 'string') return null;
        return baseUrl.trim().replace(/\/+$/, '');
}

function splitHrefParts(value: any) {
    const text = String(value || '');
    const hashIndex = text.indexOf('#');
    const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
    const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
    const queryIndex = beforeHash.indexOf('?');
    const pathname = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
    const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
    return { pathname, query, hash };
}

function normalizeBundleRelativePath(rawPath: any) {
    const cleaned = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleaned) return '';
    const normalized = path.posix.normalize(cleaned);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        return null;
    }
    return normalized;
}

function resolveBundleLinkPath(currentRelativeFile: any, rawHref: any) {
    const parts = splitHrefParts(rawHref);
    const rawPathname = String(parts.pathname || '').trim();
    if (!rawPathname) {
        return {
            relativePath: currentRelativeFile,
            query: parts.query,
            hash: parts.hash,
        };
    }

    const joined = rawPathname.startsWith('/')
        ? rawPathname.slice(1)
        : path.posix.join(path.posix.dirname(currentRelativeFile), rawPathname);

    const relativePath = normalizeBundleRelativePath(joined);
    if (!relativePath) {
        return null;
    }

    return {
        relativePath,
        query: parts.query,
        hash: parts.hash,
    };
}

function isArchiveContentType(contentType: any = '') {
    const ct = String(contentType || '').toLowerCase();
    return ct.includes('application/x-tar')
        || ct.includes('application/tar')
        || ct.includes('application/gzip')
        || ct.includes('application/x-gtar')
        || ct.includes('application/x-gzip')
        || ct.includes('application/octet-stream');
}

function looksLikeArchiveByUrl(urlValue: any = '') {
    try {
        const pathnameValue = String(new URL(urlValue).pathname || '').toLowerCase();
        return pathnameValue.endsWith('.tar')
            || pathnameValue.endsWith('.tgz')
            || pathnameValue.endsWith('.tar.gz')
            || pathnameValue.endsWith('.tar.gzip');
    } catch (_error) {
        return false;
    }
}

function isHelpArchiveSource({ contentType = '', helpSourceUrl = '', requestedHelpUrl = '' }: any) {
    if (looksLikeArchiveByUrl(requestedHelpUrl) || looksLikeArchiveByUrl(helpSourceUrl)) {
        return true;
    }
    return isArchiveContentType(contentType);
}

async function listRelativeFiles(dirPath: any): Promise<string[]> {
    const entries = await fse.readdir(dirPath, { withFileTypes: true });
    const files: string[] = [];
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const nested: string[] = await listRelativeFiles(full);
            for (const item of nested) {
                files.push(path.join(entry.name, item));
            }
            continue;
        }
        if (entry.isFile()) {
            files.push(entry.name);
        }
    }
    return files;
}

async function extractHelpArchiveToBundle({ archiveBuffer, targetDir }: any) {
    if (!Buffer.isBuffer(archiveBuffer)) {
        throw new Error('Archive response is not a binary buffer');
    }
    if (archiveBuffer.length > MAX_HELP_ARCHIVE_BYTES) {
        throw new Error(`Help archive exceeds max size (${MAX_HELP_ARCHIVE_BYTES} bytes)`);
    }

    await fse.emptyDir(targetDir);
    const tempDir = await fse.mkdtemp(path.join(os.tmpdir(), 'md-help-archive-'));
    const archivePath = path.join(tempDir, 'bundle.tar');
    let entryCount = 0;

    try {
        await fse.writeFile(archivePath, archiveBuffer);
        await tar.x({
            file: archivePath,
            cwd: targetDir,
            preservePaths: false,
            strict: true,
            filter: (entryPath: string, entry: any) => {
                const normalized = normalizeBundleRelativePath(entryPath);
                if (!normalized) {
                    return false;
                }
                if (entry?.type && !['File', 'Directory'].includes(entry.type)) {
                    return false;
                }
                entryCount += 1;
                if (entryCount > MAX_HELP_ARCHIVE_ENTRIES) {
                    throw new Error(`Help archive has too many entries (>${MAX_HELP_ARCHIVE_ENTRIES})`);
                }
                return true;
            },
        });
    } finally {
        await fse.remove(tempDir);
    }
}

async function convertMarkdownFilesInBundle({ serviceId, bundleDir }: any) {
    const files = await listRelativeFiles(bundleDir);
    let convertedCount = 0;

    for (const fileRelativeRaw of files) {
        const fileRelative = fileRelativeRaw.replace(/\\/g, '/');
        if (!/\.(md|markdown)$/i.test(fileRelative)) {
            continue;
        }
        const markdownPath = path.join(bundleDir, fileRelative);
        const markdownText = await fse.readFile(markdownPath, 'utf8');
        const title = extractMarkdownTitle(markdownText, serviceId);
        const contentHtml = marked.parse(markdownText);
        const wrapped = wrapServiceHelpHtml({
            serviceId,
            title,
            content: contentHtml,
        });
        const htmlRelative = fileRelative.replace(/\.(md|markdown)$/i, '.html');
        const htmlPath = path.join(bundleDir, htmlRelative);
        await fse.ensureDir(path.dirname(htmlPath));
        await fse.writeFile(htmlPath, wrapped, 'utf8');
        convertedCount += 1;
    }

    return convertedCount;
}

function resolveLocalBundleTarget({ bundleDir, currentRelativePath, attrName, rawValue }: any) {
    const resolved = resolveBundleLinkPath(currentRelativePath, rawValue);
    if (!resolved) return null;

    const { relativePath, query, hash } = resolved;
    const ext = path.posix.extname(relativePath).toLowerCase();
    const candidateHtml = ext === '.htm'
        ? relativePath.replace(/\.htm$/i, '.html')
        : (ext === '.md' || ext === '.markdown')
            ? relativePath.replace(/\.(md|markdown)$/i, '.html')
            : relativePath;

    const htmlFullPath = path.join(bundleDir, candidateHtml);
    const rawFullPath = path.join(bundleDir, relativePath);
    const hrefLike = attrName === 'href';

    const pageExt = path.posix.extname(candidateHtml).toLowerCase();
    if (pageExt === '.html' && fse.existsSync(htmlFullPath)) {
        return {
            type: 'page',
            relativePath: candidateHtml,
            query,
            hash,
        };
    }

    if (hrefLike && !ext) {
        const fallbackHtml = `${relativePath}.html`;
        const fallbackHtmlPath = path.join(bundleDir, fallbackHtml);
        if (fse.existsSync(fallbackHtmlPath)) {
            return {
                type: 'page',
                relativePath: fallbackHtml,
                query,
                hash,
            };
        }
    }

    if (fse.existsSync(rawFullPath)) {
        return {
            type: 'asset',
            relativePath,
            query,
            hash,
        };
    }

    return null;
}

async function rewriteBundleHtmlFiles({ serviceId, bundleDir }: any) {
    const files = await listRelativeFiles(bundleDir);
    for (const fileRelativeRaw of files) {
        const fileRelative = fileRelativeRaw.replace(/\\/g, '/');
        if (!/\.html?$/i.test(fileRelative)) {
            continue;
        }

        const filePath = path.join(bundleDir, fileRelative);
        const html = await fse.readFile(filePath, 'utf8');
        const rewritten = String(html).replace(/(href|src)=(["'])([^"']+)\2/gi, (fullMatch, attrName, quote, rawValue) => {
            const raw = String(rawValue || '').trim();
            if (!raw || raw.startsWith('#') || /^(mailto:|tel:|javascript:|data:|https?:\/\/)/i.test(raw)) {
                return fullMatch;
            }

            if (raw.startsWith('/api/')) {
                return fullMatch;
            }

            const target = resolveLocalBundleTarget({
                bundleDir,
                currentRelativePath: fileRelative,
                attrName: String(attrName || '').toLowerCase(),
                rawValue: raw,
            });
            if (!target) {
                return fullMatch;
            }

            const baseUrl = target.type === 'page'
                ? toRelativePageHref(fileRelative, target.relativePath)
                : asBundleAssetUrl(serviceId, target.relativePath);
            const suffix = `${target.query || ''}${target.hash || ''}`;
            return `${attrName}=${quote}${baseUrl}${suffix}${quote}`;
        });

        await fse.writeFile(filePath, rewritten, 'utf8');
    }
}

async function determineBundleEntryHtml(bundleDir: any) {
    const preferred = ['index.html', 'help/index.html'];
    for (const rel of preferred) {
        if (await fse.pathExists(path.join(bundleDir, rel))) {
            return rel;
        }
    }

    const files = await listRelativeFiles(bundleDir);
    const htmlFiles = files
        .map((item: any) => item.replace(/\\/g, '/'))
        .filter((item: any) => /\.html?$/i.test(item))
        .sort();
    return htmlFiles[0] || null;
}

async function ingestServiceHelpArchiveBundle({ serviceId, resolvedServiceDir, helpBody }: any) {
    const bundleDir = resolvedServiceDir;
    await fse.remove(path.join(resolvedServiceDir, SERVICE_HELP_BUNDLE_DIR));
    await extractHelpArchiveToBundle({
        archiveBuffer: helpBody,
        targetDir: bundleDir,
    });

    const convertedMarkdown = await convertMarkdownFilesInBundle({
        serviceId,
        bundleDir,
    });

    await rewriteBundleHtmlFiles({
        serviceId,
        bundleDir,
    });

    const entryHtmlRelative = await determineBundleEntryHtml(bundleDir);
    if (!entryHtmlRelative) {
        throw new Error('Help archive does not contain index.html or markdown pages');
    }

    const rootHtmlPath = path.join(resolvedServiceDir, 'index.html');
    await fse.copyFile(path.join(bundleDir, entryHtmlRelative), rootHtmlPath);

    const fileCount = (await listRelativeFiles(bundleDir)).length + 1;
    return {
        source_format: 'archive',
        bundle_dir: `/public/help/services/${serviceId}/`,
        bundle_files: fileCount,
        bundle_truncated: false,
        converted_markdown: convertedMarkdown,
        bundle_entry: entryHtmlRelative,
    };
}

function normalizeHelpSourceUrl(rawHelpUrl: any, serviceBaseUrl: any) {
    if (!rawHelpUrl) {
        return `${serviceBaseUrl}/help`;
    }

    const value = String(rawHelpUrl).trim();
    if (!value) {
        return `${serviceBaseUrl}/help`;
    }

    if (/^https?:\/\//i.test(value)) {
        return value;
    }

    if (value.startsWith('/')) {
        return `${serviceBaseUrl}${value}`;
    }

    return `${serviceBaseUrl}/${value}`;
}

function extractMarkdownTitle(markdownText: any, serviceId: any) {
        const headingMatch = String(markdownText || '').match(/^#\s+(.+)$/m);
        if (headingMatch && headingMatch[1]) {
                return headingMatch[1].trim();
        }
        return `${serviceId} help`;
}

function guessHelpAssetContentType(filePath: any) {
    const ext = path.extname(String(filePath || '')).toLowerCase();
    if (ext === '.html' || ext === '.htm') return 'text/html; charset=utf-8';
    if (ext === '.css') return 'text/css; charset=utf-8';
    if (ext === '.js') return 'application/javascript; charset=utf-8';
    if (ext === '.json') return 'application/json; charset=utf-8';
    if (ext === '.md') return 'text/markdown; charset=utf-8';
    if (ext === '.txt') return 'text/plain; charset=utf-8';
    if (ext === '.svg') return 'image/svg+xml';
    if (ext === '.png') return 'image/png';
    if (ext === '.jpg' || ext === '.jpeg') return 'image/jpeg';
    if (ext === '.gif') return 'image/gif';
    if (ext === '.webp') return 'image/webp';
    if (ext === '.pdf') return 'application/pdf';
    return 'application/octet-stream';
}

function wrapServiceHelpHtml({ serviceId, title, content }: any) {
        return `<!doctype html>
<html lang="en">
<head>
        <meta charset="utf-8" />
        <meta name="viewport" content="width=device-width, initial-scale=1" />
        <title>MessyDesk Help - ${title}</title>
    <link rel="stylesheet" href="/api/help/styles/help.css" />
</head>
<body>
        <main class="page">
                <article class="content">
                        <div class="service-meta">Service: ${serviceId}</div>
                        ${content}
                </article>
        </main>
</body>
</html>`;
}


export interface HelpLimits {
    dir: string;
    bundleMaxFiles: number;
    archiveMaxBytes: number;
    archiveMaxEntries: number;
}

export class ServiceHelp {
    constructor(limits: HelpLimits) {
        SERVICE_HELP_DIR = path.resolve(limits.dir);
        MAX_HELP_BUNDLE_FILES = limits.bundleMaxFiles;
        MAX_HELP_ARCHIVE_BYTES = limits.archiveMaxBytes;
        MAX_HELP_ARCHIVE_ENTRIES = limits.archiveMaxEntries;
    }

    normalizeId(raw: unknown): string {
        return normalizeServiceId(raw);
    }

    /** Fetches a service's help and stores it as a bundle (POST /api/services/{id}/help/ingest). */
    async ingest(serviceId: string, serviceConfig: any, requestedHelpUrl: string | undefined): Promise<any> {
        const baseUrl = getServiceBaseUrl(serviceConfig);
        if (!baseUrl) throw Boom.badRequest('Service URL is not configured');
        const helpSourceUrl = normalizeHelpSourceUrl(requestedHelpUrl, baseUrl);
        try {
            const help = await fetchHelp(helpSourceUrl, true);
            const helpBody: Buffer = help.body;
            const contentType = String(help.headers['content-type'] || '').toLowerCase();
            const archive = isHelpArchiveSource({ contentType, helpSourceUrl, requestedHelpUrl });
            if (!archive && !String(helpBody || '').trim()) throw Boom.badGateway('Service help response is empty');
            const { resolvedServiceDir, htmlPath } = resolveServiceHelpPath(serviceId);
            await fse.ensureDir(resolvedServiceDir);
            const bundle = archive
                ? await ingestServiceHelpArchiveBundle({ serviceId, resolvedServiceDir, helpBody })
                : await ingestServiceHelpBundle({ serviceId, helpSourceUrl, helpBody: helpBody.toString('utf8'), contentType, resolvedServiceDir });
            if (!(await fse.pathExists(htmlPath))) throw Boom.badGateway('Service help bundle ingest did not produce index page');
            return {
                status: 'ok',
                service: serviceId,
                source: helpSourceUrl,
                source_format: bundle.source_format,
                content_type: contentType || 'unknown',
                bundle: { dir: bundle.bundle_dir, files: bundle.bundle_files, truncated: bundle.bundle_truncated },
                output: `/help/services/${serviceId}/index.html`,
            };
        } catch (error: any) {
            if (Boom.isBoom(error)) throw error;
            if (error.response) throw Boom.badGateway(`Could not fetch service help: ${error.response.statusCode}`);
            throw Boom.badGateway(`Could not ingest service help: ${error.message}`);
        }
    }

    async page(serviceId: string): Promise<string> {
        const { htmlPath } = resolveServiceHelpPath(normalizeServiceId(serviceId));
        if (!(await fse.pathExists(htmlPath))) throw Boom.notFound('Service help page not found');
        return fsp.readFile(htmlPath, 'utf8');
    }

    async asset(serviceId: string, assetPath: string): Promise<{ body: Buffer; contentType: string }> {
        const { resolvedAssetPath, legacyBundleAssetPath } = resolveServiceHelpAssetPath(normalizeServiceId(serviceId), assetPath);
        const rootExists = await fse.pathExists(resolvedAssetPath);
        if (!rootExists && !(await fse.pathExists(legacyBundleAssetPath))) throw Boom.notFound('Service help asset not found');
        const filePath = rootExists ? resolvedAssetPath : legacyBundleAssetPath;
        return { body: await fsp.readFile(filePath), contentType: guessHelpAssetContentType(filePath) };
    }
}
