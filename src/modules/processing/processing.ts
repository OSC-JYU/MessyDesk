// Starting work: building job messages and dispatching single files, sets and sources to a
// service, plus resuming batches and re-indexing a desk for search.
//
// Behaviours (task, then service, default one-to-one):
//   one-to-one   one input file -> output file(s) next to it
//   one-to-many  one input file -> output files in a new output Set
//   many-to-one  all files of a set -> one output (per root source, see grouping.ts)
// A set run of a one-to-one/one-to-many task is a batch: one job per file under a SetProcess.

import Boom from '@hapi/boom';
import path from 'node:path';
import type { ArcadeClient } from '../../platform/arcade/client.ts';
import { toRid } from '../../platform/ids.ts';
import type { SseHub } from '../../platform/sse/hub.ts';
import { ensureDir, writeJson } from '../../platform/storage/fsutil.ts';
import type { DataLayout } from '../../platform/storage/layout.ts';
import { EDGE, type GraphStore } from '../../shared/graph-store.ts';
import { SERVICE } from '../../shared/service-ids.ts';
import type { AccessService } from '../access/access.ts';
import { BatchState } from '../batches/batch-state.ts';
import type { FilesService } from '../files/files.ts';
import type { NodesService } from '../nodes/nodes.ts';
import type { Publisher } from '../queue/publisher.ts';
import { resolveBehaviour, type ServiceRegistry } from '../services/registry.ts';
import type { SolrClient } from '../../platform/solr/solr.ts';
import type { TagFields } from '../tags/tags.ts';
import { manyToOneGroups } from './grouping.ts';

export function isSearchOutputTask(service: any, task: any): boolean {
    const def = task?.id ? service?.tasks?.[task.id] : null;
    const flag = task?.search_output ?? def?.search_output;
    if (flag === true) return true;
    const type = String(service?.type || '').toLowerCase();
    const id = String(service?.id || '').toLowerCase();
    return resolveBehaviour(service, task) === 'many-to-one'
        && (type === 'solr' || type === 'faiss' || id.includes('solr') || id.includes('faiss'));
}

/** Long-running tasks (`always_batch`) go to the batch queue even for one file. */
export function queueName(service: any, task: any, topic: string): string {
    const id = task?.task || task?.id;
    return id && service?.tasks?.[id]?.always_batch ? `${topic}_batch` : topic;
}

/**
 * Replaces the model id the UI sent (`task.model` as an id or `{ id }`) with the model's entry in
 * the descriptor, for every service that lists `models`. An unknown id is dropped, except for LLM
 * services (`external_tasks`), which keep what they were sent as before.
 */
export function resolveModel(service: any, task: any): void {
    if (!task?.model) return;
    const modelId = typeof task.model === 'string' ? task.model : task.model.id;
    if (service?.models && modelId && service.models[modelId]) {
        task.model = structuredClone(service.models[modelId]);
        task.model.id = modelId;
    } else if (!service?.external_tasks) {
        delete task.model;
    }
}

export class ProcessingService {
    private readonly db: ArcadeClient;
    private readonly store: GraphStore;
    private readonly layout: DataLayout;
    private readonly access: AccessService;
    private readonly nodes: NodesService;
    private readonly files: FilesService;
    private readonly registry: ServiceRegistry;
    private readonly publisher: Publisher;
    private readonly batches: BatchState;
    private readonly sse: SseHub;
    private readonly solr: SolrClient;
    private readonly apiUrl: string;
    private readonly log: (message: string) => void;
    private readonly dispatching = new Set<Promise<void>>();

    constructor(deps: {
        db: ArcadeClient; store: GraphStore; layout: DataLayout; access: AccessService; nodes: NodesService; files: FilesService;
        registry: ServiceRegistry; publisher: Publisher; batches: BatchState; sse: SseHub; solr: SolrClient; apiUrl: string;
        log?: (message: string) => void;
    }) {
        this.apiUrl = deps.apiUrl;
        this.log = deps.log || (() => {});
        this.db = deps.db;
        this.store = deps.store;
        this.layout = deps.layout;
        this.access = deps.access;
        this.nodes = deps.nodes;
        this.files = deps.files;
        this.registry = deps.registry;
        this.publisher = deps.publisher;
        this.batches = deps.batches;
        this.sse = deps.sse;
        this.solr = deps.solr;
    }

