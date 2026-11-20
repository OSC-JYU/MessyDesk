// Grouped browsing of a set: its files are shown by the original PDF they come from (`origin_rid`).
// Only the view is grouped; the set itself stays flat. These are the pure parts: the order of the
// groups and which part of the files a page of the view needs.

export interface GroupRow {
    origin_rid: string;
    origin_label: string;
    count: number;
}

/** The groups in the order of the view: by label, then rid. */
export function sortGroups(rows: Array<{ origin_rid: string; origin_label?: string | null; count: number | string }>): GroupRow[] {
    return rows
        .map((r) => ({ origin_rid: String(r.origin_rid), origin_label: String(r.origin_label || ''), count: Number(r.count) || 0 }))
        .sort((a, b) => a.origin_label.localeCompare(b.origin_label) || a.origin_rid.localeCompare(b.origin_rid));
}

/** A set is shown grouped when it has files from a PDF, unless they all come from one PDF and nothing else is in it. */
export function isGrouped(groups: GroupRow[], ungrouped: number): boolean {
    if (!groups.length) return false;
    return !(groups.length === 1 && ungrouped === 0);
}

/** One page of the top level: group cards first, then the files without an origin as they are. */
export function entryWindow(groups: GroupRow[], ungrouped: number, skip: number, limit: number): { groups: GroupRow[]; fileSkip: number; fileLimit: number } {
    const shown = groups.slice(skip, skip + limit);
    const fileSkip = Math.max(0, skip - groups.length);
    const fileLimit = Math.max(0, Math.min(limit - shown.length, ungrouped - fileSkip));
    return { groups: shown, fileSkip, fileLimit };
}

export interface Segment {
    origin: string | null; // null: the files without an origin
    skip: number;
    limit: number;
}

/**
 * The parts of the whole set, in the grouped order (groups in order, the pages of each by page
 * number, then the files without an origin), that make up positions [skip, skip + limit).
 */
export function flatSegments(groups: GroupRow[], ungrouped: number, skip: number, limit: number): Segment[] {
    const parts: Array<{ origin: string | null; count: number }> = groups.map((g) => ({ origin: g.origin_rid, count: g.count }));
    if (ungrouped > 0) parts.push({ origin: null, count: ungrouped });
    const segments: Segment[] = [];
    let start = 0;
    let want = limit;
    for (const part of parts) {
        const end = start + part.count;
        if (want <= 0) break;
        if (end > skip) {
            const from = Math.max(0, skip - start);
            const take = Math.min(part.count - from, want);
            segments.push({ origin: part.origin, skip: from, limit: take });
            want -= take;
            skip += take;
        }
        start = end;
    }
    return segments;
}
