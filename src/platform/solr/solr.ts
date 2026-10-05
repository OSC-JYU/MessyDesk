// Solr client: search, per-project document counts, and index deletes. Indexing itself is done
// by the md-solr consumer; tag fields are synced through the queue (see tags/tag-sync.ts), with
// a direct fallback here.

export interface SolrOptions {
    url: string;
    core: string;
    log?: (message: string) => void;
}

export function escapeSolrValue(value: unknown): string {
    return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"');
}

function normalizeProjectRid(value: unknown): string {
    if (value === undefined || value === null) return '';
    const raw = String(value).trim();
    if (!raw) return '';
    return raw.startsWith('#') ? raw : `#${raw}`;
}

/** Docs store the project rid with or without '#', so both forms are matched. */
export function projectRidVariants(value: unknown): string[] {
    const normalized = normalizeProjectRid(value);
    if (!normalized) return [];
    return [normalized, normalized.replace(/^#/, '')];
}

export class SolrClient {
    private readonly base: string;
    private readonly log: (message: string) => void;

    constructor(opts: SolrOptions) {
        this.base = `${opts.url.replace(/\/$/, '')}/${opts.core}`;
        this.log = opts.log || (() => {});
    }

    private async postJson(path: string, body: unknown): Promise<any> {
        const response = await fetch(this.base + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
        const text = await response.text();
        if (!response.ok) throw new Error(`Solr ${path} failed: ${response.status} ${text.slice(0, 300)}`);
        return text ? JSON.parse(text) : null;
    }

    private async getJson(path: string, params: URLSearchParams): Promise<any> {
        const response = await fetch(`${this.base}${path}?${params}`);
        const text = await response.text();
        if (!response.ok) throw new Error(`Solr ${path} failed: ${response.status} ${text.slice(0, 300)}`);
        return JSON.parse(text);
    }

    /** POST /api/search: Solr's response passed through. An empty query returns []. */
    async search(data: any, userRid: string): Promise<any> {
        const query = data?.query;
        const parsedRows = Number(data?.rows);
        const rows = Number.isFinite(parsedRows) && parsedRows > 0 ? Math.min(1000, Math.floor(parsedRows)) : 250;
        const requested = Array.isArray(data?.project_rids) ? data.project_rids : (data?.project_rid ? [data.project_rid] : []);
        const projects = Array.from(new Set(requested.flatMap(projectRidVariants).filter(Boolean)));
        const fq = [`owner:"${escapeSolrValue(userRid)}"`, 'type:"text"'];
        if (projects.length === 1) fq.push(`project:"${escapeSolrValue(projects[0])}"`);
        else if (projects.length > 1) fq.push(`(${projects.map((rid) => `project:"${escapeSolrValue(rid)}"`).join(' OR ')})`);
        if (!query) return [];
        return this.postJson('/query', {
            params: {
                q: query,
                rows,
                defType: 'edismax',
                qf: 'fulltext_exact^10 fulltext^2 label^3 description^1',
                pf: 'fulltext_exact^20',
                pf2: 'fulltext_exact^5',
                hl: true,
                'hl.fl': 'fulltext_exact,fulltext',
                'hl.simple.pre': '<em>',
                'hl.simple.post': '</em>',
                'hl.snippets': 3,
                'hl.fragsize': 100,
                wt: 'json',
                fl: 'description,label,id,node,process,project,set,owner,score,type,path',
                fq,
            },
        });
    }

    async projectDocCounts(userRid: string): Promise<any> {
        const params = new URLSearchParams();
        params.set('q', '*:*');
        params.set('rows', '0');
        params.set('wt', 'json');
        params.set('facet', 'true');
        params.set('facet.field', 'project');
        params.set('facet.limit', '-1');
        params.set('facet.mincount', '1');
        params.append('fq', `owner:"${escapeSolrValue(userRid)}"`);
        params.append('fq', 'type:"text"');
        const response = await this.getJson('/select', params);
        const facets: any[] = response?.facet_counts?.facet_fields?.project || [];
        const byProject = new Map<string, number>();
        for (let i = 0; i < facets.length; i += 2) {
            const rid = normalizeProjectRid(facets[i]);
            const count = Number(facets[i + 1] || 0);
            if (!rid || count <= 0) continue;
            byProject.set(rid, (byProject.get(rid) || 0) + count);
        }
        const project_counts = [...byProject.entries()].map(([project_rid, docs]) => ({ project_rid, docs })).sort((a, b) => b.docs - a.docs);
        return { total_docs: Number(response?.response?.numFound || 0), project_count: project_counts.length, project_counts };
    }

    private async deleteByQuery(query: string): Promise<any> {
        try {
            return await this.postJson('/update?commit=true', { delete: { query } });
        } catch (error) {
            this.log(`Solr delete error: ${(error as Error).message}`);
            return null;
        }
    }

    /** Docs written by an indexing process (or set process). */
    dropProcessIndex(processRid: string): Promise<any> {
        const v = escapeSolrValue(processRid);
        return this.deleteByQuery(`set_process:"${v}" OR process:"${v}"`);
    }

    /** All docs of one file (one per indexing process). */
    dropFileIndex(fileRid: string): Promise<any> {
        return this.deleteByQuery(`node:"${escapeSolrValue(fileRid)}"`);
    }

    /**
     * All docs of many files, with one commit at the end. One delete-and-commit per file made
     * deleting a 10 000-file set spend most of its time in Solr commits (perf/results/delete.md).
     */
    async dropFilesIndex(fileRids: string[]): Promise<void> {
        for (let i = 0; i < fileRids.length; i += 500) {
            const chunk = fileRids.slice(i, i + 500).map((r) => `"${escapeSolrValue(r)}"`).join(' OR ');
            try {
                await this.postJson('/update', { delete: { query: `node:(${chunk})` } });
            } catch (error) {
                this.log(`Solr delete error: ${(error as Error).message}`);
            }
        }
        if (fileRids.length) await this.postJson('/update?commit=true', { commit: {} }).catch((error) => this.log(`Solr commit error: ${(error as Error).message}`));
    }

    async dropProjectIndex(userRid: string, projectRid: string): Promise<any> {
        const values = projectRidVariants(projectRid);
        if (!values.length) return { responseHeader: { status: 0 }, message: 'no project rid' };
        const filter = values.map((rid) => `project:"${escapeSolrValue(rid)}"`).join(' OR ');
        return this.postJson('/update?commit=true', { delete: { query: `owner:"${escapeSolrValue(userRid)}" AND (${filter})` } });
    }

    /**
     * Replaces the tag_* fields on every doc of a file. A realtime get + full repost, because
     * this Solr rejects atomic `set` updates on multiValued fields.
     */
    async updateTagsForFile(fileRid: string, fields: Record<string, unknown[]>): Promise<any> {
        let ids: string[] = [];
        try {
            const params = new URLSearchParams({ q: `node:"${escapeSolrValue(fileRid)}"`, fl: 'id', rows: '1000', wt: 'json' });
            ids = ((await this.getJson('/select', params))?.response?.docs || []).map((d: any) => d.id).filter(Boolean);
        } catch (error) {
            this.log(`Solr tag lookup error: ${(error as Error).message}`);
            return null;
        }
        if (!ids.length) return null;
        const updates = [];
        for (const id of ids) {
            try {
                const doc = (await this.getJson('/get', new URLSearchParams({ id, wt: 'json' })))?.doc;
                if (!doc) continue;
                const merged: Record<string, unknown> = {};
                for (const key of Object.keys(doc)) if (!key.startsWith('_')) merged[key] = doc[key];
                for (const key of ['tag_label', 'tag_rid', 'tag_created_by', 'tag_confidence']) merged[key] = fields[key] || [];
                updates.push(merged);
            } catch (error) {
                this.log(`Solr tag realtime-get error: ${(error as Error).message}`);
            }
        }
        if (!updates.length) return null;
        try {
            return await this.postJson('/update?commit=true', updates);
        } catch (error) {
            this.log(`Solr tag update error: ${(error as Error).message}`);
            return null;
        }
    }
}
