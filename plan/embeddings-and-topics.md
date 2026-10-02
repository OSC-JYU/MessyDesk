# Embeddings, vector search, clustering and topics: plan

Status: proposal, 2026-10-02. Nothing here is implemented. The open questions for Ari are in
section 10; until they are answered the defaults stated there apply.

Claims about the existing code are marked **[verified]** (read in `MessyDesk-new`, `MD-consumers`
or `MessyDesk-UI`) or **[inferred]**. Claims about outside products come from documentation as I
know it and are marked **[check]** where a version detail matters.

## 1. What we are adding

| Piece | Kind | What it does |
|---|---|---|
| **MD-embeddings** | new Python service, existing `elg_fs` adapter | Text file in, one embeddings file out. Selectable models: open ones run locally (EmbeddingGemma by default), closed ones through their API (OpenAI). |
| **Qdrant** | new infrastructure container | Vector index for semantic search. A rebuildable index, like Solr; the embeddings files are the source of truth. |
| **md-qdrant** | new adapter in MD-consumers (`qdrant`), descriptor like `md-solr` | `index` / `delete` tasks that load embeddings files into Qdrant. |
| **Semantic search** | backend module `vectors/` + search page tab | Query text -> query vector -> Qdrant kNN filtered to the caller's own points. |
| **MD-embedding-analysis** | new Python service, `elg_fs` adapter | Whole-set analyses on embeddings: clustering and model comparison (section 7; called MD-topics in sections 7–8). |
| **MD-bertopic** | new Python service, `elg_fs` adapter | BERTopic topics on precomputed embeddings (section 7.2a). |
| **`whole-set` behaviour** | small backend addition | One job per set (the service gets the whole file list), needed by clustering and topics. |

Everything goes through the existing queue except the query embedding of an interactive search
(section 6.3, question Q1).

## 2. How the existing pieces fit (what the plan builds on)

- **Services are pure transformations.** A service reads `message.file.path` under `MD_PATH`,
  writes outputs to `data/<db>/tmp`, and returns `response.type = "disk"`; the `elg_fs` adapter
  posts each output to `/api/nomad/process/files/tmp`. Services never call the backend.
  **[verified]** `wiki/architecture/services/service_architecture.md`.
- **Behaviours.** `one-to-one` on a Set publishes one job per file to `<topic>_batch` and puts the
  outputs into an output Set; `many-to-one` also publishes one job per file
  (`current_file`/`total_files`) and expects the service to accumulate with `output_uuid` and emit on
  the last file. **[verified]** `ProcessingService.queueSet` (src/modules/processing/processing.ts).
  Jobs can be claimed by several consumers in parallel, so "the last file" is not necessarily the
  last one processed **[inferred]** — fine for text concatenation, not for fitting a clustering.
- **Search outputs.** A `many-to-one` task of a service whose type or id contains `solr` or `faiss`
  (or with `search_output: true`) gets an output Set of type `search`. **[verified]**
  `isSearchOutputTask`. The `md-solr` consumer writes to Solr directly with `owner = msg.userId`;
  the backend reads Solr with an owner filter it adds itself and deletes Solr documents on cascade
  delete (`dropProcessIndex`, `dropFileIndex`, `dropProjectIndex`). **[verified]**
  `MD-consumers/src/adapters/solr.mjs`, `src/platform/solr/solr.ts`, `src/modules/graph/graph.ts`.
- **Models.** A descriptor may have `models`; the UI already shows a model picker for any service
  with more than one model and sends the chosen model with the task **[verified]**
  `MessyDesk-UI/src/features/services/crunchers/CruncherService.vue`. The backend resolves
  `task.model` from `service.models` only for `external_tasks` services, and stores `model` and
  `model_version` on the Process node **[verified]** `prepareTask` (processing.ts:92,361),
  `nodes.ts:147`. The UI also shows `access: proprietary` and `location: external` badges per
  service.
- **Ownership.** A node is the user's when its `DERIVED_FROM`/`BELONGS_TO` chain reaches a Project
  that `HAS_OWNER` the user (`AccessService.findOwned`). Messages carry `userId` (user RID) and
  `project_rid`, filled in by the backend **[verified]**. Consumers authenticate with the service
  token, so a message is trusted data built by the backend.
