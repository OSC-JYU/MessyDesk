// LLM services: prompt runs next to fixed tasks, prompt params, and token limits per service group.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { servicesForNode } from '../../src/modules/services/matching.ts';
import { isPromptTask, promptParams } from '../../src/modules/processing/processing.ts';
import { TokenBudget, exhaustedReason, normalizeTokenLimits, periodStart } from '../../src/modules/usage/token-budget.ts';

const llm = {
    id: 'md-llm-ollama',
    external_tasks: 'prompts',
    consumers: ['a1'],
    models: {
        'gemma3:4b': { name: 'Gemma 3 4B', supported_types: ['text', 'image'], supported_formats: ['txt', 'jpg', 'png'] },
    },
    tasks: {
        autotag: { name: 'Tag with AI', supported_types: ['text', 'image'], autotag: true },
    },
};

const prompts = [
    { name: 'Summary', type: 'text', content: 'Summarise.' },
    { name: 'Describe image', type: 'image', content: 'Describe.' },
    { name: 'Old pdf', type: 'pdf', content: 'Read.' },
];

test('LLM services offer prompts of the node type plus their own tasks', () => {
    const text = servicesForNode({ [llm.id]: llm }, { '@type': 'File', type: 'text', extension: 'txt' }, undefined, {}, structuredClone(prompts));
    assert.deepEqual(Object.keys(text.for_format[0].tasks).sort(), ['autotag', 'summary']);
    const image = servicesForNode({ [llm.id]: llm }, { '@type': 'File', type: 'image', extension: 'jpg' }, undefined, {}, structuredClone(prompts));
    assert.deepEqual(Object.keys(image.for_format[0].tasks).sort(), ['autotag', 'describe_image']);
    // pdf prompts are no longer offered for sets (plan/llm-adapter.md Q12)
    const set = servicesForNode({ [llm.id]: llm }, { '@type': 'Set', types: ['text', 'pdf'], extensions: ['txt', 'pdf'] }, undefined, {}, structuredClone(prompts));
    assert.deepEqual(Object.keys(set.for_format[0].tasks).sort(), ['autotag', 'summary']);
    // no model for this format: nothing to run
    const pdf = servicesForNode({ [llm.id]: llm }, { '@type': 'File', type: 'pdf', extension: 'pdf' }, undefined, {}, structuredClone(prompts));
    assert.deepEqual(pdf.for_format[0].tasks, {});
});

test('prompt runs keep the user params under the prompt system params', () => {
    assert.equal(isPromptTask(llm, { id: 'summary' }), true);
    assert.equal(isPromptTask(llm, { id: 'autotag' }), false);
    assert.equal(isPromptTask({ tasks: {} }, { id: 'x' }), false);
    const params = promptParams({
        params: { temperature: 0.2, output_type: 'text' },
        system_params: { prompts: { content: 'Summarise.' }, output_type: 'json', json_schema: '{"a":"b"}' },
    });
    assert.deepEqual(params, { temperature: 0.2, output_type: 'json', prompts: { content: 'Summarise.' }, json_schema: '{"a":"b"}' });
    assert.deepEqual(promptParams({}), {});
});

test('token limits are validated', () => {
    assert.equal(normalizeTokenLimits(null), null);
    assert.equal(normalizeTokenLimits({}), null);
    assert.deepEqual(normalizeTokenLimits({ per_user: '1000', group_total: 5000 }), { period: 'month', per_user: 1000, group_total: 5000 });
    assert.deepEqual(normalizeTokenLimits({ period: 'day', per_job_max_output: 512 }), { period: 'day', per_job_max_output: 512 });
    assert.throws(() => normalizeTokenLimits({ per_user: -1 }));
    assert.throws(() => normalizeTokenLimits({ per_user: 1.5 }));
    assert.throws(() => normalizeTokenLimits({ period: 'year', per_user: 1 }));
    assert.throws(() => normalizeTokenLimits([1]));
});

