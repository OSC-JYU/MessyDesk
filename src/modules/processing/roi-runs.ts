// Runs on a region set (Set of type roi-set): which images get a job, and which are passed on as
// references. A region set only holds the roi.json files of the images the user drew on, so the
// images without regions (no roi.json, or an emptied one) are found from the set it was drawn on.
//
// The run param `no_rois` decides about those images:
//   only  they are left out, and so are the empty roi.json files
//   all   they go to the output as they are. A task with `"no_rois_output": "reference"` in
//         service.json gets references made here, without jobs; any other task gets the image
//         itself as a job (a service sees an image input of a ROI task as "no regions").
// Without the param the run works as before: one job per roi.json.

import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { readJson } from '../../platform/storage/fsutil.ts';
import { RoisService } from '../rois/rois.ts';

export const ROI_SET = 'roi-set';
const IMAGE_FIELDS = '@rid AS rid, type, extension, label, project_rid';

export type RoiMode = 'all' | 'only';

export interface RoiImage { rid: string; type: string; extension: string; label: string; project_rid: string | null }

export interface RoiPlan {
    /** set listing entries to dispatch; a placeholder is `{ '@rid': <image>, roi_placeholder: true }` */
    jobs: any[];
    /** images without regions that become references in MessyDesk */
    references: RoiImage[];
}

export function isRoiSet(set: any): boolean {
    return String(set?.type || '').toLowerCase() === ROI_SET;
}

export function roiMode(task: any): RoiMode | null {
    const value = String(task?.params?.no_rois ?? '').toLowerCase();
    return value === 'all' || value === 'only' ? value : null;
}

export function referencesLocally(service: any, task: any): boolean {
    return service?.tasks?.[task?.id]?.no_rois_output === 'reference';
}

async function hasRegions(file: any): Promise<boolean> {
    if (!file?.path) return false;
    return RoisService.regionCount(await readJson(file.path).catch(() => null)) > 0;
}

/** The images of what the region set was drawn on: a set of images, or one image. */
async function drawnOn(db: ArcadeClient, roiSetRid: string): Promise<RoiImage[]> {
    const edges = await db.edgesOf('out', 'DERIVED_FROM', [roiSetRid]);
    const images: RoiImage[] = [];
    for (const source of edges.map((e: any) => String(e.source)).filter(Boolean)) {
        const inSet = await db.rows(`SELECT ${IMAGE_FIELDS} FROM File WHERE set = :set AND type = 'image' ORDER BY label`, { set: source });
        images.push(...(inSet.length ? inSet : await db.rowsByRids(IMAGE_FIELDS, [source], "@type = 'File' AND type = 'image'")));
    }
    return images;
}

export async function planRoiRun(db: ArcadeClient, roiSetRid: string, roiFiles: any[], mode: RoiMode | null, local: boolean): Promise<RoiPlan> {
    if (!mode) return { jobs: roiFiles, references: [] };
    const jobs: any[] = [];
    for (const file of roiFiles) if (await hasRegions(file)) jobs.push(file);
    if (mode === 'only') return { jobs, references: [] };

    const drawn = new Set((await db.edgesOf('out', 'DERIVED_FROM', jobs.map((f) => f['@rid']))).map((e: any) => String(e.source)));
    const without = (await drawnOn(db, roiSetRid)).filter((image) => !drawn.has(String(image.rid)));
    if (local) return { jobs, references: without };
    return { jobs: [...jobs, ...without.map((image) => ({ '@rid': image.rid, roi_placeholder: true }))], references: [] };
}