    /**
     * Publishes a batch's jobs after the request has answered. Publishing 10 000 jobs inside the
     * request took over 5 minutes while consumers were busy, past any proxy timeout
     * (perf/results/upload-and-batch.md); the UI follows the batch by SSE anyway. A failure is
     * logged and recorded on the batch node as `dispatch_error`.
     */
    private inBackground(batchRid: string, work: () => Promise<unknown>): void {
        const run: Promise<void> = (async () => {
            try {
                await work();
            } catch (error) {
                const message = (error as Error)?.message || String(error);
                this.log(`Dispatching batch ${batchRid} failed: ${message}`);
                await this.batches.update(batchRid, { dispatch_error: message.slice(0, 500), updated_at: new Date().toISOString() }).catch(() => null);
            }
        })().finally(() => this.dispatching.delete(run));
        this.dispatching.add(run);
    }

    /** Resolves when every background dispatch has finished (tests, shutdown). */
    async idle(): Promise<void> {
        while (this.dispatching.size) await Promise.all([...this.dispatching]);
    }

    private service(topic: string): any {
        const service = this.registry.get(topic);
        if (!service) throw Boom.badRequest(`Service adapter not found for service "${topic}"`);
        return service;
    }

    /**
     * Fills a task from the service descriptor: the name always comes from the descriptor, and
     * system params, description, info and the autotag flag are copied. LLM services
     * (`external_tasks`) take the task from the request and resolve the chosen model.
     */
    private prepareTask(service: any, requested: any, singleFile: boolean): any {
        const task = structuredClone(requested || {});
        resolveModel(service, task);
        if (service.external_tasks) {
            if (singleFile) task.params = task.system_params;
            return task;
        }
        const def = service.tasks?.[task.id];
        if (!def) throw Boom.badRequest('Task not found in service: ' + task.id);
        task.name = def.name;
        if (singleFile && def.system_params) task.params = def.system_params;
        if (def.description && !task.description) task.description = def.description;
        if (def.info && !task.info) task.info = def.info;
        // Autotag: a fixed flag (whole-document classification) or a per-run opt-in param.
        if (def.params_help?.autotag) task.autotag = Boolean(task.params?.autotag);
        else if (def.autotag) task.autotag = true;
        return task;
    }

    private async sourceFileOf(fileRid: string, userRid: string): Promise<any | null> {
        const source = await this.store.sourceFileOf(toRid(fileRid), '@rid');
        if (!source?.['@rid']) return null;
        return this.files.metadata(source['@rid'], userRid);
    }

    // ---- single file ---------------------------------------------------------------------

    /** POST /api/queue/{topic}/files/{rid}/{roi?}. Returns the rid as given. */
    async queueFile(topic: string, fileRid: string, payload: any, userRid: string): Promise<string> {
        const service = this.service(topic);
        const file = await this.files.metadata(fileRid, userRid);
        if (!file) throw Boom.badRequest('Target file not found: ' + fileRid);
        if (file._status === 'importing') throw Boom.conflict('File is being imported and cannot be processed');

        const task = this.prepareTask(service, payload, true);
        const msg: any = { service, task, file, process: null, output_set: null, userId: userRid };
        if (service.external_tasks) msg.external = 'yes';
        msg.process = await this.nodes.createProcess(msg);
        await ensureDir(msg.process.path);
        await writeJson(path.dirname(msg.process.path), 'message.json', msg);
        if (service.tasks?.[task.id]?.source === 'source_file') {
            const source = await this.sourceFileOf(file['@rid'], userRid);
            if (source) msg.file.source = source;
        }
        if (resolveBehaviour(service, task) === 'one-to-many') {
            const label = service.tasks?.[task.id]?.output_set || task.output_set || task.name || task.id || 'Output set';
            const set = await this.nodes.createOutputSet(label, msg.process);
            msg.output_set = set['@rid'];
            msg.set_node = set;
        }
        if (isSearchOutputTask(service, payload)) {
            const projectRid = await this.store.projectRidOf(file['@rid']);
            const set = await this.nodes.createProcessSet(msg.process['@rid'], { input_set: file['@rid'], search_output: true, label: 'Search index', project_rid: projectRid });
            msg.output_set = set['@rid'];
            msg.search_output = true;
            msg.set_node = set;
        }
        const event: any = { command: 'add', type: 'process', input: msg.file['@rid'], node: msg.process };
        if (msg.set_node) {
            event.output = msg.set_node;
            event.set_process = msg.process['@rid'];
        }
        this.sse.send(userRid, event);
        await this.publisher.publish(queueName(service, payload, topic), msg);
        return fileRid;
    }

