import services from '../services.mjs';
import nomad from '../nomad.mjs';
import Graph from '../graph.mjs';
import queue from '../queue.mjs';
import filters from '../filters.mjs';
import path from 'path';
import os from 'os';
import { fileURLToPath } from 'url';
import fse from 'fs-extra';
import { marked } from 'marked';
import Boom from '@hapi/boom';
import got from 'got';
import * as tar from 'tar';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const SERVICE_HELP_DIR = path.resolve(__dirname, '../../public/help/services');
const SERVICE_ID_PATTERN = /^[a-z0-9][a-z0-9_-]*$/i;
const SERVICE_HELP_BUNDLE_DIR = 'bundle';
const MAX_HELP_BUNDLE_FILES = Number(process.env.SERVICE_HELP_BUNDLE_MAX_FILES || 120);
const MAX_HELP_ARCHIVE_BYTES = Number(process.env.SERVICE_HELP_ARCHIVE_MAX_BYTES || 25 * 1024 * 1024);
const MAX_HELP_ARCHIVE_ENTRIES = Number(process.env.SERVICE_HELP_ARCHIVE_MAX_ENTRIES || 500);

function normalizeServiceId(rawServiceId) {
        const serviceId = String(rawServiceId || '').trim();
        if (!serviceId) {
                throw Boom.badRequest('Missing service id');
        }
        if (!SERVICE_ID_PATTERN.test(serviceId)) {
                throw Boom.badRequest('Invalid service id');
        }
        return serviceId;
}

