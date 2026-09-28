import { strict as assert } from 'assert';
import path from 'path';
import fse from 'fs-extra';
import { Readable } from 'stream';

import filesRoutes from '../src/routes/files.mjs';
import Graph from '../src/graph.mjs';
import media from '../src/media.mjs';
import userManager from '../src/userManager.mjs';
import { DATA_DIR } from '../src/env.mjs';

function getRouteHandler(method, routePath) {
    const route = filesRoutes.find((item) => item.method === method && item.path === routePath);
    if (!route || typeof route.handler !== 'function') {
        throw new Error(`${method} ${routePath} route handler not found`);
    }
    return route.handler;
}

function makeUploadFile(filename, content) {
    const stream = new Readable();
    stream._read = () => {};
    stream.push(content);
    stream.push(null);
    stream.hapi = { filename };
    return stream;
}

describe('Files upload route (multi-file)', () => {
    const uploadHandler = getRouteHandler('POST', '/api/projects/{rid}/upload/{set?}');
    const testRoot = path.resolve(DATA_DIR, 'tests-upload-route');
    const projectRid = '#20:1';
    const userRid = '#49:0';

    let fileCounter = 0;
    let setTypes = [];
    let setAlreadyProcessed = false;

    let originalGetProjectMetadata;
    let originalSanitizeRID;
    let originalGetUserFileMetadata;
    let originalHasSetBeenProcessed;
    let originalCreateOriginalFileNode;
    let originalSetNodeAttribute;
    let originalDetectType;
    let originalGetTextDescription;
    let originalSendToUser;

    beforeEach(async () => {
        await fse.ensureDir(testRoot);
        fileCounter = 0;
        setTypes = [];
        setAlreadyProcessed = false;

        originalGetProjectMetadata = Graph.getProjectMetadata;
        originalSanitizeRID = Graph.sanitizeRID;
        originalGetUserFileMetadata = Graph.getUserFileMetadata;
        originalHasSetBeenProcessed = Graph.hasSetBeenProcessed;
        originalCreateOriginalFileNode = Graph.createOriginalFileNode;
        originalSetNodeAttribute = Graph.setNodeAttribute;
        originalDetectType = media.detectType;
        originalGetTextDescription = media.getTextDescription;
        originalSendToUser = userManager.sendToUser;

        Graph.getProjectMetadata = async () => ({ result: [{ project: { '@rid': projectRid } }] });
        Graph.sanitizeRID = (rid) => (String(rid).startsWith('#') ? String(rid) : `#${rid}`);
        Graph.getUserFileMetadata = async (rid) => ({
            '@rid': Graph.sanitizeRID(rid),
            '@type': 'Set',
            types: setTypes,
        });
        Graph.hasSetBeenProcessed = async () => setAlreadyProcessed;
        Graph.createOriginalFileNode = async (project_rid, file, file_type, setParam, dataDir, originalFilename) => {
            fileCounter += 1;
            return {
                '@rid': `#30:${fileCounter}`,
                type: file_type,
                path: path.join(testRoot, `file_${fileCounter}_${originalFilename}`),
                label: originalFilename,
                original_filename: originalFilename,
            };
        };
        Graph.setNodeAttribute = async () => true;

        media.detectType = async (file) => {
            const name = file.hapi.filename.toLowerCase();
            if (name.endsWith('.bin')) return null;
            return 'text';
        };
        media.getTextDescription = async () => ({ lines: 1, words: 1 });
        userManager.sendToUser = () => {};
    });

    afterEach(async () => {
        Graph.getProjectMetadata = originalGetProjectMetadata;
        Graph.sanitizeRID = originalSanitizeRID;
        Graph.getUserFileMetadata = originalGetUserFileMetadata;
        Graph.hasSetBeenProcessed = originalHasSetBeenProcessed;
        Graph.createOriginalFileNode = originalCreateOriginalFileNode;
        Graph.setNodeAttribute = originalSetNodeAttribute;
        media.detectType = originalDetectType;
        media.getTextDescription = originalGetTextDescription;
        userManager.sendToUser = originalSendToUser;
        await fse.remove(testRoot);
    });

    function buildRequest({ files, set }) {
        return {
            params: { rid: '20:1', set },
            payload: { file: files },
            query: {},
            auth: { credentials: { user: { rid: userRid, id: 'user-1' } } },
        };
    }

    it('uploads multiple files into a Set and writes each to disk', async () => {
        const files = [
            makeUploadFile('a.txt', 'hello a'),
            makeUploadFile('b.txt', 'hello b'),
        ];
        const response = await uploadHandler(buildRequest({ files, set: '77:1' }), {});

        assert.equal(response.total, 2);
        assert.equal(response.uploaded.length, 2);
        assert.equal(response.failed.length, 0);
        assert.equal(await fse.readFile(response.uploaded[0].path, 'utf8'), 'hello a');
        assert.equal(await fse.readFile(response.uploaded[1].path, 'utf8'), 'hello b');
    });

    it('rejects multiple files when no Set is targeted', async () => {
        const files = [
            makeUploadFile('a.txt', 'hello a'),
            makeUploadFile('b.txt', 'hello b'),
        ];

        await assert.rejects(
            () => uploadHandler(buildRequest({ files, set: undefined }), {}),
            (error) => {
                assert.equal(error.isBoom, true);
                assert.match(error.message, /only supported when uploading into a Set/);
                return true;
            }
        );
    });

    it('collects per-file failures without aborting the whole batch', async () => {
        const files = [
            makeUploadFile('a.txt', 'hello a'),
            makeUploadFile('bad.bin', 'unusable'),
        ];
        const response = await uploadHandler(buildRequest({ files, set: '77:1' }), {});

        assert.equal(response.total, 2);
        assert.equal(response.uploaded.length, 1);
        assert.equal(response.failed.length, 1);
        assert.equal(response.failed[0].filename, 'bad.bin');
        assert.match(response.failed[0].error, /Could not determine file type/);
    });

    it('blocks uploads whose type conflicts with the Set\'s existing type', async () => {
        setTypes = ['image'];
        const files = [makeUploadFile('a.txt', 'hello a')];

        await assert.rejects(
            () => uploadHandler(buildRequest({ files, set: '77:1' }), {}),
            (error) => {
                assert.equal(error.isBoom, true);
                assert.match(error.message, /Set accepts only image files/);
                return true;
            }
        );
    });

    it('blocks uploads into a Set that has already been processed by a cruncher', async () => {
        setAlreadyProcessed = true;
        const files = [makeUploadFile('a.txt', 'hello a')];

        await assert.rejects(
            () => uploadHandler(buildRequest({ files, set: '77:1' }), {}),
            (error) => {
                assert.equal(error.isBoom, true);
                assert.equal(error.output.statusCode, 409);
                assert.match(error.message, /already been processed/);
                return true;
            }
        );
    });

    it('still returns a single filegraph object for single-file uploads (backward compatibility)', async () => {
        const files = [makeUploadFile('a.txt', 'hello a')];
        const response = await uploadHandler(buildRequest({ files, set: '77:1' }), {});

        assert.equal(response.label, 'a.txt');
        assert.equal(response.type, 'text');
        assert.equal(await fse.readFile(response.path, 'utf8'), 'hello a');
    });
});
