// Which services, tasks and filters to offer for a node (GET /api/services/files/{rid}).

import fsp from 'node:fs/promises';
import path from 'node:path';
import { ALLOWED_CATEGORIES, resolveBehaviour } from './registry.ts';
import { SERVICE } from '../../shared/service-ids.ts';

function filterTask(filter: string | undefined, task: any): boolean {
    if (filter) return Boolean(task.filter && task.filter === filter);
    return !task.filter;
}

function pickModels(type: string, extensions: string[], service: any): Record<string, any> {
    const models: Record<string, any> = {};
    for (const [id, model] of Object.entries<any>(service.models || {})) {
        if ((model.supported_formats || []).some((f: string) => extensions.includes(f))) {
            if ((model.supported_types || []).includes(type) || type === 'Set') models[id] = model;
        }
    }
    return models;
}

/** LLM services take their tasks from the user's prompts. */
function promptsToTasks(filter: string | undefined, prompts: any[], type: string, extensions: string[]): Record<string, any> {
    const tasks: Record<string, any> = {};
    if (filter) return tasks;
    for (const prompt of prompts) {
        prompt.system_params = { prompts: { content: prompt.content } };
        const key = String(prompt.name).toLowerCase().replace(/ /g, '_');
        if (type === 'Set') {
            if ((extensions.includes('txt') && prompt.type === 'text')
                || (extensions.includes('pdf') && prompt.type === 'pdf')
                || ((extensions.includes('jpg') || extensions.includes('png')) && prompt.type === 'image')) tasks[key] = prompt;
        } else if (type === prompt.type) {
            tasks[key] = prompt;
        }
    }
    return tasks;
}

function pickTasks(service: any, extensions: string[], types: string[], filter: string | undefined, user: any, prompts: any[], nodeType: string): any {
    const out = structuredClone(service);
    out.tasks = {};
    const userGroups: string[] = user?.service_groups || [];
    if (out.service_groups && !out.service_groups.some((g: string) => userGroups.includes(g))) return undefined;
    if (out.external_tasks) {
        out.models = pickModels(nodeType, extensions, out);
        out.tasks = Object.keys(out.models).length ? promptsToTasks(filter, prompts, nodeType, extensions) : {};
        return out;
    }
    for (const [name, task] of Object.entries<any>(service.tasks || {})) {
        const behaviour = resolveBehaviour(service, { ...task, id: name });
        if (task.service_groups && !task.service_groups.some((g: string) => userGroups.includes(g))) continue;
        if (nodeType === 'Set' && task.set_disabled) continue;
        if (nodeType !== 'Set' && (task.set_only || behaviour === 'many-to-one')) continue;
        let matches = false;
        if (task.supported_types?.length) matches = task.supported_types.some((t: string) => types.includes(t));
        else if (task.supported_formats?.length) matches = task.supported_formats.some((f: string) => extensions.includes(f));
        else if (service.supported_types?.length) matches = service.supported_types.some((t: string) => types.includes(t));
        else if (service.supported_formats?.length) matches = service.supported_formats.some((f: string) => extensions.includes(f));
        if (matches && filterTask(filter, task)) out.tasks[name] = task;
    }
    return Object.keys(out.tasks).length ? out : null;
}

export function servicesForNode(services: Record<string, any>, node: any, filter: string | undefined, user: any, prompts: any[]): { for_type: any[]; for_format: any[] } {
    const matches = { for_type: [] as any[], for_format: [] as any[] };
    if (!node) return matches;
    const unprocessable = node.processable === false;
    for (const [id, service] of Object.entries<any>(services)) {
        if (service.category === 'system' || id === SERVICE.THUMBNAILER) continue;
        const live = (service.consumers || []).length > 0;
        if (unprocessable) {
            // Unprocessable PDFs are only offered the splitter.
            if (id !== SERVICE.PDF_SPLITTER || !live) continue;
            const splitOnly = structuredClone(service);
            splitOnly.tasks = service.tasks?.split ? { split: service.tasks.split } : {};
            if (Object.keys(splitOnly.tasks).length) matches.for_format.push(splitOnly);
            continue;
        }
        if (!live) continue;
        let picked: any;
        if (node['@type'] === 'Set') {
            if (service.set_disabled) continue;
            picked = pickTasks(service, node.extensions || [], node.types || [], filter, user, prompts, 'Set');
        } else if (node['@type'] === 'Source') {
            picked = pickTasks(service, [node.extension], [node.type], filter, user, prompts, node.type);
        } else if (node['@type'] === 'File') {
            picked = pickTasks(service, [node.extension], [node.type], filter, user, prompts, node.type);
        }
        if (picked) matches.for_format.push(picked);
    }
    return matches;
}

// ---- filters (filters/<id>/filter.json) ---------------------------------------------------

export async function loadFilters(dir: string, log: (m: string) => void): Promise<Record<string, any>> {
    const filters: Record<string, any> = {};
    let entries: string[] = [];
    try {
        entries = (await fsp.readdir(dir, { withFileTypes: true })).filter((e) => e.isDirectory()).map((e) => e.name);
    } catch (error) {
        log(`Could not read filters from ${dir}: ${(error as Error).message}`);
        return filters;
    }
    for (const name of entries) {
        try {
            const json = JSON.parse(await fsp.readFile(path.join(dir, name, 'filter.json'), 'utf8'));
            if (json.category !== undefined && !ALLOWED_CATEGORIES.includes(json.category)) {
                log(`WARN: filter '${name}' has invalid category '${json.category}', treating as uncategorized`);
                delete json.category;
            }
            filters[name] = json;
        } catch (error) {
            log(`Error reading filter ${name}: ${(error as Error).message}`);
        }
    }
    return filters;
}

export function filterMatchesNode(filter: any, node: any): boolean {
    if (!filter || !node) return false;
    const nodeType = String(node['@type'] || '').toLowerCase();
    const fileType = String(node.type || '').toLowerCase();
    const extension = String(node.extension || '').toLowerCase();
    const nodeTypes = Array.isArray(node.types) ? node.types.map((t: unknown) => String(t || '').toLowerCase()).filter(Boolean) : [];
    const nodeExtensions = Array.isArray(node.extensions) ? node.extensions.map((f: unknown) => String(f || '').toLowerCase()).filter(Boolean) : [];
    if (Number(filter.set_only || 0) === 1 && nodeType !== 'set') return false;
    const types = Array.isArray(filter.supported_types) ? filter.supported_types.map((t: unknown) => String(t).toLowerCase()) : [];
    if (types.length) {
        const candidates = [...new Set([fileType, nodeType, ...nodeTypes].filter(Boolean))];
        if (!types.some((t: string) => candidates.includes(t))) return false;
    }
    const formats = Array.isArray(filter.supported_formats) ? filter.supported_formats.map((f: unknown) => String(f).toLowerCase()) : [];
    const formatCandidates = [...new Set([extension, ...nodeExtensions].filter(Boolean))];
    if (formats.length && !formats.some((f: string) => formatCandidates.includes(f))) return false;
    return true;
}
