# Search (Solr Integration)

MessyDesk uses Apache Solr 9.7 for full-text search. The integration is in `src/platform/solr/solr.ts`.

## Configuration

**[verified]** from `src/config.ts`:

| Variable | Default |
|----------|---------|
| `SOLR_URL` | `http://localhost:8983/solr` |
| `SOLR_CORE` | `messydesk` |

The Solr core is pre-created by `docker-compose.yml` via `solr-precreate messydesk`.

## Search Query

**[verified]** from `src/platform/solr/solr.ts` `SolrClient.search`:

- Query parser: **eDisMax**
- Query fields with boosting: `fulltext_exact^10`, `fulltext^2`, `label^3`, `description^1`
- Phrase boosting: `pf=fulltext_exact^20`, `pf2=fulltext_exact^5`
- Highlighting: 3 snippets, 100-character fragments
- Default row limit: 250, hard cap: 1000

### Returned fields

`label`, `description`, `id`, `node`, `process`, `project`, `set`, `owner`, `score`, `type`, `path`

Docs also carry `tag_label`/`tag_rid`/`tag_created_by`/`tag_confidence` (multivalued, kept in sync from
`TagLink` \u2014 see Index Management below), though these aren't currently part of the default query/highlight
fields above. `TagLink` is Autotag only (see graph-data-model.md Entity/Tag System) — Faceted ROI-data
(`ner.json`) isn't indexed into Solr yet, it's browsed directly via `/api/tags/ner/labels*`.

### Filters

- Owner filter: always applied (user RID from auth context)
- Type filter: `type=text` by default
- Project filter: optional, supports single project or OR'd multiple projects

### RID handling

Solr queries normalize RIDs: accept both `#123:45` and `123:45` formats, escape special Solr characters (`\`, `"`), and support variant matching (with/without `#` prefix). **[verified]**

## Index Management

**[verified]** from `src/platform/solr/solr.ts`:

| Function | Purpose |
|----------|---------|
| `solr.indexDocuments(data)` | Bulk index documents |
| `solr.dropUserIndex(userRID)` | Delete all documents owned by a user |
| `solr.dropProjectIndex(userRID, projectRID)` | Delete all documents in a project |
| `solr.dropSetIndex(set_rid)` | Delete documents in a set/process |
| `SolrClient.updateTagsForFile`(file_rid)` | Sync `tag_label`/`tag_rid`/`tag_created_by`/`tag_confidence` (multivalued) on every doc for a file from current `TagLink` rows, via atomic `{"set": [...]}` partial update |

`updateTagsForFile` is invoked from `TagsService.reindexFileTags`, called from `linkEntity`/`unLinkEntity` (file-level
only) and transitively from `TagsService.autotag`. A single file can have multiple Solr docs (one per indexing
process, doc `id = fileRidNorm:processRidNorm`), all keyed by the `node` field; all matching docs are updated.
Errors are non-fatal (logged, not thrown).

## Statistics

`SolrClient.projectDocCounts(userRid)` uses faceting to return per-project document counts:

```json
{
    "total_docs": 1500,
    "project_count": 3,
    "project_counts": [
        { "project_rid": "#11:0", "docs": 800 },
        { "project_rid": "#11:1", "docs": 700 }
    ]
}
```

**[verified]**

## Indexing Flow

Documents are indexed via the Solr adapter in MD-consumers:
1. Text file processed (e.g., OCR output)
2. Consumer sends text to Solr via `POST /update` endpoint
3. Solr adapter (`MD-consumers/src/adapters/solr.mjs`) converts to Solr schema format

**[verified]** from `MD-consumers/src/adapters/solr.mjs`.

## Search endpoint

**[verified]** from `src/modules/misc/routes.ts`:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/search` | Full-text search with query, project filter, pagination |
| `GET /api/search/info` | Search statistics (document counts per project) |

## Semantic and similarity search (vector and TF-IDF indexes)

**[verified]** from `src/modules/semantic/`:

| Endpoint | Purpose |
|---|---|
| `GET /api/search/semantic/indexes` | The caller's indexes (File nodes of type `vector_index` or `similarity_index`): `type`, model, rows and file count from the index file's header, the indexed set, the desk, and `large` above 200 000 rows |
| `POST /api/search/semantic` | `{ index, query, k, level: chunk\|doc, threshold? }` → 202 `{ search_id }`. Queries are at most 2 000 characters for a vector index and 50 000 for a similarity index (a pasted text) |
| `GET /api/search/semantic/{id}` | `queued` / `done` (with `hits` and `comparison`) / `failed` (with `error`); kept 10 minutes, only for the searcher |

A search is a job on the **single-file queue** of the service that built the index (the
producing process's `service_id`, default `md-embeddings` for vector indexes and `md-gensim` for
similarity indexes), with `role: semantic_search`,
`search_id` and `task: {id: 'search'}`. Consumers claim the single-file queue before the batch
queue, so a search waits at most for the job a consumer is already running. The service answers
with `response.type = "results"`; the consumer reports it with `/api/nomad/process/files/done`,
and the backend routes it to `SemanticSearch.deliver` instead of the results module. Hits are
checked with `AccessService.findOwned` for the user of the pending search (never the message's
`userId`), given labels and snippets from the source text, and announced with the SSE event
`{ command: 'semantic_results', search_id, status }`. Failed searches arrive through `/error`.
Search jobs are not shown in the jobs panel.

Another vector backend (e.g. a vector database service) answers the same job with the same
results, so the routes and the UI stay the same.

A **similarity index** (md-gensim, TF-IDF) is searched the same way, from the Search tab or from
the index file's viewer, where the user pastes a whole text to find the passages it shares with
the indexed texts (text reuse). Its hits also carry where the match is in the query
(`query_start_char`, `query_end_char`, `query_start_token`), and `comparison` gives the passage
length (`window_size`), `overlap`, `threshold` and how many of the query's passages matched
(`query_windows`, `matched_windows`).
