// File type detection and the metadata stored on File nodes: size, image dimensions/EXIF
// rotation, and the short text preview (`info`) of text-like files.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { imageSize } from 'image-size';
import { FILE_TYPE, isPdfType } from '../../shared/service-ids.ts';
import type { ArcadeClient } from '../../platform/arcade/client.ts';

export const TEXT_LIKE_TYPES = ['text', 'html', 'json', 'csv'];

/** File type from the upload's MIME type and extension; undefined when not supported. */
export function detectType(filename: string, mimeType: string | undefined): string | undefined {
    const extension = path.extname(filename || '').toLowerCase();
    const mime = String(mimeType || '');
    const major = mime.split('/')[0];
    if (mime === 'application/zip' || extension === '.zip') return 'zip';
    if (major === 'image') return 'image';
    if (mime === 'application/pdf' || extension === '.pdf') return FILE_TYPE.ORIGINAL_PDF;
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

const XML_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function decodeXml(text: string): string {
    return text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (whole, name: string) => {
        if (name[0] === '#') {
            const code = name[1] === 'x' || name[1] === 'X' ? parseInt(name.slice(2), 16) : parseInt(name.slice(1), 10);
            return Number.isFinite(code) ? String.fromCodePoint(code) : whole;
        }
        return XML_ENTITIES[name] ?? whole;
    });
}

/** The text lines of a PAGE XML (page.xml), in document order: each TextLine's own TextEquiv. */
export function pageXmlLines(xml: string): string[] {
    const lines: string[] = [];
    for (const match of xml.matchAll(/<(?:\w+:)?TextLine\b[^>]*>([\s\S]*?)<\/(?:\w+:)?TextLine>/g)) {
        const own = match[1].replace(/<(?:\w+:)?Word\b[\s\S]*?<\/(?:\w+:)?Word>/g, '');
        const unicode = /<(?:\w+:)?Unicode>([\s\S]*?)<\/(?:\w+:)?Unicode>/.exec(own);
        lines.push(decodeXml(unicode ? unicode[1] : ''));
    }
    return lines;
}

/** The `info` preview: first 150 characters, or a summary for ner.json, ocr.json and page.xml. */
export async function textDescription(filePath: string, fileType: string): Promise<string | null> {
    const max = 150;
    try {
        const data = await fsp.readFile(filePath, 'utf8');
        if (fileType === 'ner.json') return nerSummary(data);
        if (fileType === 'page.xml') return pageXmlLines(data).join(' ').substring(0, max);
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

/** The first two text snippets of a set, as shown on its node. */
export async function setTextSamples(db: ArcadeClient, setRid: string): Promise<Array<{ label: string; text: string }>> {
    const rows = await db.rows("SELECT label, info FROM File WHERE set = :set AND type IN ['text', 'page.xml'] AND info IS NOT NULL AND info <> '' ORDER BY label LIMIT 2", { set: setRid });
    return rows.map((r) => {
        const raw = String(r.info).trim();
        return { label: r.label || '', text: raw.length > 280 ? `${raw.slice(0, 280)}...` : raw };
    });
}

export function contentTypeFor(file: { type?: string; extension?: string; label?: string }): { type?: string; disposition?: string } {
    if (isPdfType(file.type)) return { type: 'application/pdf', disposition: `inline; filename=${file.label}` };
    // Images are always labelled image/png (old behaviour, plan/decisions.md C3).
    if (file.type === 'image') return { type: 'image/png' };
    if (file.extension === 'csv') return { type: 'text/csv; charset=utf-8' };
    if (file.type === 'text' || file.type === 'data') return { type: 'text/plain; charset=utf-8' };
    if (file.type === 'page.xml') return { type: 'application/xml; charset=utf-8' };
    if (String(file.type || '').includes('.json')) return { type: 'application/json' };
    const safe = encodeURIComponent(String(file.label || '')).replace(/['()]/g, (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase()).replace(/\*/g, '%2A');
    return { disposition: `attachment; filename="${safe}"` };
}
