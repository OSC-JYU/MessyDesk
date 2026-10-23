import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SseHub } from '../../src/platform/sse/hub.ts';

test('events go to every connection of a user, in the susie wire format', () => {
    const hub = new SseHub();
    const a = hub.open('#1:1');
    const b = hub.open('#1:1');
    const chunks: string[] = [];
    a.stream.on('data', (c) => chunks.push(String(c)));
    b.stream.on('data', (c) => chunks.push(String(c)));
    assert.equal(hub.send('#1:1', { command: 'add' }), true);
    assert.equal(chunks.length, 2);
    assert.match(chunks[0], /^id: \d+\r\ndata: \{"command":"add"\}\r\n\r\n$/);
    hub.close(a);
    assert.equal(hub.send('#1:1', { x: 1 }), true);
    hub.close(b);
    assert.equal(hub.send('#1:1', { x: 1 }), false);
    assert.equal(hub.send(null, { x: 1 }), false);
});
