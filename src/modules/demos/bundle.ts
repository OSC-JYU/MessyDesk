// The demo bundle format (wiki/proposals/demo-project-format.md): what graph.json holds and how
// the values in it refer to each other without RIDs or absolute paths.
//
//   "@ref:<id>"       a RID of a node in the bundle (a vertex's own id is its uuid)
//   "@project/<rel>"  a path inside the project directory
//   "@@..."           a string that started with "@" in the data (one "@" is added in front)

export const BUNDLE_FORMAT = 1;

export const MANIFEST_FILE = 'manifest.json';
export const GRAPH_FILE = 'graph.json';
export const FILES_PREFIX = 'files/';

export interface BundleNode {
    id: string;
    type: string;
    props: Record<string, unknown>;
}

export interface BundleEdge {
    type: string;
    from: string;
    to: string;
    props: Record<string, unknown>;
}

/** A row of a document type (TagLink, DeskTag): not a vertex, so it has no id. */
export interface BundleDocument {
    type: string;
    props: Record<string, unknown>;
}

export interface Graph {
    nodes: BundleNode[];
    edges: BundleEdge[];
    documents: BundleDocument[];
}

export interface Manifest {
    format: number;
    title: Record<string, string>;
    description: Record<string, string>;
    created: string;
    source: string;
    /** The id of the Project node in graph.json. */
    project: string;
    files: number;
}

/** Record properties the database sets itself, or that name users or deletion state. */
export const DROPPED_PROPERTIES = new Set(['@rid', '@type', '@cat', '@in', '@out', '_deleting', 'owner', 'added_by', 'tagged_by']);

export class Encoder {
    private readonly ids: Map<string, string>;
    private readonly projectDir: string;

    constructor(ids: Map<string, string>, projectDir: string) {
        this.ids = ids;
        this.projectDir = projectDir.replace(/\/+$/, '');
    }

    value(input: unknown): unknown {
        if (typeof input === 'string') return this.string(input);
        if (Array.isArray(input)) return input.map((v) => this.value(v));
        if (input && typeof input === 'object') return this.properties(input as Record<string, unknown>);
        return input;
    }

    properties(record: Record<string, unknown>): Record<string, unknown> {
        const out: Record<string, unknown> = {};
        for (const [key, value] of Object.entries(record)) {
            if (DROPPED_PROPERTIES.has(key) || value === undefined) continue;
            out[key] = this.value(value);
        }
        return out;
    }

    private string(text: string): string {
        const id = this.ids.get(text);
        if (id !== undefined) return `@ref:${id}`;
        if (text === this.projectDir) return '@project/';
        if (text.startsWith(`${this.projectDir}/`)) return `@project/${text.slice(this.projectDir.length + 1)}`;
        return text.startsWith('@') ? `@${text}` : text;
    }
}

export class Decoder {
    private readonly rids: Map<string, string>;
    private readonly projectDir: string;
    private readonly mapPath: (relative: string) => string;

    /** `rids` maps a bundle id to the RID it got on import; `mapPath` renames paths inside the project directory. */
    constructor(rids: Map<string, string>, projectDir: string, mapPath: (relative: string) => string = (p) => p) {
        this.rids = rids;
        this.projectDir = projectDir.replace(/\/+$/, '');
        this.mapPath = mapPath;
    }

    value(input: unknown): unknown {
        if (typeof input === 'string') return this.string(input);
        if (Array.isArray(input)) return input.map((v) => this.value(v));
        if (input && typeof input === 'object') {
            return Object.fromEntries(Object.entries(input).map(([key, value]) => [key, this.value(value)]));
        }
        return input;
    }

    private string(text: string): string {
        if (text.startsWith('@@')) return text.slice(1);
        if (text.startsWith('@ref:')) {
            const rid = this.rids.get(text.slice(5));
            if (!rid) throw new Error(`Bundle refers to an unknown node: ${text.slice(5)}`);
            return rid;
        }
        if (text.startsWith('@project/')) return `${this.projectDir}/${this.mapPath(text.slice(9))}`.replace(/\/+$/, '');
        return text;
    }
}

/** True when a path inside the bundle stays inside it (no "..", no absolute path). */
export function isSafeBundlePath(name: string): boolean {
    if (!name || name.startsWith('/') || name.includes('\\') || name.includes('\0')) return false;
    return !name.split('/').some((part) => part === '..');
}
