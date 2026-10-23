// Solr client: search, per-project document counts, index deletes and the ROI label documents. Indexing itself is done
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

// OCR confusions that are two edits apart, which `~1` cannot reach (m read as rn, d as cl, ...).
const OCR_CONFUSIONS: Array<[string, string]> = [['m', 'rn'], ['rn', 'm'], ['d', 'cl'], ['cl', 'd'], ['w', 'vv'], ['vv', 'w'], ['h', 'li'], ['li', 'h']];
const MAX_VARIANTS = 6;

/** Spellings of a word with one OCR confusion applied, e.g. governments -> govemments. */
export function ocrVariants(word: string): string[] {
    const out = new Set<string>();
    const lower = word.toLowerCase();
    for (const [from, to] of OCR_CONFUSIONS) {
        for (let i = lower.indexOf(from); i >= 0 && out.size < MAX_VARIANTS; i = lower.indexOf(from, i + 1)) {
            out.add(lower.slice(0, i) + to + lower.slice(i + from.length));
        }
    }
    out.delete(lower);
    return [...out].slice(0, MAX_VARIANTS);
}

/**
 * The query with every plain word of 4+ letters made fuzzy, to find OCR misreadings: `word~1`
 * (one letter changed, added or removed) or one of its common two-edit OCR confusions
 * (ocrVariants). Phrases, wildcards, fuzzy/boosted terms, field queries and operators are left
 * as they are; so are short words, where one edit matches too much.
 */
export function fuzzyQuery(query: string): string {
    const tokens = String(query).match(/[+-]?"[^"]*"\S*|\S+/g) || [];
    return tokens.map((token) => {
        const sign = /^[+-]/.test(token) ? token[0] : '';
        const bare = token.slice(sign.length);
        if (bare.startsWith('"') || /[*?~^:()\[\]{}\\/]/.test(bare)) return token;
        if (['AND', 'OR', 'NOT', '&&', '||'].includes(bare)) return token;
        if (bare.length < 4) return token;
        const variants = ocrVariants(bare);
        return variants.length ? `${sign}(${bare}~1 ${variants.join(' ')})` : `${sign}${bare}~1`;
    }).join(' ');
}

/**
 * One document per ner.json run (ROI data: spans or regions with labels): which file the run read
 * and which labels it found. Not part of text search (`type` is `roi_run`); the labels feed the
 * tag filter. Mention texts stay in the ner.json file.
 */
export interface RoiRunDoc {
    nerRid: string;
    sourceRid: string;
    owner: string;
    project: string | null;
    serviceId: string | null;
    task: string | null;
    model: string | null;
    labels: string[];
}

export interface RoiKey {
    service_id: string;
    task: string;
    model: string;
    label: string;
}

/** The facet value of one label of one run kind: `service|task|model|label`. */
export function roiKey(serviceId: unknown, task: unknown, model: unknown, label: unknown): string {
    return [serviceId, task, model, label].map((part) => String(part ?? '')).join('|');
}

export function parseRoiKey(key: string): RoiKey {
    const [service_id = '', task = '', model = '', ...label] = String(key).split('|');
    return { service_id, task, model, label: label.join('|') };
}

