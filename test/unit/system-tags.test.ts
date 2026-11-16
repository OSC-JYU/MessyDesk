import { test } from 'node:test';
import assert from 'node:assert/strict';
import { TagsService } from '../../src/modules/tags/tags.ts';

test('a system tag is a machine tag of type System, linked or unlinked on request', async () => {
    const tags: any = new TagsService({} as any, {} as any);
    const calls: any[] = [];
    tags.findOrCreateMachineEntity = async (...args: any[]) => (calls.push(['entity', ...args]), { '@rid': '#7:1' });
    tags.link = async (...args: any[]) => calls.push(['link', ...args]);
    tags.unlink = async (...args: any[]) => calls.push(['unlink', ...args]);
    await tags.setSystemTag('#9:1', 'edited', '#3:0', true);
    await tags.setSystemTag('#9:1', 'edited', '#3:0', false);
    assert.deepEqual(calls[0].slice(0, 5), ['entity', 'System', 'edited', '#3:0', null]);
    assert.deepEqual(calls[1], ['link', '#7:1', '#9:1', '#3:0', { created_by: 'machine', service_id: 'system', task: 'edited' }]);
    assert.deepEqual(calls[3], ['unlink', '#7:1', '#9:1', '#3:0']);
});

test('regions in a roi.json are counted from a list or a map', async () => {
    const { RoisService } = await import('../../src/modules/rois/rois.ts');
    assert.equal(RoisService.regionCount({ rois: [{ x: 1 }, { x: 2 }] }), 2);
    assert.equal(RoisService.regionCount({ rois: { a: {}, b: {}, c: {} } }), 3);
    assert.equal(RoisService.regionCount({ rois: [] }), 0);
    assert.equal(RoisService.regionCount(null), 0);
});