    // ---- sets ----------------------------------------------------------------------------

    /**
     * Publishes one batch job per file. Each job uses the SetProcess as its process. Stops quietly
     * when the batch was paused or cancelled meanwhile.
     */
    async dispatchBatchFiles(args: { service: any; task: any; files: any[]; batchRid: string; inputSet: string | null; outputSet: string | null; userRid: string; total: number; startIndex?: number; searchOutput?: boolean; resolveSource?: boolean }): Promise<number> {
        let index = args.startIndex ?? 1;
        let count = 0;
        for (const f of args.files) {
            const file = await this.files.metadata(f['@rid'], args.userRid);
            if (!file) { index += 1; continue; }
            const msg: any = {
                service: args.service,
                task: args.task,
                file,
                set_rid: args.inputSet,
                set_process: args.batchRid,
                process: { '@rid': args.batchRid },
                output_set: args.outputSet,
                total_files: args.total,
                current_file: index,
                userId: args.userRid,
            };
            if (args.searchOutput) {
                msg.search_output = true;
                msg.search_source_set = args.inputSet;
            }
            if (args.service.tasks?.[args.task.id]?.source === 'source_file') {
                const source = await this.sourceFileOf(file['@rid'], args.userRid);
                if (source) msg.file.source = source;
            }
            const status = BatchState.status(await this.batches.get(args.batchRid)) || 'running';
            if (['paused', 'cancelling', 'cancelled', 'done'].includes(status)) break;
            await this.publisher.publish(`${args.service.id}_batch`, msg);
            index += 1;
            count += 1;
        }
        return count;
    }

