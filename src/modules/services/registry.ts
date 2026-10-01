// The service registry: descriptors registered by consumers (or installed by an admin), persisted
// to service-registry.json, plus the live consumer ("adapter") list of each service.
//
// Consumers re-register every 30 seconds. An adapter that has not been seen for
// CONSUMER_TTL_SECONDS is dropped (plan/decisions.md D7), so a crashed consumer no longer keeps
// a service looking alive.

import fsp from 'node:fs/promises';
import path from 'node:path';

export const ALLOWED_BEHAVIOURS = ['one-to-one', 'one-to-many', 'many-to-one'] as const;
export type Behaviour = (typeof ALLOWED_BEHAVIOURS)[number];
// The four tool categories plus `system`, for internal services never offered to users.
export const ALLOWED_CATEGORIES = ['preparation', 'linguistic', 'ml', 'generative', 'system'];

export class DescriptorError extends Error {
    statusCode = 400;
}

export function resolveBehaviour(service: any, task: any = {}): Behaviour {
    const taskDef = task?.id ? service?.tasks?.[task.id] : null;
    const explicit = String(task?.behaviour || taskDef?.behaviour || service?.behaviour || '').toLowerCase();
    return (ALLOWED_BEHAVIOURS as readonly string[]).includes(explicit) ? explicit as Behaviour : 'one-to-one';
}

function taskBehaviour(service: any, taskName: string, task: any): string {
    const def = service?.tasks?.[taskName] || task || {};
    const explicit = task?.behaviour || def?.behaviour || service?.behaviour;
    return (ALLOWED_BEHAVIOURS as readonly string[]).includes(explicit) ? explicit : 'one-to-one';
}

function asLowerStrings(value: unknown, field: string): string[] | undefined {
    if (value === undefined) return undefined;
    if (!Array.isArray(value)) throw new DescriptorError(`${field} must be an array`);
    return value.map((v) => String(v).toLowerCase());
}

/** Validates a descriptor and fills in task behaviours (normalizeServiceDescriptor). */
export function normalizeDescriptor(raw: any): any {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new DescriptorError('service descriptor must be an object');
    if (!raw.id || typeof raw.id !== 'string') throw new DescriptorError('service descriptor id is required');
    const id = raw.id.trim();
    if (!id) throw new DescriptorError('service descriptor id must not be empty');
    if (raw.tasks !== undefined && (typeof raw.tasks !== 'object' || Array.isArray(raw.tasks))) throw new DescriptorError('tasks must be an object when provided');
    const out: any = { ...raw, id };
    const types = asLowerStrings(raw.supported_types, 'supported_types');
    if (types !== undefined) out.supported_types = types;
    const formats = asLowerStrings(raw.supported_formats, 'supported_formats');
    if (formats !== undefined) out.supported_formats = formats;
    if (raw.behaviour !== undefined && !(ALLOWED_BEHAVIOURS as readonly string[]).includes(raw.behaviour)) throw new DescriptorError('behaviour is invalid');
    if (raw.category !== undefined && !ALLOWED_CATEGORIES.includes(raw.category)) {
        throw new DescriptorError(`category is invalid, must be one of: ${ALLOWED_CATEGORIES.join(', ')}`);
    }
    out.tasks = {};
    for (const [name, task] of Object.entries<any>(raw.tasks || {})) {
        if (!task || typeof task !== 'object' || Array.isArray(task)) throw new DescriptorError(`tasks.${name} must be an object`);
        if (task.behaviour !== undefined && !(ALLOWED_BEHAVIOURS as readonly string[]).includes(task.behaviour)) throw new DescriptorError(`tasks.${name}.behaviour is invalid`);
        const normalized: any = { ...task, behaviour: taskBehaviour(out, name, task) };
        const tTypes = asLowerStrings(task.supported_types, `tasks.${name}.supported_types`);
        if (tTypes !== undefined) normalized.supported_types = tTypes;
        const tFormats = asLowerStrings(task.supported_formats, `tasks.${name}.supported_formats`);
        if (tFormats !== undefined) normalized.supported_formats = tFormats;
        out.tasks[name] = normalized;
    }
    return out;
}

interface RegistryFile {
    version: number;
    services: Record<string, { source?: string; registered_at?: string; last_seen?: string; descriptor: any }>;
}

export class ServiceRegistry {
    private services: Record<string, any> = {};
    private adapterSeen = new Map<string, Map<string, number>>();
    private readonly filePath: string;
    private readonly ttlMs: number;

    constructor(filePath: string, ttlSeconds: number) {
        this.filePath = filePath;
        this.ttlMs = ttlSeconds * 1000;
    }

    private now(): string {
        return new Date().toISOString();
    }

