// Page ranges typed by the user, e.g. "1-5,8,10-". Pages are 1-based and inclusive. The same
// grammar is parsed by the PDF splitter (MD-pypdf_fs), which must stay in step with this file.

export type PageRange = Array<[number, number]>;

const OPEN_END = Number.MAX_SAFE_INTEGER;

/** The parsed range, or null for an empty one (= all pages). Throws an Error naming the bad part. */
export function parsePageRange(text: unknown): PageRange | null {
    const raw = String(text ?? '').trim();
    if (!raw) return null;
    const range: PageRange = [];
    for (const part of raw.split(',')) {
        const item = part.trim();
        const match = /^(\d+)?\s*(-)?\s*(\d+)?$/.exec(item);
        if (!item || !match || (!match[1] && !match[3])) throw new Error(`Invalid page range "${item}". Use for example 1-5,8,10-`);
        const from = match[1] ? Number(match[1]) : 1;
        const to = match[2] ? (match[3] ? Number(match[3]) : OPEN_END) : from;
        if (from < 1 || to < from) throw new Error(`Invalid page range "${item}". Pages start from 1 and a range goes upwards`);
        range.push([from, to]);
    }
    return range;
}

export function pageInRange(range: PageRange | null, page: number): boolean {
    if (!range) return true;
    return range.some(([from, to]) => page >= from && page <= to);
}
