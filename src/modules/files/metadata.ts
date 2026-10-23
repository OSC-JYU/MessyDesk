// File type detection and the metadata stored on File nodes: size, image dimensions/EXIF
// rotation, and the short text preview (`info`) of text-like files.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';

export const TEXT_LIKE_TYPES = ['text', 'html', 'json', 'csv'];

/** File type from the upload's MIME type and extension; undefined when not supported. */
export function detectType(filename: string, mimeType: string | undefined): string | undefined {
    const extension = path.extname(filename || '').toLowerCase();
    const mime = String(mimeType || '');
    const major = mime.split('/')[0];
    if (mime === 'application/zip' || extension === '.zip') return 'zip';
    if (major === 'image') return 'image';
    if (mime === 'application/pdf' || extension === '.pdf') return 'pdf';
    if (mime === 'application/octet-stream' || extension === '.csv') return extension === '.csv' ? 'csv' : undefined;
    if (mime === 'application/json' || extension === '.json') return 'json';
    if (mime === 'application/html' || extension === '.html') return 'html';
    if (['text/plain', 'text/markdown', 'text/x-markdown', 'application/markdown'].includes(mime) || extension === '.txt' || extension === '.md') return 'text';
    return undefined;
}

export interface ImageMetadata {
    width?: number;
    height?: number;
    imgtype?: string;
    orientation?: number;
    rotate?: number;
}

/** Image dimensions; `rotate` is set when the EXIF orientation needs a rotation. */
export function imageMetadata(filePath: string): ImageMetadata {
    const data: ImageMetadata = {};
    try {
        const dims = imageSize(filePath);
        data.width = dims.width;
        data.height = dims.height;
        data.imgtype = dims.type;
        if (dims.orientation && dims.orientation !== 1) {
            data.orientation = dims.orientation;
            if (dims.orientation === 3) data.rotate = 180;
            if (dims.orientation === 6) data.rotate = 90;
            if (dims.orientation === 8) data.rotate = 270;
        }
    } catch {
        // Not an image we can read: no dimensions.
    }
    return data;
}

function nerSummary(data: string): string | null {
    try {
        const parsed = JSON.parse(data);
        const counts: Record<string, number> = {};
        for (const entity of Object.values<any>(parsed.rois || parsed || {})) {
            const group = entity.label || entity.entity_group;
            counts[group] = (counts[group] || 0) + 1;
        }
        let summary = 'Entity Groups Found:\n';
        for (const [group, count] of Object.entries(counts)) summary += `- ${group}: ${count}\n`;
        return summary;
    } catch {
        return null;
    }
}

/** The `info` preview: first 150 characters, or a summary for ner.json and ocr.json. */
export async function textDescription(filePath: string, fileType: string): Promise<string | null> {
    const max = 150;
    try {
        const data = await fsp.readFile(filePath, 'utf8');
        if (fileType === 'ner.json') return nerSummary(data);
        if (fileType === 'ocr.json') {
            const json = JSON.parse(data);
            let text = '';
            for (const item of json) text += item.text + ' ';
            return text.substring(0, max);
        }
        return data.substring(0, max).replace(/[^a-zA-Z0-9.,<>\s/äöåÄÖÅøØæÆ-]/g, '') + '...';
    } catch {
        return '';
    }
}

export function contentTypeFor(file: { type?: string; extension?: string; label?: string }): { type?: string; disposition?: string } {
    if (file.type === 'pdf') return { type: 'application/pdf', disposition: `inline; filename=${file.label}` };
    // Images are always labelled image/png (old behaviour, plan/decisions.md C3).
    if (file.type === 'image') return { type: 'image/png' };
    if (file.extension === 'csv') return { type: 'text/csv; charset=utf-8' };
    if (file.type === 'text' || file.type === 'data') return { type: 'text/plain; charset=utf-8' };
    if (String(file.type || '').includes('.json')) return { type: 'application/json' };
    const safe = encodeURIComponent(String(file.label || '')).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/\*/g, '%2A');
    return { disposition: `attachment; filename="${safe}"` };
}
