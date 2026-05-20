import { strict as assert } from 'assert';

import Graph from '../src/graph.mjs';
import db from '../src/db.mjs';
import media from '../src/media.mjs';

describe('Graph.createTagFilterSet', () => {
    it('creates reference outputs with OR matching', async () => {
        const originalGetNodeAttributes = Graph.getNodeAttributes;
        const originalGetProjectRidForNode = Graph.getProjectRidForNode;
        const originalCreate = Graph.create;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalCreateReferenceFileNode = Graph.createReferenceFileNode;
        const originalSyncSetManifest = Graph.syncSetManifest;
        const originalCreateProcessDir = media.createProcessDir;
        const originalSql = db.sql;

        const createdReferences = [];
        const createdTypes = [];

        Graph.getNodeAttributes = async () => ({ '@rid': '#12:1', '@type': 'Set', project_rid: '#2:1' });
        Graph.getProjectRidForNode = async () => '#2:1';
        Graph.create = async (type) => {
            createdTypes.push(type);
            if (type === 'SetProcess') return { '@rid': '#90:1' };
            if (type === 'Set') return { '@rid': '#91:1' };
            return { '@rid': '#99:1' };
        };
        Graph.setNodeAttribute_old = async () => ({ result: 'ok' });
        Graph.connectDerivedFrom = async () => ({ result: 'ok' });
        Graph.createReferenceFileNode = async (processRid, message, refFileRid) => {
            createdReferences.push({ processRid, message, refFileRid });
            return { '@rid': '#100:1' };
        };
        Graph.syncSetManifest = async () => null;
        media.createProcessDir = async () => null;

        db.sql = async (query) => {
            if (query.includes('RETURN count(file) as count')) {
                return { result: [{ count: 3 }] };
            }
            if (query.startsWith('SELECT @rid AS rid FROM File WHERE set = "#12:1"')) {
                return { result: [{ rid: '#50:1' }, { rid: '#50:2' }, { rid: '#50:3' }] };
            }
            if (query.includes('FROM Entity WHERE owner')) {
                return { result: [{ rid: '#31:2', label: 'Alice' }, { rid: '#31:7', label: 'Helsinki' }] };
            }
            if (query.includes('MATCH {type:File, as:file, where:(set = "#12:1")}-HAS_ENTITY')) {
                return {
                    result: [
                        { file_rid: '#50:1', entity_rid: '#31:2' },
                        { file_rid: '#50:2', entity_rid: '#31:7' },
                        { file_rid: '#50:3', entity_rid: '#31:2' },
                    ],
                };
            }
            if (query.startsWith('SELECT @rid, project_rid, type, extension, label, info FROM File WHERE @rid IN [')) {
                return {
                    result: [
                        { '@rid': '#50:1', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'a.jpg', info: 'a' },
                        { '@rid': '#50:2', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'b.jpg', info: 'b' },
                        { '@rid': '#50:3', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'c.jpg', info: 'c' },
                    ],
                };
            }
            return { result: [] };
        };

        try {
            const result = await Graph.createTagFilterSet('#12:1', '#2:99', {
                selected_entity_rids: ['#31:2', '#31:7'],
                match: 'or',
                set_label: 'People or place',
            });

            assert.equal(result.match, 'or');
            assert.equal(result.matched_files, 3);
            assert.equal(createdReferences.length, 3);
            assert.ok(createdTypes.includes('SetProcess'));
            assert.ok(createdTypes.includes('Set'));
        } finally {
            Graph.getNodeAttributes = originalGetNodeAttributes;
            Graph.getProjectRidForNode = originalGetProjectRidForNode;
            Graph.create = originalCreate;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.createReferenceFileNode = originalCreateReferenceFileNode;
            Graph.syncSetManifest = originalSyncSetManifest;
            media.createProcessDir = originalCreateProcessDir;
            db.sql = originalSql;
        }
    });

    it('creates reference outputs with AND matching', async () => {
        const originalGetNodeAttributes = Graph.getNodeAttributes;
        const originalGetProjectRidForNode = Graph.getProjectRidForNode;
        const originalCreate = Graph.create;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalCreateReferenceFileNode = Graph.createReferenceFileNode;
        const originalSyncSetManifest = Graph.syncSetManifest;
        const originalCreateProcessDir = media.createProcessDir;
        const originalSql = db.sql;

        const createdReferences = [];

        Graph.getNodeAttributes = async () => ({ '@rid': '#12:1', '@type': 'Set', project_rid: '#2:1' });
        Graph.getProjectRidForNode = async () => '#2:1';
        Graph.create = async (type) => {
            if (type === 'SetProcess') return { '@rid': '#90:1' };
            if (type === 'Set') return { '@rid': '#91:1' };
            return { '@rid': '#99:1' };
        };
        Graph.setNodeAttribute_old = async () => ({ result: 'ok' });
        Graph.connectDerivedFrom = async () => ({ result: 'ok' });
        Graph.createReferenceFileNode = async (processRid, message, refFileRid) => {
            createdReferences.push({ processRid, message, refFileRid });
            return { '@rid': '#100:1' };
        };
        Graph.syncSetManifest = async () => null;
        media.createProcessDir = async () => null;

        db.sql = async (query) => {
            if (query.includes('RETURN count(file) as count')) {
                return { result: [{ count: 1 }] };
            }
            if (query.startsWith('SELECT @rid AS rid FROM File WHERE set = "#12:1"')) {
                return { result: [{ rid: '#50:1' }, { rid: '#50:2' }, { rid: '#50:3' }] };
            }
            if (query.includes('FROM Entity WHERE owner')) {
                return { result: [{ rid: '#31:2', label: 'Alice' }, { rid: '#31:7', label: 'Helsinki' }] };
            }
            if (query.includes('MATCH {type:File, as:file, where:(set = "#12:1")}-HAS_ENTITY')) {
                return {
                    result: [
                        { file_rid: '#50:1', entity_rid: '#31:2' },
                        { file_rid: '#50:1', entity_rid: '#31:7' },
                        { file_rid: '#50:2', entity_rid: '#31:2' },
                    ],
                };
            }
            if (query.startsWith('SELECT @rid, project_rid, type, extension, label, info FROM File WHERE @rid IN [')) {
                return {
                    result: [
                        { '@rid': '#50:1', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'a.jpg', info: 'a' },
                    ],
                };
            }
            return { result: [] };
        };

        try {
            const result = await Graph.createTagFilterSet('#12:1', '#2:99', {
                selected_entity_rids: ['#31:2', '#31:7'],
                match: 'and',
            });

            assert.equal(result.match, 'and');
            assert.equal(result.matched_files, 1);
            assert.equal(createdReferences.length, 1);
            assert.equal(createdReferences[0].refFileRid, '#50:1');
        } finally {
            Graph.getNodeAttributes = originalGetNodeAttributes;
            Graph.getProjectRidForNode = originalGetProjectRidForNode;
            Graph.create = originalCreate;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.createReferenceFileNode = originalCreateReferenceFileNode;
            Graph.syncSetManifest = originalSyncSetManifest;
            media.createProcessDir = originalCreateProcessDir;
            db.sql = originalSql;
        }
    });

    it('creates reference outputs for negative tags (exclude mode)', async () => {
        const originalGetNodeAttributes = Graph.getNodeAttributes;
        const originalGetProjectRidForNode = Graph.getProjectRidForNode;
        const originalCreate = Graph.create;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalCreateReferenceFileNode = Graph.createReferenceFileNode;
        const originalSyncSetManifest = Graph.syncSetManifest;
        const originalCreateProcessDir = media.createProcessDir;
        const originalSql = db.sql;

        const createdReferences = [];

        Graph.getNodeAttributes = async () => ({ '@rid': '#12:1', '@type': 'Set', project_rid: '#2:1' });
        Graph.getProjectRidForNode = async () => '#2:1';
        Graph.create = async (type) => {
            if (type === 'SetProcess') return { '@rid': '#90:1' };
            if (type === 'Set') return { '@rid': '#91:1' };
            return { '@rid': '#99:1' };
        };
        Graph.setNodeAttribute_old = async () => ({ result: 'ok' });
        Graph.connectDerivedFrom = async () => ({ result: 'ok' });
        Graph.createReferenceFileNode = async (processRid, message, refFileRid) => {
            createdReferences.push({ processRid, message, refFileRid });
            return { '@rid': '#100:1' };
        };
        Graph.syncSetManifest = async () => null;
        media.createProcessDir = async () => null;

        db.sql = async (query) => {
            if (query.includes('RETURN count(file) as count')) {
                return { result: [{ count: 2 }] };
            }
            if (query.startsWith('SELECT @rid AS rid FROM File WHERE set = "#12:1"')) {
                return { result: [{ rid: '#50:1' }, { rid: '#50:2' }, { rid: '#50:3' }] };
            }
            if (query.includes('FROM Entity WHERE owner')) {
                return { result: [{ rid: '#31:2', label: 'Alice' }] };
            }
            if (query.includes('MATCH {type:File, as:file, where:(set = "#12:1")}-HAS_ENTITY->{type:Entity')) {
                return {
                    result: [
                        { file_rid: '#50:1', entity_rid: '#31:2' },
                    ],
                };
            }
            if (query.startsWith('SELECT @rid, project_rid, type, extension, label, info FROM File WHERE @rid IN [')) {
                return {
                    result: [
                        { '@rid': '#50:2', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'b.jpg', info: 'b' },
                        { '@rid': '#50:3', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'c.jpg', info: 'c' },
                    ],
                };
            }
            return { result: [] };
        };

        try {
            const result = await Graph.createTagFilterSet('#12:1', '#2:99', {
                selected_entity_rids: ['#31:2'],
                selection_mode: 'exclude',
            });

            assert.equal(result.selection_mode, 'exclude');
            assert.equal(result.matched_files, 2);
            assert.equal(createdReferences.length, 2);
        } finally {
            Graph.getNodeAttributes = originalGetNodeAttributes;
            Graph.getProjectRidForNode = originalGetProjectRidForNode;
            Graph.create = originalCreate;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.createReferenceFileNode = originalCreateReferenceFileNode;
            Graph.syncSetManifest = originalSyncSetManifest;
            media.createProcessDir = originalCreateProcessDir;
            db.sql = originalSql;
        }
    });

    it('creates reference outputs for untagged files', async () => {
        const originalGetNodeAttributes = Graph.getNodeAttributes;
        const originalGetProjectRidForNode = Graph.getProjectRidForNode;
        const originalCreate = Graph.create;
        const originalSetNodeAttributeOld = Graph.setNodeAttribute_old;
        const originalConnectDerivedFrom = Graph.connectDerivedFrom;
        const originalCreateReferenceFileNode = Graph.createReferenceFileNode;
        const originalSyncSetManifest = Graph.syncSetManifest;
        const originalCreateProcessDir = media.createProcessDir;
        const originalSql = db.sql;

        const createdReferences = [];

        Graph.getNodeAttributes = async () => ({ '@rid': '#12:1', '@type': 'Set', project_rid: '#2:1' });
        Graph.getProjectRidForNode = async () => '#2:1';
        Graph.create = async (type) => {
            if (type === 'SetProcess') return { '@rid': '#90:1' };
            if (type === 'Set') return { '@rid': '#91:1' };
            return { '@rid': '#99:1' };
        };
        Graph.setNodeAttribute_old = async () => ({ result: 'ok' });
        Graph.connectDerivedFrom = async () => ({ result: 'ok' });
        Graph.createReferenceFileNode = async (processRid, message, refFileRid) => {
            createdReferences.push({ processRid, message, refFileRid });
            return { '@rid': '#100:1' };
        };
        Graph.syncSetManifest = async () => null;
        media.createProcessDir = async () => null;

        db.sql = async (query) => {
            if (query.includes('RETURN count(file) as count')) {
                return { result: [{ count: 1 }] };
            }
            if (query.startsWith('SELECT @rid AS rid FROM File WHERE set = "#12:1"')) {
                return { result: [{ rid: '#50:1' }, { rid: '#50:2' }, { rid: '#50:3' }] };
            }
            if (query.includes('MATCH {type:File, as:file, where:(set = "#12:1")}-HAS_ENTITY->{type:Entity, as:entity, where:(owner = "#2:99")}')) {
                return { result: [{ file_rid: '#50:1' }, { file_rid: '#50:3' }] };
            }
            if (query.startsWith('SELECT @rid, project_rid, type, extension, label, info FROM File WHERE @rid IN [')) {
                return {
                    result: [
                        { '@rid': '#50:2', project_rid: '#2:1', type: 'image', extension: 'jpg', label: 'b.jpg', info: 'b' },
                    ],
                };
            }
            return { result: [] };
        };

        try {
            const result = await Graph.createTagFilterSet('#12:1', '#2:99', {
                selection_mode: 'untagged',
            });

            assert.equal(result.selection_mode, 'untagged');
            assert.equal(result.matched_files, 1);
            assert.equal(createdReferences.length, 1);
            assert.equal(createdReferences[0].refFileRid, '#50:2');
        } finally {
            Graph.getNodeAttributes = originalGetNodeAttributes;
            Graph.getProjectRidForNode = originalGetProjectRidForNode;
            Graph.create = originalCreate;
            Graph.setNodeAttribute_old = originalSetNodeAttributeOld;
            Graph.connectDerivedFrom = originalConnectDerivedFrom;
            Graph.createReferenceFileNode = originalCreateReferenceFileNode;
            Graph.syncSetManifest = originalSyncSetManifest;
            media.createProcessDir = originalCreateProcessDir;
            db.sql = originalSql;
        }
    });
});
