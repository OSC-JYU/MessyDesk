import Boom from '@hapi/boom';
import type { Request, ServerRoute } from '@hapi/hapi';
import type { Deps } from '../../app/deps.ts';
import { currentUser, requireAdmin } from '../../platform/http/auth.ts';
import { BatchState } from '../batches/batch-state.ts';
import { API_KEY_HEADER, InvalidApiKeyError, apiKeyFromHeader } from '../secrets/vault.ts';
import { tryRid } from '../../platform/ids.ts';
import { readJson } from '../../platform/storage/fsutil.ts';
import path from 'node:path';

const SERVICE_ONLY = { auth: { strategy: 'service' } };

function rid(value: string): string {
    const r = tryRid(value);
    if (!r) throw Boom.badRequest('Invalid RID format');
    return r;
}

function batchSummary(batch: any, status: string, extra: Record<string, unknown> = {}): Record<string, unknown> {
    return {
        status,
        state: status,
        processed_files: batch?.processed_files || 0,
        failed_files: batch?.failed_files || 0,
        total_files: batch?.total_files || 0,
        avg_sec_per_file: batch?.avg_sec_per_file || 0,
        ...extra,
    };
}

export function processingRoutes({ processing, queue, batches, sse, access, results, tokenBudget, secrets }: Deps): ServerRoute[] {
    /** Jobs and batches belong to the user who started them; admins may act on any. */
    async function requireOwner(request: Request, id: string): Promise<void> {
        const user = currentUser(request);
        if (user.access === 'admin') return;
        if (queue.ownerOf(id) === user.rid) return;
        if (!/^job_/.test(id) && await access.canRead(id, user.rid)) return;
        throw Boom.notFound('Batch not found');
    }

    /**
     * A claimed job whose service group is out of tokens: a batch is paused (it can be resumed
     * once the limit is raised or the period has turned), a single job fails with the reason.
     */
    async function stopOverBudget(payload: any, reason: string): Promise<void> {
        const batchRid = tryRid(payload?.set_process);
        if (batchRid) {
            const now = new Date().toISOString();
            queue.pauseBatch(batchRid);
            const batch = await batches.update(batchRid, { status: 'paused', paused_at: now, updated_at: now, pause_reason: reason });
            if (payload.userId) sse.send(payload.userId, { command: 'process_update', process: { '@rid': batchRid, status: 'paused' }, batch: batchSummary(batch, 'paused', { pause_reason: reason }) });
            return;
        }
        await results.handleError(reason, payload);
    }

    /** The user's own API key for this run, from the header only (never from the stored body). */
    const userKey = (request: Request) => {
        try {
            return apiKeyFromHeader(request.headers[API_KEY_HEADER] as string | string[] | undefined);
        } catch (error) {
            if (error instanceof InvalidApiKeyError) throw Boom.badRequest(error.message);
            throw error;
        }
    };

    /** Drops the key of a run that has ended: a single job, or a batch with its last job done. */
    async function releaseFinished(payload: any): Promise<void> {
        if (!payload?.task?.secret_ref) return;
        const batchRid = tryRid(payload.set_process);
        if (!batchRid) {
            secrets.release(payload.task.secret_ref);
            return;
        }
        const status = String(BatchState.status(await batches.get(batchRid)) || '').toLowerCase();
        if (['done', 'cancelled'].includes(status)) secrets.releaseScope(batchRid);
    }

    return [
        // ---- starting work ---------------------------------------------------------------
        {
            method: 'POST',
            path: '/api/queue/{topic}/files/{rid}/{roi?}',
            handler: async (request) => {
                rid(request.params.rid);
                return processing.queueFile(request.params.topic, request.params.rid, request.payload || {}, currentUser(request).rid, userKey(request));
            },
        },
        {
            method: 'POST',
            path: '/api/queue/{topic}/sets/{rid}',
            handler: (request) => processing.queueSet(request.params.topic, rid(request.params.rid), request.payload || {}, currentUser(request).rid, userKey(request)),
        },
        {
            method: 'POST',
            path: '/api/queue/{topic}/sources/{rid}',
            handler: (request) => processing.queueSource(request.params.topic, rid(request.params.rid), request.payload || {}, currentUser(request).rid),
        },

        // ---- jobs and batches ------------------------------------------------------------
        {
            method: 'GET',
            path: '/api/queue/jobs/active',
            handler: (request) => {
                const user = currentUser(request);
                return queue.activeJobs(user.access === 'admin' ? null : user.rid);
            },
        },
        {
            method: 'POST',
            path: '/api/queue/jobs/{rid}/dismiss',
            handler: async (request) => {
                const id = request.params.rid;
                await requireOwner(request, id);
                const ok = queue.dismiss(id);
                if (ok) sse.send(currentUser(request).rid, { command: 'process_finished', process: { '@rid': id, status: 'cancelled' } });
                return { ok, rid: id };
            },
        },
        {
            method: 'GET',
            path: '/api/queue/{topic}/flush',
            handler: (request) => {
                requireAdmin(request);
                return queue.flush(request.params.topic);
            },
        },
        {
            method: 'GET',
            path: '/api/batches/{rid}',
            handler: async (request) => {
                const raw = request.params.rid;
                const job = /^job_(\d+)$/.exec(raw);
                if (job) {
                    await requireOwner(request, raw);
                    const info = queue.getJob(Number(job[1]));
                    if (!info) throw Boom.notFound('Job not found');
                    return info;
                }
                const batchRid = rid(raw);
                await requireOwner(request, batchRid);
                return batches.get(batchRid);
            },
        },
        {
            // What the run was started with (params.json in the process folder), when it was kept.
            method: 'GET',
            path: '/api/batches/{rid}/params',
            handler: async (request) => {
                const batchRid = rid(request.params.rid);
                await requireOwner(request, batchRid);
                const batch = await batches.get(batchRid);
                if (!batch?.path) throw Boom.notFound('No parameters stored');
                try {
                    return await readJson(path.join(path.dirname(batch.path), 'params.json'));
                } catch {
                    throw Boom.notFound('No parameters stored');
                }
            },
        },
        {
            method: 'POST',
            path: '/api/batches/{rid}/pause',
            handler: async (request) => {
                if (/^job_\d+$/.test(request.params.rid)) throw Boom.badRequest('Individual queue jobs cannot be paused, only batch processes');
                const batchRid = rid(request.params.rid);
                await requireOwner(request, batchRid);
                const now = new Date().toISOString();
                const batch = await batches.update(batchRid, { status: 'paused', paused_at: now, updated_at: now });
                const status = queue.pauseBatch(batchRid);
                secrets.releaseScope(batchRid);
                sse.send(currentUser(request).rid, { command: 'process_update', process: { '@rid': batchRid, status: 'paused' }, batch: batchSummary(batch, 'paused', { eta_sec: batch?.eta_sec ?? null }) });
                return { ...status, batch };
            },
        },
        {
            method: 'POST',
            path: '/api/batches/{rid}/resume',
            handler: async (request) => {
                if (/^job_\d+$/.test(request.params.rid)) throw Boom.badRequest('Individual queue jobs cannot be resumed, only batch processes');
                const user = currentUser(request);
                const batchRid = rid(request.params.rid);
                await requireOwner(request, batchRid);
                const apiKey = userKey(request);
                const { batch } = await processing.resume(batchRid, user.rid, apiKey);
                queue.resumeBatch(batchRid);
                await batches.update(batchRid, { status: 'resuming', pause_reason: null, updated_at: new Date().toISOString() });
                const { pending } = await processing.redispatch(batchRid, batch, user.rid, apiKey);
                const resumed = await batches.update(batchRid, { status: 'running', updated_at: new Date().toISOString() });
                sse.send(user.rid, { command: 'process_update', process: { '@rid': batchRid, status: 'running' }, batch: batchSummary(resumed, 'running', { eta_sec: resumed?.eta_sec ?? null, pending_files: pending }) });
                return { status: 'running', process_rid: batchRid, resumed_messages: pending, batch: resumed };
            },
        },
        {
            method: 'POST',
            path: '/api/batches/{rid}/cancel',
            handler: async (request) => {
                const user = currentUser(request);
                const raw = request.params.rid;
                const job = /^job_(\d+)$/.exec(raw);
                if (job) {
                    await requireOwner(request, raw);
                    secrets.release(queue.payloadOf(Number(job[1]))?.task?.secret_ref);
                    const deleted = queue.cancelJob(Number(job[1]));
                    sse.send(user.rid, { command: 'process_finished', process: { '@rid': raw, status: 'cancelled' } });
                    return { status: 'cancelled', job_id: Number(job[1]), deleted };
                }
                const batchRid = rid(raw);
                await requireOwner(request, batchRid);
                await batches.update(batchRid, { status: 'cancelling', updated_at: new Date().toISOString() });
                const status = queue.cancelBatch(batchRid);
                secrets.releaseScope(batchRid);
                const now = new Date().toISOString();
                const batch = await batches.update(batchRid, { status: 'cancelled', finished_at: now, updated_at: now, eta_sec: 0 });
                sse.send(user.rid, { command: 'process_finished', process: { '@rid': batchRid, status: 'cancelled' }, batch: batchSummary(batch, 'cancelled', { eta_sec: 0 }) });
                return { ...status, batch };
            },
        },

        // ---- consumer queue API ------------------------------------------------------------
        {
            method: 'POST',
            path: '/api/queue/claim',
            options: SERVICE_ONLY,
            handler: async (request) => {
                const { topic, adapter_id: adapterId } = (request.payload || {}) as any;
                if (!topic || !adapterId) throw Boom.badRequest('topic and adapter_id are required');
                const job = queue.claim(topic, adapterId);
                if (!job) return { job: null };
                // Token limits are checked again here, so a running batch stops at the limit.
                const overBudget = await tokenBudget.check(job.payload).catch(() => null);
                if (!overBudget) return { job };
                queue.cancelJob(job.id);
                await stopOverBudget(job.payload, overBudget);
                return { job: null };
            },
        },
        {
            // A consumer trades a task's secret_ref for the user's key. POST, so that nothing about
            // the request lands in an access log; the answer is never cached.
            method: 'POST',
            path: '/api/queue/secret',
            options: SERVICE_ONLY,
            handler: (request, h) => {
                const { ref, user, topic } = (request.payload || {}) as any;
                if (!ref || !user || !topic) throw Boom.badRequest('ref, user and topic are required');
                const key = secrets.get(String(ref), { userId: String(user), topic: String(topic) });
                if (!key) throw Boom.notFound('The API key is no longer available');
                return h.response({ key }).header('cache-control', 'no-store');
            },
        },
        {
            method: 'POST',
            path: '/api/queue/{job_id}/heartbeat',
            options: SERVICE_ONLY,
            handler: (request) => {
                const { adapter_id: adapterId } = (request.payload || {}) as any;
                if (!adapterId) throw Boom.badRequest('adapter_id is required');
                if (!queue.heartbeat(Number(request.params.job_id), adapterId)) throw Boom.notFound('Job not found or not owned by this adapter');
                return { ok: true };
            },
        },
        {
            method: 'POST',
            path: '/api/queue/{job_id}/complete',
            options: SERVICE_ONLY,
            handler: async (request) => {
                const { adapter_id: adapterId } = (request.payload || {}) as any;
                if (!adapterId) throw Boom.badRequest('adapter_id is required');
                const jobId = Number(request.params.job_id);
                const payload = queue.payloadOf(jobId);
                if (!queue.complete(jobId, adapterId)) throw Boom.notFound('Job not found or not owned by this adapter');
                await releaseFinished(payload);
                return { ok: true };
            },
        },
        {
            method: 'POST',
            path: '/api/queue/{job_id}/fail',
            options: SERVICE_ONLY,
            handler: async (request) => {
                const { adapter_id: adapterId, error } = (request.payload || {}) as any;
                if (!adapterId) throw Boom.badRequest('adapter_id is required');
                const jobId = Number(request.params.job_id);
                const payload = queue.payloadOf(jobId);
                const result = queue.fail(jobId, error || 'unknown error', adapterId);
                if (!result) throw Boom.notFound('Job not found or not owned by this adapter');
                // A job that will be retried keeps its key.
                if (result.permanent || result.cancelled || result.batch_aborted) await releaseFinished(payload);
                if (result.batch_aborted && result.batch_rid) secrets.releaseScope(result.batch_rid);
                if (result.batch_aborted && result.batch_rid) {
                    // Too many failures: the batch was cancelled automatically.
                    const now = new Date().toISOString();
                    const batch = await batches.update(result.batch_rid, { status: 'cancelled', finished_at: now, updated_at: now, eta_sec: 0 });
                    if (result.userId) {
                        sse.send(result.userId, {
                            command: 'process_finished',
                            process: { '@rid': result.batch_rid, status: 'cancelled' },
                            batch: { status: 'cancelled', state: 'cancelled', processed_files: batch?.processed_files || 0, failed_files: batch?.failed_files || 0, total_files: batch?.total_files || 0, eta_sec: 0 },
                            abort_reason: result.abort_reason,
                        });
                    }
                }
                return { ok: true, permanent: result.permanent || false, batch_aborted: result.batch_aborted || false };
            },
        },
    ];
}

