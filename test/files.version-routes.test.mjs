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

function createH() {
    return {
        response(payload) {
            return {
                payload,
                statusCode: 200,
                code(nextStatusCode) {
                    this.statusCode = nextStatusCode;
                    return this;
                },
                header() {
                    return this;
                },
                type() {
                    return this;
                },
            };
        },
    };
}

describe('Files version/revert routes', () => {
    const versionHandler = getRouteHandler('POST', '/api/files/{file_rid}/version');
    const revertHandler = getRouteHandler('POST', '/api/files/{file_rid}/revert');

    const testRoot = path.resolve(DATA_DIR, 'tests-version-routes');
    const testFilePath = path.join(testRoot, 'sample.txt');
    const testFileRid = '#12:34';
    const userRid = '#49:0';

    let currentFileType = 'text';
    const setNodeAttributeCalls = [];
    const sendToUserCalls = [];

    let originalSanitizeRID;
    let originalGetUserFileMetadata;
    let originalSetNodeAttribute;
    let originalGetTextDescription;
    let originalSendToUser;

    beforeEach(async () => {
        await fse.ensureDir(testRoot);
        await fse.writeFile(testFilePath, 'original-content', 'utf8');

        currentFileType = 'text';
        setNodeAttributeCalls.length = 0;
        sendToUserCalls.length = 0;

        originalSanitizeRID = Graph.sanitizeRID;
        originalGetUserFileMetadata = Graph.getUserFileMetadata;
        originalSetNodeAttribute = Graph.setNodeAttribute;
        originalGetTextDescription = media.getTextDescription;
        originalSendToUser = userManager.sendToUser;

        Graph.sanitizeRID = (rid) => (String(rid).startsWith('#') ? String(rid) : `#${rid}`);
        Graph.getUserFileMetadata = async (rid) => ({
            '@rid': Graph.sanitizeRID(rid),
            '@type': 'File',
            type: currentFileType,
            path: testFilePath,
            label: 'sample.txt',
            metadata: {},
        });

        Graph.setNodeAttribute = async (rid, payload) => {
            setNodeAttributeCalls.push({ rid, payload });
            return true;
        };


        media.getTextDescription = async () => ({ lines: 1, words: 1 });
        userManager.sendToUser = (rid, payload) => {
            sendToUserCalls.push({ rid, payload });
        };
    });

    afterEach(async () => {
        Graph.sanitizeRID = originalSanitizeRID;
        Graph.getUserFileMetadata = originalGetUserFileMetadata;
        Graph.setNodeAttribute = originalSetNodeAttribute;
        media.getTextDescription = originalGetTextDescription;
        userManager.sendToUser = originalSendToUser;

        await fse.remove(testRoot);
    });

    it('creates a text edited version and stores backup/origin metadata', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: { content: 'updated-content' },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        const response = await versionHandler(request, createH());

        assert.equal(response.statusCode, 200);
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'updated-content');
        assert.equal(await fse.readFile(`${testFilePath}.original`, 'utf8'), 'original-content');

        const editedCall = setNodeAttributeCalls.find((entry) => entry.payload?.key === 'edited');
        assert.ok(editedCall, 'edited metadata should be written');
        assert.equal(editedCall.rid, testFileRid);
        assert.equal(editedCall.payload.value.task, 'text-edit');
        assert.equal(editedCall.payload.value.user, userRid);

        const wsUpdate = sendToUserCalls.find((entry) => entry.payload?.command === 'update');
        assert.ok(wsUpdate, 'websocket update should be sent');
        assert.equal(wsUpdate.payload.target, testFileRid);
    });

    it('rejects content payload for non-text files', async () => {
        currentFileType = 'image';
        const request = {
            params: { file_rid: '12:34' },
            payload: { content: 'should-fail' },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => versionHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 400);
                assert.equal(error?.message, 'Content payload is only supported for text-like files');
                return true;
            }
        );
    });

    it('rejects mixed payload with both upload and content', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: {
                content: 'text',
                file: { pipe: () => {} },
            },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => versionHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 400);
                assert.equal(error?.message, 'Provide either file upload or content payload, not both');
                return true;
            }
        );
    });

    it('rejects missing content for text-like files', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: {},
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => versionHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 400);
                assert.equal(error?.message, 'Missing edited file upload or content payload');
                return true;
            }
        );
    });

    it('accepts streamed JSON payload with content', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: Readable.from([Buffer.from('{"content":"streamed-content"}')]),
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        const response = await versionHandler(request, createH());
        assert.equal(response.statusCode, 200);
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'streamed-content');
        assert.equal(await fse.readFile(`${testFilePath}.original`, 'utf8'), 'original-content');
    });

    it('keeps first backup unchanged across multiple quick edits', async () => {
        const firstEdit = {
            params: { file_rid: '12:34' },
            payload: { content: 'first-edit' },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        const secondEdit = {
            params: { file_rid: '12:34' },
            payload: { content: 'second-edit' },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await versionHandler(firstEdit, createH());
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'first-edit');
        assert.equal(await fse.readFile(`${testFilePath}.original`, 'utf8'), 'original-content');

        await versionHandler(secondEdit, createH());
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'second-edit');
        assert.equal(await fse.readFile(`${testFilePath}.original`, 'utf8'), 'original-content');

        const revertRequest = {
            params: { file_rid: '12:34' },
            auth: { credentials: { user: { rid: userRid } } },
        };

        await revertHandler(revertRequest, createH());
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'original-content');
    });

    it('rejects content field with upload payload', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: {
                content: null,
                file: { pipe: () => {} },
            },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => versionHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 400);
                assert.equal(error?.message, 'Provide either file upload or content payload, not both');
                return true;
            }
        );
    });

    it('rejects oversized text payload', async () => {
        const request = {
            params: { file_rid: '12:34' },
            payload: { content: 'a'.repeat(10 * 1024 * 1024 + 1) },
            query: {},
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => versionHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 400);
                assert.equal(error?.message, 'Text payload exceeds size limit');
                return true;
            }
        );
    });

    it('reverts edited version back to original content', async () => {
        await fse.writeFile(testFilePath, 'edited-content', 'utf8');
        await fse.writeFile(`${testFilePath}.original`, 'original-content', 'utf8');

        const request = {
            params: { file_rid: '12:34' },
            auth: { credentials: { user: { rid: userRid } } },
        };

        const response = await revertHandler(request, createH());

        assert.equal(response.statusCode, 200);
        assert.equal(await fse.readFile(testFilePath, 'utf8'), 'original-content');
        assert.equal(await fse.pathExists(`${testFilePath}.original`), false);

        const editedClearCall = setNodeAttributeCalls.find((entry) => entry.payload?.key === 'edited');
        assert.ok(editedClearCall, 'edited metadata should be cleared on revert');
        assert.equal(editedClearCall.payload.value, null);
    });

    it('returns conflict when reverting without backup', async () => {
        const request = {
            params: { file_rid: '12:34' },
            auth: { credentials: { user: { rid: userRid } } },
        };

        await assert.rejects(
            () => revertHandler(request, createH()),
            (error) => {
                assert.equal(error?.output?.statusCode, 409);
                assert.equal(error?.message, 'No original version exists to revert');
                return true;
            }
        );
    });

});
