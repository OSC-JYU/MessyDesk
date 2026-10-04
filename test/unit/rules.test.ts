// Pure rules: ids, paths, message enrichment, descriptors, service matching, file types.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { toRid, tryRid, ridToPathPart, uuidv7, isUuid, InvalidRidError } from '../../src/platform/ids.ts';
import { DataLayout } from '../../src/platform/storage/layout.ts';
import { enrichMessage } from '../../src/modules/queue/publisher.ts';
import { normalizeDescriptor, resolveBehaviour, DescriptorError } from '../../src/modules/services/registry.ts';
import { servicesForNode, filterMatchesNode } from '../../src/modules/services/matching.ts';
import { sortFiles } from '../../src/modules/processing/grouping.ts';
import { isSearchOutputTask, queueName, resolveModel } from '../../src/modules/processing/processing.ts';
import { detectType, contentTypeFor } from '../../src/modules/files/metadata.ts';
import { normalizeJsonSchema } from '../../src/modules/prompts/prompts.ts';
import { validatePatch, withDefaults } from '../../src/modules/users/settings.ts';
import { cypherString } from '../../src/platform/arcade/client.ts';

test('rids', () => {
    assert.equal(toRid('12:3'), '#12:3');
    assert.equal(toRid(' #12:3 '), '#12:3');
    assert.throws(() => toRid('12:3; DELETE'), InvalidRidError);
    assert.throws(() => toRid(5), InvalidRidError);
    assert.equal(tryRid('x'), null);
    assert.equal(ridToPathPart('#12:3'), '12_3');
});

test('uuidv7 starts with the timestamp and sorts by time', () => {
    const a = uuidv7();
    const b = uuidv7();
    assert.ok(isUuid(a) && isUuid(b));
    assert.equal(a[14], '7');
    assert.equal(parseInt(a.replace(/-/g, '').slice(0, 12), 16) <= Date.now(), true);
    assert.ok(a.slice(0, 8) <= b.slice(0, 8));
});

test('data layout matches the old sharded paths', () => {
    const layout = new DataLayout('data/messydesk');
    const uuid = '01a0f811-7ba9-7c61-9f97-d7859d63506a';
    assert.equal(layout.projectDir('#10:12'), 'data/messydesk/projects/10_12');
    assert.equal(layout.filePath('#10:12', uuid, 'JPG'), 'data/messydesk/projects/10_12/files/01/a0/f8/01a0f8117ba97c619f97d7859d63506a/01a0f8117ba97c619f97d7859d63506a.jpg');
    assert.equal(layout.processFilesDir('#10:12', uuid), 'data/messydesk/projects/10_12/processes/01/a0/f8/01a0f8117ba97c619f97d7859d63506a/files');
    assert.equal(DataLayout.shard('#82:1500'), '82/1/1500');
    assert.equal(layout.contains('data/messydesk/projects/x'), true);
    assert.equal(layout.contains('data/other'), false);
    assert.equal(layout.contains('data/messydesk/../../etc'), false);
});

test('message enrichment fills project_rid and set_rid', async () => {
    const lookups: string[] = [];
    const resolve = async (rid: string) => { lookups.push(rid); return '#9:9'; };
    const fromFile = await enrichMessage({ file: { '@rid': '#1:1', project_rid: '#2:2' } }, resolve);
    assert.equal(fromFile.project_rid, '#2:2');
    assert.equal(lookups.length, 0);
    const looked = await enrichMessage({ file: { '@rid': '1:1' } }, resolve);
    assert.equal(looked.project_rid, '#9:9');
    assert.deepEqual(lookups, ['#1:1']);
    const batch = await enrichMessage({ project_rid: '#2:2', set_process: '#5:5', input_set: '3:3', output_set: '#4:4', file: {} }, resolve);
    assert.equal(batch.set_rid, '#3:3');
    const setFile = await enrichMessage({ project_rid: '#2:2', file: { '@rid': '#6:6', '@type': 'Set' } }, resolve);
    assert.equal(setFile.set_rid, '#6:6');
});

