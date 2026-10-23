// Token limits per service group (plan/llm-adapter.md 4.9). Commercial LLM providers bill per
// token, and production access is controlled with service groups, so the limits live on the
// ServiceGroup (`token_limits`). Consumers report each job's tokens to /metadata, which stores a
// Usage row; the checks here sum those rows. Nothing calls a provider.
//
// A job runs under one paying group: the first group in the service's `service_groups` that the
// user belongs to and that has budget left. The group goes on the task (`task.token_budget`) and on
// the Usage row, and the budget is checked again when a consumer claims the job.

import Boom from '@hapi/boom';
import type { ArcadeClient } from '../../platform/arcade/client.ts';

export interface TokenLimits {
    period: 'month' | 'day';
    per_user?: number;
    group_total?: number;
    per_job_max_output?: number;
}

/** What a task carries: who pays for it. */
export interface TokenBudgetRef {
    service_group: string;
    period: TokenLimits['period'];
}

const LIMIT_KEYS = ['per_user', 'group_total', 'per_job_max_output'] as const;

/** Validates admin input. Empty input or no limits at all clears the limits (null). */
export function normalizeTokenLimits(raw: unknown): TokenLimits | null {
    if (raw === null || raw === undefined || raw === '') return null;
    if (typeof raw !== 'object' || Array.isArray(raw)) throw Boom.badRequest('token_limits must be an object');
    const input = raw as Record<string, unknown>;
    const period = input.period === undefined || input.period === '' ? 'month' : input.period;
    if (period !== 'month' && period !== 'day') throw Boom.badRequest('token_limits.period must be "month" or "day"');
    const limits: TokenLimits = { period };
    let any = false;
    for (const key of LIMIT_KEYS) {
        const value = input[key];
        if (value === undefined || value === null || value === '') continue;
        const number = Number(value);
        if (!Number.isInteger(number) || number <= 0) throw Boom.badRequest(`token_limits.${key} must be a positive whole number`);
        limits[key] = number;
        any = true;
    }
    return any ? limits : null;
}

/** Reads `token_limits` as stored on a ServiceGroup (an object, or JSON text from older writes). */
export function parseStoredLimits(stored: unknown): TokenLimits | null {
    if (!stored) return null;
    try {
        return normalizeTokenLimits(typeof stored === 'string' ? JSON.parse(stored) : stored);
    } catch {
        return null;
    }
}

/** Start of the current period in the Usage `time` format (UTC, 'YYYY-MM-DD HH:MM:SS'). */
export function periodStart(period: TokenLimits['period'], now = new Date()): string {
    const day = period === 'day' ? String(now.getUTCDate()).padStart(2, '0') : '01';
    return `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, '0')}-${day} 00:00:00`;
}

/** Usage `time` for a row written now. */
export function usageTime(now = new Date()): string {
    return now.toISOString().replace('T', ' ').substring(0, 19);
}

/** Why a group's budget is used up for this user, or null when there is budget left. */
export function exhaustedReason(limits: TokenLimits | null, used: { user: number; group: number }, groupId: string): string | null {
    if (!limits) return null;
    const period = limits.period === 'day' ? 'today' : 'this month';
    if (limits.group_total !== undefined && used.group >= limits.group_total) {
        return `Token limit reached: service group ${groupId} has used ${used.group} of its ${limits.group_total} tokens ${period}`;
    }
    if (limits.per_user !== undefined && used.user >= limits.per_user) {
        return `Token limit reached: you have used ${used.user} of your ${limits.per_user} tokens in service group ${groupId} ${period}`;
    }
    return null;
}

export class TokenBudget {
    private readonly db: ArcadeClient;

    constructor(db: ArcadeClient) {
        this.db = db;
    }

    private async group(id: string): Promise<{ id: string; name?: string; limits: TokenLimits | null } | null> {
        const row = await this.db.first('SELECT id, name, token_limits FROM ServiceGroup WHERE id = :id', { id });
        if (!row) return null;
        return { id: row.id, name: row.name, limits: parseStoredLimits(row.token_limits) };
    }

    private async userGroups(userRid: string): Promise<string[]> {
        const user = await this.db.firstByRid<any>('service_groups', userRid, "@type = 'User'");
        return Array.isArray(user?.service_groups) ? user.service_groups.map(String) : [];
    }

