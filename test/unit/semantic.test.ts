// Semantic search: index headers, ownership of hits, and that results only reach the searcher.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { SemanticSearch, readSafetensorsHeader, SEMANTIC_ROLE } from '../../src/modules/semantic/semantic.ts';

function safetensors(file: string, metadata: Record<string, string>): void {
    const header = Buffer.from(JSON.stringify({ __metadata__: metadata }), 'utf8');
    const size = Buffer.alloc(8);
    size.writeBigUInt64LE(BigInt(header.length));
    fs.writeFileSync(file, Buffer.concat([size, header]));
}

function fakes(dir: string) {
    const published: any[] = [];
    const sent: any[] = [];
    const text = path.join(dir, 'a.txt');
    fs.writeFileSync(text, 'The ship reached the harbour at dawn. '.repeat(3));
    const nodes: Record<string, any> = {
        '#10:1': { node: { '@rid': '#10:1', '@type': 'File', type: 'vector_index', path: path.join(dir, 'i.safetensors') }, projectRid: '#1:0' },
        '#10:2': { node: { '@rid': '#10:2', '@type': 'File', type: 'text', label: 'a.txt', path: text }, projectRid: '#1:0' },
    };
    const deps: any = {
        db: { first: async () => null, rows: async () => [] },
        access: { findOwned: async (rid: string, user: string) => (user === '#16:0' ? nodes[rid] ?? null : null) },
        registry: { hasActiveConsumer: () => true },
        publisher: { publish: async (topic: string, msg: any) => { published.push({ topic, msg }); } },
        sse: { send: (user: string, data: any) => { sent.push({ user, data }); return true; } },
        layout: {},
        logger: { warn: () => {} },
    };
    return { search: new SemanticSearch(deps), published, sent };
}

test('reads the metadata of a safetensors vector index', async () => {
    const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'md-sem-')), 'i.safetensors');
    safetensors(file, { format: 'messydesk-vector-index/1', rows: '42', model: '{"id":"m"}' });
    const header = await readSafetensorsHeader(file);
    assert.equal(header.__metadata__.rows, '42');
});

test('a search is a queued job and its hits reach only the searcher', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-sem-'));
    const { search, published, sent } = fakes(dir);
    await assert.rejects(search.start('#99:9', { index: '#10:1', query: 'ship' }), /not found/);
    const { search_id } = await search.start('#16:0', { index: '#10:1', query: 'ship', k: 5 });
    assert.equal(published[0].topic, 'md-embeddings');
    assert.equal(published[0].msg.role, SEMANTIC_ROLE);
    assert.equal(published[0].msg.task.params.top_k, 5);
    assert.throws(() => search.get(search_id, '#99:9'), /not found/i);

    // The message names another user and a file the searcher does not own: both are ignored.
    await search.deliver({
        search_id, userId: '#99:9',
        response: { results: { doc_map: ['#10:2', '#77:7'], model: { id: 'm' }, chunk_similarities: [
            { similarity: 0.9, doc_index: 0, chunk: 0, text_start_char: 4, text_end_char: 30 },
            { similarity: 0.8, doc_index: 1, chunk: 0, text_start_char: 0, text_end_char: 10 },
        ] } },
    });
    const result = search.get(search_id, '#16:0');
    assert.equal(result.status, 'done');
    assert.deepEqual(result.hits.map((h: any) => h.rid), ['#10:2']);
    assert.equal(result.hits[0].snippet, 'ship reached the harbour a');
    assert.deepEqual(sent.map((s) => s.user), ['#16:0']);
});

test('a failed search reports its error', async () => {
    const { search } = fakes(fs.mkdtempSync(path.join(os.tmpdir(), 'md-sem-')));
    const { search_id } = await search.start('#16:0', { index: '#10:1', query: 'x' });
    search.fail({ search_id }, { message: 'model missing' });
    assert.equal(search.get(search_id, '#16:0').error, 'model missing');
});
