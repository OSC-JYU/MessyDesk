import { test } from 'node:test';
import assert from 'node:assert/strict';
import { FiltersService } from '../../src/modules/filters/filters.ts';
import { filterMatchesNode, loadFilters } from '../../src/modules/services/matching.ts';

const filtersDir = new URL('../../../filters', import.meta.url).pathname;

test('the text ROI filter is offered for texts and sets of texts, the image one for images', async () => {
    const filters = await loadFilters(filtersDir, () => {});
    assert.ok(filters['mdf-text-roi']);
    const text = { '@type': 'File', type: 'text', extension: 'txt' };
    const image = { '@type': 'File', type: 'image', extension: 'png' };
    const textSet = { '@type': 'Set', types: ['text'], extensions: ['txt'] };
    assert.equal(filterMatchesNode(filters['mdf-text-roi'], text), true);
    assert.equal(filterMatchesNode(filters['mdf-text-roi'], textSet), true);
    assert.equal(filterMatchesNode(filters['mdf-text-roi'], image), false);
    assert.equal(filterMatchesNode(filters['mdf-image-roi'], text), false);
});

test('applying a ROI filter makes a process and a ROI set with the labels of the filter', async () => {
    const created: any[] = [];
    const store: any = {
        createVertex: async (type: string, attrs: any) => (created.push([type, attrs]), { '@rid': `#${created.length}:0`, uuid: `u${created.length}`, ...attrs }),
        connect: async () => {},
        connectDerivedFrom: async () => {},
    };
    const layout: any = { processFilesDir: () => '/tmp/p' };
    const access: any = { findOwned: async () => ({ node: { '@rid': '#9:9', type: 'text' }, projectRid: '#1:0' }) };
    const service = new FiltersService({} as any, store, layout, access, {} as any, {} as any);
    service.setFilters({
        'mdf-text-roi': { process_label: 'Mark passages', set_label: 'My passages' },
        'mdf-image-roi': {},
    });
    await service.apply('mdf-text-roi', '#9:9', '#2:0');
    await service.apply('mdf-image-roi', '#9:9', '#2:0');
    assert.deepEqual(created.map(([t, a]) => [t, a.label]), [
        ['Process', 'Mark passages'], ['Set', 'My passages'],
        ['Process', 'Draw regions'], ['Set', 'My regions'],
    ]);
    assert.equal(created[1][1].type, 'roi-set');
});
