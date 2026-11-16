// Merging sets: a new Set that holds references to the files of two or more sets of the same type.
// The files are not copied (a reference shares the bytes of the file, and the tags and ROI labels
// stay on that file), and the sets that were merged stay as they are. A file that is in more than
// one of the sets, or reached through a reference, is added once.

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, tryRid } from '../../platform/ids.ts';
import { ensureDir } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';
import { resolveReferences } from '../files/references.ts';
import type { NodesService } from '../nodes/nodes.ts';

export const SET_MERGE = 'mdf-set-merge';
const LABEL_MAX = 80;

export class SetMerge {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly nodes: NodesService;

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout, access: AccessService, nodes: NodesService) {
        this.db = db;
        this.store = store;
        this.layout = layout;
        this.access = access;
        this.nodes = nodes;
    }

    /** POST /api/sets/merge: { set_rids: [...], label? }. */
    async merge(setRids: unknown, label: unknown, userRid: string): Promise<any> {
        const rids = [...new Set((Array.isArray(setRids) ? setRids : []).map((r) => tryRid(String(r))).filter(Boolean))] as string[];
        if (rids.length < 2) throw Boom.badRequest('Select at least two sets to merge');

        const sets = [];
        let project: string | null = null;
        for (const rid of rids) {
            const owned = await this.access.findOwned(rid, userRid);
            if (!owned || owned.node['@type'] !== 'Set') throw Boom.badRequest(`Set not found: ${rid}`);
            if (['search', 'roi-set'].includes(String(owned.node.type || '').toLowerCase())) throw Boom.badRequest(`"${owned.node.label || rid}" is not a set of files and cannot be merged`);
            if (project && project !== owned.projectRid) throw Boom.badRequest('Sets of different desks cannot be merged');
            project = owned.projectRid;
            sets.push({ rid, label: String(owned.node.label || rid) });
        }

        const members = await this.db.rows(
            'SELECT @rid AS rid, set, project_rid, type, extension, label, info FROM File WHERE set IN :sets ORDER BY label',
            { sets: rids },
        );
        const types = [...new Set(members.map((f) => String(f.type || '').toLowerCase()))];
        if (types.length > 1) throw Boom.badRequest(`The sets have different kinds of files (${types.join(', ')}). Only sets with the same kind of files can be merged.`);
        if (!members.length) throw Boom.badRequest('The sets have no files');

        // Source set order first, then name; a file that is already in is skipped.
        const order = new Map(rids.map((r, i) => [r, i]));
        members.sort((a, b) => (order.get(a.set) ?? 0) - (order.get(b.set) ?? 0));
        const actual = await resolveReferences(this.db, members.map((m) => m.rid));
        const seen = new Set<string>();
        const unique = members.filter((m) => {
            const real = actual.get(m.rid)!;
            if (seen.has(real)) return false;
            seen.add(real);
            return true;
        });

        const names = sets.map((s) => s.label);
        const typed = typeof label === 'string' ? label.trim() : '';
        const setLabel = (typed || names.join(' + ')).slice(0, LABEL_MAX);

        const process = await this.store.createVertex('SetProcess', {
            filter_id: SET_MERGE,
            label: 'Merge sets',
            project_rid: project,
            info: `Merged ${sets.length} sets: ${names.join(', ')}`,
        });
        const processRid = process['@rid'];
        const processPath = this.layout.processFilesDir(project, process.uuid || processRid);
        await ensureDir(processPath);
        await this.store.setAttribute(processRid, 'path', processPath);
        process.path = processPath;
        if (project) await this.store.connect(processRid, EDGE.BELONGS_TO, project);

        const output = await this.store.createVertex('Set', { label: setLabel, project_rid: project });
        const setPath = this.layout.setDir(project, output.uuid || output['@rid']);
        await ensureDir(setPath);
        await this.store.setAttribute(output['@rid'], 'path', setPath);
        output.path = setPath;
        for (const set of sets) await this.store.connectDerivedFrom(output['@rid'], set.rid, processRid);

        for (const file of unique) {
            const message = { file: { '@rid': file.rid, project_rid: file.project_rid || project, type: file.type, extension: file.extension, label: file.label }, output_set: output['@rid'] };
            await this.nodes.createReferenceFile(processRid, message, file.rid, '', file.info || '');
        }
        await this.nodes.updateFileCount(output['@rid']);
        return { process, output_set: output, merged_sets: sets.length, files: unique.length, skipped_duplicates: members.length - unique.length };
    }
}
