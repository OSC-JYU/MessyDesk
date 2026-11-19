// Text regions: spans of a text file, stored in a roi.json like image regions but with offsets.
//
// `start` (inclusive) and `end` (exclusive) count Unicode code points, as Python services (Gliner)
// produce them. JavaScript strings are UTF-16, so every offset the backend checks goes through
// these helpers. `text_hash` ties a region set to the exact text its offsets refer to.

import crypto from 'node:crypto';

export interface TextRegion {
    id: string;
    type: 'text';
    start: number;
    end: number;
    text: string;
    [key: string]: unknown;
}

export interface TextRegionSet {
    rois: Record<string, TextRegion>;
    text_hash?: string;
}

export function textHash(text: string): string {
    return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export function codePointLength(text: string): number {
    let count = 0;
    for (const _ of text) count++;
    return count;
}

/** The text between two code point offsets. */
export function sliceCodePoints(text: string, start: number, end: number): string {
    return Array.from(text).slice(start, end).join('');
}

/** Regions of a roi.json (`{ rois: {id: region} }` or a list) as a list. */
export function regionList(data: any): any[] {
    const rois = data?.rois ?? data;
    if (Array.isArray(rois)) return rois;
    return rois && typeof rois === 'object' ? Object.values(rois) : [];
}

const MAX_ID_LENGTH = 100;

/**
 * Checks a text region set against the text and returns it in the stored shape: regions keyed by id,
 * `text` filled from the offsets when missing, `text_hash` of the text. Throws an Error with a
 * message for the user on the first invalid region.
 */
export function normalizeTextRegions(data: any, text: string): TextRegionSet {
    const length = codePointLength(text);
    const points = Array.from(text);
    const rois: Record<string, TextRegion> = {};
    for (const region of regionList(data)) {
        const id = String(region?.id ?? '').trim();
        if (!id || id.length > MAX_ID_LENGTH) throw new Error('Every region needs an id');
        if (rois[id]) throw new Error(`Duplicate region id: ${id}`);
        const { start, end } = region;
        if (!Number.isInteger(start) || !Number.isInteger(end)) throw new Error(`Region ${id}: start and end must be whole numbers`);
        if (start < 0 || end > length || start >= end) throw new Error(`Region ${id}: offsets ${start}-${end} do not fit a text of ${length} characters`);
        rois[id] = { ...region, id, type: 'text', start, end, text: points.slice(start, end).join('') };
    }
    return { rois, text_hash: textHash(text) };
}

/**
 * Whether a stored region set no longer matches the text. A set without a hash (written by a
 * service) is stale when a region's snippet differs from the text at its offsets.
 */
export function isStale(data: any, text: string): boolean {
    if (data?.text_hash) return data.text_hash !== textHash(text);
    return regionList(data).some((r) => typeof r?.text === 'string' && sliceCodePoints(text, r.start, r.end) !== r.text);
}
