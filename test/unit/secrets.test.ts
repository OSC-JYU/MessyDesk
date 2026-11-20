// A user's API key lives in memory only: the vault's rules, and that starting a run never lets the
// plaintext key into the queued job, message.json or anything else that is stored.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import util from 'node:util';
import { SecretVault, apiKeyFromHeader } from '../../src/modules/secrets/vault.ts';
import { ProcessingService } from '../../src/modules/processing/processing.ts';

const KEY = 'sk-test-SECRET-1234567890';
const owner = { userId: '#9:1', topic: 'md-llm-openai' };

test('a key is handed out only to its user and service', () => {
    const vault = new SecretVault({ idleMs: 1000 });
    const ref = vault.put(KEY, owner);
    assert.notEqual(ref, KEY);
    assert.equal(vault.get(ref, owner), KEY);
    assert.equal(vault.get(ref, { ...owner, userId: '#9:2' }), null);
    assert.equal(vault.get(ref, { ...owner, topic: 'md-llm-azure' }), null);
    assert.equal(vault.get('unknown', owner), null);
});

test('a key expires after it was idle, and use keeps it alive', () => {
    let now = 1000;
    const vault = new SecretVault({ idleMs: 100, now: () => now });
    const kept = vault.put(KEY, owner);
    const idle = vault.put(KEY, owner);
    now += 80;
    assert.equal(vault.get(kept, owner), KEY);
    now += 80;
    assert.equal(vault.get(kept, owner), KEY);
    assert.equal(vault.get(idle, owner), null);
    assert.equal(vault.size, 1);
});

test('a run releases its keys, and a stop forgets all', () => {
    const vault = new SecretVault({ idleMs: 1000 });
    const a = vault.put(KEY, owner);
    const b = vault.put(KEY, owner);
    vault.bind(a, '#5:1');
    vault.bind(b, '#5:2');
    vault.releaseScope('#5:1');
    assert.equal(vault.get(a, owner), null);
    assert.equal(vault.get(b, owner), KEY);
    vault.release(b);
    assert.equal(vault.size, 0);
    vault.put(KEY, owner);
    vault.stop();
    assert.equal(vault.size, 0);
});

test('the vault shows no key when it is logged or serialised', () => {
    const vault = new SecretVault({ idleMs: 1000 });
    vault.put(KEY, owner);
    for (const text of [util.inspect(vault, { depth: 5 }), JSON.stringify(vault), JSON.stringify({ vault }), String(util.format('%o', vault))]) {
        assert.ok(!text.includes(KEY), text);
    }
});

test('the key header is checked', () => {
    assert.equal(apiKeyFromHeader(` ${KEY} `), KEY);
    assert.equal(apiKeyFromHeader([KEY, 'other']), KEY);
    assert.equal(apiKeyFromHeader(undefined), null);
    assert.equal(apiKeyFromHeader(''), null);
    // a long token (a JWT, like CSC Aitta's) is fine
    const jwt = `eyJ${'a'.repeat(900)}.${'b'.repeat(1500)}.${'c'.repeat(300)}`;
    assert.equal(apiKeyFromHeader(jwt), jwt);
    assert.throws(() => apiKeyFromHeader('has space'), /spaces or line breaks/);
    assert.throws(() => apiKeyFromHeader('x'.repeat(7001)), /longer than 7000/);
});

function setup(apiKeyMode: string | undefined) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-secret-'));
    const published: any[] = [];
    const service = {
        id: 'md-llm-openai',
        external_tasks: 'prompts',
        api_key_source: apiKeyMode,
        models: { 'gpt-5': { name: 'GPT-5' } },
        tasks: { autotag: { name: 'Tag', autotag: true } },
    };
    const vault = new SecretVault({ idleMs: 60_000 });
    const processing = new ProcessingService({
        db: {} as any, store: {} as any, layout: {} as any, access: {} as any, files: { metadata: async () => ({ '@rid': '#12:3', label: 'a.txt', type: 'text', extension: 'txt' }) } as any,
        nodes: { createProcess: async () => ({ '@rid': '#5:7', path: path.join(dir, 'process', 'out') }) } as any,
        registry: { get: () => service } as any,
        publisher: { publish: async (topic: string, msg: any) => { published.push({ topic, json: JSON.stringify(msg), msg }); } } as any,
        batches: {} as any, sse: { send: () => {} } as any, solr: {} as any, apiUrl: 'http://x', secrets: vault,
    });
    return { dir, processing, vault, published };
}

const run = { id: 'u-summary', model: 'gpt-5', params: { temperature: 0.2 }, system_params: { prompts: { content: 'Summarise.' } } };

test('a run on a "user" service keeps only a ref in the job, never the key', async () => {
    const { dir, processing, vault, published } = setup('user');
    await processing.queueFile('md-llm-openai', '12:3', structuredClone(run), '#9:1', KEY);
    assert.equal(published.length, 1);
    const ref = published[0].msg.task.secret_ref;
    assert.ok(ref && ref !== KEY);
    assert.ok(!published[0].json.includes(KEY));
    // everything written under the run's folder
    for (const name of fs.readdirSync(path.join(dir, 'process'), { recursive: true }) as string[]) {
        const file = path.join(dir, 'process', name);
        if (fs.statSync(file).isFile()) assert.ok(!fs.readFileSync(file, 'utf8').includes(KEY), file);
    }
    assert.equal(vault.get(ref, { userId: '#9:1', topic: 'md-llm-openai' }), KEY);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a "user" service refuses a run without a key', async () => {
    const { dir, processing, published } = setup('user');
    await assert.rejects(processing.queueFile('md-llm-openai', '12:3', structuredClone(run), '#9:1', null), /needs your own API key/);
    assert.equal(published.length, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});

test('a service with its own key does not keep what a user sends', async () => {
    const { dir, processing, vault, published } = setup(undefined);
    await processing.queueFile('md-llm-openai', '12:3', structuredClone(run), '#9:1', KEY);
    assert.equal(published[0].msg.task.secret_ref, undefined);
    assert.equal(vault.size, 0);
    fs.rmSync(dir, { recursive: true, force: true });
});