    async load(): Promise<Record<string, any>> {
        let data: RegistryFile = { version: 1, services: {} };
        try {
            const parsed = JSON.parse(await fsp.readFile(this.filePath, 'utf8'));
            if (parsed && typeof parsed === 'object' && parsed.services && typeof parsed.services === 'object' && !Array.isArray(parsed.services)) data = parsed;
        } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
        }
        const loaded: Record<string, any> = {};
        for (const [id, entry] of Object.entries(data.services)) {
            const descriptor = entry?.descriptor || {};
            if (!descriptor.id) continue;
            const existing = this.services[id];
            loaded[id] = {
                ...(existing || {}),
                ...descriptor,
                consumers: [],
                registration: {
                    source: entry.source || 'registry',
                    registered_at: entry.registered_at || entry.last_seen || this.now(),
                    last_seen: entry.last_seen || entry.registered_at || this.now(),
                },
            };
            if (existing?.url && !descriptor.url) loaded[id].url = existing.url;
        }
        this.services = loaded;
        this.adapterSeen.clear();
        return this.services;
    }

    async persist(): Promise<void> {
        const entries: RegistryFile['services'] = {};
        for (const [id, service] of Object.entries(this.services)) {
            if (!service || typeof service !== 'object') continue;
            const { consumers: _c, path: _p, nomad_hcl: nomadHcl, url: _u, registration, ...descriptor } = service;
            // UI-installed Nomad services keep their spec so start/stop survives restarts.
            if (service.kind && typeof nomadHcl === 'string' && nomadHcl.trim()) descriptor.nomad_hcl = nomadHcl;
            entries[id] = {
                source: registration?.source || 'runtime',
                registered_at: registration?.registered_at || this.now(),
                last_seen: registration?.last_seen || this.now(),
                descriptor,
            };
        }
        await fsp.mkdir(path.dirname(this.filePath), { recursive: true });
        await fsp.writeFile(this.filePath, JSON.stringify({ version: 1, services: entries }, null, 2), 'utf8');
    }

    private pruneAdapters(id: string): void {
        const service = this.services[id];
        const seen = this.adapterSeen.get(id);
        if (!service || !seen) return;
        const cutoff = Date.now() - this.ttlMs;
        for (const [adapter, at] of seen) if (at < cutoff) seen.delete(adapter);
        service.consumers = [...seen.keys()];
    }

    /** All services keyed by id, with live consumers. */
    all(): Record<string, any> {
        for (const id of Object.keys(this.services)) this.pruneAdapters(id);
        return this.services;
    }

    get(id: string): any | undefined {
        if (this.services[id]) this.pruneAdapters(id);
        return this.services[id];
    }

    /** Like get() but throws, for routes that need the service. */
    require(id: string): any {
        const service = this.get(id);
        if (!service) throw new DescriptorError(`Service adapter not found for service "${id}"`);
        return service;
    }

    hasActiveConsumer(id: string): boolean {
        return Boolean(this.get(id)?.consumers?.length);
    }

    async register(raw: any, source = 'runtime'): Promise<{ status: string; service: any }> {
        const descriptor = normalizeDescriptor(raw);
        const existing = this.services[descriptor.id];
        const merged: any = { ...(existing || {}), ...descriptor, consumers: Array.isArray(existing?.consumers) ? existing.consumers : [] };
        if (existing?.path && !descriptor.path) merged.path = existing.path;
        if (existing?.nomad_hcl && !descriptor.nomad_hcl) merged.nomad_hcl = existing.nomad_hcl;
        if (existing?.nomad !== undefined && descriptor.nomad === undefined) merged.nomad = existing.nomad;
        if (existing?.url && !descriptor.url) merged.url = existing.url;
        const current = merged.registration || {};
        merged.registration = { source, registered_at: current.registered_at || current.last_seen || this.now(), last_seen: this.now() };
        this.services[descriptor.id] = merged;
        await this.persist();
        return { status: existing ? 'updated' : 'created', service: merged };
    }

    async forget(id: string): Promise<{ status: string; service: string }> {
        const clean = String(id || '').trim();
        let key: string | null = this.services[clean] ? clean : null;
        if (!key) for (const [k, svc] of Object.entries(this.services)) if (svc?.id === clean) { key = k; break; }
        if (!key) return { status: 'not_found', service: clean };
        delete this.services[key];
        this.adapterSeen.delete(key);
        await this.persist();
        return { status: 'forgotten', service: key };
    }

    addAdapter(id: string, adapterId: string): any {
        const service = this.services[id];
        if (!service) return { error: 'service not found', name: id };
        let seen = this.adapterSeen.get(id);
        if (!seen) {
            seen = new Map();
            this.adapterSeen.set(id, seen);
        }
        const known = seen.has(adapterId);
        seen.set(adapterId, Date.now());
        this.pruneAdapters(id);
        if (known) return { status: 'consumer already exists', name: id };
        return service;
    }

    removeAdapter(id: string, adapterId: string): any {
        const service = this.services[id];
        if (!service) return { error: 'service not found for deletion', name: id };
        this.adapterSeen.get(id)?.delete(adapterId);
        this.pruneAdapters(id);
        service.consumers = (service.consumers || []).filter((c: string) => c !== adapterId);
        return service;
    }
}
