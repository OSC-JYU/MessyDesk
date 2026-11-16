// A PDF split reports the pages the splitter could not write.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { checkPageRanges, filterSetPages } from '../../src/modules/processing/processing.ts';
import { ResultsService } from '../../src/modules/results/results.ts';
import { pageInRange, parsePageRange } from '../../src/shared/page-range.ts';

function fakes() {
    const attrs: Record<string, any> = {};
    const sent: any[] = [];
    const store = {
        getNode: async (rid: string) => attrs[rid] ?? null,
        setAttributes: async (rid: string, patch: any) => { attrs[rid] = { ...(attrs[rid] || {}), ...patch }; },
        setAttribute: async (rid: string, key: string, value: any) => { attrs[rid] = { ...(attrs[rid] || {}), [key]: value }; },
    };
    const results: any = new ResultsService({ store, sse: { send: (user: string, data: any) => { sent.push({ user, data }); return true; } } } as any);
    return { results, attrs, sent };
}

test('failed pages are recorded once on the split process', async () => {
    const { results, attrs, sent } = fakes();
    const message = {
        userId: '#16:0',
        response: { page_count: 120, failed_pages: [{ page: 7, error: 'broken content stream' }, { page: 15, error: 'x' }] },
    };
    await results.reportFailedPages(message, '#30:1');
    await results.reportFailedPages(message, '#30:1');
    assert.equal(attrs['#30:1'].info, '2 of 120 pages could not be split and are missing: 7, 15 (broken content stream)');
    assert.equal(attrs['#30:1'].failed_pages.length, 2);
    assert.equal(sent.length, 1);
    await results.reportFailedPages({ response: { failed_pages: [] } }, '#30:2');
    assert.equal(attrs['#30:2'], undefined);
});

test('page ranges', () => {
    assert.equal(parsePageRange(''), null);
    assert.equal(parsePageRange('  '), null);
    const range = parsePageRange('1-3, 8,10-');
    assert.deepEqual([1, 3, 4, 8, 9, 10, 500].map((p) => pageInRange(range, p)), [true, true, false, true, false, true, true]);
    assert.equal(pageInRange(parsePageRange('-2'), 2), true);
    assert.equal(pageInRange(parsePageRange('-2'), 3), false);
    assert.equal(pageInRange(null, 99), true);
    for (const bad of ['0', '3-1', 'a', '1-2-3', '-', '1,,2', '1;2']) assert.throws(() => parsePageRange(bad), /Invalid page range/, bad);
});

test('a page range of the descriptor is checked and applied to the set files', () => {
    const def = { params_help: { pages: { format: 'page_range', filter: 'set_pages' } } };
    assert.throws(() => checkPageRanges(def, { params: { pages: '5-2' } }), /Invalid page range/);
    checkPageRanges(def, { params: { pages: '2-3' } });
    const files = [1, 2, 3, 4].map((n) => ({ page_number: n })).concat([{} as any]);
    const task: any = { params: { pages: '2-3', resolution: 150 } };
    assert.deepEqual(filterSetPages(def, task, files).map((f) => f.page_number), [2, 3]);
    assert.deepEqual(task.params, { resolution: 150 }); // the cruncher never sees the range
    assert.equal(filterSetPages(def, { params: { pages: '' } }, files).length, 5);
    assert.throws(() => filterSetPages(def, { params: { pages: '9-' } }, files), /No page of the set/);
    assert.equal(filterSetPages({ params_help: { pages: { format: 'page_range' } } }, { params: { pages: '2' } }, files).length, 5);
});

test('the original PDF is removed after the split unless the user keeps it', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'split-'));
    try {
        for (const [keep, removed] of [[undefined, true], [true, true], [false, false], ['false', false]] as Array<[unknown, boolean]>) {
            const file = path.join(dir, 'original.pdf');
            await fsp.writeFile(file, '%PDF-1.4');
            const { results, attrs, sent } = fakes();
            attrs['#80:1'] = { path: file };
            const params = keep === undefined ? {} : { delete_original: keep };
            await results.finishSplit({ userId: '#16:0', file: { '@rid': '#80:1' }, task: { params } });
            assert.equal(fs.existsSync(file), !removed, String(keep));
            assert.equal(attrs['#80:1']._file_removed === true, removed, String(keep));
            assert.equal(sent.length, removed ? 1 : 0);
        }
    } finally {
        await fsp.rm(dir, { recursive: true, force: true });
    }
});

test('a file made from a page belongs to the original PDF of the page', async () => {
    const { NodesService } = await import('../../src/modules/nodes/nodes.ts');
    const parents: Record<string, any> = {
        '#1:1': { rid: '#1:1', type: 'original-pdf', label: 'report.pdf' },
        '#1:2': { rid: '#1:2', type: 'pdf', label: 'page_003.pdf', origin_rid: '#1:1', origin_label: 'report.pdf', page_number: 3 },
        '#1:3': { rid: '#1:3', type: 'image', label: 'scan.png' },
    };
    const db: any = { first: async (sql: string) => parents[/(#\d+:\d+)/.exec(sql)![1]] ?? null };
    const nodes: any = new NodesService(db, {} as any, {} as any);
    assert.deepEqual(await nodes.originOf('#1:1'), { origin_rid: '#1:1', origin_label: 'report.pdf' });
    assert.deepEqual(await nodes.originOf('#1:2'), { origin_rid: '#1:1', origin_label: 'report.pdf', page_number: 3 });
    assert.deepEqual(await nodes.originOf('#1:3'), {});
    assert.deepEqual(await nodes.originOf('#9:9'), {});
    assert.deepEqual(await nodes.originOf(undefined), {});
});
