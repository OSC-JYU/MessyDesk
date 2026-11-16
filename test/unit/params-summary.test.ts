import { test } from 'node:test';
import assert from 'node:assert/strict';
import { summarizeParams, paramsSummaryJson } from '../../src/modules/nodes/params-summary.ts';

const service = {
    tasks: {
        extract: {
            params_help: {
                lang: { name: 'Language', values: { fi: 'Finnish', en: 'English' } },
                mode: { name: 'Mode', values: [{ value: 'a', title: 'Automatic' }] },
                math: { name: 'Math as LaTeX' },
                hidden_one: { display: 'hidden' },
            },
        },
    },
};

test('params are shown with their labels and the titles of chosen values', () => {
    const summary = summarizeParams(service, {
        id: 'extract',
        params: { lang: 'fi', mode: 'a', math: false, empty: '', none: null, labels: ['x', 'y'], hidden_one: 1 },
    });
    assert.deepEqual(summary?.params, [
        { name: 'lang', label: 'Language', value: 'Finnish' },
        { name: 'mode', label: 'Mode', value: 'Automatic' },
        { name: 'math', label: 'Math as LaTeX', value: 'No' },
        { name: 'labels', label: 'labels', value: 'x, y' },
    ]);
});

test('API keys, secret refs and credential-like params never reach the summary', () => {
    const json = paramsSummaryJson(service, {
        id: 'extract',
        secret_ref: 'REF123',
        params: { lang: 'en', api_key: 'sk-SECRET', apiKey: 'sk-SECRET', token: 'T', secret_ref: 'REF123', Authorization: 'Bearer X' },
    });
    assert.ok(json);
    assert.ok(!/SECRET|REF123|Bearer|"T"/.test(json));
    assert.deepEqual(JSON.parse(json).params.map((p: any) => p.name), ['lang']);
});

test('a prompt run keeps the prompt text as used and drops the prompt system params', () => {
    const task = {
        id: 'p1',
        params: { temperature: 0.2, prompts: { content: ' Describe the image ' }, output: 'json' },
        system_params: { prompts: { content: ' Describe the image ' }, output: 'json' },
    };
    const summary = summarizeParams({ external_tasks: true, tasks: {} }, task);
    assert.deepEqual(summary, { params: [{ name: 'temperature', label: 'temperature', value: '0.2' }], prompt: 'Describe the image' });
});

test('nothing to show gives no summary', () => {
    assert.equal(summarizeParams(service, { id: 'extract', params: {} }), null);
    assert.equal(paramsSummaryJson(service, undefined), undefined);
});
