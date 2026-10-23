// Deletes run after the request has answered (plan/decisions.md G5): a desk of 100 000 pages with
// its outputs took 217 s to delete, past any proxy timeout.
//
// The request checks ownership, marks the node `_deleting` (desk lists and the desk graph hide it
// from then on), records it in the queue database so a restart finishes the job, and answers. The
// cascade then runs in the background and ends with an SSE event to the user:
//   { command: 'delete_finished', target, deleted }   or   { command: 'delete_failed', target, error }

import Boom from '@hapi/boom';
import type { SseHub } from '../../platform/sse/hub.ts';
import { toRid } from '../../platform/ids.ts';
import type { GraphStore } from '../../shared/graph-store.ts';
import type { AccessService } from '../access/access.ts';
import type { JobQueue } from '../queue/queue.ts';
import type { GraphService } from './graph.ts';

export class BackgroundDeletes {
    private readonly running = new Map<string, Promise<void>>();
    private readonly graph: GraphService;
    private readonly store: GraphStore;
    private readonly access: AccessService;
    private readonly queue: JobQueue;
    private readonly sse: SseHub;
    private readonly log: (message: string) => void;

    constructor(graph: GraphService, store: GraphStore, access: AccessService, queue: JobQueue, sse: SseHub, log: (message: string) => void) {
        this.graph = graph;
        this.store = store;
        this.access = access;
        this.queue = queue;
        this.sse = sse;
        this.log = log;
    }

    /** Checks access, hides the node and starts deleting it. Throws 404 for nodes the user cannot see. */
    async start(rid: string, userRid: string): Promise<void> {
        const target = toRid(rid);
        // A node already being deleted is gone for the user too (access hides `_deleting`).
        if (!(await this.access.canRead(target, userRid))) throw Boom.notFound('Node not found');
        if (this.running.has(target)) return;
        await this.store.setAttribute(target, '_deleting', true);
        this.queue.addPendingDelete(target, userRid);
        this.run(target, userRid);
    }

    /** Deletes that a restart interrupted. */
    resumePending(): void {
        for (const pending of this.queue.pendingDeletes()) {
            this.log(`Resuming the delete of ${pending.rid}`);
            this.run(pending.rid, pending.user_rid);
        }
    }

    /** Resolves when every running delete has finished (shutdown, tests). */
    async idle(): Promise<void> {
        while (this.running.size) await Promise.all([...this.running.values()]);
    }

    private run(target: string, userRid: string): void {
        const work = (async () => {
            try {
                const result = await this.graph.deleteNode(target, userRid, true);
                this.queue.removePendingDelete(target);
                this.sse.send(userRid, { command: 'delete_finished', target, deleted: result.deleted });
            } catch (error) {
                const message = (error as Error)?.message || String(error);
                this.log(`Deleting ${target} failed: ${message}`);
                this.queue.removePendingDelete(target);
                await this.store.removeAttribute(target, '_deleting').catch(() => null);
                this.sse.send(userRid, { command: 'delete_failed', target, error: message });
            }
        })().finally(() => this.running.delete(target));
        this.running.set(target, work);
    }
}
