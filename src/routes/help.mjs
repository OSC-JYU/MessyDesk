import path from 'path';
import { fileURLToPath } from 'url';
import fse from 'fs-extra';
import Boom from '@hapi/boom';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const HELP_DIR = path.resolve(__dirname, '../../public/help');
const HELP_IMAGE_DIR = path.resolve(__dirname, '../../public/help/images');
const HELP_STYLE_DIR = path.resolve(__dirname, '../../public/help/styles');
const SLUG_PATTERN = /^[a-z0-9-]+$/i;

function normalizeSlug(rawSlug) {
    if (!rawSlug) return 'index';
    const slug = String(rawSlug).trim().toLowerCase();
    if (!slug || slug === 'index') return 'index';
    if (!SLUG_PATTERN.test(slug)) {
        throw Boom.badRequest('Invalid help page slug');
    }
    return slug;
}

function resolveHelpImagePath(rawAssetPath) {
    if (!rawAssetPath) {
        throw Boom.badRequest('Missing help image path');
    }

    const normalized = path.normalize(String(rawAssetPath)).replace(/^[\\/]+/, '');
    const imagePath = path.resolve(path.join(HELP_IMAGE_DIR, normalized));

    if (!imagePath.startsWith(HELP_IMAGE_DIR + path.sep) && imagePath !== HELP_IMAGE_DIR) {
        throw Boom.forbidden('Help image path is outside allowed directory');
    }

    return imagePath;
}

function resolveHelpStylePath(rawAssetPath) {
    if (!rawAssetPath) {
        throw Boom.badRequest('Missing help style path');
    }

    const normalized = path.normalize(String(rawAssetPath)).replace(/^[\\/]+/, '');
    const stylePath = path.resolve(path.join(HELP_STYLE_DIR, normalized));

    if (!stylePath.startsWith(HELP_STYLE_DIR + path.sep) && stylePath !== HELP_STYLE_DIR) {
        throw Boom.forbidden('Help style path is outside allowed directory');
    }

    return stylePath;
}

export default [
    {
        method: 'GET',
        path: '/api/help/images/{assetPath*}',
        options: {
            auth: false,
        },
        handler: async (request, h) => {
            const imagePath = resolveHelpImagePath(request.params.assetPath);
            const exists = await fse.pathExists(imagePath);

            if (!exists) {
                throw Boom.notFound('Help image not found');
            }

            return h.file(imagePath, {
                confine: false,
            });
        },
    },
    {
        method: 'GET',
        path: '/api/help/styles/{assetPath*}',
        options: {
            auth: false,
        },
        handler: async (request, h) => {
            const stylePath = resolveHelpStylePath(request.params.assetPath);
            const exists = await fse.pathExists(stylePath);

            if (!exists) {
                throw Boom.notFound('Help style not found');
            }

            return h.file(stylePath, {
                confine: false,
            });
        },
    },
    {
        method: 'GET',
        path: '/api/help/{slug?}',
        options: {
            auth: false,
        },
        handler: async (request, h) => {
            const slug = normalizeSlug(request.params.slug);
            const filePath = path.join(HELP_DIR, `${slug}.html`);

            if (!filePath.startsWith(HELP_DIR + path.sep) && filePath !== HELP_DIR) {
                throw Boom.forbidden('Help path is outside allowed directory');
            }

            const exists = await fse.pathExists(filePath);
            if (!exists) {
                throw Boom.notFound('Help page not found');
            }

            const html = await fse.readFile(filePath, 'utf8');
            return h.response(html).type('text/html; charset=utf-8');
        },
    },
];
