// A grouped many-to-one run (Clever text join over several PDFs) reports group counters in
// total_files/current_file; /done must count against the whole batch, not the group.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultsService } from '../../src/modules/results/results.ts';

function fakes() {
    const increments: any[] = [];
    const sent: any[] = [];
    const batches = {
        incrementProcessed: async (rid: string, _time: unknown, total: unknown) => {
            increments.push({ rid, total });
            return { '@rid': rid, status: 'running', processed_files: increments.length, total_files: total };
        },
        get: async () => null,
    };
    const results: any = new ResultsService({ batches, sse: { send: (_user: string, data: any) => { sent.push(data); return true; } } } as any);
    return { results, increments, sent };
}

test('a grouped many-to-one /done counts against the batch total, not the group size', async () => {
    const { results, increments, sent } = fakes();
    await results.handleDone({
        userId: '#121:0',
        behaviour: 'many-to-one',
        set_process: '#64:10',
        process: { '@rid': '#64:10' },
        file: { '@rid': '#88:1' },
        total_files: 10,
        current_file: 10,
        batch_total_files: 24,
        batch_current_file: 10,
    });
    assert.deepEqual(increments, [{ rid: '#64:10', total: 24 }]);
    assert.ok(!sent.some((m) => m.command === 'process_finished' && m.process?.['@rid'] === '#64:10'));
});

test('an ungrouped /done still uses total_files', async () => {
    const { results, increments } = fakes();
    await results.handleDone({ userId: '#121:0', set_process: '#64:11', process: { '@rid': '#64:11' }, file: { '@rid': '#88:2' }, total_files: 5, current_file: 2 });
    assert.deepEqual(increments, [{ rid: '#64:11', total: 5 }]);
});
