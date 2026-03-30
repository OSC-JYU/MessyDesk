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

describe('Graph.groupFilesByRootSource', () => {
    it('groups descendants by highest PDF ancestor while skipping ZIP roots', async () => {
        const text1Rid = '#10:1';
        const text2Rid = '#10:2';
        const page1Rid = '#10:3';
        const page2Rid = '#10:4';
        const zipRid = '#10:5';
        const originalPdfRid = '#10:6';

        const nodes = new Map([
            [text1Rid, { rid: text1Rid, label: 'p1.txt', type: 'text', path: 'data/messydesk/p1.txt' }],
            [text2Rid, { rid: text2Rid, label: 'p2.txt', type: 'text', path: 'data/messydesk/p2.txt' }],
            [page1Rid, { rid: page1Rid, label: 'p1.pdf', type: 'pdf', path: 'data/messydesk/p1.pdf' }],
            [page2Rid, { rid: page2Rid, label: 'p2.pdf', type: 'pdf', path: 'data/messydesk/p2.pdf' }],
            [zipRid, { rid: zipRid, label: 'archive.zip', type: 'zip', path: 'data/messydesk/a.zip' }],
            [originalPdfRid, { rid: originalPdfRid, label: 'book.pdf', type: 'pdf', path: 'data/messydesk/book.pdf', original_filename: 'book.pdf' }],
        ]);

        const edges = new Map([
            [text1Rid, page1Rid],
            [text2Rid, page2Rid],
            [page1Rid, zipRid],
            [page2Rid, originalPdfRid],
            [zipRid, originalPdfRid],
        ]);

        const originalSql = db.sql;
        db.sql = async (query) => {
            if (query.startsWith('SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [')) {
                const targetRids = parseRidListFromInClause(query);
                const result = [];
                for (const targetRid of targetRids) {
                    const sourceRid = edges.get(targetRid);
                    if (sourceRid) result.push({ target_rid: targetRid, source_rid: sourceRid });
                }
                return { result };
            }

            if (query.startsWith('SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN [')) {
                const rids = parseRidListFromInClause(query);
                const result = [];
                for (const rid of rids) {
                    const node = nodes.get(rid);
                    if (!node) continue;
                    result.push({
                        rid,
                        label: node.label,
                        type: node.type,
                        path: node.path,
                        original_filename: node.original_filename,
                    });
                }
                return { result };
            }

            return { result: [] };
        };

        try {
            const groups = await Graph.groupFilesByRootSource([
                { '@rid': text1Rid, label: 'p1.txt', type: 'text', path: 'data/messydesk/p1.txt' },
                { '@rid': text2Rid, label: 'p2.txt', type: 'text', path: 'data/messydesk/p2.txt' },
            ], {
                boundary: 'pdf',
                excludeRootTypes: ['zip'],
            });

            assert.equal(groups.length, 1);
            assert.equal(groups[0].source_rid, originalPdfRid);
            assert.equal(groups[0].label, 'book.pdf');
            assert.equal(groups[0].files.length, 2);
        } finally {
            db.sql = originalSql;
        }
    });

    it('falls back to highest non-excluded ancestor when no PDF exists', async () => {
        const csvRid = '#20:1';
        const txtRid = '#20:2';
        const rootTxtRid = '#20:3';

        const nodes = new Map([
            [csvRid, { rid: csvRid, label: 'part.csv', type: 'csv', path: 'data/messydesk/part.csv' }],
            [txtRid, { rid: txtRid, label: 'part.txt', type: 'text', path: 'data/messydesk/part.txt' }],
            [rootTxtRid, { rid: rootTxtRid, label: 'root.txt', type: 'text', path: 'data/messydesk/root.txt' }],
        ]);

        const edges = new Map([
            [csvRid, txtRid],
            [txtRid, rootTxtRid],
        ]);

        const originalSql = db.sql;
        db.sql = async (query) => {
            if (query.startsWith('SELECT @out AS target_rid, @in AS source_rid FROM DERIVED_FROM WHERE @out IN [')) {
                const targetRids = parseRidListFromInClause(query);
                const result = [];
                for (const targetRid of targetRids) {
                    const sourceRid = edges.get(targetRid);
                    if (sourceRid) result.push({ target_rid: targetRid, source_rid: sourceRid });
                }
                return { result };
            }

            if (query.startsWith('SELECT @rid AS rid, label, type, path, original_filename FROM File WHERE @rid IN [')) {
                const rids = parseRidListFromInClause(query);
                const result = [];
                for (const rid of rids) {
                    const node = nodes.get(rid);
                    if (!node) continue;
                    result.push({
                        rid,
                        label: node.label,
                        type: node.type,
                        path: node.path,
                        original_filename: node.original_filename,
                    });
                }
                return { result };
            }

            return { result: [] };
        };

        try {
            const groups = await Graph.groupFilesByRootSource([
                { '@rid': csvRid, label: 'part.csv', type: 'csv', path: 'data/messydesk/part.csv' },
            ], {
                boundary: 'pdf',
                excludeRootTypes: ['zip'],
            });

            assert.equal(groups.length, 1);
            assert.equal(groups[0].source_rid, rootTxtRid);
            assert.equal(groups[0].label, 'root.txt');
            assert.equal(groups[0].files.length, 1);
        } finally {
            db.sql = originalSql;
        }
    });
});
