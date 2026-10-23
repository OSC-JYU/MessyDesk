// The PDF import reports pages the splitter could not write, and a split that failed.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ResultsService } from '../../src/modules/results/results.ts';

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

test('failed pages are recorded once on the import process', async () => {
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

test('a failed split ends the import with its reason', async () => {
    const { results, attrs } = fakes();
    await results.failImport({ message: 'None of the 3 pages could be split: bad xref' }, { userId: '#16:0', file: { '@rid': '#80:1' }, process: { '@rid': '#30:1' } });
    assert.equal(attrs['#80:1']._status, 'import_failed');
    assert.equal(attrs['#30:1'].status, 'failed');
    assert.match(attrs['#30:1'].info, /could not be split into pages: None of the 3 pages/);
});
