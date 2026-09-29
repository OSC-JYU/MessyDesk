import { strict as assert } from 'assert';

import authRoutes from '../src/routes/auth.mjs';
import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';
import { withDefaults, validatePatch, DEFAULT_SETTINGS } from '../src/userSettings.mjs';

const route = (method, path) => authRoutes.find((r) => r.method === method && r.path === path).handler;
const credentials = { user: { rid: '#49:0', id: 'local.user@localhost' } };

describe('User settings', () => {
    it('fills in defaults and drops unknown values', () => {
        assert.deepEqual(withDefaults(undefined), DEFAULT_SETTINGS);
        assert.deepEqual(withDefaults({ theme: 'dark', cookie: 'purple', extra: 1 }), {
            theme: 'dark',
            cookie: 'classic',
        });
    });

    it('accepts only known keys and values', () => {
        assert.deepEqual(validatePatch({ theme: 'system' }), { theme: 'system' });
        assert.throws(() => validatePatch({ theme: 'neon' }), /theme must be one of/);
        assert.throws(() => validatePatch({ font: 'x' }), /Unknown setting/);
        assert.throws(() => validatePatch(['dark']), /must be an object/);
    });

    it('GET /api/me returns the settings with defaults', async () => {
        const original = Graph.myId;
        Graph.myId = async () => ({ rid: '#49:0', access: 'user', settings: { cookie: 'matcha' } });
        try {
            const me = await route('GET', '/api/me')({ auth: { credentials } });
            assert.deepEqual(me.settings, { theme: 'light', cookie: 'matcha' });
        } finally {
            Graph.myId = original;
        }
    });

    it('PUT /api/me/settings merges the patch into the stored map', async () => {
        const original = db.sql;
        const calls = [];
        db.sql = async (query, options) => {
            calls.push({ query, options });
            return { result: query.startsWith('SELECT') ? [{ settings: { theme: 'dark' } }] : [] };
        };
        try {
            const saved = await route('PUT', '/api/me/settings')({
                auth: { credentials },
                payload: { cookie: 'blueberry' },
            });
            assert.deepEqual(saved, { theme: 'dark', cookie: 'blueberry' });
            assert.match(calls[1].query, /^UPDATE User SET settings = :settings WHERE @rid = #49:0/);
            assert.deepEqual(calls[1].options.params.settings, { theme: 'dark', cookie: 'blueberry' });
        } finally {
            db.sql = original;
        }
    });

    it('PUT /api/me/settings rejects bad values with 400', async () => {
        await assert.rejects(
            route('PUT', '/api/me/settings')({ auth: { credentials }, payload: { theme: 'neon' } }),
            (error) => error.isBoom && error.output.statusCode === 400,
        );
    });
});
