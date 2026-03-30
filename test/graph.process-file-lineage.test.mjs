import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';
import media from '../src/media.mjs';

describe('Graph.createProcessFileNode lineage source', () => {
    it('prefers root_source rid over message.file rid when connecting DERIVED_FROM', async () => {
        const originalSql = db.sql;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalSyncSetManifest = Graph.syncSetManifest;
        const originalGetFilePath = media.getFilePath;

        let connectCall = null;

        db.sql = async (query) => {
            if (query.startsWith('SELECT path FROM')) {
                return { result: [{ path: '/tmp/process/files' }] };
            }
            if (query.startsWith('CREATE VERTEX File CONTENT')) {
                return { result: [{ '@rid': '#40:1', uuid: 'uuid-40-1' }] };
            }
            return { result: [] };
        };

        Graph.setNodeAttribute_old = async () => ({ result: 'ok' });
        Graph.syncSetManifest = async () => null;
        media.getFilePath = () => '/tmp/combined.txt';
        Graph.connectDerivedFrom = async (target, source, processRid) => {
            connectCall = { target, source, processRid };
            return { result: 'ok' };
        };

        try {
            const message = {
                process: { '@rid': '#20:1' },
                file: {
                    '@rid': '#10:9',
                    project_rid: '#2:1',
                    type: 'text',
                    extension: 'txt',
                    label: 'combined.txt',
                },
                root_source: {
                    '@rid': '#10:1',
                    label: 'original.pdf',
                },
            };

            await Graph.createProcessFileNode('#20:1', message, '', '');

            assert.ok(connectCall, 'connectDerivedFrom should be called');
            assert.equal(connectCall.source, '#10:1');
        } finally {
            db.sql = originalSql;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.syncSetManifest = originalSyncSetManifest;
            media.getFilePath = originalGetFilePath;
        }
    });
});
