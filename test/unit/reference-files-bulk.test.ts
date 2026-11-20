import { test } from 'node:test';
import assert from 'node:assert/strict';
import { NodesService } from '../../src/modules/nodes/nodes.ts';

test('references are made in one script, with the lineage edge and the origin of each source', async () => {
    const scripts: any[] = [];
    const db: any = {
        rowsByRids: async () => [
            { rid: '#2:1', path: 'a/1.jpg', type: 'image', origin_rid: '#7:0', origin_label: 'book.pdf', page_number: 3 },
            { rid: '#2:2', path: 'a/2.jpg', type: 'image' },
        ],
        first: async () => ({ uuid: 'proc-uuid', service_id: 'md-sharp', task: 'extract_rois' }),
        script: async (command: string, params: any) => scripts.push({ command, params }),
    };
    const nodes = new NodesService(db, {} as any, {} as any, { manifestDelayMs: 1e9 });
    const made = await nodes.createReferenceFiles('#9:1', '#5:5', [
        { rid: '#2:1', label: 'p1.jpg', type: 'image', extension: 'jpg', project_rid: '#1:0' },
        { rid: '#2:2', label: 'p2.jpg', type: 'image', extension: 'jpg', project_rid: '#1:0' },
    ]);
    assert.equal(made, 2);
    assert.equal(scripts.length, 1);
    const { command, params } = scripts[0];
    assert.match(command, /^BEGIN;/);
    assert.match(command, /COMMIT;$/);
    assert.match(command, /CREATE EDGE DERIVED_FROM FROM \$v1 TO #2:2 SET process_rid = :processRid/);
    assert.equal(params.processId, 'proc-uuid');
    assert.equal(params.cruncher, 'md-sharp');
    assert.deepEqual([params.c0.ref, params.c0.path, params.c0.set, params.c0.page_number, params.c0.origin_label], ['#2:1', 'a/1.jpg', '#5:5', 3, 'book.pdf']);
    assert.equal(params.c1.origin_rid, undefined);
});

test('a source that is gone stops the step before anything is written', async () => {
    const db: any = { rowsByRids: async () => [], first: async () => null, script: async () => assert.fail('nothing should be written') };
    const nodes = new NodesService(db, {} as any, {} as any, { manifestDelayMs: 1e9 });
    await assert.rejects(() => nodes.createReferenceFiles('#9:1', '#5:5', [{ rid: '#2:1' }]), /Reference source not found/);
});