- **Existing UI hooks.** `faiss.json` and `similarity.json` file types already exist, with a
  `SimilarityDisplay` that shows query-text chunks matched against documents **[verified]**
  `MessyDesk-UI/src/features/files/similarity.js`. The FAISS service itself is not in the local
  repos **[verified: not found]**.

## 3. MD-embeddings service

### 3.1 Shape

One FastAPI repo, `MD-embeddings`, following the service checklist (disk mode, `MD_PATH`,
filename-only outputs, `/process`, `/config`, `/health`, `/help`). It has providers behind one
interface `embed(texts, mode) -> float32[n, d]`:

| Provider | Used for | Notes |
|---|---|---|
| `sentence-transformers` | open models, run in the container (CPU or GPU) | exact control over prompts, normalisation and Matryoshka truncation |
| `openai` | OpenAI embedding models | API key from the service's own env; never in a message |
| `ollama` (optional, later) | open models already served by Ollama | Ollama's `/api/embed` |

It is deployed as **two registered services from the same image**, so the existing badges and
`service_groups` gating work per service without new UI:

| Service id | `location` / `access` | Models |
|---|---|---|
| `md-embeddings` | on-premise / open source | `embeddinggemma-300m` (default), `bge-m3`, `multilingual-e5-large-instruct` |
| `md-embeddings-openai` | external / proprietary | `text-embedding-3-small`, `text-embedding-3-large` |

Default models and why:

- **EmbeddingGemma 300M**: 768 dims (Matryoshka 512/256/128), 2 048-token context, multilingual
  (100+ languages, so Finnish is covered), small enough for CPU. It expects task prefixes
  (`task: search result | query: ...` for queries, `title: none | text: ...` for documents),
  which the provider adds. Weights are under Gemma terms, not an OSI licence **[check]**.
- **BGE-M3** (1 024 dims, 8 192-token context, MIT) and **multilingual-e5-large-instruct**
  (1 024 dims, MIT) as open alternatives to compare against.
- **OpenAI `text-embedding-3-small` (1 536) and `-large` (3 072)**; both accept a `dimensions`
  parameter to shorten the vector **[check]**.

The model list lives in `service.json` and can be changed without code: each model entry has
`provider`, `model_name`, `dims`, `max_tokens`, `query_prefix`, `doc_prefix`, `normalize`,
`version`, `supported_types: ["text"]`, `supported_formats: ["txt", "md", "json"]`.

### 3.2 Descriptor (sketch)

```json
{
  "id": "md-embeddings",
  "type": "embeddings",
  "adapter": "elg_fs",
  "category": "ml",
  "location": "on-premise",
  "access": "open",
  "supported_types": ["text"],
  "supported_formats": ["txt"],
  "models": {
    "embeddinggemma-300m": { "provider": "sentence-transformers", "model_name": "google/embeddinggemma-300m", "dims": 768, "max_tokens": 2048, "normalize": true, "version": "1",
                             "supported_types": ["text"], "supported_formats": ["txt"] }
  },
  "tasks": {
    "embed": {
      "name": "Embeddings",
      "description": "Split the text into chunks and compute one vector per chunk.",
      "behaviour": "one-to-one",
      "params_help": {
        "chunk_tokens": { "type": "number", "default": 512 },
        "overlap_tokens": { "type": "number", "default": 64 },
        "dims": { "type": "number", "help": "Shorter Matryoshka vector; empty = full size" }
      }
    }
  }
}
```

Backend change needed: `prepareTask` resolves `task.model` from `service.models` for **every**
service that has `models`, not only `external_tasks` (and `pickModels` filters them the same way).
Then the Process node gets `model` / `model_version`, which the comparison and the index rely on.

### 3.3 The embeddings file

One file per input text, type `embeddings.json` (a new file type for the UI's `FILE_TYPES`, drawn
by `FileNode`; the JSON display works as is). Plain JSON so anyone can read it with any tool:

