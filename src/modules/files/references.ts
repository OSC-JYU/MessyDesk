// Reference files (made by filters) share the bytes of another file and carry none of its tags
// or ROI labels: those are looked up on the file they point to.

import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';

/** Member file -> the file its tags belong to. Follows `ref` links, so a filter of a filter works. */
export async function resolveReferences(db: ArcadeClient, files: string[]): Promise<Map<string, string>> {
    const actual = new Map(files.map((r) => [r, r]));
    let pending = files;
    for (let depth = 0; pending.length && depth < 10; depth += 1) {
        const rows = await db.rowsByRids('@rid AS rid, ref', pending, "@type = 'File' AND ref IS NOT NULL");
        const byRid = new Map(rows.map((r) => [r.rid, r]));
        const next: string[] = [];
        for (const [member, current] of actual) {
            const row = byRid.get(current);
            if (!row?.ref) continue;
            actual.set(member, toRid(row.ref));
            next.push(toRid(row.ref));
        }
        pending = [...new Set(next)];
    }
    return actual;
}
