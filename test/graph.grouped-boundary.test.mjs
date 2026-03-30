import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';

function parseRidListFromInClause(query) {
    const match = query.match(/IN \[([^\]]+)\]/i);
    if (!match) return [];
    return match[1]
        .split(',')
        .map((part) => part.trim())
        .filter(Boolean);
}

function createMockSql({ filesBySetRid, nodesByRid, directEdges }) {
    return async function mockSql(query) {
        if (query.includes('MATCH {type:File, as:node, where:(set =')) {
            const setMatch = query.match(/set = "([^"]+)"/);
            const setRid = setMatch ? setMatch[1] : null;
            const files = filesBySetRid.get(setRid) || [];
            return { result: files.map((node) => ({ node })) };
        }

        if (query.includes('RETURN target.@rid AS target_rid, source.@rid AS source_rid')) {
            const setMatch = query.match(/set = "([^"]+)"/);
            const setRid = setMatch ? setMatch[1] : null;
            const files = filesBySetRid.get(setRid) || [];
            const fileRidSet = new Set(files.map((file) => file['@rid']));
            const result = [];

            for (const [targetRid, sourceRid] of directEdges.entries()) {
                if (!fileRidSet.has(targetRid)) continue;
                const source = nodesByRid.get(sourceRid) || {};
                result.push({
                    target_rid: targetRid,
                    source_rid: sourceRid,
                    source_label: source.label,
                    source_type: source.type,
                    source_path: source.path,
                    source_original_filename: source.original_filename,
                });
            }
            return { result };
        }

        if (query.startsWith('SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [')) {
            const targetRids = parseRidListFromInClause(query);
            const result = [];
            for (const targetRid of targetRids) {
                const sourceRid = directEdges.get(targetRid);
                if (sourceRid) {
                    result.push({ target_rid: targetRid, source_rid: sourceRid });
                }
            }
            return { result };
        }

        if (query.startsWith('SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN [')) {
            const sourceRids = parseRidListFromInClause(query);
            const result = [];
            for (const sourceRid of sourceRids) {
                const source = nodesByRid.get(sourceRid);
                if (!source) continue;
                result.push({
                    rid: sourceRid,
                    label: source.label,
                    type: source.type,
                    path: source.path,
                    original_filename: source.original_filename,
                });
            }
            return { result };
        }

        return { result: [] };
    };
}

