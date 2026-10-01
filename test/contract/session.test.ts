import { test } from 'node:test';
import assert from 'node:assert/strict';
import { get, post, put, del, call, ADMIN, OTHER, onlyNew, ensureOtherUser, uniq } from './helpers.ts';

test('GET /api is a plain-text session check', async () => {
    const res = await get('/api');
    assert.equal(res.status, 200);
    assert.equal(res.text, 'MessyDesk API');
});

test('requests without the mail header get 401 with a Boom body', async () => {
    const res = await get('/api/me', { user: null });
    assert.equal(res.status, 401);
    assert.equal(res.body.statusCode, 401);
    assert.equal(res.body.error, 'Unauthorized');
    assert.equal(typeof res.body.message, 'string');
});

test('unknown user gets 401', async () => {
    const res = await get('/api/me', { user: 'nobody.contract@example.com' });
    assert.equal(res.status, 401);
});

test('GET /api/sso echoes the proxy headers without auth', async () => {
    const res = await call('GET', '/api/sso', { user: null, headers: { mail: 'x@y.fi', displayname: 'X Y' } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body, { mail: 'x@y.fi', name: 'X Y' });
});

test('GET /api/me returns identity and settings with defaults', async () => {
    const res = await get('/api/me');
    assert.equal(res.status, 200);
    assert.match(res.body.rid, /^#\d+:\d+$/);
    assert.equal(res.body.id, ADMIN);
    assert.equal(res.body.access, 'admin');
    assert.equal(res.body.group, 'user');
    assert.equal(typeof res.body.mode, 'string');
    assert.deepEqual(Object.keys(res.body.settings).sort(), ['cookie', 'motion', 'theme']);
});

test('PUT /api/me/settings merges and validates', async () => {
    const ok = await put('/api/me/settings', { theme: 'navy' });
    assert.equal(ok.status, 200);
    assert.equal(ok.body.theme, 'navy');
    assert.ok(ok.body.cookie);
    const me = await get('/api/me');
    assert.equal(me.body.settings.theme, 'navy');
    const bad = await put('/api/me/settings', { theme: 'pink' });
    assert.equal(bad.status, 400);
    const unknown = await put('/api/me/settings', { font: 'x' });
    assert.equal(unknown.status, 400);
    await put('/api/me/settings', { theme: 'light' });
});

test('users: admin can list and create, others get 403', async () => {
    await ensureOtherUser();
    const list = await get('/api/users');
    assert.equal(list.status, 200);
    assert.ok(Array.isArray(list.body));
    const other = list.body.find((u: any) => u.id === OTHER);
    assert.ok(other, 'other user listed');
    assert.ok(other['@rid']);
    assert.equal(other.access, 'user');
    assert.deepEqual(other.service_groups, ['OSC']);

    const forbidden = await get('/api/users', { user: OTHER });
    assert.equal(forbidden.status, 403);
    const forbiddenCreate = await post('/api/users', { id: 'x@y.fi', label: 'x' }, { user: OTHER });
    assert.equal(forbiddenCreate.status, 403);
});

test('PUT /api/users/{rid}/service-groups replaces groups (admin only)', async () => {
    const otherRid = await ensureOtherUser();
    const res = await put(`/api/users/${otherRid.replace('#', '')}/service-groups`, { service_groups: ['OSC', 'IMAGE'] });
    assert.equal(res.status, 200);
    assert.deepEqual(res.body.service_groups, ['OSC', 'IMAGE']);
    assert.equal(res.body.rid, otherRid);
    await put(`/api/users/${otherRid.replace('#', '')}/service-groups`, { service_groups: ['OSC'] });
    const forbidden = await put(`/api/users/${otherRid.replace('#', '')}/service-groups`, { service_groups: [] }, { user: OTHER });
    assert.equal(forbidden.status, 403);
});

test('permission requests: create without auth, list and delete', async () => {
    const mail = `${uniq('req').replace(' ', '.')}@example.com`;
    const created = await call('POST', '/api/permissions/request', { user: null, headers: { mail, displayname: 'Req' }, body: {} });
    assert.equal(created.status, 200);
    assert.deepEqual(created.body, { status: 'ok' });

    const list = await get('/api/permissions/request');
    assert.equal(list.status, 200);
    const row = list.body.find((r: any) => r.id === mail);
    assert.ok(row);
    assert.equal(row.label, 'Req');

    const removed = await del(`/api/permissions/request/${row['@rid'].replace('#', '')}`);
    assert.equal(removed.status, 200);
    const after = await get('/api/permissions/request');
    assert.ok(!after.body.find((r: any) => r.id === mail));
});

test('permission request without identity is 400', async () => {
    const res = await call('POST', '/api/permissions/request', { user: null, body: {} });
    assert.equal(res.status, 400);
});

test('duplicate permission request is 409 (was 500 because of a missing import)', { skip: onlyNew }, async () => {
    const res = await call('POST', '/api/permissions/request', { user: null, headers: { mail: ADMIN }, body: {} });
    assert.equal(res.status, 409);
});

test('permission request list and delete are admin only', { skip: onlyNew }, async () => {
    await ensureOtherUser();
    assert.equal((await get('/api/permissions/request', { user: OTHER })).status, 403);
    assert.equal((await del('/api/permissions/request/1:1', { user: OTHER })).status, 403);
});