test('descriptor normalisation', () => {
    const d = normalizeDescriptor({ id: ' svc ', supported_types: ['Image'], tasks: { a: {}, b: { behaviour: 'many-to-one' } }, behaviour: 'one-to-many' });
    assert.equal(d.id, 'svc');
    assert.deepEqual(d.supported_types, ['image']);
    assert.equal(d.tasks.a.behaviour, 'one-to-many');
    assert.equal(d.tasks.b.behaviour, 'many-to-one');
    assert.throws(() => normalizeDescriptor({ id: 'x', tasks: { a: { behaviour: 'weird' } } }), DescriptorError);
    assert.throws(() => normalizeDescriptor({ id: 'x', category: 'fun' }), DescriptorError);
    assert.throws(() => normalizeDescriptor({ tasks: {} }), DescriptorError);
    assert.equal(resolveBehaviour({ tasks: { t: {} } }, { id: 't' }), 'one-to-one');
    assert.equal(resolveBehaviour({ tasks: { t: { behaviour: 'one-to-many' } } }, { id: 't' }), 'one-to-many');
});

test('services offered for a node', () => {
    const services = {
        img: { id: 'img', consumers: ['a'], supported_types: ['image'], tasks: { rot: { name: 'R' }, comb: { behaviour: 'many-to-one' }, roi: { filter: 'ROI' } } },
        offline: { id: 'offline', consumers: [], supported_types: ['image'], tasks: { x: {} } },
        sys: { id: 'sys', consumers: ['a'], category: 'system', supported_types: ['image'], tasks: { x: {} } },
        'md-thumbnailer': { id: 'md-thumbnailer', consumers: ['a'], supported_types: ['image'], tasks: { thumbnail: {} } },
        grouped: { id: 'grouped', consumers: ['a'], service_groups: ['VIP'], supported_types: ['image'], tasks: { x: {} } },
        'md-pypdf_fs': { id: 'md-pypdf_fs', consumers: ['a'], supported_types: ['pdf'], tasks: { split: {}, other: {} } },
    };
    const user = { service_groups: ['OSC'] };
    const file = { '@type': 'File', type: 'image', extension: 'jpg' };
    const res = servicesForNode(services, file, undefined, user, []);
    assert.deepEqual(res.for_format.map((s: any) => s.id), ['img']);
    assert.deepEqual(Object.keys(res.for_format[0].tasks), ['rot']);
    const roi = servicesForNode(services, file, 'ROI', user, []);
    assert.deepEqual(Object.keys(roi.for_format[0].tasks), ['roi']);
    const set = servicesForNode(services, { '@type': 'Set', types: ['image'], extensions: ['jpg'] }, undefined, user, []);
    assert.deepEqual(Object.keys(set.for_format[0].tasks), ['rot', 'comb']);
    const pdf = servicesForNode(services, { '@type': 'File', type: 'pdf', extension: 'pdf', processable: false }, undefined, user, []);
    assert.deepEqual(pdf.for_format.map((s: any) => Object.keys(s.tasks)), [['split']]);
    const vip = servicesForNode(services, file, undefined, { service_groups: ['VIP'] }, []);
    assert.ok(vip.for_format.find((s: any) => s.id === 'grouped'));
});

test('filters match nodes by type, format and set_only', () => {
    assert.equal(filterMatchesNode({ supported_types: ['image'] }, { '@type': 'File', type: 'image' }), true);
    assert.equal(filterMatchesNode({ supported_types: ['image'] }, { '@type': 'File', type: 'text' }), false);
    assert.equal(filterMatchesNode({ set_only: 1 }, { '@type': 'File' }), false);
    assert.equal(filterMatchesNode({ set_only: 1, supported_types: ['set'] }, { '@type': 'Set' }), true);
    assert.equal(filterMatchesNode({ supported_formats: ['png'] }, { '@type': 'Set', extensions: ['jpg', 'png'] }), true);
});

test('file sort: page numbers first, then names', () => {
    const sorted = sortFiles([{ label: 'b' }, { label: 'x', page_number: 2 }, { original_filename: 'A' }, { label: 'y', page_number: 1 }]);
    assert.deepEqual(sorted.map((f) => f.label || f.original_filename), ['y', 'x', 'A', 'b']);
});

