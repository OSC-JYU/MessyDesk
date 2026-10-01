// Regions of interest drawn on an image, stored as one roi.json File node per (image, region set).
// Coordinates are percentages of the image size.

import Boom from '@hapi/boom';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { ridToPathPart, toRid, tryRid } from '../../platform/ids.ts';
import { readJson, writeJson } from '../../platform/storage/fsutil.ts';
import type { GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';
import type { GraphService } from '../graph/graph.ts';

/** URL segments may use "12_3" as well as "12:3". */
function rid(value: string): string {
    const r = tryRid(String(value).replace('_', ':'));
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

export class RoisService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly access: AccessService;
    private readonly graph: GraphService;

    constructor(db: ArcadeClient, store: GraphStore, access: AccessService, graph: GraphService) {
        this.db = db;
        this.store = store;
        this.access = access;
        this.graph = graph;
    }

    private async roiOf(imageRid: string, setRid: string): Promise<any | null> {
        const row = await this.db.first(
            'MATCH {type:File, as:roi, where:(set = :set AND type = "roi.json")}-DERIVED_FROM->{type:File, where:(@rid = :image)} RETURN roi ORDER BY roi.created DESC LIMIT 1',
            { set: setRid, image: imageRid },
        );
        return row?.roi || null;
    }

    /** POST: creates the roi.json, or overwrites the existing one (upsert). */
    async save(imageParam: string, setParam: string, data: unknown, userRid: string): Promise<any> {
        const image = rid(imageParam);
        const set = rid(setParam);
        const owned = await this.access.findOwned(image, userRid);
        if (!owned) throw Boom.notFound('Image not found: ' + image);
        const imagePath = owned.node.path;
        if (!imagePath) throw Boom.badRequest('Image path not found for node: ' + image);
        const existing = await this.roiOf(image, set);
        if (existing) {
            if (!existing.path) throw Boom.internal('ROI path not found for node: ' + existing['@rid']);
            await writeJson(path.dirname(existing.path), path.basename(existing.path), data);
            return existing;
        }
        const roi = await this.store.createVertex('File', {
            type: 'roi.json',
            extension: 'json',
            set,
            project_rid: owned.node.project_rid || owned.projectRid,
            label: `${path.basename(owned.node.label || image)}.roi.json`,
        });
        await this.store.connectDerivedFrom(roi['@rid'], image);
        const dir = path.dirname(imagePath);
        const file = `${ridToPathPart(roi['@rid'])}.roi.json`;
        await writeJson(dir, file, data);
        await this.store.setAttributes(roi['@rid'], { path: path.join(dir, file), set });
        return roi;
    }

    async read(imageParam: string, setParam: string, userRid: string): Promise<any> {
        const image = rid(imageParam);
        if (!(await this.access.canRead(image, userRid))) throw Boom.notFound('ROI not found for file: ' + image);
        const roi = await this.roiOf(image, rid(setParam));
        if (!roi) throw Boom.notFound('ROI not found for file: ' + image);
        try {
            return await readJson(roi.path);
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code === 'ENOENT') throw Boom.notFound('ROI JSON file not found: ' + roi.path);
            throw Boom.internal('Error reading ROI JSON: ' + (error as Error).message);
        }
    }

    async update(roiParam: string, data: unknown, userRid: string): Promise<any> {
        const owned = await this.access.findOwned(rid(roiParam), userRid);
        if (!owned) throw Boom.notFound('ROI not found: ' + roiParam);
        if (!owned.node.path) throw Boom.internal('ROI path not found for node: ' + roiParam);
        await writeJson(path.dirname(owned.node.path), path.basename(owned.node.path), data);
        return { message: 'ROI updated successfully' };
    }

    async remove(imageParam: string, setParam: string, roiParam: string, userRid: string): Promise<any> {
        const image = rid(imageParam);
        const set = rid(setParam);
        const roi = rid(roiParam);
        const row = await this.db.first(
            'MATCH {type:File, as:roi, where:(@rid = :roi AND set = :set AND type = "roi.json")}-DERIVED_FROM->{type:File, as:image, where:(@rid = :image)} RETURN roi.@rid AS rid',
            { roi, set, image },
        );
        if (!row) throw Boom.notFound('ROI not found for delete');
        await this.graph.deleteNode(toRid(roi), userRid);
        return { message: 'ROI deleted successfully', deleted: true };
    }
}
