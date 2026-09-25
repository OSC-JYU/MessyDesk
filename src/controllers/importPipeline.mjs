import Graph from '../graph.mjs';
import media from '../media.mjs';
import queue from '../queue.mjs';
import services from '../services.mjs';
import userManager from '../userManager.mjs';
import { DATA_DIR } from '../env.mjs';
import path from 'path';

/**
 * Handles post-creation logic for uploaded/extracted files.
 * For PDFs: triggers automatic split via md-pypdf_fs if the splitter is active.
 *
 * @param {object} fileNode - The created File graph node
 * @param {object} options
 * @param {string} options.userId - User RID for SSE notifications
 * @param {boolean} [options.delete_original=true] - Whether to delete the source PDF after split
 * @returns {object|null} The process node if split was queued, null otherwise
 */
export async function afterFileCreated(fileNode, options = {}) {
    if (!fileNode || fileNode.type !== 'pdf') {
        return null;
    }

    const { userId, delete_original = true } = options;

    // Check if splitter is available
    if (!services.hasActiveConsumer('md-pypdf_fs')) {
        // Splitter unavailable — mark as unprocessable (for ZIP extraction path)
        await Graph.setNodeAttribute_old(fileNode['@rid'], { key: 'processable', value: false }, 'File');
        return null;
    }

    // Get the splitter service descriptor for task metadata
    const splitterService = services.service_list['md-pypdf_fs'];
    const splitTask = splitterService.tasks?.split;
    if (!splitTask) {
        console.error('md-pypdf_fs split task not found in service descriptor');
        return null;
    }

    // Build the queue message following the same pattern as createQueueMessages
    const msg = {
        service: { id: 'md-pypdf_fs', name: splitterService.name || 'PyPDF' },
        task: {
            id: 'split',
            name: splitTask.name || 'Split PDF to pages',
            description: splitTask.description,
            params: splitTask.params || { task: 'split' }
        },
        file: fileNode,
        process: null,
        output_set: null,
        userId: userId,
        role: 'import',
        delete_original: delete_original
    };

    // Create Process node
    msg.process = await Graph.createProcessNode_queue(msg);
    await media.createProcessDir(msg.process.path);

    // Set role on the Process node for UI differentiation
    await Graph.setNodeAttribute_old(msg.process['@rid'], { key: 'role', value: 'import' }, 'Process');
    await Graph.setNodeAttribute_old(msg.process['@rid'], { key: 'status', value: 'running' }, 'Process');

    // Create output Set for split pages
    const originalFilename = fileNode.original_filename || fileNode.label || 'PDF';
    const setLabel = `${originalFilename} — PDF pages`;
    const setNode = await Graph.createOutputSetNode(setLabel, msg.process);
    msg.output_set = setNode['@rid'];
    msg.set_node = setNode;

    // Store delete_original flag on process node so processFilesController can act on it
    if (delete_original) {
        await Graph.setNodeAttribute_old(msg.process['@rid'], { key: 'delete_original', value: true }, 'Process');
    }

    // Store the total_files as unknown for now (splitter will report)
    await media.writeJSON(msg, 'message.json', path.dirname(msg.process.path));

    // Publish split job to queue
    queue.publish('md-pypdf_fs', JSON.stringify(msg));

    // Set importing status on the file node
    await Graph.setNodeAttribute_old(fileNode['@rid'], { key: '_status', value: 'importing' }, 'File');

    // Notify UI about the import process starting
    if (userId) {
        const wsdata = {
            command: 'add',
            type: 'process',
            input: fileNode['@rid'],
            node: msg.process,
            output: setNode,
            role: 'import'
        };
        userManager.sendToUser(userId, wsdata);
    }

    return msg.process;
}
