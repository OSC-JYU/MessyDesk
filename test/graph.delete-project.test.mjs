import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';

describe('Graph.deleteProject', () => {
    let originalSql;
    let originalDeleteNode;
    let deleteCalls;

    beforeEach(() => {
        originalSql = db.sql;
        originalDeleteNode = Graph.deleteNode;
        deleteCalls = [];
        Graph.deleteNode = async (...args) => {
            deleteCalls.push(args);
            return { deleted: 1 };
        };
    });

    afterEach(() => {
        db.sql = originalSql;
        Graph.deleteNode = originalDeleteNode;
    });

    it('deletes an owned project, passing the user rid on to deleteNode', async () => {
        db.sql = async () => ({ result: [{ rid: '#1:1' }] });

        const result = await Graph.deleteProject('#1:1', '#49:0');

        assert.equal(result, '#1:1');
        assert.deepEqual(deleteCalls, [['#1:1', '#49:0']]);
    });

    it('returns null and deletes nothing when the project is not found or not owned', async () => {
        db.sql = async () => ({ result: [] });

        const result = await Graph.deleteProject('#1:1', '#49:0');

        assert.equal(result, null);
        assert.equal(deleteCalls.length, 0);
    });
});
