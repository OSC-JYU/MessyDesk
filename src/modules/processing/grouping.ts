// Root-source grouping for many-to-one tasks: when a set holds pages of several split PDFs, a
// "combine" task runs once per original PDF (file1.pdf -> file1.pdf.txt) instead of once for all.

import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { tryRid } from '../../platform/ids.ts';

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

/**
 * Groups files by their root source: walking DERIVED_FROM up, the topmost PDF (the "boundary"),
 * else the topmost file that is not a ZIP.
 */
export async function groupByRootSource(db: ArcadeClient, files: any[], boundary = 'pdf', excluded = ['zip']): Promise<FileGroup[]> {
    const excludedTypes = new Set(excluded.map((t) => t.toLowerCase()));
    const byRid = new Map<string, any>();
    for (const file of files || []) {
        const rid = tryRid(file?.['@rid']);
        if (rid) byRid.set(rid, file);
    }
    const parent = new Map<string, string>();
    const meta = new Map<string, any>();
    for (const [rid, file] of byRid) meta.set(rid, { '@rid': rid, label: file.label, type: file.type, path: file.path, original_filename: file.original_filename });

    let frontier = [...byRid.keys()];
    const visited = new Set<string>();
    for (let depth = 0; frontier.length && depth < 40; depth += 1) {
        const batch = frontier.filter((r) => !visited.has(r));
        if (!batch.length) break;
        batch.forEach((r) => visited.add(r));
        frontier = [];
        const edges = await db.rows('SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN :rids', { rids: batch });
        const sources: string[] = [];
        for (const edge of edges) {
            if (!edge.target_rid || !edge.source_rid) continue;
            if (!parent.has(edge.target_rid)) parent.set(edge.target_rid, edge.source_rid);
            sources.push(edge.source_rid);
            if (!visited.has(edge.source_rid)) frontier.push(edge.source_rid);
        }
        const missing = [...new Set(sources)].filter((r) => !meta.has(r));
        if (missing.length) {
            for (const row of await db.rows('SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN :rids', { rids: missing })) {
                meta.set(row.rid, { '@rid': row.rid, label: row.label, type: row.type, path: row.path, original_filename: row.original_filename });
            }
        }
    }

    const groups = new Map<string, FileGroup>();
    for (const [fileRid, file] of byRid) {
        let cursor: string | undefined = fileRid;
        let boundaryRid: string | null = null;
        let highest = fileRid;
        for (let guard = 0; cursor && guard < 40; guard += 1) {
            const type = String(meta.get(cursor)?.type || '').toLowerCase();
            if (!excludedTypes.has(type)) {
                highest = cursor;
                if (boundary === 'pdf' && type === 'pdf') boundaryRid = cursor;
            }
            cursor = parent.get(cursor);
        }
        const root = boundaryRid || highest || fileRid;
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
    const all: FileGroup = { source_rid: null, label: null, type: null, path: null, files: ordered };
    const decision = groupingDecision(service, task, isSearchOutput);
    if (!decision.enabled) return [all];
    const inputRids = new Set(ordered.map((f) => tryRid(f?.['@rid'])).filter(Boolean));
    const resolved = await groupByRootSource(db, ordered);
    // Group only when the grouping sources are themselves in the input set.
    const inSet = resolved.filter((g) => g.source_rid && inputRids.has(tryRid(g.source_rid)));
    if (!inSet.length) return [all];
    if (!decision.explicit && !inSet.some((g) => String(g.type || '').toLowerCase() === 'pdf')) return [all];
    const grouped = new Set<string>();
    for (const g of inSet) for (const f of g.files) { const r = tryRid(f?.['@rid']); if (r) grouped.add(r); }
    const rest = ordered.filter((f) => !grouped.has(tryRid(f?.['@rid']) || ''));
    const groups = inSet.map((g) => ({ ...g, files: sortFiles(g.files) }));
    if (rest.length) groups.push({ source_rid: null, label: null, type: null, path: null, files: rest });
    return groups;
}