describe('Graph grouped boundary set browsing', () => {
    it('groups multi-hop descendants by original PDF when group_boundary=pdf', async () => {
        const setRid = '#9:1';
        const originalPdfRid = '#1:1';
        const page1Rid = '#1:2';
        const page2Rid = '#1:3';
        const text1Rid = '#1:4';
        const text2Rid = '#1:5';
        const image1Rid = '#1:6';

        const nodesByRid = new Map([
            [originalPdfRid, { '@rid': originalPdfRid, label: 'book.pdf', type: 'pdf', path: 'data/messydesk/book.pdf', original_filename: 'book.pdf' }],
            [page1Rid, { '@rid': page1Rid, label: 'book_page_001.pdf', type: 'pdf', path: 'data/messydesk/page1.pdf' }],
            [page2Rid, { '@rid': page2Rid, label: 'book_page_002.pdf', type: 'pdf', path: 'data/messydesk/page2.pdf' }],
            [text1Rid, { '@rid': text1Rid, label: 'book_page_001.txt', type: 'text', path: 'data/messydesk/page1.txt' }],
            [text2Rid, { '@rid': text2Rid, label: 'book_page_002.txt', type: 'text', path: 'data/messydesk/page2.txt' }],
            [image1Rid, { '@rid': image1Rid, label: 'book_page_001.png', type: 'image', path: 'data/messydesk/page1.png' }],
        ]);

        const filesBySetRid = new Map([
            [setRid, [nodesByRid.get(text1Rid), nodesByRid.get(text2Rid), nodesByRid.get(image1Rid)]],
        ]);

        // child -> parent lineage: extracted files -> page pdf -> original pdf
        const directEdges = new Map([
            [text1Rid, page1Rid],
            [text2Rid, page2Rid],
            [image1Rid, page1Rid],
            [page1Rid, originalPdfRid],
            [page2Rid, originalPdfRid],
        ]);

        const originalSql = db.sql;
        const originalCypher = db.cypher;
        const originalHasAccess = Graph.hasAccess;

        db.sql = createMockSql({ filesBySetRid, nodesByRid, directEdges });
        db.cypher = async () => ({ result: [] });
        Graph.hasAccess = async () => true;

        try {
            const groupsResponse = await Graph.getSetFiles(setRid, '#2:1', {
                group_by_origin: true,
                group_boundary: 'pdf',
                thumbnails: false,
                skip: 0,
                limit: 10,
            });

            assert.equal(groupsResponse.mode, 'groups');
            assert.equal(groupsResponse.grouped, true);
            assert.equal(groupsResponse.group_boundary, 'pdf');
            assert.equal(groupsResponse.group_count, 1);
            assert.equal(groupsResponse.groups.length, 1);
            assert.equal(groupsResponse.groups[0].source_rid, originalPdfRid);
            assert.equal(groupsResponse.groups[0].label, 'book.pdf');
            assert.equal(groupsResponse.groups[0].file_count, 3);

            const childrenResponse = await Graph.getSetFiles(setRid, '#2:1', {
                group_by_origin: true,
                group_boundary: 'pdf',
                source_rid: originalPdfRid,
                thumbnails: false,
                skip: 0,
                limit: 10,
            });

            assert.equal(childrenResponse.mode, 'children');
            assert.equal(childrenResponse.grouped, true);
            assert.equal(childrenResponse.file_count, 3);
            assert.equal(childrenResponse.files.length, 3);

            const returnedRids = childrenResponse.files.map((file) => file['@rid']);
            assert.deepEqual(new Set(returnedRids), new Set([text1Rid, text2Rid, image1Rid]));
        } finally {
            db.sql = originalSql;
            db.cypher = originalCypher;
            Graph.hasAccess = originalHasAccess;
        }
    });

    it('uses batched DERIVED_FROM traversal shape instead of per-file source lookups', async () => {
        const setRid = '#9:2';
        const originalPdfRid = '#3:1';

        const files = [];
        const nodesByRid = new Map();
        const directEdges = new Map();

        for (let i = 0; i < 25; i++) {
            const pageRid = `#3:${100 + i}`;
            const textRid = `#3:${200 + i}`;

            const pageNode = {
                '@rid': pageRid,
                label: `big_page_${String(i + 1).padStart(3, '0')}.pdf`,
                type: 'pdf',
                path: `data/messydesk/page_${i + 1}.pdf`,
            };
            const textNode = {
                '@rid': textRid,
                label: `big_page_${String(i + 1).padStart(3, '0')}.txt`,
                type: 'text',
                path: `data/messydesk/page_${i + 1}.txt`,
            };

            nodesByRid.set(pageRid, pageNode);
            nodesByRid.set(textRid, textNode);
            files.push(textNode);

            directEdges.set(textRid, pageRid);
            directEdges.set(pageRid, originalPdfRid);
        }

        nodesByRid.set(originalPdfRid, {
            '@rid': originalPdfRid,
            label: 'big_original.pdf',
            type: 'pdf',
            path: 'data/messydesk/big_original.pdf',
            original_filename: 'big_original.pdf',
        });

        const filesBySetRid = new Map([[setRid, files]]);

        const originalSql = db.sql;
        const originalCypher = db.cypher;
        const originalHasAccess = Graph.hasAccess;

        const seenQueries = [];
        db.sql = async (query) => {
            seenQueries.push(query);
            return createMockSql({ filesBySetRid, nodesByRid, directEdges })(query);
        };
        db.cypher = async () => ({ result: [] });
        Graph.hasAccess = async () => true;

        try {
            const response = await Graph.getSetFiles(setRid, '#2:1', {
                group_by_origin: true,
                group_boundary: 'pdf',
                thumbnails: false,
                skip: 0,
                limit: 10,
            });

            assert.equal(response.group_count, 1);
            assert.equal(response.groups[0].source_rid, originalPdfRid);

            const perFileMatchQueries = seenQueries.filter((query) =>
                query.includes('MATCH {type:File, as:target, where:(@rid =')
            );
            assert.equal(perFileMatchQueries.length, 0, 'should not perform per-file source MATCH queries');

            const batchTraverseQueries = seenQueries.filter((query) =>
                query.startsWith('SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [')
            );
            assert.ok(batchTraverseQueries.length > 0, 'should use batched DERIVED_FROM traversal queries');
        } finally {
            db.sql = originalSql;
            db.cypher = originalCypher;
            Graph.hasAccess = originalHasAccess;
        }
    });
});