    /** Tokens used in the period: by the user within the group, and by the whole group. */
    async used(groupId: string, userRid: string, period: TokenLimits['period']): Promise<{ user: number; group: number }> {
        const since = periodStart(period);
        const [group, user] = await Promise.all([
            this.db.first('SELECT sum(total) AS used FROM Usage WHERE service_group = :group AND time >= :since', { group: groupId, since }),
            this.db.first('SELECT sum(total) AS used FROM Usage WHERE service_group = :group AND user = :user AND time >= :since', { group: groupId, user: userRid, since }),
        ]);
        return { user: Number(user?.used || 0), group: Number(group?.used || 0) };
    }

    /**
     * Picks the group that pays for running `service` and caps the task's output tokens. Services
     * without `service_groups` are not limited (null). Throws 403 when the user is in none of the
     * service's groups and 429 when every group they could use is out of budget.
     */
    async choose(service: any, userRid: string): Promise<{ ref: TokenBudgetRef; limits: TokenLimits | null } | null> {
        const serviceGroups: string[] = Array.isArray(service?.service_groups) ? service.service_groups.map(String) : [];
        if (!serviceGroups.length) return null;
        const mine = new Set(await this.userGroups(userRid));
        const candidates = serviceGroups.filter((g) => mine.has(g));
        if (!candidates.length) throw Boom.forbidden(`Service ${service?.id || ''} is not available for your service groups`);
        let reason = '';
        for (const id of candidates) {
            const group = await this.group(id);
            const limits = group?.limits || null;
            const ref: TokenBudgetRef = { service_group: id, period: limits?.period || 'month' };
            if (!limits) return { ref, limits };
            const exhausted = exhaustedReason(limits, await this.used(id, userRid, limits.period), id);
            if (!exhausted) return { ref, limits };
            reason = reason || exhausted;
        }
        throw Boom.tooManyRequests(reason);
    }

    /** Adds the paying group to a task and caps its output tokens by the group's per-job limit. */
    async apply(service: any, task: any, userRid: string): Promise<void> {
        const chosen = await this.choose(service, userRid);
        if (!chosen) return;
        task.token_budget = chosen.ref;
        const cap = chosen.limits?.per_job_max_output;
        if (cap) {
            task.params = task.params || {};
            const asked = Number(task.params.max_output_tokens);
            task.params.max_output_tokens = Number.isFinite(asked) && asked > 0 ? Math.min(asked, cap) : cap;
        }
    }

    /** Claim-time check for a queued job: the reason it may not run now, or null. */
    async check(payload: any): Promise<string | null> {
        const ref: TokenBudgetRef | undefined = payload?.task?.token_budget;
        const userRid = payload?.userId;
        if (!ref?.service_group || !userRid) return null;
        const group = await this.group(ref.service_group);
        if (!group?.limits) return null;
        return exhaustedReason(group.limits, await this.used(group.id, userRid, group.limits.period), group.id);
    }

    /** GET /api/me/usage: the user's tokens this period in each of their groups, and per service. */
    async forUser(userRid: string): Promise<any> {
        const groups = [];
        for (const id of await this.userGroups(userRid)) {
            const group = await this.group(id);
            if (!group) continue;
            const period = group.limits?.period || 'month';
            const used = await this.used(id, userRid, period);
            groups.push({ id, name: group.name || id, period, since: periodStart(period), limits: group.limits, used_by_me: used.user, used_by_group: used.group });
        }
        const since = periodStart('month');
        const services = await this.db.rows(
            'SELECT service, model, sum(`in`) AS tokens_in, sum(`out`) AS tokens_out, sum(total) AS total FROM Usage WHERE user = :user AND time >= :since GROUP BY service, model',
            { user: userRid, since },
        );
        return { month_since: since, groups, services };
    }

    /** GET /api/service-groups/{id}/usage (admin): the group's tokens this period, per user. */
    async forGroup(groupId: string): Promise<any> {
        const group = await this.group(groupId);
        if (!group) throw Boom.notFound(`ServiceGroup "${groupId}" not found`);
        const period = group.limits?.period || 'month';
        const since = periodStart(period);
        const users = await this.db.rows(
            'SELECT user, sum(total) AS total FROM Usage WHERE service_group = :group AND time >= :since GROUP BY user ORDER BY total DESC',
            { group: groupId, since },
        );
        const total = users.reduce((sum: number, row: any) => sum + Number(row.total || 0), 0);
        return { id: groupId, period, since, limits: group.limits, total, users };
    }
}
