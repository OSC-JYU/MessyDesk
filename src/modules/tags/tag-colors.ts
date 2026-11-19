// Colours for tags, so that coded passages of different tags are easy to tell apart.
//
// A new human tag of the default type gets the palette colour that the user's tags use least, in
// palette order. The colour is stored on the tag and can be changed. A tag that has none (made
// before colours were assigned) is shown in a colour taken from a hash of its label.

/** Distinct, readable on white and dark backgrounds, ordered so that neighbours differ clearly. */
export const TAG_PALETTE = [
    '#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#008080',
    '#f032e6', '#9a6324', '#808000', '#469990', '#800000', '#000075',
] as const;

const HEX_COLOR = /^#[0-9a-fA-F]{6}$/;

export function isHexColor(value: unknown): value is string {
    return typeof value === 'string' && HEX_COLOR.test(value);
}

/** The palette colour used by the fewest of `used` (ties: first in the palette). */
export function nextTagColor(used: Array<string | null | undefined>): string {
    const counts = new Map<string, number>(TAG_PALETTE.map((c) => [c, 0]));
    for (const color of used) {
        const key = String(color || '').toLowerCase();
        if (counts.has(key)) counts.set(key, counts.get(key)! + 1);
    }
    let best: string = TAG_PALETTE[0];
    for (const color of TAG_PALETTE) if (counts.get(color)! < counts.get(best)!) best = color;
    return best;
}

/** A stable palette colour for a tag that has none. */
export function colorFromLabel(label: string): string {
    let hash = 0;
    for (const char of String(label)) hash = (hash * 31 + (char.codePointAt(0) || 0)) >>> 0;
    return TAG_PALETTE[hash % TAG_PALETTE.length];
}