```json
{
  "format": "messydesk-embeddings/1",
  "model": { "service": "md-embeddings", "id": "embeddinggemma-300m", "name": "google/embeddinggemma-300m",
             "version": "1", "dims": 768, "normalized": true, "distance": "cosine" },
  "source": { "rid": "#79:123", "label": "page_001.txt", "sha256": "…", "chars": 5123 },
  "chunking": { "unit": "tokens", "size": 512, "overlap": 64, "tokenizer": "model" },
  "created": "2026-10-02T12:00:00Z",
  "document_vector": [0.0123, -0.0456, …],
  "chunks": [
    { "i": 0, "start_char": 0, "end_char": 2011, "tokens": 512, "vector": [0.0101, …] },
    { "i": 1, "start_char": 1790, "end_char": 3870, "tokens": 512, "vector": [ … ] }
  ]
}
```

- `document_vector` is the normalised mean of the chunk vectors, so document-level clustering does
  not need to re-read chunks.
- Character offsets point into the source text, so search hits can be highlighted without storing
  text twice.
- Size: a 768-dim vector written with 6 significant digits is about 8 KB of JSON; a page of OCR text
  is usually 1–3 chunks. If files get too big, version 2 of the format can store vectors as base64
  float32 (`"encoding": "f32-base64"`), about 3.5x smaller, without changing anything else.
- The source text is not copied in. Services that need the text (topics) read the source file
  through `source.rid` / the `DERIVED_FROM` lineage.

Running `embed` on a text Set gives an output Set of `embeddings.json` files, one per text file,
through the existing one-to-one batch path. No new backend dispatch code.

## 4. Vector database

### 4.1 Recommendation: Qdrant, with ArcadeDB 26.x as a close second

