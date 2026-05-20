import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';

describe('Graph.createReferenceFileNode', () => {
    it('creates a file node with ref RID and shared source path', async () => {
        const originalSql = db.sql;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalSyncSetManifest = Graph.syncSetManifest;

        let createQuery = null;
        const setNodeAttributeCalls = [];
        let connectCall = null;
        let syncedSetRid = null;

        db.sql = async (query) => {
            if (query.startsWith('SELECT @rid, path, metadata, info FROM #10:1')) {
                return {
                    result: [
                        {
                            '@rid': '#10:1',
                            path: '/tmp/source/shared.jpg',
                            metadata: { size: 1.2 },
                            info: 'source info',
                        },
                    ],
                };
            }
            if (query.startsWith('CREATE VERTEX File CONTENT')) {
                createQuery = query;
                return { result: [{ '@rid': '#40:1', uuid: 'uuid-40-1' }] };
            }
            return { result: [] };
        };

        Graph.setNodeAttribute_old = async (rid, payload, type) => {
            setNodeAttributeCalls.push({ rid, payload, type });
            return { result: 'ok' };
        };
        Graph.connectDerivedFrom = async (target, source, processRid) => {
            connectCall = { target, source, processRid };
            return { result: 'ok' };
        };
        Graph.syncSetManifest = async (setRid) => {
            syncedSetRid = setRid;
            return null;
        };

        try {
            const message = {
                process: { '@rid': '#20:1' },
                file: {
                    '@rid': '#10:9',
                    project_rid: '#2:1',
                    type: 'image',
                    extension: 'jpg',
                    label: 'copied-label.jpg',
                },
                output_set: '#12:9',
            };

            const created = await Graph.createReferenceFileNode('#20:1', message, '#10:1', '', 'reference info');

            assert.ok(createQuery, 'CREATE VERTEX query should be executed');
            assert.ok(createQuery.includes('"ref":"#10:1"'), 'vertex payload should include ref field');
            assert.equal(created.path, '/tmp/source/shared.jpg');
            assert.equal(created.ref, '#10:1');

            assert.equal(setNodeAttributeCalls.length, 2);
            assert.deepEqual(setNodeAttributeCalls[0], {
                rid: '#40:1',
                payload: { key: 'path', value: '/tmp/source/shared.jpg' },
                type: 'File',
            });
            assert.deepEqual(setNodeAttributeCalls[1], {
                rid: '#40:1',
                payload: { key: 'set', value: '#12:9' },
                type: 'File',
            });

            assert.ok(connectCall, 'connectDerivedFrom should be called');
            assert.equal(connectCall.target, '#40:1');
            assert.equal(connectCall.source, '#10:1');
            assert.equal(connectCall.processRid, '#20:1');
            assert.equal(syncedSetRid, '#12:9');
        } finally {
            db.sql = originalSql;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.syncSetManifest = originalSyncSetManifest;
        }
    });
});