    /** POST /api/queue/{topic}/sets/{rid}. Returns the set rid. */
    async queueSet(topic: string, setRid: string, payload: any, userRid: string): Promise<string> {
        const service = this.service(topic);
        const rid = toRid(setRid);
        const task = this.prepareTask(service, payload, false);
        if (service.external_tasks) {
            task.params = task.system_params;
        }
        const set = await this.files.metadata(rid, userRid);
        if (!set || set['@type'] !== 'Set') throw Boom.notFound('Set not found');
        const listing = await this.files.setFiles(rid, userRid, { limit: 10000 });
        const files = listing.files;
        const behaviour = resolveBehaviour(service, task);
        const taskName = task?.name || task?.id || topic;

        if (!service.external_tasks && behaviour === 'whole-set') {
            return this.dispatchWholeSet({ topic, service, task, set, files, payload, userRid });
        }

        if (!service.external_tasks && behaviour === 'many-to-one') {
            if (!files.length) throw Boom.badRequest('Set has no files to process');
            const searchOutput = isSearchOutputTask(service, task);
            const groups = await manyToOneGroups(this.db, service, task, files, searchOutput);
            const processNode = await this.nodes.createManyToOneProcess(taskName, service, task, set);
            const outputSet = await this.nodes.createProcessSet(processNode['@rid'], { input_set: rid, label: `${task.name || task.id} output`, project_rid: set.project_rid, search_output: searchOutput });
            await this.batches.init(processNode['@rid'], { topic, task_id: task.id, input_set: rid, output_set: outputSet?.['@rid'] || null, task_payload_json: JSON.stringify(payload), total_files: files.length, search_output: searchOutput });
            this.sse.send(userRid, { command: 'add', type: 'process', input: rid, node: processNode, output: outputSet });
            await writeJson(path.dirname(processNode.path), 'params.json', payload);
            const dispatchGroups = async () => {
                let batchIndex = 1;
                for (const group of groups) {
                    let groupIndex = 1;
                    for (const f of group.files) {
                        // Published after the request: stop when the batch is paused or cancelled meanwhile.
                        const status = BatchState.status(await this.batches.get(processNode['@rid'])) || 'running';
                        if (['paused', 'cancelling', 'cancelled', 'done'].includes(status)) return;
                        const msg: any = {
                            task,
                            process: processNode,
                            project_rid: set.project_rid,
                            set_rid: rid,
                            input_set: rid,
                            output_set: outputSet['@rid'],
                            behaviour,
                            set_process: processNode['@rid'],
                            total_files: group.files.length,
                            current_file: groupIndex,
                            batch_total_files: files.length,
                            batch_current_file: batchIndex,
                            userId: userRid,
                            file: await this.files.metadata(f['@rid'], userRid),
                        };
                        if (group.source_rid) {
                            msg.root_source = { '@rid': group.source_rid, label: group.label || null, type: group.type || null, path: group.path || null };
                            msg.root_source_rid = group.source_rid;
                            msg.root_source_label = group.label || null;
                            msg.group_size = group.files.length;
                        }
                        if (searchOutput) {
                            msg.search_output = true;
                            msg.search_source_set = rid;
                        }
                        if (service.tasks?.[task.id]?.source === 'source_file') {
                            const source = await this.sourceFileOf(f['@rid'], userRid);
                            if (source) msg.source = source;
                        }
                        await this.publisher.publish(`${topic}_batch`, msg);
                        groupIndex += 1;
                        batchIndex += 1;
                    }
                }
            };
            this.inBackground(processNode['@rid'], dispatchGroups);
            return rid;
        }

        const nodes = await this.nodes.createSetProcessWithOutput(service, task, set, Boolean(service.external_tasks) || behaviour !== 'many-to-one');
        await this.batches.init(nodes.process['@rid'], {
            topic,
            task_id: task.id,
            input_set: rid,
            output_set: nodes.set ? nodes.set['@rid'] : null,
            task_payload_json: JSON.stringify(payload),
            total_files: files.length,
        });
        this.sse.send(userRid, { command: 'add', type: 'process', input: rid, node: nodes.process, output: nodes.set });
        this.inBackground(nodes.process['@rid'], () => this.dispatchBatchFiles({ service, task, files, batchRid: nodes.process['@rid'], inputSet: rid, outputSet: nodes.set?.['@rid'] ?? null, userRid, total: files.length }));
        return rid;
    }

    /**
     * Adds `source` ({@rid, label, path, type}) to whole-set entries whose file was derived from
     * another file, e.g. the text an embeddings file was computed from (topic models need it).
     */
    private async attachSources(entries: any[]): Promise<void> {
        const rids = entries.map((e) => e['@rid']).filter(Boolean);
        for (let i = 0; i < rids.length; i += 500) {
            const chunk = rids.slice(i, i + 500);
            const edges = await this.db.edgesOf('out', 'DERIVED_FROM', chunk);
            const sources = [...new Set(edges.map((e: any) => String(e.source)).filter(Boolean))];
            if (!sources.length) continue;
            const files = await this.db.rowsByRids('@rid AS rid, label, path, type', sources, "@type = 'File'");
            const byRid = new Map(files.map((f: any) => [String(f.rid), f]));
            const sourceOf = new Map(edges.map((e: any) => [String(e.target), byRid.get(String(e.source))]));
            for (const entry of entries) {
                const source = sourceOf.get(String(entry['@rid']));
                if (source?.path) entry.source = { '@rid': source.rid, label: source.label, path: source.path, type: source.type };
            }
        }
    }

