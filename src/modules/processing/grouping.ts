// Root-source grouping for many-to-one tasks: when a set holds pages of several split PDFs, a
// "combine" task runs once per original PDF (file1.pdf -> file1.pdf.txt) instead of once for all.

import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { tryRid } from '../../platform/ids.ts';
import { FILE_TYPE, isPdfType } from '../../shared/service-ids.ts';

export interface FileGroup {
    source_rid: string | null;
    label: string | null;
    type: string | null;
    path: string | null;
    files: any[];
}

function sortName(file: any): string {
    if (file?.original_filename) return String(file.original_filename).toLowerCase();
    if (file?.label) return String(file.label).toLowerCase();
    if (file?.path) return path.basename(String(file.path)).toLowerCase();
    return '';
}

/** Page number first (when both have one), then file name. */
export function sortFiles(files: any[]): any[] {
    return [...(files || [])].sort((a, b) => {
        const ap = Number.isFinite(Number(a?.page_number)) ? Number(a.page_number) : null;
        const bp = Number.isFinite(Number(b?.page_number)) ? Number(b.page_number) : null;
        if (ap !== null && bp !== null && ap !== bp) return ap - bp;
        if (ap !== null && bp === null) return -1;
        if (ap === null && bp !== null) return 1;
        return sortName(a).localeCompare(sortName(b));
    });
}

const TEXT_SOURCE_EXTENSIONS = new Set(['txt', 'md', 'html']);

/** A source document for text: an uploaded PDF, or an uploaded text file (txt, md, html). */
function isTextSource(file: any, hasParent: boolean): boolean {
    const type = String(file?.type || '').toLowerCase();
    if (type === FILE_TYPE.ORIGINAL_PDF) return true;
    return type === 'text' && !hasParent && TEXT_SOURCE_EXTENSIONS.has(String(file?.extension || '').toLowerCase());
}

/**
 * Groups files by their root source: walking DERIVED_FROM up, the topmost PDF (the "boundary"),
 * else the topmost file that is not a ZIP.
 */
export async function groupByRootSource(db: ArcadeClient, files: any[], boundary: 'pdf' | 'text_source' = 'pdf', excluded = ['zip']): Promise<FileGroup[]> {
    const excludedTypes = new Set(excluded.map((t) => t.toLowerCase()));
    const byRid = new Map<string, any>();
    for (const file of files || []) {
        const rid = tryRid(file?.['@rid']);
        if (rid) byRid.set(rid, file);
    }
    const parent = new Map<string, string>();
    const meta = new Map<string, any>();
    for (const [rid, file] of byRid) meta.set(rid, { '@rid': rid, label: file.label, type: file.type, path: file.path, original_filename: file.original_filename, extension: file.extension });

    let frontier = [...byRid.keys()];
    const visited = new Set<string>();
    for (let depth = 0; frontier.length && depth < 40; depth += 1) {
        const batch = frontier.filter((r) => !visited.has(r));
        if (!batch.length) break;
        batch.forEach((r) => visited.add(r));
        frontier = [];
        const edges = await db.edgesOf('out', 'DERIVED_FROM', batch);
        const sources: string[] = [];
        for (const edge of edges) {
            if (!edge.target || !edge.source) continue;
            if (!parent.has(edge.target)) parent.set(edge.target, edge.source);
            sources.push(edge.source);
            if (!visited.has(edge.source)) frontier.push(edge.source);
        }
        const missing = [...new Set(sources)].filter((r) => !meta.has(r));
        if (missing.length) {
            for (const row of await db.rowsByRids('@rid AS rid, label, type, path, original_filename, extension', missing, "@type = 'File'")) {
                meta.set(row.rid, { '@rid': row.rid, label: row.label, type: row.type, path: row.path, original_filename: row.original_filename, extension: row.extension });
            }
        }
    }

    const groups = new Map<string, FileGroup>();
    for (const [fileRid, file] of byRid) {
        let cursor: string | undefined = fileRid;
        let boundaryRid: string | null = null;
        let highest = fileRid;
        let textSourceRid: string | null = null;
        for (let guard = 0; cursor && guard < 40; guard += 1) {
            const type = String(meta.get(cursor)?.type || '').toLowerCase();
            // Nearest source going up: split pages and derived texts are passed over.
            if (boundary === 'text_source' && !textSourceRid && isTextSource(meta.get(cursor), parent.has(cursor))) textSourceRid = cursor;
            if (!excludedTypes.has(type)) {
                highest = cursor;
                if (boundary === 'pdf' && isPdfType(type)) boundaryRid = cursor;
            }
            cursor = parent.get(cursor);
        }
        const root = textSourceRid || boundaryRid || highest || fileRid;
        if (!groups.has(root)) {
            const m = meta.get(root) || {};
            groups.set(root, { source_rid: root, label: m.label || m.original_filename || file.label, type: m.type || file.type, path: m.path || null, files: [] });
        }
        groups.get(root)!.files.push(file);
    }
    const list = [...groups.values()].sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
    for (const g of list) g.files.sort((a, b) => String(a.label || '').localeCompare(String(b.label || '')));
    return list;
}

function groupingDecision(service: any, task: any, isSearchOutput: boolean): { enabled: boolean; explicit: boolean } {
    const config = service?.tasks?.[task?.id] || {};
    if (task?.group_by_root_source === false || config.group_by_root_source === false) return { enabled: false, explicit: true };
    if (task?.grouping_mode === 'group_by_root_source' || config.grouping_mode === 'group_by_root_source') return { enabled: true, explicit: true };
    if (task?.group_by_root_source === true || config.group_by_root_source === true) return { enabled: true, explicit: true };
    if (isSearchOutput) return { enabled: false, explicit: false };
    return { enabled: true, explicit: false };
}

/** The dispatch groups of a many-to-one run: one group per root source found in the input set. */
export async function manyToOneGroups(db: ArcadeClient, service: any, task: any, files: any[], isSearchOutput: boolean): Promise<FileGroup[]> {
    const ordered = sortFiles(files);
    const textSource = (task?.grouping_mode || service?.tasks?.[task?.id]?.grouping_mode) === 'text_source';
    const all: FileGroup = { source_rid: null, label: null, type: null, path: null, files: ordered };
    if (textSource) return textSourceGroups(db, ordered);
    const decision = groupingDecision(service, task, isSearchOutput);
    if (!decision.enabled) return [all];
    const inputRids = new Set(ordered.map((f) => tryRid(f?.['@rid'])).filter(Boolean));
    const resolved = await groupByRootSource(db, ordered);
    // Group only when the grouping sources are themselves in the input set.
    const inSet = resolved.filter((g) => g.source_rid && inputRids.has(tryRid(g.source_rid)));
    if (!inSet.length) return [all];
    if (!decision.explicit && !inSet.some((g) => isPdfType(String(g.type || '').toLowerCase()))) return [all];
    const grouped = new Set<string>();
    for (const g of inSet) for (const f of g.files) { const r = tryRid(f?.['@rid']); if (r) grouped.add(r); }
    const rest = ordered.filter((f) => !grouped.has(tryRid(f?.['@rid']) || ''));
    const groups = inSet.map((g) => ({ ...g, files: sortFiles(g.files) }));
    if (rest.length) groups.push({ source_rid: null, label: null, type: null, path: null, files: rest });
    return groups;
}

/** One group per source document (original PDF or uploaded text); the source need not be in the set. */
async function textSourceGroups(db: ArcadeClient, ordered: any[]): Promise<FileGroup[]> {
    const groups = await groupByRootSource(db, ordered, 'text_source');
    return groups.map((g) => ({ ...g, files: sortFiles(g.files) }));
}