function resolveServiceHelpPath(serviceId) {
        const resolvedServiceDir = path.resolve(path.join(SERVICE_HELP_DIR, serviceId));
        if (!resolvedServiceDir.startsWith(SERVICE_HELP_DIR + path.sep) && resolvedServiceDir !== SERVICE_HELP_DIR) {
                throw Boom.forbidden('Service help path is outside allowed directory');
        }

        const htmlPath = path.join(resolvedServiceDir, 'index.html');
        return { resolvedServiceDir, htmlPath };
}

    function resolveServiceHelpAssetPath(serviceId, assetPath) {
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

    function encodePathSegments(relativePath) {
        return String(relativePath || '')
            .split('/')
            .filter(Boolean)
            .map((segment) => encodeURIComponent(segment))
            .join('/');
    }

    function sanitizePathSegment(segment) {
        return String(segment || '')
            .replace(/[^a-zA-Z0-9._-]+/g, '_')
            .replace(/^_+|_+$/g, '') || 'item';
    }

    function normalizePathnameToRelative(pathnameValue) {
        const cleaned = String(pathnameValue || '').replace(/^\/+/, '').replace(/\/+$/, '');
        if (!cleaned) return 'index';
        return cleaned
            .split('/')
            .filter(Boolean)
            .map((segment) => sanitizePathSegment(segment))
            .join('/');
    }

    function stripServiceHelpPathPrefix(relativePath) {
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

    function asBundleAssetUrl(serviceId, relativePath) {
        return `/api/services/${encodeURIComponent(serviceId)}/help/assets/${encodePathSegments(relativePath)}`;
    }

    function asBundlePageUrl(serviceId, relativePath) {
        const encodedServiceId = encodeURIComponent(serviceId);
        const encodedAssetPath = encodePathSegments(relativePath);
        return `/help/services/${encodedServiceId}/${encodedAssetPath}`;
    }

    function toRelativePageHref(fromRelativePath, toRelativePath) {
        const fromDir = path.posix.dirname(String(fromRelativePath || 'index.html'));
        const target = String(toRelativePath || 'index.html');
        let rel = path.posix.relative(fromDir, target);
        if (!rel) {
            rel = path.posix.basename(target);
        }
        return rel;
    }

    function stripHashFromUrl(urlValue) {
        if (!urlValue) return urlValue;
        const hashIndex = String(urlValue).indexOf('#');
        if (hashIndex < 0) return String(urlValue);
        return String(urlValue).slice(0, hashIndex);
    }

    function guessSourceFormat(urlValue, contentType) {
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

    function wrapOrNormalizeHelpHtml({ serviceId, htmlOrMarkdown, sourceFormat, sourceUrl }) {
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

    function shouldFetchLinkedResource(candidateUrl, rootOrigin) {
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

    function classifyLinkTarget(attrName, parsedUrl) {
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

    function toLocalBundlePath(parsedUrl, targetType) {
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

    function rewriteAndCollectHelpLinks({ html, currentUrl, currentLocalPath, serviceId, rootOrigin, addPendingResource }) {
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

    async function ingestServiceHelpBundle({ serviceId, helpSourceUrl, helpBody, contentType, resolvedServiceDir }) {
        const bundleDir = resolvedServiceDir;
        await fse.remove(path.join(resolvedServiceDir, SERVICE_HELP_BUNDLE_DIR));
        await fse.emptyDir(bundleDir);

        const pending = [];
        const pendingKeySet = new Set();
        const visited = new Set();
        let fileCount = 0;

        function addPendingResource(item) {
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
                const response = await got.get(item.remoteUrl, {
                    responseType: item.targetType === 'asset' ? 'buffer' : 'text',
                    headers: {
                        accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1',
                    },
                });

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
            } catch (error) {
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

function getServiceBaseUrl(serviceConfig) {
        if (!serviceConfig) return null;
        const baseUrl = serviceConfig.url || serviceConfig.local_url;
        if (!baseUrl || typeof baseUrl !== 'string') return null;
        return baseUrl.trim().replace(/\/+$/, '');
}

function splitHrefParts(value) {
    const text = String(value || '');
    const hashIndex = text.indexOf('#');
    const beforeHash = hashIndex >= 0 ? text.slice(0, hashIndex) : text;
    const hash = hashIndex >= 0 ? text.slice(hashIndex) : '';
    const queryIndex = beforeHash.indexOf('?');
    const pathname = queryIndex >= 0 ? beforeHash.slice(0, queryIndex) : beforeHash;
    const query = queryIndex >= 0 ? beforeHash.slice(queryIndex) : '';
    return { pathname, query, hash };
}

function normalizeBundleRelativePath(rawPath) {
    const cleaned = String(rawPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!cleaned) return '';
    const normalized = path.posix.normalize(cleaned);
    if (!normalized || normalized === '.' || normalized === '..' || normalized.startsWith('../')) {
        return null;
    }
    return normalized;
}

function resolveBundleLinkPath(currentRelativeFile, rawHref) {
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

function isArchiveContentType(contentType = '') {
    const ct = String(contentType || '').toLowerCase();
    return ct.includes('application/x-tar')
        || ct.includes('application/tar')
        || ct.includes('application/gzip')
        || ct.includes('application/x-gtar')
        || ct.includes('application/x-gzip')
        || ct.includes('application/octet-stream');
}

function looksLikeArchiveByUrl(urlValue = '') {
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

function isHelpArchiveSource({ contentType = '', helpSourceUrl = '', requestedHelpUrl = '' }) {
    if (looksLikeArchiveByUrl(requestedHelpUrl) || looksLikeArchiveByUrl(helpSourceUrl)) {
        return true;
    }
    return isArchiveContentType(contentType);
}

async function listRelativeFiles(dirPath) {
    const entries = await fse.readdir(dirPath, { withFileTypes: true });
    const files = [];
    for (const entry of entries) {
        const full = path.join(dirPath, entry.name);
        if (entry.isDirectory()) {
            const nested = await listRelativeFiles(full);
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

async function extractHelpArchiveToBundle({ archiveBuffer, targetDir }) {
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
            filter: (entryPath, entry) => {
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

async function convertMarkdownFilesInBundle({ serviceId, bundleDir }) {
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

function resolveLocalBundleTarget({ bundleDir, currentRelativePath, attrName, rawValue }) {
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

async function rewriteBundleHtmlFiles({ serviceId, bundleDir }) {
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

async function determineBundleEntryHtml(bundleDir) {
    const preferred = ['index.html', 'help/index.html'];
    for (const rel of preferred) {
        if (await fse.pathExists(path.join(bundleDir, rel))) {
            return rel;
        }
    }

    const files = await listRelativeFiles(bundleDir);
    const htmlFiles = files
        .map((item) => item.replace(/\\/g, '/'))
        .filter((item) => /\.html?$/i.test(item))
        .sort();
    return htmlFiles[0] || null;
}

async function ingestServiceHelpArchiveBundle({ serviceId, resolvedServiceDir, helpBody }) {
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

function normalizeHelpSourceUrl(rawHelpUrl, serviceBaseUrl) {
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

function extractMarkdownTitle(markdownText, serviceId) {
        const headingMatch = String(markdownText || '').match(/^#\s+(.+)$/m);
        if (headingMatch && headingMatch[1]) {
                return headingMatch[1].trim();
        }
        return `${serviceId} help`;
}

function guessHelpAssetContentType(filePath) {
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

function wrapServiceHelpHtml({ serviceId, title, content }) {
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

function doesFilterMatchNode(filter, node) {
    if (!filter || !node) return false;

    const nodeType = String(node['@type'] || '').toLowerCase();
    const fileType = String(node.type || '').toLowerCase();
    const extension = String(node.extension || '').toLowerCase();
    const nodeTypes = Array.isArray(node.types)
        ? node.types.map((t) => String(t || '').toLowerCase()).filter(Boolean)
        : [];
    const nodeExtensions = Array.isArray(node.extensions)
        ? node.extensions.map((f) => String(f || '').toLowerCase()).filter(Boolean)
        : [];

    if (Number(filter.set_only || 0) === 1 && nodeType !== 'set') {
        return false;
    }

    const supportedTypes = Array.isArray(filter.supported_types)
        ? filter.supported_types.map((t) => String(t).toLowerCase())
        : [];
    if (supportedTypes.length > 0) {
        const typeCandidates = Array.from(new Set([fileType, nodeType, ...nodeTypes].filter(Boolean)));
        const hasTypeMatch = supportedTypes.some((type) => typeCandidates.includes(type));
        if (!hasTypeMatch) return false;
    }

    const supportedFormats = Array.isArray(filter.supported_formats)
        ? filter.supported_formats.map((f) => String(f).toLowerCase())
        : [];
    const formatCandidates = Array.from(new Set([extension, ...nodeExtensions].filter(Boolean)));
    if (supportedFormats.length > 0 && !supportedFormats.some((format) => formatCandidates.includes(format))) {
        return false;
    }

    return true;
}

export default [
    {
        method: 'GET',
        path: '/api/services',
        handler: async () => {
            return await services.getServices();
        }
    },
    {
        method: 'GET',
        path: '/api/services/{service}',
        handler: async (request) => {
            return services.getService(request.params.service);
        }
    },
    {
        method: 'POST',
        path: '/api/services/reload',
        handler: async (request, h) => {
            try {
                await services.loadServiceAdapters();
                return { status: 'ok', service: services };
            } catch (e) {
                console.log(e);
                return h.response({ error: e }).code(500);
            }
        }
    },
    {
        method: 'POST',
        path: '/api/services/{service}/adapter/{id}',
        handler: async (request, h) => {
            const response = await services.addServiceAdapter(request.params.service, request.params.id);
            if (response?.error) {
                return h.response(response).code(404);
            }

            await queue.ensureProcessConsumersForService(request.params.service);
            return response;
        }
    },
    {
        method: 'POST',
        path: '/api/services/register',
        handler: async (request, h) => {
            try {
                const source = request.payload?.source || request.query?.source || 'runtime';
                const descriptor = request.payload?.service || request.payload;
                return await services.registerServiceDescriptorAndPersist(descriptor, { source });
            } catch (error) {
                const code = error.statusCode || 500;
                return h.response({ error: error.message }).code(code);
            }
        }
    },
    {
        method: 'POST',
        path: '/api/services/{service}/help/ingest',
        handler: async (request, h) => {
            try {
                const serviceId = normalizeServiceId(request.params.service);
                const serviceConfig = services.getService(serviceId);

                if (!serviceConfig) {
                    throw Boom.notFound('Service not found');
                }

                const serviceBaseUrl = getServiceBaseUrl(serviceConfig);
                if (!serviceBaseUrl) {
                    throw Boom.badRequest('Service URL is not configured');
                }

                const requestedHelpUrl = request.payload?.help_url || request.query?.help_url;
                const helpSourceUrl = normalizeHelpSourceUrl(requestedHelpUrl, serviceBaseUrl);

                const helpResponse = await got.get(helpSourceUrl, {
                    responseType: 'buffer',
                    headers: {
                        accept: 'text/markdown, text/plain;q=0.9, text/html;q=0.8, */*;q=0.1',
                    },
                });
                const helpBody = helpResponse.body;
                const contentType = String(helpResponse.headers['content-type'] || '').toLowerCase();

                const isArchiveSource = isHelpArchiveSource({
                        contentType,
                        helpSourceUrl,
                        requestedHelpUrl,
                });

                if (!isArchiveSource && !String(helpBody || '').trim()) {
                    throw Boom.badGateway('Service help response is empty');
                }

                const { resolvedServiceDir, htmlPath } = resolveServiceHelpPath(serviceId);
                await fse.ensureDir(resolvedServiceDir);

                const bundleResult = isArchiveSource
                    ? await ingestServiceHelpArchiveBundle({
                        serviceId,
                        resolvedServiceDir,
                        helpBody,
                    })
                    : await ingestServiceHelpBundle({
                        serviceId,
                        helpSourceUrl,
                        helpBody: helpBody.toString('utf8'),
                        contentType,
                        resolvedServiceDir,
                    });

                const indexExists = await fse.pathExists(htmlPath);
                if (!indexExists) {
                        throw Boom.badGateway('Service help bundle ingest did not produce index page');
                }

                return {
                    status: 'ok',
                    service: serviceId,
                    source: helpSourceUrl,
                    source_format: bundleResult.source_format,
                    content_type: contentType || 'unknown',
                    bundle: {
                            dir: bundleResult.bundle_dir,
                            files: bundleResult.bundle_files,
                            truncated: bundleResult.bundle_truncated,
                    },
                    output: `/help/services/${serviceId}/index.html`,
                };
            } catch (error) {
                if (Boom.isBoom(error)) {
                    throw error;
                }
                if (error.response) {
                    throw Boom.badGateway(`Could not fetch service help: ${error.response.statusCode}`);
                }
                throw Boom.badGateway(`Could not ingest service help: ${error.message}`);
            }
        }
    },
    {
        method: 'GET',
        path: '/api/services/{service}/help',
        options: {
            auth: false,
        },
        handler: async (request, h) => {
            const serviceId = normalizeServiceId(request.params.service);
            const { htmlPath } = resolveServiceHelpPath(serviceId);
            const exists = await fse.pathExists(htmlPath);

            if (!exists) {
                throw Boom.notFound('Service help page not found');
            }

            const html = await fse.readFile(htmlPath, 'utf8');
            return h.response(html).type('text/html; charset=utf-8');
        }
    },
    {
        method: 'GET',
        path: '/api/services/{service}/help/assets/{assetPath*}',
        options: {
            auth: false,
        },
        handler: async (request, h) => {
            const serviceId = normalizeServiceId(request.params.service);
            const { resolvedAssetPath, legacyBundleAssetPath } = resolveServiceHelpAssetPath(serviceId, request.params.assetPath);
            const rootExists = await fse.pathExists(resolvedAssetPath);
            const legacyExists = await fse.pathExists(legacyBundleAssetPath);

            if (!rootExists && !legacyExists) {
                throw Boom.notFound('Service help asset not found');
            }

            const filePath = rootExists ? resolvedAssetPath : legacyBundleAssetPath;
            const body = await fse.readFile(filePath);
            return h.response(body).type(guessHelpAssetContentType(filePath));
        }
    },
    {
        method: 'DELETE', 
        path: '/api/services/{service}/adapter/{id}',
        handler: async (request) => {
            const adapter = await services.getServiceAdapterByName(request.params.service);
            const response = await services.removeServiceAdapter(request.params.service, request.params.id);
            await nomad.stopService(adapter);
            return response;
        }
    },
    {
        method: 'GET',
        path: '/api/services/files/{rid}',
        handler: async (request) => {
            const file = await Graph.getUserFileMetadata(
                request.params.rid,
                request.auth.credentials.user.rid
            );
            const prompts = await Graph.getPrompts(request.auth.credentials.user.rid);
            const filterList = await filters.loadFilters();
            const allFilters = Object.values(filterList);
            const filtersArray = file
                ? allFilters.filter((filter) => doesFilterMatchNode(filter, file))
                : allFilters;

            if (file) {
                const matches = await services.getServicesForNode(
                    file,
                    request.query.filter,
                    request.auth.credentials.user,
                    prompts
                );
                matches.filters = filtersArray;
                return matches;
            }
            return { for_type: [], for_format: [], filters: filtersArray };
        }
    }
]; 