export function roiRunDocument(run: RoiRunDoc): Record<string, unknown> {
    return {
        id: `roi:${normalizeProjectRid(run.nerRid).replace('#', '')}`,
        type: 'roi_run',
        owner: run.owner,
        ...(run.project ? { project: normalizeProjectRid(run.project) } : {}),
        roi_run: normalizeProjectRid(run.nerRid),
        roi_source: normalizeProjectRid(run.sourceRid),
        roi_service: run.serviceId || '',
        roi_task: run.task || '',
        roi_model: run.model || '',
        roi_key: [...new Set(run.labels)].map((label) => roiKey(run.serviceId, run.task, run.model, label)),
    };
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
        // `fuzzy`: also find OCR misreadings (plan/decisions.md G6). Fuzzy terms go only to the
        // whole-word field: on the n-gram field they would match almost anything.
        const fuzzy = data?.fuzzy === true || data?.fuzzy === 'true';
        const params = {
            q: query,
            rows,
            defType: 'edismax',
            qf: 'fulltext_exact^10 fulltext^2 label^3 description^1',
            pf: 'fulltext_exact^20',
            pf2: 'fulltext_exact^5',
            hl: true,
            'hl.fl': 'fulltext_exact',
            'hl.simple.pre': '<em>',
            'hl.simple.post': '</em>',
            'hl.snippets': 3,
            'hl.fragsize': 100,
            wt: 'json',
            fl: 'description,label,id,node,process,project,set,owner,score,type,path',
            fq,
        };
        // Highlighting the n-gram field took most of the search time (~300 ms of 320 for 500 hits,
        // perf/results/search.md). Whole-word snippets come first; only hits without one (matched
        // by a word fragment) are highlighted on the n-gram field, in a second, smaller request.
        // Fuzzy: the normal search OR the fuzzy terms on the whole-word field only (on the n-gram
        // field they would match almost anything), so word-fragment matches are kept.
        const request = fuzzy
            ? {
                ...params,
                defType: 'lucene',
                q: '_query_:"{!edismax qf=$qf pf=$pf pf2=$pf2 v=$qn}" OR _query_:"{!edismax qf=$qff v=$qz}"',
                qn: query,
                qz: fuzzyQuery(query),
                qff: 'fulltext_exact^10 label^3 description^1',
            }
            : params;
        const response = await this.postJson('/query', { params: request });
        const docs: any[] = response?.response?.docs || [];
        const highlighting = response?.highlighting || {};
        const missing = docs.map((d) => d.id).filter((id) => !(highlighting[id]?.fulltext_exact?.length));
        if (missing.length) {
            const ids = missing.map((id) => `"${escapeSolrValue(id)}"`).join(' OR ');
            const fragments = await this.postJson('/query', {
                params: { ...params, rows: missing.length, fl: 'id', 'hl.fl': 'fulltext', fq: [...fq, `id:(${ids})`] },
            }).catch(() => null);
            for (const [id, hl] of Object.entries<any>(fragments?.highlighting || {})) {
                if (hl?.fulltext?.length) highlighting[id] = { ...(highlighting[id] || {}), fulltext: hl.fulltext };
            }
            if (response) response.highlighting = highlighting;
        }
        return response;
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
                await this.postJson('/update', { delete: { query: `node:(${chunk}) OR roi_source:(${chunk})` } });
            } catch (error) {
                this.log(`Solr delete error: ${(error as Error).message}`);
            }
        }
        if (fileRids.length) await this.postJson('/update?commit=true', { commit: {} }).catch((error) => this.log(`Solr commit error: ${(error as Error).message}`));
    }

    /** Writes ROI run documents. Throws when Solr fails; the callers treat that as non-fatal. */
    async indexRoiRuns(runs: RoiRunDoc[]): Promise<void> {
        for (let i = 0; i < runs.length; i += 200) {
            await this.postJson('/update?commitWithin=1000', runs.slice(i, i + 200).map(roiRunDocument));
        }
    }

    /** The ROI document of one ner.json run. */
    dropRoiRun(nerRid: string): Promise<any> {
        return this.deleteByQuery(`id:"roi:${escapeSolrValue(normalizeProjectRid(nerRid).replace('#', ''))}"`);
    }

    private roiFilters(userRid: string, projects: string[]): string[] {
        const fq = [`owner:"${escapeSolrValue(userRid)}"`, 'type:"roi_run"'];
        const variants = Array.from(new Set(projects.flatMap(projectRidVariants).filter(Boolean)));
        if (variants.length) fq.push(`(${variants.map((rid) => `project:"${escapeSolrValue(rid)}"`).join(' OR ')})`);
        return fq;
    }

    /**
     * ROI labels with how many runs (files) have them, sorted by run kind and label so a run's labels
     * come together. `search` matches part of a key (case-insensitive); one page, `hasMore` tells
     * whether there is another.
     */
    async roiLabels(userRid: string, options: { projects?: string[]; search?: string; offset?: number; limit?: number } = {}): Promise<{ items: Array<RoiKey & { count: number }>; hasMore: boolean }> {
        const limit = Math.min(1000, Math.max(1, Math.floor(Number(options.limit) || 200)));
        const params = new URLSearchParams({ q: '*:*', rows: '0', wt: 'json', facet: 'true', 'facet.field': 'roi_key', 'facet.sort': 'index', 'facet.mincount': '1', 'facet.limit': String(limit + 1), 'facet.offset': String(Math.max(0, Math.floor(Number(options.offset) || 0))) });
        const search = String(options.search || '').trim();
        if (search) {
            params.set('facet.contains', search);
            params.set('facet.contains.ignoreCase', 'true');
        }
        for (const fq of this.roiFilters(userRid, options.projects || [])) params.append('fq', fq);
        const facets: any[] = (await this.getJson('/select', params))?.facet_counts?.facet_fields?.roi_key || [];
        const items: Array<RoiKey & { count: number }> = [];
        for (let i = 0; i < facets.length; i += 2) items.push({ ...parseRoiKey(facets[i]), count: Number(facets[i + 1] || 0) });
        return { items: items.slice(0, limit), hasMore: items.length > limit };
    }

    /**
     * For files, which of the wanted ROI keys their runs have: Map<source file rid, Set<key>>. Throws
     * when Solr fails, so a filter never works from partial data.
     */
    async roiSources(userRid: string, fileRids: string[], keys: string[]): Promise<Map<string, Set<string>>> {
        const found = new Map<string, Set<string>>();
        if (!fileRids.length || !keys.length) return found;
        const wanted = new Set(keys);
        const keyQuery = keys.map((k) => `"${escapeSolrValue(k)}"`).join(' OR ');
        const pageSize = 5000;
        for (let i = 0; i < fileRids.length; i += 1000) {
            const terms = fileRids.slice(i, i + 1000).map((r) => normalizeProjectRid(r)).join(',');
            for (let start = 0; ; start += pageSize) {
                const response = await this.postJson('/query', {
                    params: { q: '*:*', fl: 'roi_source,roi_key', rows: pageSize, start, sort: 'id asc', wt: 'json', fq: [...this.roiFilters(userRid, []), `{!terms f=roi_source}${terms}`, `roi_key:(${keyQuery})`] },
                });
                const docs: any[] = response?.response?.docs || [];
                for (const doc of docs) {
                    const set = found.get(doc.roi_source) || new Set<string>();
                    for (const key of [doc.roi_key].flat()) if (wanted.has(key)) set.add(key);
                    found.set(doc.roi_source, set);
                }
                if (start + docs.length >= Number(response?.response?.numFound || 0) || !docs.length) break;
            }
        }
        return found;
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