    /**
     * whole-set: one job carries every file of the set (`files`), for services that must see the
     * whole corpus at once (vector indexes, clustering, topics). The run is a many-to-one run with a
     * single job, so results, batch progress and lineage work unchanged. A task with
     * `output: "file"` instead gets a plain Process and one result file derived from the set.
     */
    private async dispatchWholeSet(args: { topic: string; service: any; task: any; set: any; files: any[]; payload: any; userRid: string }): Promise<string> {
        const { topic, service, task, set, files, payload, userRid } = args;
        const rid = set['@rid'];
        if (!files.length) throw Boom.badRequest('Set has no files to process');
        const entries: any[] = [];
        for (const f of files) {
            const meta = await this.files.metadata(f['@rid'], userRid);
            if (!meta?.path) continue;
            entries.push({ '@rid': meta['@rid'], label: meta.label, path: meta.path, type: meta.type, extension: meta.extension });
        }
        if (!entries.length) throw Boom.badRequest('Set has no files to process');
        await this.attachSources(entries);
        const taskName = task?.name || task?.id || topic;
        if (service.tasks?.[task.id]?.output === 'file') {
            // One result file derived from the set (e.g. a vector index), no output set.
            const msg: any = { service, task, file: set, files: entries, process: null, output_set: null, set_rid: rid, input_set: rid, whole_set: true, userId: userRid };
            msg.process = await this.nodes.createProcess(msg);
            await ensureDir(msg.process.path);
            await writeJson(path.dirname(msg.process.path), 'params.json', payload);
            this.sse.send(userRid, { command: 'add', type: 'process', input: rid, node: msg.process });
            await this.publisher.publish(`${topic}_batch`, msg);
            return rid;
        }
        const processNode = await this.nodes.createManyToOneProcess(taskName, service, task, set);
        const outputSet = await this.nodes.createProcessSet(processNode['@rid'], { input_set: rid, label: `${taskName} output`, project_rid: set.project_rid });
        await this.batches.init(processNode['@rid'], { topic, task_id: task.id, input_set: rid, output_set: outputSet?.['@rid'] || null, total_files: 1 });
        this.sse.send(userRid, { command: 'add', type: 'process', input: rid, node: processNode, output: outputSet });
        await writeJson(path.dirname(processNode.path), 'params.json', payload);
        await this.publisher.publish(`${topic}_batch`, {
            task,
            process: processNode,
            project_rid: set.project_rid,
            set_rid: rid,
            input_set: rid,
            output_set: outputSet['@rid'],
            behaviour: 'many-to-one',
            whole_set: true,
            set_process: processNode['@rid'],
            total_files: 1,
            current_file: 1,
            batch_total_files: 1,
            batch_current_file: 1,
            userId: userRid,
            // The set stands in for `file`: adapters echo it back, so the output derives from the set.
            file: set,
            files: entries,
        });
        return rid;
    }

    // ---- sources -------------------------------------------------------------------------

    /** POST /api/queue/{topic}/sources/{rid}: a request to an external source (DSpace, Nextcloud). */
    async queueSource(topic: string, sourceRid: string, payload: any, userRid: string): Promise<string> {
        const service = this.service(topic);
        const rid = toRid(sourceRid);
        const task = structuredClone(payload || {});
        if (!service.tasks?.[task.id]) throw Boom.badRequest('Task not found in service: ' + task.id);
        const source = await this.files.metadata(rid, userRid);
        if (!source || source['@type'] !== 'Source') throw Boom.notFound('Source not found');
        task.params = { ...(task.params || {}), url: source.url };
        const attrs: Record<string, unknown> = { label: topic, path: '', service: service.name, project_rid: source.project_rid };
        if (payload?.info) attrs.info = payload.info;
        const processNode = await this.store.createVertex('Process', attrs);
        await this.store.connect(source.project_rid, EDGE.HAS_PROCESS, processNode['@rid']);
        const processPath = this.layout.processFilesDir(source.project_rid, processNode.uuid || processNode['@rid']);
        await ensureDir(processPath);
        await this.store.setAttribute(processNode['@rid'], 'path', processPath);
        await writeJson(path.dirname(processPath), 'params.json', payload);
        const set = await this.store.createVertex('Set', { project_rid: source.project_rid });
        const setPath = this.layout.setDir(source.project_rid, set.uuid || set['@rid']);
        await ensureDir(setPath);
        await this.store.setAttribute(set['@rid'], 'path', setPath);
        set.path = setPath;
        await this.store.connectDerivedFrom(set['@rid'], rid, processNode['@rid']);
        await this.nodes.syncSetManifest(set['@rid']);
        this.sse.send(userRid, { command: 'add', type: 'process', target: rid, node: processNode, set_node: set, image: this.iconUrl('wait.gif') });
        await this.publisher.publish(`${topic}_batch`, { process: processNode, task, file: source, target: source['@rid'], userId: userRid, output_set: set['@rid'] });
        return rid;
    }

