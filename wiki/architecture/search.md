# Search (Solr Integration)

MessyDesk uses Apache Solr 9.7 for full-text search. The integration is in `src/solr.mjs`.

## Configuration

**[verified]** from `src/env.mjs`:

| Variable | Default |
|----------|---------|
| `SOLR_URL` | `http://localhost:8983/solr` |
| `SOLR_CORE` | `messydesk` |

The Solr core is pre-created by `docker-compose.yml` via `solr-precreate messydesk`.

## Search Query

**[verified]** from `src/solr.mjs` `solr.search()`:

- Query parser: **eDisMax**
- Query fields with boosting: `fulltext_exact^10`, `fulltext^2`, `label^3`, `description^1`
- Phrase boosting: `pf=fulltext_exact^20`, `pf2=fulltext_exact^5`
- Highlighting: 3 snippets, 100-character fragments
- Default row limit: 250, hard cap: 1000

### Returned fields

`label`, `description`, `id`, `node`, `process`, `project`, `set`, `owner`, `score`, `type`, `path`

### Filters

- Owner filter: always applied (user RID from auth context)
- Type filter: `type=text` by default
- Project filter: optional, supports single project or OR'd multiple projects

### RID handling

Solr queries normalize RIDs: accept both `#123:45` and `123:45` formats, escape special Solr characters (`\`, `"`), and support variant matching (with/without `#` prefix). **[verified]**

## Index Management

**[verified]** from `src/solr.mjs`:

| Function | Purpose |
|----------|---------|
| `solr.indexDocuments(data)` | Bulk index documents |
| `solr.dropUserIndex(userRID)` | Delete all documents owned by a user |
| `solr.dropProjectIndex(userRID, projectRID)` | Delete all documents in a project |
| `solr.dropSetIndex(set_rid)` | Delete documents in a set/process |

## Statistics

`solr.getUserProjectDocCounts(userRID)` uses faceting to return per-project document counts:

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

**[verified]** from `src/routes/search.mjs`:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/search` | Full-text search with query, project filter, pagination |
| `GET /api/search/info` | Search statistics (document counts per project) |
