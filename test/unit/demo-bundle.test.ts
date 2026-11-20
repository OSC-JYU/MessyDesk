import { test } from 'node:test';
import assert from 'node:assert/strict';
import fsp from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import yauzl from 'yauzl';
import { Decoder, Encoder, isSafeBundlePath } from '../../src/modules/demos/bundle.ts';
import { DemoImporter, uuidPathMapper } from '../../src/modules/demos/importer.ts';
import { DemoExporter, writeBundleZip } from '../../src/modules/demos/exporter.ts';
import { DataLayout } from '../../src/platform/storage/layout.ts';

test('encoder replaces rids and project paths, decoder restores them', () => {
    const ids = new Map([['#9:1', 'aaa'], ['#9:2', 'bbb']]);
    const encoder = new Encoder(ids, '/data/projects/9_1');
    const encoded = encoder.properties({
        '@rid': '#9:2', owner: '#1:1', label: '@odd', set: '#9:1', path: '/data/projects/9_1/files/x.png',
        metadata: { origin: '#9:2', list: ['#9:1', '#7:7'] }, active: true,
    });
    assert.deepEqual(encoded, {
        label: '@@odd', set: '@ref:aaa', path: '@project/files/x.png',
        metadata: { origin: '@ref:bbb', list: ['@ref:aaa', '#7:7'] }, active: true,
    });
    const rids = new Map([['aaa', '#20:5'], ['bbb', '#20:6']]);
    const decoded: any = new Decoder(rids, '/data/projects/20_4').value(encoded);
    assert.equal(decoded.label, '@odd');
    assert.equal(decoded.set, '#20:5');
    assert.equal(decoded.path, '/data/projects/20_4/files/x.png');
    assert.throws(() => new Decoder(new Map(), '/x').value('@ref:zzz'));
});

test('isSafeBundlePath refuses traversal and absolute paths', () => {
    assert.equal(isSafeBundlePath('files/a/b.png'), true);
    for (const bad of ['../x', 'files/../../x', '/etc/passwd', 'a\\b', '']) assert.equal(isSafeBundlePath(bad), false);
});

test('exports a desk with its graph and files into a zip', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'demo-export-'));
    try {
        const layout = new DataLayout(dataDir);
        const projectDir = layout.projectDir('#9:1');
        const filePath = path.join(projectDir, 'files', 'ab', 'f1.txt');
        await fsp.mkdir(path.dirname(filePath), { recursive: true });
        await fsp.writeFile(filePath, 'hello');

        const rows: Record<string, any> = {
            '#9:1': { '@rid': '#9:1', '@type': 'Project', label: 'Demo', uuid: 'p-uuid' },
            '#9:2': { '@rid': '#9:2', '@type': 'File', uuid: 'f-uuid', project_rid: '#9:1', path: filePath, _deleting: undefined },
            '#9:3': { '@rid': '#9:3', '@type': 'File', uuid: 'gone', _deleting: true },
        };
        const db: any = {
            firstByRid: async (_s: string, rid: string) => rows[rid] ?? null,
            traverse: async () => [rows['#9:1'], rows['#9:2'], rows['#9:3']],
            rows: async (sql: string) => (sql.includes('TagLink') ? [{ '@type': 'TagLink', entity_rid: '#5:1', target_rid: '#9:2', owner: '#1:1' }] : []),
            rowsByRids: async () => [{ '@rid': '#5:1', '@type': 'Entity', label: 'cat', owner: '#1:1' }],
            edgesOf: async () => [
                { rid: '#e:1', target: '#9:2', source: '#9:1', edge_type: 'BELONGS_TO' },
                { rid: '#e:2', target: '#9:1', source: '#1:1', edge_type: 'HAS_OWNER' },
            ],
        };
        const bundle = await new DemoExporter(db, layout, 'test').build('#9:1', { title: { en: 'Demo' }, description: {} });
        assert.equal(bundle.manifest.project, 'p-uuid');
        assert.deepEqual(bundle.files, ['files/ab/f1.txt']);
        assert.deepEqual(bundle.graph.nodes.map((n) => n.id).sort(), ['n0', 'f-uuid', 'p-uuid'].sort());
        const file = bundle.graph.nodes.find((n) => n.id === 'f-uuid')!;
        assert.equal(file.props.path, '@project/files/ab/f1.txt');
        assert.equal(file.props.project_rid, '@ref:p-uuid');
        assert.deepEqual(bundle.graph.edges, [{ type: 'BELONGS_TO', from: 'f-uuid', to: 'p-uuid', props: {} }]);
        assert.deepEqual(bundle.graph.documents, [{ type: 'TagLink', props: { entity_rid: '@ref:n0', target_rid: '@ref:f-uuid' } }]);

        const target = path.join(dataDir, 'out', 'demo.zip');
        await writeBundleZip(bundle, target);
        const names = await new Promise<string[]>((resolve, reject) => {
            yauzl.open(target, { lazyEntries: true }, (error, zip) => {
                if (error) return reject(error);
                const found: string[] = [];
                zip.on('entry', (entry) => { found.push(entry.fileName); zip.readEntry(); });
                zip.on('end', () => resolve(found));
                zip.readEntry();
            });
        });
        assert.deepEqual(names.sort(), ['files/files/ab/f1.txt', 'graph.json', 'manifest.json']);
    } finally {
        await fsp.rm(dataDir, { recursive: true, force: true });
    }
});

