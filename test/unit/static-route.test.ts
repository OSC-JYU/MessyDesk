import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createServer, isUiRoute, staticRoute } from '../../src/platform/http/server.ts';

async function serverWith(files: Record<string, string>) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'md-public-'));
    for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
    const server = await createServer(0, dir);
    server.route(staticRoute());
    return server;
}

test('UI routes are paths without a file name outside the API', () => {
    assert.equal(isUiRoute('/projects/12_3'), true);
    assert.equal(isUiRoute('/'), true);
    assert.equal(isUiRoute('/api/projects'), false);
    assert.equal(isUiRoute('/events'), false);
    assert.equal(isUiRoute('/icons/x'), false);
    assert.equal(isUiRoute('/assets/app.js'), false);
});

test('with a built UI, deep links get index.html and missing files stay 404', async () => {
    const server = await serverWith({ 'index.html': '<div id="app"></div>', 'favicon.ico': 'x' });
    const deep = await server.inject('/projects/12_3/files');
    assert.equal(deep.statusCode, 200);
    assert.match(deep.payload, /id="app"/);
    assert.equal((await server.inject('/favicon.ico')).payload, 'x');
    assert.equal((await server.inject('/assets/missing.js')).statusCode, 404);
    assert.equal((await server.inject('/api/nothing-here')).statusCode, 404);
});

test('without a built UI, unknown paths stay 404', async () => {
    const server = await serverWith({ 'favicon.ico': 'x' });
    assert.equal((await server.inject('/projects/12_3')).statusCode, 404);
});
