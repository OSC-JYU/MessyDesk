// Creating and maintaining the nodes of a desk: files, sets, processes, error nodes, the set
// manifest and file counts. Shared by upload, processing, results, filters and import.

import path from 'node:path';
import { cypherString, type ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid, uuidv7, ridToPathPart } from '../../platform/ids.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { ensureDir, writeJson } from '../../platform/storage/fsutil.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';

export interface MessageLike {
    file: any;
    service?: any;
    task?: any;
    process?: any;
    output_set?: string | null;
    set?: string;
    set_process?: string;
    set_process_rid?: string;
    [key: string]: any;
}

function ridOf(value: unknown): string | undefined {
    if (!value) return undefined;
    if (typeof value === 'string') return value;
    return (value as any)['@rid'];
}

export class NodesService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;

    constructor(db: ArcadeClient, store: GraphStore, layout: DataLayout) {
        this.db = db;
        this.store = store;
        this.layout = layout;
    }

    // ---- sets --------------------------------------------------------------------------

    /** A user-created set on a desk. */
    async createSet(projectRid: string, data: Record<string, unknown>): Promise<any> {
        const set = await this.store.createVertex('Set', { ...data, project_rid: projectRid });
        await this.store.connect(set['@rid'], EDGE.BELONGS_TO, projectRid);
        const setPath = this.layout.setDir(projectRid, set.uuid || set['@rid']);
        const filepath = path.join(setPath, 'set.json');
        await ensureDir(setPath);
        await this.store.setAttributes(set['@rid'], { path: setPath, filepath });
        set.path = setPath;
        set.filepath = filepath;
        await this.syncSetManifest(set['@rid']);
        return set;
    }

    /** Output set of a one-to-many process, linked to the process input. */
    async createOutputSet(label: string, processNode: any): Promise<any> {
        const processRid = processNode['@rid'];
        const projectRid = processNode.project_rid || await this.store.projectRidOf(processRid);
        const attrs: Record<string, unknown> = { label };
        if (projectRid) attrs.project_rid = projectRid;
        const set = await this.store.createVertex('Set', attrs);
        const setPath = this.layout.setDir(projectRid, set.uuid || set['@rid']);
        await ensureDir(setPath);
        await this.store.setAttribute(set['@rid'], 'path', setPath);
        set.path = setPath;
        const input = processNode.input_set || processNode.file_rid;
        if (input) await this.store.connectDerivedFrom(set['@rid'], input, processRid);
        await this.syncSetManifest(set['@rid']);
        return set;
    }

    /** Output set of a set process (many-to-one, search index, reindex). */
    async createProcessSet(processRid: string, options: Record<string, any> = {}): Promise<any> {
        const attrs: Record<string, any> = { ...options };
        if (attrs.search_output) attrs.type = 'search';
        delete attrs.search_output;
        const set = await this.store.createVertex('Set', attrs);
        if (attrs.type && !set.type) set.type = attrs.type;
        const projectRid = attrs.project_rid || await this.store.projectRidOf(processRid);
        if (projectRid && !attrs.project_rid) await this.store.setAttribute(set['@rid'], 'project_rid', projectRid);
        const setPath = this.layout.setDir(projectRid, set.uuid || set['@rid']);
        await ensureDir(setPath);
        await this.store.setAttribute(set['@rid'], 'path', setPath);
        set.path = setPath;
        if (projectRid) await this.store.connect(set['@rid'], EDGE.BELONGS_TO, projectRid);
        if (attrs.input_set) await this.store.connectDerivedFrom(set['@rid'], attrs.input_set, processRid);
        await this.syncSetManifest(set['@rid']);
        return set;
    }

    async setFileRids(setRid: string): Promise<string[]> {
        const rows = await this.db.rows('SELECT @rid AS rid FROM File WHERE set = :set', { set: toRid(setRid) });
        return rows.map((r) => r.rid).filter(Boolean);
    }

    async updateFileCount(setRid: string): Promise<number> {
        const rid = toRid(setRid);
        const row = await this.db.first('SELECT count(*) AS count FROM File WHERE set = :set', { set: rid });
        const count = Number(row?.count || 0);
        await this.store.setAttribute(rid, 'count', count);
        await this.syncSetManifest(rid);
        return count;
    }

    /** Writes <set path>/set.json with the current members. */
    async syncSetManifest(setRid: string): Promise<any> {
        const rid = toRid(setRid);
        const set = await this.db.first('SELECT @rid, uuid, label, path, count FROM Set WHERE @rid = :rid', { rid });
        if (!set) return null;
        let setPath = set.path;
        if (!setPath) {
            const projectRid = await this.store.projectRidOf(rid);
            setPath = this.layout.setDir(projectRid, set.uuid || rid);
            await ensureDir(setPath);
            await this.store.setAttribute(rid, 'path', setPath);
        }
        const items = await this.db.rows(
            'SELECT @rid AS rid, @type AS node, label, path, type FROM File WHERE set = :set',
            { set: rid },
        );
        const manifest = {
            set: { rid: set['@rid'], label: set.label || '', count: set.count || 0, path: setPath },
            updated_at: new Date().toISOString(),
            items,
        };
        await writeJson(setPath, 'set.json', manifest);
        return manifest;
    }

    async addFileToSet(fileRid: string, setRid: string): Promise<void> {
        await this.store.setAttribute(fileRid, 'set', toRid(setRid));
    }

    // ---- processes ---------------------------------------------------------------------

    /** The Process node for a single-file job (createProcessNode_queue in the old code). */
    async createProcess(msg: MessageLike): Promise<any> {
        if (!msg.task) throw new Error('Task not found in message');
        const fileRid = msg.file['@rid'];
        const attrs: Record<string, unknown> = { label: msg.task.name, service: msg.service?.name };
        if (msg.service?.id) attrs.service_id = msg.service.id;
        if (msg.task.id) attrs.task = msg.task.id;
        if (msg.task.info) attrs.info = msg.task.info;
        else if (msg.task.description) attrs.info = msg.task.description;
        if (msg.task.description) attrs.description = msg.task.description;
        if (msg.task.model) attrs.model = msg.task.model.id;
        if (msg.task.model?.version) attrs.model_version = msg.task.model.version;
        if (msg.output_set) attrs.set = msg.output_set;
        if (msg.set_process_rid) attrs.set_process = msg.set_process_rid;
        if (msg.set_process && !attrs.set_process) attrs.set_process = msg.set_process;
        const projectRid = msg.file.project_rid || await this.store.projectRidOf(fileRid);
        if (projectRid) attrs.project_rid = projectRid;
        const node = await this.store.createVertex('Process', attrs);
        node.path = this.layout.processFilesDir(projectRid, node.uuid || node['@rid']);
        if (projectRid) node.project_rid = projectRid;
        node.file_rid = fileRid;
        await this.store.setAttribute(node['@rid'], 'path', node.path);
        if (projectRid) await this.store.connect(node['@rid'], EDGE.BELONGS_TO, projectRid);
        return node;
    }

    /** SetProcess plus its output Set for set-to-set batches (createSetAndProcessNodes). */
    async createSetProcessWithOutput(service: any, task: any, input: any, outputSet: boolean): Promise<{ process: any; set: any }> {
        const attrs: Record<string, unknown> = { label: task.name, path: '', service: service.name };
        if (input.project_rid) attrs.project_rid = input.project_rid;
        if (task.info) attrs.info = task.info;
        if (task.model?.id) attrs.model = task.model.id;
        if (task.model?.version) attrs.model_version = task.model.version;
        const processNode = await this.store.createVertex('SetProcess', attrs);
        const projectRid = input.project_rid || await this.store.projectRidOf(input['@rid']);
        if (projectRid) await this.store.connect(processNode['@rid'], EDGE.BELONGS_TO, projectRid);
        let set: any = null;
        if (outputSet) {
            set = await this.store.createVertex('Set', {});
            if (projectRid) await this.store.setAttribute(set['@rid'], 'project_rid', projectRid);
            const setPath = this.layout.setDir(projectRid, set.uuid || set['@rid']);
            await ensureDir(setPath);
            await this.store.setAttribute(set['@rid'], 'path', setPath);
            set.path = setPath;
            await this.store.connectDerivedFrom(set['@rid'], input['@rid'], processNode['@rid']);
            await this.syncSetManifest(set['@rid']);
        }
        return { process: processNode, set };
    }

    /** SetProcess for many-to-one batches and the search reindex (createManyToOneProcessNode). */
    async createManyToOneProcess(label: string, service: any, task: any, input: any): Promise<any> {
        const processLabel = String(label || task?.name || task?.id || service?.name || 'Process').trim() || 'Process';
        const attrs: Record<string, unknown> = { label: processLabel, path: '', service: service.name };
        if (input.project_rid) attrs.project_rid = input.project_rid;
        if (task.info) attrs.info = task.info;
        else if (task.description) attrs.info = task.description;
        if (task.model?.id) attrs.model = task.model.id;
        if (task.model?.version) attrs.model_version = task.model.version;
        const node = await this.store.createVertex('SetProcess', attrs);
        const processPath = this.layout.processFilesDir(input.project_rid, node.uuid || node['@rid']);
        await ensureDir(processPath);
        await this.setPathLegacyAware(node['@rid'], processPath);
        node.path = processPath;
        if (input.project_rid) await this.store.connect(node['@rid'], EDGE.BELONGS_TO, input.project_rid);
        return node;
    }

    /** The old code set this path with Cypher; legacy mode keeps that statement. */
    private async setPathLegacyAware(rid: string, value: string): Promise<void> {
        if (this.db.legacy) {
            await this.db.cypher(`MATCH (p:SetProcess) WHERE id(p) = ${cypherString(toRid(rid))} SET p.path = ${cypherString(value)} RETURN p`);
        } else {
            await this.store.setAttribute(rid, 'path', value);
        }
    }

    // ---- files -------------------------------------------------------------------------

    /** File node for an upload. Fields kept even when empty, like the old raw CONTENT insert. */
    async createOriginalFile(projectRid: string, filename: string, fileType: string, setRid: string | null): Promise<any> {
        const extension = path.extname(filename).replace('.', '').toLowerCase();
        const params = {
            uuid: uuidv7(),
            project_rid: projectRid,
            type: fileType,
            extension,
            label: filename,
            original_filename: filename,
            description: '',
            info: '',
            expand: false,
            metadata: { size: 0 },
            _active: true,
        };
        const node = await this.store.createVertexRaw('File', params);
        await this.store.connect(node['@rid'], EDGE.BELONGS_TO, projectRid);
        const filePath = this.layout.filePath(projectRid, node.uuid || node['@rid'], extension);
        await this.store.setAttribute(node['@rid'], 'path', filePath);
        node.path = filePath;
        if (setRid) {
            await this.store.setAttribute(node['@rid'], 'set', toRid(setRid));
            await this.updateFileCount(setRid);
        }
        return node;
    }

    /** Resolves which node an output derives from (see the rules in the comments). */
    private lineageSource(msg: MessageLike, fallback: string | undefined): string | undefined {
        const searchSource = ridOf(msg.search_source_set);
        const inputSet = ridOf(msg.input_set);
        const setRid = ridOf(msg.set_rid);
        if (msg.search_output === true) return searchSource || inputSet || setRid || fallback;
        return fallback;
    }

    /** File node for a process output (createProcessFileNode). */
    async createProcessFile(processRid: string, msg: MessageLike, description: string, info: string): Promise<any> {
        const params: Record<string, unknown> = {
            uuid: uuidv7(),
            project_rid: msg.file.project_rid || null,
            type: msg.file.type,
            extension: msg.file.extension,
            label: msg.file.label,
            description: description || '',
            info: info || '',
            expand: false,
            _active: true,
        };
        if (msg.set) params.set = msg.set;
        const node = await this.store.createVertexRaw('File', params);
        const projectRid = msg.file.project_rid || await this.store.projectRidOf(processRid);
        const filePath = this.layout.filePath(projectRid, node.uuid || node['@rid'], msg.file.extension);
        await this.store.setAttribute(node['@rid'], 'path', filePath);
        node.path = filePath;
        const isManyToOne = String(msg.behaviour || '').toLowerCase() === 'many-to-one';
        const fallback = msg.root_source?.['@rid']
            || (isManyToOne ? (ridOf(msg.input_set) || ridOf(msg.set_rid) || msg.file['@rid']) : msg.file['@rid']);
        const source = this.lineageSource(msg, fallback);
        if (msg.output_set) await this.store.setAttribute(node['@rid'], 'set', msg.output_set);
        if (source) await this.store.connectDerivedFrom(node['@rid'], source, processRid);
        if (msg.output_set) await this.syncSetManifest(msg.output_set);
        return node;
    }

    /** File node that shares the bytes of another file (createReferenceFileNode). */
    async createReferenceFile(processRid: string, msg: MessageLike, refRid: string, description: string, info: string): Promise<any> {
        const ref = toRid(refRid);
        const source = await this.db.first(`SELECT @rid, path, metadata, info FROM ${ref}`);
        if (!source?.path) throw new Error(`Reference source not found or missing path: ${ref}`);
        const params: Record<string, unknown> = {
            uuid: uuidv7(),
            project_rid: msg.file.project_rid || null,
            type: msg.file.type,
            extension: msg.file.extension,
            label: msg.file.label,
            description: description || '',
            info: info || '',
            expand: false,
            _active: true,
            ref,
        };
        if (msg.set) params.set = msg.set;
        const node = await this.store.createVertexRaw('File', params);
        await this.store.setAttribute(node['@rid'], 'path', source.path);
        node.path = source.path;
        node.ref = ref;
        const lineage = this.lineageSource(msg, ref);
        if (msg.output_set) await this.store.setAttribute(node['@rid'], 'set', msg.output_set);
        if (lineage) await this.store.connectDerivedFrom(node['@rid'], lineage, processRid);
        if (msg.output_set) await this.syncSetManifest(msg.output_set);
        return node;
    }

    /** error.json node for a failed job. */
    async createErrorNode(error: any, msg: MessageLike): Promise<any> {
        if (!msg?.file) throw new Error('Message or file not found');
        const processRid = msg.process?.['@rid'];
        if (!processRid) throw new Error('Process not found in message');
        const params: Record<string, unknown> = {
            uuid: uuidv7(),
            project_rid: msg.file.project_rid || null,
            type: 'error.json',
            extension: 'json',
            label: `${msg.file.label}.error.json`,
            description: error?.code || 'unknown',
            info: error?.message || 'There was an error processing your file.',
            metadata: { size: 0 },
            _active: true,
        };
        const node = await this.store.createVertexRaw('File', params);
        const projectRid = msg.file.project_rid || await this.store.projectRidOf(processRid);
        const filePath = this.layout.filePath(projectRid, node.uuid || node['@rid'], 'json');
        await this.store.setAttribute(node['@rid'], 'path', filePath);
        node.path = filePath;
        if (msg.output_set) await this.store.setAttribute(node['@rid'], 'set', msg.output_set);
        await this.store.connectDerivedFrom(node['@rid'], msg.file['@rid'], processRid);
        if (msg.output_set) await this.syncSetManifest(msg.output_set);
        return node;
    }

    /** Writes the job message next to the process directory, for debugging and replay. */
    async writeProcessMessage(processPath: string, msg: unknown, filename = 'message.json'): Promise<void> {
        await ensureDir(processPath);
        await writeJson(path.dirname(processPath), filename, msg);
    }

    roiFilePath(imagePath: string, roiRid: string): string {
        return path.join(path.dirname(imagePath), `${ridToPathPart(roiRid)}.roi.json`);
    }
}
