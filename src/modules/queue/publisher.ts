// Publishing a job: fills in the context fields every consumer may rely on, then enqueues it.
//
// - project_rid: from the file, the process, or by looking the node's project up, so access
//   control context is always present in async processing.
// - set_rid: for set processing, the input set (or the set itself when the "file" is a Set).

import type { Logger } from '../../platform/logger.ts';
import type { JobQueue } from './queue.ts';

function ridOrEmpty(value: unknown): string {
    if (!value && value !== 0) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    return raw.startsWith('#') ? raw : `#${raw}`;
}

export async function enrichMessage(msg: any, resolveProjectRid: (rid: string) => Promise<string | null>): Promise<any> {
    if (!msg || typeof msg !== 'object' || Array.isArray(msg)) return msg;
    const fileRid = ridOrEmpty(msg?.file?.['@rid']);
    const inputSet = ridOrEmpty(msg?.input_set);
    const explicitSet = ridOrEmpty(msg?.set_rid);
    const outputSet = ridOrEmpty(msg?.output_set);
    if (!msg.project_rid) {
        const known = ridOrEmpty(msg?.file?.project_rid) || ridOrEmpty(msg?.process?.project_rid);
        if (known) msg.project_rid = known;
        else {
            const lookup = fileRid || inputSet || explicitSet || outputSet;
            if (lookup) {
                try {
                    const found = await resolveProjectRid(lookup);
                    if (found) msg.project_rid = found;
                } catch { /* publish anyway */ }
            }
        }
    }
    const isSetFile = String(msg?.file?.['@type'] || '') === 'Set';
    if ((msg.set_process || inputSet || explicitSet || outputSet || isSetFile) && !msg.set_rid) {
        const setRid = inputSet || explicitSet || (isSetFile ? fileRid : '') || outputSet;
        if (setRid) msg.set_rid = setRid;
    }
    return msg;
}

export class Publisher {
    private readonly queue: JobQueue;
    private readonly resolveProjectRid: (rid: string) => Promise<string | null>;
    private readonly logger: Logger;
    private readonly logContext: boolean;
    private sampled = new Set<string>();

    constructor(queue: JobQueue, resolveProjectRid: (rid: string) => Promise<string | null>, logger: Logger, logContext: boolean) {
        this.queue = queue;
        this.resolveProjectRid = resolveProjectRid;
        this.logger = logger;
        this.logContext = logContext;
    }

    /** Enqueues a job. Like before, a failure is logged and not thrown. */
    async publish(topic: string, message: any): Promise<void> {
        try {
            // Work on a copy: callers keep using their message object afterwards.
            const msg = await enrichMessage(JSON.parse(JSON.stringify(message)), this.resolveProjectRid);
            if (this.logContext && !this.sampled.has(topic)) {
                this.sampled.add(topic);
                this.logger.info('queue_context_sample', { topic, project_rid: msg.project_rid || null, set_rid: msg.set_rid || null, set_process: msg.set_process || null, file_rid: msg.file?.['@rid'] || null });
            }
            this.queue.publish(topic, msg);
        } catch (error) {
            this.logger.error(`Could not add topic ${topic} to the queue: ${(error as Error).message}`);
        }
    }
}
