import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';
import media from '../src/media.mjs';
import solr from '../src/solr.mjs';

describe('Graph.deleteNode reference path safety', () => {
    it('deletes reference node without deleting shared source path', async () => {
        const originalGetNodeAttributes = Graph.getNodeAttributes;
        const originalSql = db.sql;
        const originalDeleteMany = db.deleteMany;
        const originalDeleteNodePath = media.deleteNodePath;
        const originalDropSetIndex = solr.dropSetIndex;

        let deleteManyTargets = null;
        const deletedPaths = [];

        Graph.getNodeAttributes = async () => ({ '@rid': '#40:1' });

        db.sql = async (query) => {
            if (query.startsWith('SELECT @rid, @type, path, service, ref FROM #40:1')) {
                return {
                    result: [
                        {
                            '@rid': '#40:1',
                            '@type': 'File',
                            path: '/tmp/source/shared.jpg',
                            ref: '#10:1',
                            service: null,
                        },
                    ],
                };
            }
            if (query.startsWith('SELECT @out AS rid, process_rid FROM DERIVED_FROM WHERE @in = #40:1')) {
                return { result: [] };
            }
            if (query.startsWith('SELECT @out AS rid FROM DERIVED_FROM WHERE process_rid = "#40:1"')) {
                return { result: [] };
            }
            if (query.startsWith('SELECT process_rid FROM DERIVED_FROM WHERE @in = #40:1 OR @out = #40:1')) {
                return { result: [] };
            }
            return { result: [] };
        };

        db.deleteMany = async (targets) => {
            deleteManyTargets = targets;
            return { result: 'ok' };
        };

        media.deleteNodePath = async (targetPath) => {
            deletedPaths.push(targetPath);
            return true;
        };

        solr.dropSetIndex = async () => true;

        try {
            const result = await Graph.deleteNode('#40:1', '#2:1');

            assert.deepEqual(deleteManyTargets, [{ id: '#40:1' }]);
            assert.equal(deletedPaths.length, 0, 'reference node deletion must not remove shared bitstream path');
            assert.equal(result.path, null);
            assert.equal(result.deleted, 1);
        } finally {
            Graph.getNodeAttributes = originalGetNodeAttributes;
            db.sql = originalSql;
            db.deleteMany = originalDeleteMany;
            media.deleteNodePath = originalDeleteNodePath;
            solr.dropSetIndex = originalDropSetIndex;
        }
    });
});