    private iconUrl(name: string): string {
        return this.apiUrl + 'icons/' + name;
    }

    /** POST /api/projects/{rid}/sources: creates the Source and asks its service to initialise it. */
    async createSource(projectRid: string, data: any, userRid: string): Promise<any> {
        if (!(await this.access.isProjectOwner(projectRid, userRid))) throw Boom.badRequest('Source creation failed! Project not found!');
        const project = toRid(projectRid);
        const source = await this.store.createVertex('Source', { ...data, status: 'initing...', project_rid: project });
        source.path = this.layout.sourceDir(project, source.uuid || source['@rid']);
        await this.store.connect(source['@rid'], EDGE.BELONGS_TO, project);
        await ensureDir(source.path);
        await this.store.setAttribute(source['@rid'], 'path', source.path);
        const serviceId = 'md-' + String(data?.type || '').toLowerCase();
        await this.publisher.publish(serviceId, {
            service: { id: serviceId },
            task: { id: 'init', params: { url: `${source.url}` } },
            file: source,
            process: source,
            userId: userRid,
        });
        return source;
    }

    // ---- resume / reindex / tag sync ----------------------------------------------------

    /** POST /api/batches/{rid}/resume: re-dispatches the files that have no output yet. */
    async resume(processRid: string, userRid: string): Promise<any> {
        const rid = toRid(processRid);
        const batch = await this.batches.get(rid);
        if (!batch) throw Boom.notFound('Batch not found');
        if (!batch.input_set || !batch.topic || !batch.task_id || !batch.output_set) throw Boom.badRequest('Batch resume is currently supported for set-to-set batches only');
        const status = BatchState.status(batch);
        if (status !== 'paused') throw Boom.conflict(`Batch is not paused (status: ${status || 'unknown'})`);
        return { batch, rid };
    }

    async redispatch(rid: string, batch: any, userRid: string): Promise<{ pending: number }> {
        const service = this.service(batch.topic);
        let task: any = { id: batch.task_id };
        if (batch.task_payload_json) {
            try { task = JSON.parse(batch.task_payload_json); } catch { task = { id: batch.task_id }; }
        }
        if (!task.id) task.id = batch.task_id;
        task = structuredClone(task);
        if (service.external_tasks) {
            task.name = task.name || task.id;
            task.params = task.system_params || task.params || {};
        } else {
            if (!service.tasks?.[task.id]) throw Boom.badRequest('Task not found in service');
            task.name = service.tasks[task.id].name;
        }
        resolveModel(service, task);
        const listing = await this.files.setFiles(batch.input_set, userRid, { limit: 10000 });
        const done = new Set(await this.batches.processedInputs(rid));
        const pending = listing.files.filter((f: any) => !done.has(f['@rid']));
        const current = BatchState.status(await this.batches.get(rid));
        if (current !== 'resuming' && current !== 'running') throw Boom.conflict(`Batch changed state before dispatch (status: ${current || 'unknown'})`);
        this.inBackground(rid, () => this.dispatchBatchFiles({
            service, task, files: pending, batchRid: rid, inputSet: batch.input_set, outputSet: batch.output_set, userRid,
            total: batch.total_files || listing.files.length, startIndex: Number(batch.processed_files || 0) + 1, searchOutput: batch.search_output === true,
        }));
        return { pending: pending.length };
    }

    /** Publishes a tag-field update for the search index (md-solr update_tags), or writes it directly. */
    async syncTags(fileRid: string, userRid: string, fields: TagFields): Promise<unknown> {
        const service = this.registry.get(SERVICE.SOLR);
        if (!service?.tasks?.update_tags) return this.solr.updateTagsForFile(fileRid, fields as any);
        const file = await this.files.metadata(fileRid, userRid);
        if (!file) return null;
        // No Process node (plan/schema-review.md P7): it was one node, one directory and one
        // message.json per tag change, shown nowhere. The md-solr adapter only echoes the message
        // to /done, which falls back to the file rid.
        const msg: any = { service, task: { id: 'update_tags', name: service.tasks.update_tags.name || 'Sync tags to search index' }, file, userId: userRid, tag_fields: fields, output_file: false, process: null };
        await this.publisher.publish(`${service.id}_batch`, msg);
        return null;
    }