Updated 2026-10-02 after Ari asked about ArcadeDB latest and FAISS. ArcadeDB facts are from its
docs ([vector search](https://docs.arcadedb.com/arcadedb/concepts/vector-search)), not tested here.

| | **Qdrant** | **ArcadeDB 26.x** (`LSM_VECTOR`) | Solr 9.7 dense vectors | FAISS |
|---|---|---|---|---|
| What it is | vector database (server) | the graph DB we run, with a vector index on a property | search server with a vector field type | a library inside a process, not a server |
| New component | yes, one container | no, but needs the upgrade from 23.7.1 (backend `LEGACY_ARCADEDB=false`, tested on 25.3.1 only) | no | no server; lives inside a service |
| Several models / dimensions side by side | one collection per model, created at run time | one index per property; a type (e.g. `Chunk_embeddinggemma_768`) or property per model, created with SQL at run time | one schema field per dimension; dims capped at 1 024 by default in Lucene 9 **[check]** | one index file per model |
| Per-user filtering | payload filter during HNSW search; tenant-aware `owner` index | allowed-RID filter from a SQL subquery, or buckets partitioned by a key (e.g. owner) so the search only walks that user's graph; narrow filters are scored directly | `fq` pre-filter | none built in; you keep separate indexes per user/set or filter afterwards |
| Ownership through the graph | no, payload copied in | **yes**: the filter can be the same graph query the access rule uses | no | no |
| Reading all vectors of a scope | `scroll` with filter | SQL | awkward | in memory |
| Deletes | by filter | normal deletes; index skips deleted nodes, rebuild in background (changed in 26.10.1) | by query | poor (rebuild or ID removal, index-type dependent) |
| Quantisation | scalar, binary, on-disk | INT8, BINARY, PRODUCT | scalar **[check]** | many (PQ, IVF, ...) |
| Maturity of the vector part | mature, its whole purpose | young: the JVector-based index arrived late 2025 and its behaviour still changes release to release | stable | very mature, but only as a library |
| Load / blast radius | separate | vectors and kNN load go into the DB every UI request depends on; DB size and backups grow (a 768-dim float vector is 3 KB) | shares the full-text core or needs a second one | none outside the service |

Reading of the table:

- **FAISS is not a candidate for the shared database.** It has no server, no users, no metadata
  filters and weak deletes; MessyDesk would have to build all of that. It is the right tool *inside*
  MD-topics/MD-bertopic for kNN over one set while computing clusters or model comparisons, and
  per-set index files (the old `faiss.json` node type) are isolated simply by being files in the
  user's project.
- **ArcadeDB 26.x is a real option now.** Its strongest point is isolation: a search can be
  restricted with the same graph ownership the rest of MessyDesk uses, instead of trusting a copied
  `owner` field. The costs are the upgrade first, a vector index that is still changing quickly,
  and putting heavy vector storage and kNN queries into the database the whole UI depends on.
- **Qdrant** stays the default because it is purpose-built and mature, keeps vector load away from
  the graph DB, and if it is lost it is rebuilt from the `embeddings.json` files.

Practical route: the backend talks to vectors only through a `VectorStore` interface (`upsert`,
`search(owner, filters)`, `scroll`, `dropBy*`). Phase 2 can start with Qdrant and an ArcadeDB 26.x
implementation can be tried behind the same interface once production is upgraded; the
embeddings files make switching a reindex, not a migration. If ArcadeDB is chosen: chunks as
documents (not vertices) of one type per model, `owner`/`project`/`file` properties, buckets
partitioned by `owner`, and the search filter built from the project ownership query.

Solr remains the fallback if neither a new container nor the upgrade is wanted (Q2): a second core
`messydesk_vectors`, one `DenseVectorField` per dimension, OpenAI-large truncated to 1 536.
pgvector would work too but adds a second database engine with fixed-dimension columns.

### 4.2 Layout

- Collection per model and dimension: `md_<service>_<model>_<dims>`, e.g.
  `md_embeddings_embeddinggemma-300m_768`. Distance cosine (vectors are normalised).
- One point per chunk, plus one point per document (`level: "doc"`) with the document vector.
- Point id: UUIDv5 of `<embeddings file rid>:<chunk index>`, so re-indexing the same file
  overwrites instead of duplicating.
- Payload (all indexed except `start_char`/`end_char`):

```json
{ "owner": "#49:0", "project": "#4:0", "set": "#130:4", "file": "#79:200",
  "source_file": "#79:123", "embed_process": "#109:3", "index_process": "#110:7",
  "model": "embeddinggemma-300m", "level": "chunk", "chunk": 0, "start_char": 0, "end_char": 2011 }
```

`owner` gets a keyword index with `is_tenant: true`; `project`, `index_process`, `file`,
`source_file` and `level` get keyword indexes.

### 4.3 md-qdrant consumer

A descriptor and adapter in MD-consumers, modelled on `md-solr`:

| Task | Behaviour | What it does |
|---|---|---|
| `index` | `many-to-one` (search output, so the result is a search Set like Solr's) | Reads each `embeddings.json` from disk, creates the collection if missing, upserts its points with the payload above, emits `vector_index.json` (counts, model, collection) on the last file. Accumulating is not needed: each job upserts its own file. |
| `delete` | internal | Deletes points by `file` + `owner`. |

`isSearchOutputTask` needs `qdrant` (or `vector`) added next to `solr`/`faiss`, or the descriptor
sets `search_output: true` (preferred: no new magic strings).

The adapter writes `owner = msg.userId` and `project = msg.project_rid` from the message, exactly as
the Solr adapter does; the backend built the message after an ownership check.

### 4.4 Sizing (example: 10 000 pages, EmbeddingGemma 768 dims)

Assumptions: an OCR page is 300–600 words, so about 1.5 chunks of 512 tokens per page, plus one
document vector per page: about **25 000 points**. Formula from Qdrant's
[capacity planning guide](https://qdrant.tech/documentation/capacity-planning/): vectors =
points x dims x 4 bytes; payload RAM = points x payload x 1.5 x 3 when cached; +20 % headroom.

| Part | Size |
|---|---|
| Vectors, float32 (25 000 x 768 x 4 B) | 77 MB |
| HNSW graph (m = 16) | about 3 MB |
| Payload (~300 B/point), cached in RAM | 11 MB on disk, up to 34 MB in RAM (or keep on disk) |
| **RAM total with headroom** | **about 110–140 MB** |
| Same with int8 quantisation, originals on disk | about 20 MB of vectors in RAM, about 40–60 MB total |
| Disk in Qdrant | about 100 MB |
| `embeddings.json` files on MessyDesk disk (~8 KB of JSON per vector) | about 200 MB, more than Qdrant; base64 float32 would halve it |

Scaling: each extra model compared on the same pages adds the same again (1 024-dim models x1.33,
OpenAI large 3 072 dims x4). 50 users at this size is about 1.25 M points, about 5 GB RAM in
float32 or about 1.2 GB with int8 quantisation and originals on disk, which is the setting to use
from the start. Matryoshka 256 dims would cut it to a third again, at some quality cost.

### 4.5 Low-memory option: no vector database (recommended for our environment)

Added 2026-10-02: Ari says the RAM figures in 4.4 are too much for our environment and that speed
is not an issue.

**ArcadeDB does not save RAM.** Its docs say the HNSW graph lives in the JVM heap while in use
(loaded lazily on the first query), new vectors sit in an in-memory buffer until the next rebuild,
and an online rebuild peaks at about 1.7x the memory of a fresh build
([vector embeddings how-to](https://docs.arcadedb.com/arcadedb/how-to/data-modeling/vector-embeddings)).
With INT8 the vectors take about the same space as in quantised Qdrant. The difference is that
this memory comes out of the heap of the database every request depends on, so a squeeze there
slows or breaks all of MessyDesk, not only search.

**If speed does not matter, an always-on vector database is not needed at all.** One user's
10 000 pages are about 25 000 vectors; comparing a query against all of them directly (no index)
is about 20 million multiply-adds, a few milliseconds in numpy, and even a million vectors is
under a second. So:

- **The index is a file.** A `vectors` task (whole-set, on an embeddings Set) packs the set's
  vectors into one matrix file, `vector_index.npy` (float16 or int8, row-major), plus
  `vector_index.json` (model, dims, and per row: file rid, chunk, char range). Both are ordinary
  output File nodes in the user's project, like the old `faiss.json`.
- **Search is a queued task** (`query`, text as a param) on an index node, handled by
  MD-embeddings, which already has the model loaded: it embeds the query, memory-maps the matrix,
  scans it in blocks and writes `similarity.json` for the existing `SimilarityDisplay`. RAM during
  a search is the block being scanned (a few MB); nothing stays resident between jobs. Searching
  several indexes is the same job with several files.
- **Isolation needs nothing new.** Index files are the user's files; the backend only puts paths
  the user owns into the message, exactly as for every other job. There is no shared store that
  could leak between users, and deleting a project deletes its indexes with it. Section 5's rules
  for Qdrant then do not apply.
- **No backend call to services.** Q1 disappears, because the query is embedded inside the job.
  The cost is that search is not interactive: the user starts a search and opens the result node.
- **Clustering, topics and comparison** read the same matrix files (or the embeddings files) with
  numpy/FAISS inside their own jobs, so they need no database either.
- **Upgrade path:** if interactive search is wanted later, Solr (below) or Qdrant with vectors,
  graph and payload all on disk (`on_disk: true`) can be loaded from the same files.

**Solr is the low-RAM choice if search must be interactive.** Lucene keeps vectors and the HNSW
graph in index files that are memory-mapped, so they live in the OS page cache, not in Solr's JVM
heap; with little free RAM queries get slower but keep working. It is already running, the owner
filter is the same `fq` as full-text search, and BM25 + vector hybrid queries become possible.
Needed: a second core `messydesk_vectors` (so full-text counts stay clean), one dense vector field
per dimension (768 fits under Lucene's default 1 024 limit; byte/int8 encoding to shrink files
**[check which encodings Solr 9.7 offers]**), and the md-qdrant consumer becomes an `md-solr`
`index_vectors` task. Heap is still used while segments are built and merged, which can be bounded
by indexing in small batches. Interactive search brings back Q1 (the backend needs the query
embedded synchronously), and that means the **embedding model must stay loaded**, which costs more
RAM than the whole vector index (next paragraph). Queued search avoids that.

**The real RAM cost is the embedding model, not the vectors.** EmbeddingGemma (300 M parameters)
needs roughly 0.6 GB in bf16 or 1.2 GB in float32 while loaded **[check by measuring]**, more than
the vectors of 10 000 pages. Under Nomad the service can be started for a batch and stopped
afterwards (the backend already has Nomad start/stop routes), or the model can be unloaded after
an idle timeout, so it costs nothing while nobody embeds.

## 5. Multi-user isolation

The rule: **a user's vectors are only ever read through the backend, which adds the owner filter
itself; consumers write only what a backend-built message tells them to.**

1. **Network**: Qdrant is not reachable from the UI or the proxy. Only the backend and the
   md-qdrant consumer get `QDRANT_URL` and `QDRANT_API_KEY`. MD-topics and MD-embeddings never talk
   to Qdrant.
2. **Writes**: points carry `owner` (user RID) and `project` from the message. The message is built
   by the backend after `AccessService.findOwned` on the input set and delivered over the
   service-token API, so a consumer cannot be steered by a user into writing someone else's owner.
3. **Reads**: `VectorStore.search` in the backend takes the caller from the auth context and always
   adds `must: [{ key: "owner", match: user.rid }]`; there is no method without it (admin tools get
   a separate, named method). Optional `project` / `index_process` filters are first checked with
   `findOwned` / `isProjectOwner`; a foreign RID gives 404 as elsewhere.
4. **Hits are re-checked**: the backend resolves each hit's `file` through the graph (it needs the
   label and path anyway) and drops anything `findOwned` rejects, so a stale point (e.g. a file
   moved or deleted) never leaks.
5. **Deletes follow the graph**: the cascade delete in `graph.ts` that calls
   `solr.dropProcessIndex` / `dropFileIndex` also calls `vectors.dropByProcess` /
   `vectors.dropByFile`; project delete calls `vectors.dropByProject(owner, project)`; user removal
   calls `vectors.dropByOwner`. Deletes go to every collection (the list is small).
6. **One collection per model, not per user**: per-user collections do not scale in Qdrant and
   complicate model comparison. Tenant isolation is the payload filter plus the `is_tenant` index,
   which also keeps each user's points together on disk.
7. **Whole-set jobs** (section 7) get only file paths the backend listed from a set the user owns;
   the service reads those files from disk and nothing else.

## 6. Semantic search

### 6.1 Scope

Like Solr search: across all of the user's indexed material, optionally narrowed to projects or to
one vector index (search Set). The model is chosen per search (only models the user has indexed
something with are offered: `GET /api/search/semantic/models` = distinct `model` values among the
user's points, via a filtered facet/count).

### 6.2 Backend

New module `src/modules/vectors/` plus `src/platform/qdrant/` client, following the layering rules:

| Route | Auth | Purpose |
|---|---|---|
| `POST /api/search/semantic` | user | `{ query, model, projects?, index?, level: "chunk" \| "doc", limit }` -> hits with file rid, label, score, char range and a text snippet read from the source file |
| `GET /api/search/semantic/models` | user | models the caller has vectors for |
| `POST /api/vectors/{rid}/similar` | user | "more like this": neighbours of a file's document vector (no query embedding needed) |

### 6.3 The query vector (Q1)

A search needs the query embedded with the same model. Default: the backend calls the embeddings
service's small synchronous endpoint `POST /embed { model, texts, mode: "query" }` at the URL the
consumer registered (`service.url` in the registry), with a short timeout, and answers 503 when the
service is down. This is the same kind of call as the synchronous Solr query: one short text, not
processing. It does bend "the backend never calls services", hence Q1.

If Ari says no: semantic search becomes a queued task on a vector index (`query` task with the text
as a param); the md-embeddings consumer embeds the query and the md-qdrant consumer runs the kNN
with the owner from the message, producing a `similarity.json` file shown by the existing
`SimilarityDisplay`. It works, but search is no longer interactive.

### 6.4 UI

A "Semantic" toggle on the existing search page (same result grid), model picker, and "Similar
documents" on a file that has embeddings. Saving a search as a `similarity.json` node can come later
and reuses the existing display.

## 7. Whole-set analyses (MD-topics)

### 7.1 New behaviour `whole-set`

Clustering, topics and comparison have to see the whole corpus at once. `many-to-one` sends one
job per file and parallel consumers can finish them in any order, so the backend gets one more
behaviour:

- `whole-set`: `queueSet` creates the same SetProcess + output Set as `many-to-one`, and publishes
  **one** job to `<topic>_batch` with `files: [{ "@rid", label, path, type, extension, source_rid }]`
  (the files the backend listed through `setFiles` for the owner) and `total_files: 1`.
- It is set-only (`set_only`), skipped by `pickTasks` for single files, and goes through the normal
  results path. `queue_options.max_attempts` can be lowered for long jobs; `always_batch` already
  exists.

This is about 40 lines in `processing.ts` plus a unit test, and it is useful beyond embeddings
(e.g. any corpus-level statistics).

### 7.2 MD-topics service

FastAPI, disk mode, `elg_fs` adapter. Input: a Set of `embeddings.json` files (from one model).
For topics it also reads the source texts through `source.rid` -> the source file path, which the
backend adds to each entry of `files` (`source_path`).

| Task | Output files | Method |
|---|---|---|
| `cluster` | `clusters.json`, `clusters.png` | UMAP (cosine) to ~5–10 dims, HDBSCAN (`min_cluster_size` param), or k-means when `k` is given. `level` param: document or chunk. Output: cluster per item, size, the items nearest each centroid, 2-D UMAP coordinates for plotting. |
| `topics` | `topics.json`, `topics.html` | BERTopic with the **precomputed embeddings** (`fit_transform(docs, embeddings)`), UMAP + HDBSCAN + c-TF-IDF; `CountVectorizer` with a stop-word list chosen by `language` param (Finnish and English lists shipped in the image); optional KeyBERT-inspired representation. Output: topics (id, top words with weights, size, representative docs), document -> topic with probability, and the BERTopic HTML visualisations (the `html` file type is already displayable). |
| `topic_labels` (later) | updated `topics.json` | Name topics with an LLM through the existing Ollama service; kept separate so `topics` stays on-premise and deterministic. |
| `compare_models` | `comparison.json`, `comparison.png` | See 7.3. |

Granularity default: chunks for topics (BERTopic works best on paragraph-sized text; a page is
often one chunk anyway), documents for clustering; both are a `level` param.

Determinism: UMAP and HDBSCAN get a fixed `random_state` param (default 42) stored in the output,
so a run can be repeated.

Later (not in this plan's first phases): write clusters and topics back as tags through the
existing `autotag` / `TagLink` path, so the tags page and Solr tag fields can browse them.

### 7.2a BERTopic as its own service (MD-bertopic)

Yes, BERTopic works with these embeddings, and it is a good candidate for its own service:

- **Precomputed embeddings are supported directly**: `BERTopic(embedding_model=None)` and
  `fit_transform(docs, embeddings=E)`. BERTopic itself then never loads an embedding model, so the
  same topic service works for EmbeddingGemma, BGE-M3 or OpenAI vectors alike, and comparing topic
  models across embeddings is just running it on two embedding sets.
- **It needs the texts as well as the vectors**: c-TF-IDF builds topic words from the text. The
  service gets each embeddings file plus its `source_path`, and cuts chunk texts with the
  `start_char`/`end_char` offsets in the embeddings file.
- **Representations that need the embedding model** (KeyBERTInspired, MaximalMarginalRelevance)
  embed candidate words, so they would have to call the same model. Default: plain c-TF-IDF with a
  language-specific stop-word list, which needs no model. KeyBERT-style words are offered only for
  open models, with MD-bertopic loading that model itself; LLM topic names go through the existing
  Ollama service as a separate step (`topic_labels`).
- **Later documents** can be assigned to an existing topic model with `transform(docs, embeddings)`
  as long as they were embedded with the same model; the fitted model is saved
  (`topic_model/` with safetensors) next to `topics.json` so this is possible.

Split of services, default: **MD-bertopic** (tasks `topics`, `topic_labels`) and **MD-topics**
renamed **MD-embedding-analysis** (tasks `cluster`, `compare_models`). Both use the same
`whole-set` job and input format, so a user sees them as two crunchers on an embeddings set.
Keeping BERTopic separate isolates its heavier, faster-moving dependency stack (bertopic, umap,
hdbscan, plotly) and lets it be swapped for another topic method (e.g. Top2Vec or an LLM-only
approach) without touching clustering. FAISS is used inside both for kNN.

### 7.3 Comparing models on the same material

Workflow: run `embed` twice (or more) on the same text Set with different models. Each run is a
Process with `model` on it and its own output Set.

`compare_models` runs on the **text Set** (whole-set), and the backend fills `files` with, per
model, the embeddings files derived from that set's files (lineage: text file <-`DERIVED_FROM`-
embeddings file, grouped by the producing process's `model`). Default: compare every embedding run
of that set; a run picker in the task dialog can come later. Metrics, all on the documents both
runs cover:

- **Neighbourhood agreement**: for each document, Jaccard overlap of its k nearest neighbours under
  model A and model B (k = 10), averaged and as a distribution.
- **Similarity structure**: Spearman correlation of the pairwise cosine similarities (a
  Mantel-style test), and linear CKA between the two embedding matrices.
- **Cluster agreement**: ARI and NMI between the clusterings each model gives with the same
  settings.
- **Side-by-side map**: aligned 2-D UMAP plots per model, coloured by model A's clusters, as PNG.

Output `comparison.json` holds the numbers per model pair plus the documents whose neighbourhoods
differ most (where a human should look).

Semantic-search comparison comes for free: the same query against two models' collections; the UI
can show both result lists side by side later.

## 8. Changes by repository

| Repository | Change |
|---|---|
| `MessyDesk-new` | `platform/qdrant/` client (`VectorStore` interface); `modules/vectors/` (search, similar, models, drops); cascade delete, project delete and user delete call the drops; `whole-set` behaviour in `queueSet` + `resolveBehaviour`; `prepareTask` model resolution for all services with `models`; `files` entries with `source_path` for whole-set jobs; config `QDRANT_URL`, `QDRANT_API_KEY`, `VECTOR_SEARCH_TIMEOUT_MS`; Qdrant in `docker-compose.yml`; wiki page `architecture/vectors.md`; contract tests for the new routes including a second user who must see nothing. |
| `MD-consumers` | `qdrant` adapter + `md-qdrant` descriptor. MD-embeddings and MD-topics use the existing `elg_fs` adapter (checked to be generic enough when building; a whole-set job is still one `/process` call). |
| `MD-embeddings` (new) | service, Dockerfile (CPU image; GPU image optional), model cache volume, `nomad.hcl`, two `service.json` variants. |
| `MD-topics` (new) | service, Dockerfile, `nomad.hcl`, `service.json`. |
| `MessyDesk-UI` | file types `embeddings.json`, `vector_index.json`, `clusters.json`, `topics.json`, `comparison.json` (FileNode + JSON display first); semantic toggle and model picker on the search page; "Similar documents" in the file viewer. Dedicated cluster/topic views later. |

Old `MessyDesk` is not touched.

## 9. Phases

1. **Embeddings files.** MD-embeddings with EmbeddingGemma and OpenAI, the `prepareTask` model fix,
   `embeddings.json` file type in the UI. Useful alone: files can be downloaded and analysed
   elsewhere.
2. **Vector index and search.** Qdrant, md-qdrant, `modules/vectors`, cascade deletes, semantic
   search + "similar documents", isolation contract tests.
3. **Whole-set behaviour and clustering.** Backend `whole-set`, MD-topics `cluster`.
4. **Topics and model comparison.** `topics`, `compare_models`, then `topic_labels` and tag
   write-back.

## 10. Questions for Ari (defaults apply until answered)

| # | Question | Default |
|---|---|---|
| Q1 | May the backend call the embeddings service synchronously to embed a search query (one short text, short timeout)? | Not needed with file-based indexes (4.5); only relevant if a vector database is chosen later. |
| Q2 | File-based indexes with queued search (no database), Qdrant, ArcadeDB 26.x or Solr? | **File-based indexes** (4.5), since RAM is tight and speed is not an issue; Solr vectors if interactive search is wanted. |
| Q3 | Is there a GPU on the production host for MD-embeddings / MD-topics? | **CPU only**: EmbeddingGemma 300M as default, BGE-M3 offered but slower. |
| Q4 | May users send their texts to OpenAI at all, and if so for everyone or only a service group? | **Only users in an `external-ai` service group** (the descriptor's `service_groups`), as with other external AI services. |
| Q5 | Are the Gemma licence terms acceptable for the default model? | **Yes**; if not, BGE-M3 (MIT) becomes the default. |