test('period start and the exhausted reason', () => {
    const now = new Date('2026-10-06T10:20:30Z');
    assert.equal(periodStart('month', now), '2026-10-01 00:00:00');
    assert.equal(periodStart('day', now), '2026-10-06 00:00:00');
    const limits = { period: 'month' as const, per_user: 100, group_total: 1000 };
    assert.equal(exhaustedReason(null, { user: 1e9, group: 1e9 }, 'G'), null);
    assert.equal(exhaustedReason(limits, { user: 99, group: 999 }, 'G'), null);
    assert.match(exhaustedReason(limits, { user: 100, group: 10 }, 'G') || '', /you have used 100 of your 100 tokens/);
    assert.match(exhaustedReason(limits, { user: 1, group: 1000 }, 'G') || '', /service group G has used 1000/);
});

/** A tiny stand-in for ArcadeClient: groups, the user's groups and Usage totals. */
function fakeDb(state: { groups: Record<string, any>; userGroups: string[]; used: Record<string, { group: number; user: number }> }): any {
    return {
        async first(sql: string, params: any) {
            if (sql.startsWith('SELECT id, name, token_limits FROM ServiceGroup')) return state.groups[params.id] || null;
            if (sql.includes('FROM Usage')) {
                const used = state.used[params.group] || { group: 0, user: 0 };
                return { used: sql.includes('user = :user') ? used.user : used.group };
            }
            throw new Error('unexpected query ' + sql);
        },
        async firstByRid() {
            return { service_groups: state.userGroups };
        },
        async rows() {
            return [];
        },
    };
}

test('the first of the user\'s groups with budget left pays, and caps output tokens', async () => {
    const state = {
        groups: {
            A: { id: 'A', token_limits: { period: 'month', per_user: 100 } },
            B: { id: 'B', token_limits: JSON.stringify({ per_user: 1000, per_job_max_output: 256 }) },
        },
        userGroups: ['B', 'A'],
        used: { A: { group: 100, user: 100 }, B: { group: 10, user: 10 } } as Record<string, { group: number; user: number }>,
    };
    const budget = new TokenBudget(fakeDb(state));
    const service = { id: 's', service_groups: ['A', 'B', 'C'] };

    const task: any = { params: { max_output_tokens: 4096 } };
    await budget.apply(service, task, '#1:1');
    assert.deepEqual(task.token_budget, { service_group: 'B', period: 'month' });
    assert.equal(task.params.max_output_tokens, 256);

    const small: any = { params: { max_output_tokens: 100 } };
    await budget.apply(service, small, '#1:1');
    assert.equal(small.params.max_output_tokens, 100);

    // claim-time check uses the group on the task
    assert.equal(await budget.check({ userId: '#1:1', task: { token_budget: { service_group: 'B' } } }), null);
    state.used.B = { group: 1000, user: 1000 };
    assert.match(await budget.check({ userId: '#1:1', task: { token_budget: { service_group: 'B' } } }) || '', /Token limit reached/);
    assert.equal(await budget.check({ userId: '#1:1', task: {} }), null);

    // every group used up: 429
    await assert.rejects(budget.apply(service, {}, '#1:1'), (error: any) => error.output.statusCode === 429);
});

test('services without groups are not limited; users outside the groups are refused', async () => {
    const budget = new TokenBudget(fakeDb({ groups: {}, userGroups: ['X'], used: {} }));
    const task: any = {};
    await budget.apply({ id: 'open' }, task, '#1:1');
    assert.equal(task.token_budget, undefined);
    await assert.rejects(budget.apply({ id: 's', service_groups: ['A'] }, {}, '#1:1'), (error: any) => error.output.statusCode === 403);
    // a group without limits pays without any usage query
    const free = new TokenBudget(fakeDb({ groups: { X: { id: 'X' } }, userGroups: ['X'], used: {} }));
    const freeTask: any = {};
    await free.apply({ id: 's', service_groups: ['X'] }, freeTask, '#1:1');
    assert.deepEqual(freeTask.token_budget, { service_group: 'X', period: 'month' });
});