    /** POST /api/projects/{rid}/reindex-search: drops the desk's search docs and re-queues indexing. */
    async reindexProject(projectRid: string, userRid: string, reindexTags: (fileRid: string) => Promise<unknown>): Promise<any> {
        const project = toRid(projectRid);
        if (!(await this.access.isProjectOwner(project, userRid))) throw Boom.forbidden('Project not found or access denied');
        const service = this.registry.get(SERVICE.SOLR);
        if (!service?.tasks?.index) throw Boom.badRequest('md-solr index task is not available');
        await this.solr.dropProjectIndex(userRid, project);
        const variants = [project, project.replace(/^#/, '')];
        const where = 'project_rid IN :projects AND (service_id = "md-solr" OR service = "Solr" OR service = "md-solr" OR topic = "md-solr")';
        const fields = '@rid AS process_rid, input_set, task, task_id, task_payload_json, service, service_id, project_rid, topic';
        const rows = [
            ...await this.db.rows(`SELECT ${fields} FROM SetProcess WHERE ${where}`, { projects: variants }),
            ...await this.db.rows(`SELECT ${fields} FROM Process WHERE ${where}`, { projects: variants }),
        ];
        const seen = new Set<string>();
        const sources = [];
        for (const row of rows) {
            if (!row?.input_set) continue;
            let input: string;
            try { input = toRid(String(row.input_set)); } catch { continue; }
            if (seen.has(input)) continue;
            seen.add(input);
            // Keep the run's index options (full or light index, decision G6) when re-indexing.
            let params: Record<string, unknown> = {};
            try { params = JSON.parse(row.task_payload_json || '{}')?.params || {}; } catch { params = {}; }
            sources.push({ input_set: input, params });
        }
        let requeuedSets = 0;
        let requeuedFiles = 0;
        const warnings = [];
        for (const source of sources) {
            try {
                const set = await this.files.metadata(source.input_set, userRid);
                if (!set) { warnings.push({ set_rid: source.input_set, reason: 'set metadata not found' }); continue; }
                const files = (await this.files.setFiles(source.input_set, userRid, { limit: 10000 })).files;
                if (!files.length) { warnings.push({ set_rid: source.input_set, reason: 'set has no files' }); continue; }
                const task = { id: 'index', name: service.tasks.index.name || 'Search index', params: source.params };
                const searchOutput = isSearchOutputTask(service, task);
                const processNode = await this.nodes.createManyToOneProcess(task.name, service, task, set);
                const outputSet = await this.nodes.createProcessSet(processNode['@rid'], { input_set: source.input_set, label: `${task.name || task.id} output`, project_rid: set.project_rid, search_output: searchOutput });
                await this.batches.init(processNode['@rid'], { topic: SERVICE.SOLR, task_id: 'index', input_set: source.input_set, output_set: outputSet?.['@rid'] || null, task_payload_json: JSON.stringify(task), total_files: files.length, search_output: searchOutput });
                let index = 1;
                for (const f of files) {
                    const file = await this.files.metadata(f['@rid'], userRid);
                    if (!file) { index += 1; continue; }
                    const msg: any = { service, task, file, set_rid: source.input_set, set_process: processNode['@rid'], process: { '@rid': processNode['@rid'] }, output_set: outputSet?.['@rid'] || null, total_files: files.length, current_file: index, userId: userRid };
                    if (searchOutput) {
                        msg.search_output = true;
                        msg.search_source_set = source.input_set;
                    }
                    await this.publisher.publish(`${service.id}_batch`, msg);
                    // The project's docs were dropped, so their tag fields need re-applying too.
                    await reindexTags(file['@rid']);
                    index += 1;
                    requeuedFiles += 1;
                }
                requeuedSets += 1;
            } catch (error) {
                warnings.push({ set_rid: source.input_set, reason: (error as Error).message || 'requeue failed' });
            }
        }
        return { project_rid: project, deleted: true, source_sets_found: sources.length, requeued_sets: requeuedSets, requeued_files: requeuedFiles, warnings };
    }
}