test('uuidPathMapper renames shard directories and file names', () => {
    const map = new Map([['aabbcc' + 'd'.repeat(26), '112233' + 'e'.repeat(26)]]);
    const old = 'aabbcc' + 'd'.repeat(26);
    const mapped = uuidPathMapper(map)(`files/aa/bb/cc/${old}/${old}.png`);
    assert.equal(mapped, `files/11/22/33/${'112233' + 'e'.repeat(26)}/${'112233' + 'e'.repeat(26)}.png`);
    assert.equal(uuidPathMapper(map)('sources/1/2/3'), 'sources/1/2/3');
});

test('imports a bundle with new rids, uuids and paths', async () => {
    const dataDir = await fsp.mkdtemp(path.join(os.tmpdir(), 'demo-import-'));
    try {
        const layout = new DataLayout(dataDir);
        const oldUuid = '0190aabb-ccdd-7eee-8fff-001122334455';
        const hex = oldUuid.replace(/-/g, '');
        const srcDir = path.join(dataDir, 'src');
        const rel = `files/${hex.slice(0, 2)}/${hex.slice(2, 4)}/${hex.slice(4, 6)}/${hex}/${hex}.txt`;
        await fsp.mkdir(path.dirname(path.join(srcDir, rel)), { recursive: true });
        await fsp.writeFile(path.join(srcDir, rel), 'hello');
        const bundle = {
            manifest: { format: 1, title: { en: 'Demo' }, description: {}, created: '', source: 't', project: 'p', files: 1 },
            graph: {
                nodes: [
                    { id: 'p', type: 'Project', props: { label: 'Demo', uuid: 'pu' } },
                    { id: oldUuid, type: 'File', props: { uuid: oldUuid, label: 'f.txt', project_rid: '@ref:p', path: `@project/${rel}` } },
                    { id: 'n0', type: 'Entity', props: { label: 'cat', type: 'animal' } },
                ],
                edges: [{ type: 'BELONGS_TO', from: oldUuid, to: 'p', props: {} }],
                documents: [{ type: 'TagLink', props: { entity_rid: '@ref:n0', target_rid: `@ref:${oldUuid}` } }],
            },
            projectDir: srcDir,
            files: [rel],
        };
        const zip = path.join(dataDir, 'demo.zip');
        await writeBundleZip(bundle, zip);

        let counter = 0;
        const sql: Array<[string, any]> = [];
        const attrs: Record<string, any> = {};
        const created: Record<string, any> = {};
        const db: any = { first: async () => null, sql: async (q: string, p: any) => { sql.push([q, p]); } };
        const store: any = {
            createVertexRaw: async (type: string, content: any) => { const rid = `#20:${++counter}`; created[rid] = { type, content }; return { '@rid': rid, ...content }; },
            setAttributes: async (rid: string, patch: any) => { attrs[rid] = patch; },
        };
        const projects: any = { create: async (data: any) => ({ '@rid': '#10:1', ...data }) };
        const synced: string[] = [];
        const result = await new DemoImporter(db, store, layout, projects, { syncSetManifest: async (r) => { synced.push(r); } })
            .import({ zipFile: zip, userRid: '#1:1', source: 'demo@1' });

        assert.equal(result.project.demo_source, 'demo@1');
        assert.equal(result.files, 1);
        const [fileRid] = Object.keys(created).filter((r) => created[r].type === 'File');
        const newUuid = created[fileRid].content.uuid;
        assert.notEqual(newUuid, oldUuid);
        const newHex = newUuid.replace(/-/g, '');
        const expected = path.join(layout.projectDir('#10:1'), `files/${newHex.slice(0, 2)}/${newHex.slice(2, 4)}/${newHex.slice(4, 6)}/${newHex}/${newHex}.txt`);
        assert.equal(attrs[fileRid].path, expected);
        assert.equal(attrs[fileRid].project_rid, '#10:1');
        assert.equal(await fsp.readFile(expected, 'utf8'), 'hello');
        const edge = sql.find(([q]) => q.startsWith('CREATE EDGE BELONGS_TO'))!;
        assert.match(edge[0], new RegExp(`FROM ${fileRid} TO #10:1`));
        const tag = sql.find(([q]) => q.startsWith('INSERT INTO TagLink'))![1].props;
        assert.equal(tag.target_rid, fileRid);
        assert.equal(tag.owner, '#1:1');
        assert.equal(tag.project_rid, '#10:1');
    } finally {
        await fsp.rm(dataDir, { recursive: true, force: true });
    }
});
