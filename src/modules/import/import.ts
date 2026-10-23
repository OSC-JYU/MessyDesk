// PDF auto-import: an uploaded (or ZIP-extracted) PDF is split into single-page PDFs by the
// md-pypdf_fs splitter. The upload shows as "Importing..." until the split finishes, and the
// original PDF is deleted afterwards (the node stays, marked `_file_removed`).

import fsp from 'node:fs/promises';
import path from 'node:path';
import type { SseHub } from '../../platform/sse/hub.ts';
import { writeJson } from '../../platform/storage/fsutil.ts';
import type { GraphStore } from '../../shared/graph-store.ts';
import { ROLE, SERVICE } from '../../shared/service-ids.ts';
import type { NodesService } from '../nodes/nodes.ts';
import type { Publisher } from '../queue/publisher.ts';
import type { ServiceRegistry } from '../services/registry.ts';

export class ImportPipeline {
    private readonly store: GraphStore;
    private readonly nodes: NodesService;
    private readonly registry: ServiceRegistry;
    private readonly publisher: Publisher;
    private readonly sse: SseHub;

    constructor(store: GraphStore, nodes: NodesService, registry: ServiceRegistry, publisher: Publisher, sse: SseHub) {
        this.store = store;
        this.nodes = nodes;
        this.registry = registry;
        this.publisher = publisher;
        this.sse = sse;
    }

    /** Starts the split of a new PDF. Without a live splitter the PDF is marked unprocessable. */
    async afterFileCreated(fileNode: any, options: { userId?: string; delete_original?: boolean } = {}): Promise<any | null> {
        if (!fileNode || fileNode.type !== 'pdf') return null;
        const { userId, delete_original: deleteOriginal = true } = options;
        if (!this.registry.hasActiveConsumer(SERVICE.PDF_SPLITTER)) {
            await this.store.setAttribute(fileNode['@rid'], 'processable', false);
            return null;
        }
        const splitter = this.registry.get(SERVICE.PDF_SPLITTER);
        const splitTask = splitter?.tasks?.split;
        if (!splitTask) return null;
        const msg: any = {
            service: { id: SERVICE.PDF_SPLITTER, name: splitter.name || 'PyPDF' },
            task: { id: 'split', name: splitTask.name || 'Split PDF to pages', description: splitTask.description, params: splitTask.params || { task: 'split' } },
            file: fileNode,
            process: null,
            output_set: null,
            userId,
            role: ROLE.IMPORT,
            delete_original: deleteOriginal,
        };
        msg.process = await this.nodes.createProcess(msg);
        await fsp.mkdir(msg.process.path, { recursive: true });
        await this.store.setAttributes(msg.process['@rid'], { role: ROLE.IMPORT, status: 'running' });
        const label = `${fileNode.original_filename || fileNode.label || 'PDF'} — PDF pages`;
        const set = await this.nodes.createOutputSet(label, msg.process);
        msg.output_set = set['@rid'];
        msg.set_node = set;
        if (deleteOriginal) await this.store.setAttribute(msg.process['@rid'], 'delete_original', true);
        await writeJson(path.dirname(msg.process.path), 'message.json', msg);
        await this.publisher.publish(SERVICE.PDF_SPLITTER, msg);
        await this.store.setAttribute(fileNode['@rid'], '_status', 'importing');
        if (userId) this.sse.send(userId, { command: 'add', type: 'process', input: fileNode['@rid'], node: msg.process, output: set, role: ROLE.IMPORT });
        return msg.process;
    }

    /** When the split batch finished: delete the original PDF and clear the importing state. */
    async complete(message: any): Promise<void> {
        const sourceRid = message.process?.file_rid || message.file?.['@rid'];
        if (!sourceRid) return;
        const processNode = await this.store.getNode(message.process['@rid']);
        if (processNode?.delete_original !== false) {
            const original = await this.store.getNode(sourceRid);
            if (original?.path) await fsp.rm(original.path, { force: true }).catch(() => {});
            await this.store.setAttribute(sourceRid, '_file_removed', true);
        }
        await this.store.setAttribute(sourceRid, '_status', 'split');
    }
}