test('search output tasks and batch queue names', () => {
    assert.equal(isSearchOutputTask({ id: 'md-solr', tasks: { index: { behaviour: 'many-to-one' } } }, { id: 'index' }), true);
    assert.equal(isSearchOutputTask({ id: 'md-solr', tasks: { index: {} } }, { id: 'index' }), false);
    assert.equal(isSearchOutputTask({ id: 'x', tasks: { t: { search_output: true } } }, { id: 't' }), true);
    assert.equal(queueName({ tasks: { t: { always_batch: true } } }, { id: 't' }, 'svc'), 'svc_batch');
    assert.equal(queueName({ tasks: { t: {} } }, { id: 't' }, 'svc'), 'svc');
});

test('file types and download content types', () => {
    assert.equal(detectType('a.zip', 'application/octet-stream'), 'zip');
    assert.equal(detectType('a.jpg', 'image/jpeg'), 'image');
    assert.equal(detectType('a.pdf', 'application/octet-stream'), 'pdf');
    assert.equal(detectType('a.csv', 'application/octet-stream'), 'csv');
    assert.equal(detectType('a.bin', 'application/octet-stream'), undefined);
    assert.equal(detectType('a.md', 'text/markdown'), 'text');
    assert.equal(detectType('a.json', 'application/json'), 'json');
    assert.deepEqual(contentTypeFor({ type: 'image', label: 'x.jpg' }), { type: 'image/png' });
    assert.equal(contentTypeFor({ type: 'ner.json' }).type, 'application/json');
    assert.equal(contentTypeFor({ type: 'zip', label: "a b(1).zip" }).disposition, 'attachment; filename="a%20b%281%29.zip"');
});

test('prompt json schema normalisation', () => {
    assert.equal(normalizeJsonSchema(''), '');
    assert.equal(normalizeJsonSchema('{"a": 1}'), '{"a":1}');
    assert.equal(normalizeJsonSchema('{a: string, b: 1}'), '{"a":"string","b":1}');
    assert.throws(() => normalizeJsonSchema('[1]'));
    assert.throws(() => normalizeJsonSchema('{{'));
});

test('user settings', () => {
    assert.deepEqual(withDefaults({ theme: 'navy', cookie: 'nope' }), { theme: 'navy', cookie: 'classic', motion: 'on' });
    assert.deepEqual(validatePatch({ motion: 'off' }), { motion: 'off' });
    assert.throws(() => validatePatch({ font: 'x' }));
    assert.throws(() => validatePatch([]));
});

test('cypher string literals escape quotes and backslashes', () => {
    assert.equal(cypherString('a"b\\c'), '"a\\"b\\\\c"');
});

test('whole-set tasks are offered only for sets', () => {
    assert.equal(resolveBehaviour({ tasks: { t: { behaviour: 'whole-set' } } }, { id: 't' }), 'whole-set');
    const services = {
        'md-embeddings': {
            id: 'md-embeddings', consumers: ['a'], supported_formats: ['json'],
            tasks: { index: { behaviour: 'whole-set' }, embed: { supported_formats: ['txt'] } },
        },
    };
    const file = servicesForNode(services, { '@type': 'File', type: 'json', extension: 'json' }, undefined, {}, []);
    assert.equal(file.for_format.length, 0);
    const set = servicesForNode(services, { '@type': 'Set', types: ['json'], extensions: ['json'] }, undefined, {}, []);
    assert.deepEqual(Object.keys(set.for_format[0].tasks), ['index']);
});

test('resolveModel fills the chosen model from the descriptor', () => {
    const service = { models: { small: { dims: 384, version: '1' } } };
    const task: any = { id: 'embed', model: 'small' };
    resolveModel(service, task);
    assert.deepEqual(task.model, { dims: 384, version: '1', id: 'small' });
    const unknown: any = { id: 'embed', model: 'nope' };
    resolveModel(service, unknown);
    assert.equal(unknown.model, undefined);
    const llm: any = { model: { id: 'custom' } };
    resolveModel({ external_tasks: true, models: {} }, llm);
    assert.deepEqual(llm.model, { id: 'custom' });
});
