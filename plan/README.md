# MessyDesk backend rewrite: plan

Status: implemented 2026-10-01 (see [decisions.md](decisions.md) and ../wiki/architecture/backend-structure.md).

The new backend lives on the `rewrite` branch of `MessyDesk` (it was developed in a separate `MessyDesk-new` checkout, merged here on 2026-10-06). The old `MessyDesk`, `MessyDesk-UI` and `MD-consumers`
repositories are not touched. The new backend must be a drop-in replacement: same HTTP API, same
SSE messages, same queue message format, same ArcadeDB schema, same data directory layout and same
`queue.sqlite` file, so it can start against an existing installation and the UI and consumers
don't notice.

Files in this folder:

| File | What it is |
|---|---|
| [README.md](README.md) | This plan |
| [endpoints.md](endpoints.md) | Every backend route, its auth, and who calls it: the contract |
| [questions.md](questions.md) | API oddities found while reading the code |
| [decisions.md](decisions.md) | Ari's answers to questions.md; these override anything else in this plan |
| [ui-calls.md](ui-calls.md) | Every call the UI makes, with bodies, response fields read and call sites |
| [consumer-calls.md](consumer-calls.md) | Every call MD-consumers make, the claim loop, and the message fields adapters read |
| [performance-testing.md](performance-testing.md) | How to measure the size limits (files per set/project, tags, search index) and the bottlenecks the code suggests |
| [llm-adapter.md](llm-adapter.md) | One LLM adapter for OpenAI-compatible providers plus Gemini, provider config, prompt → model → provider flow, LLM autotagger; open questions |

## 1. What the current backend looks like

About 14 000 lines in `src/`. The problems the rewrite fixes:

- **One 4 200-line `graph.mjs`** holds the data access for every domain (projects, files, sets,
  processes, tags, NER browsing, service groups, prompts, users) plus business rules, path
  building, thumbnail URL building and Solr side effects.
- **Business logic in route handlers.** `routes/queues.mjs` (940 lines) builds queue messages,
  decides one-to-one / one-to-many / many-to-one dispatch and root-source grouping inline;
  `routes/services.mjs` contains an 800-line help-bundle crawler; `routes/files.mjs` contains the
  upload pipeline and the zip job store.
- **Copy-paste.** Three dispatch loops (`dispatchSetFilesForBatch`, `dispatchSetFilesForReindex`,
  the many-to-one loop), four thumbnail-job builders with different field sets, two `create`
  functions (`create`, `createWithSQL`), two attribute setters (`setNodeAttribute`,
  `setNodeAttribute_old`), several near-identical RID normalisers, two ancestor walkers
  (`getSetFiles` grouped mode, `groupFilesByRootSource`), two NER mention aggregators.
- **Queries built by string interpolation** almost everywhere (see questions B7).
- **Access control done four different ways** (`hasAccess` traversal, `getUserFileMetadata`,
  `getNodeAttributes`/`isNodeOwner` MATCH up to depth 30–100, `isProjectOwner`), and missing in
  several routes (questions B1–B5).
- **Dead code and dead paths**: `styles.mjs`, `schema_old.mjs`, `user-examples.mjs`, `mailer.js`,
  `img-size.js`, `local-*.js`, `getDataWithSchema`, `getProject_old`, `getProject_`,
  `getSetThumbnails_old`, the `groupByOrigin` branch of `getSetFiles`, transaction helpers that call
  functions `db.mjs` doesn't have, NATS stubs in `queue.mjs`, legacy-edge fallbacks.
- **Hidden coupling through module state**: the service registry, SSE connections and paused /
  cancelled batch sets are module singletons imported everywhere; tests replace functions on
  imported objects.
- **Magic strings** for service ids and roles (`md-thumbnailer`, `md-poppler` vs `md-poppler_fs`,
  `md-pypdf_fs`, `md-pdf-splitter_fs`, `md-zip_fs`, `md-solr`, `md-sharp`; `role` `thumbnail` /
  `thumbnails` / `internal_versioning` / `exif_rotate` / `import`) spread over six files.

What is good and should be kept as behaviour: the SQLite queue design (leases, retries, auto-abort,
sweeper), the sharded data layout, the service registry persisted to `service-registry.json`,
`TagLink` as a document type, the import pipeline, and the existing unit tests as a source of cases.

## 2. Principles

1. **The contract is frozen.** [endpoints.md](endpoints.md) plus the SSE and queue-message
   sections are the spec, as amended by [decisions.md](decisions.md) (security fixes, dropped
   routes, service credentials). Any other deviation needs a new decision.
2. **Prove it with contract tests, not by reading.** Before any module is rewritten, its routes get
   HTTP-level tests that record the old backend's responses on a seeded database; the new backend
   must pass the same tests.
3. **Thin routes, plain services, one place for queries.** A route parses and validates input,
   calls one service function, and maps the result. Services hold the rules. Only repositories talk
   to ArcadeDB, Solr, the file system or SQLite.
4. **Bound parameters only.** No string-built SQL/Cypher anywhere except type and edge names from a
   fixed list.
5. **One way to check access.** Every route that takes a rid goes through one `access` service.
6. **Explicit dependencies.** A composition root builds the config, clients, repositories and
   services and passes them in. No module-level singletons except the logger. Tests use fakes
   instead of patching imports.
7. **No new features during the rewrite.** Improvements wait until after cutover, except the fixes
   you approve in questions.md.

## 3. Proposed structure

TypeScript run by Node's type stripping, on Hapi 21 (decisions A1, A2).

```
MessyDesk-new/
  package.json
  src/
    main.ts                      composition root: config → clients → repos → services → server
    config.ts                    every env var in one typed object (names and defaults unchanged)
    platform/                    no domain knowledge
      http/
        server.ts                Hapi setup, CORS, payload defaults, static files
        auth.ts                  mail-header scheme + development bypass (as today) and the
                                 `service` token strategy for consumers (decision B8)
        errors.ts                one mapping from domain errors to Boom responses
        validate.ts              rid / query / body validation helpers
      arcade/                    ArcadeDB HTTP client: sql(), cypher(), params, retries, transactions
      sqlite/                    node:sqlite connection for the queue
      solr/                      Solr HTTP client
      nomad/                     Nomad HTTP client
      storage/                   data dir layout (sharded paths), safe path resolution, JSON files, tmp dir
      sse/                       connection hub (per user), send(), typed event builders
      ids.ts                     Rid type, parse/format (with and without '#'), uuidv7
      logger.ts
    contracts/                   types shared across modules
      queue-message.ts           the message envelope and every field in consumer-calls.md §4
      sse-events.ts              add / update / process_update / process_finished payloads
      service-descriptor.ts
    modules/
      access/                    owner lookup and assertCanRead/Write(user, rid); admin guard
      users/                     /api/me, settings, users, permission requests, /api/sso
      projects/                  projects CRUD, storage summary and sizes, reindex-search
      desk-graph/                GET /api/projects/{rid} graph projection (Vue Flow nodes/edges, set previews)
      graph/                     generic vertex/edge routes, traverse, ancestors, cascade delete
      files/                     upload, download, documents, versions/revert, metadata extraction
      thumbnails/                serving thumbnails, building and queueing thumbnail jobs (all variants)
      sets/                      set creation, file listing, set manifest, file count, zip export jobs
      sources/                   sources and source init
      processing/                single-file, set and source dispatch, pipelines, behaviour rules,
                                 many-to-one root-source grouping, message building
      batches/                   batch state (SetProcess counters), pause/resume/cancel/dismiss
      queue/                     SQLite job store, claim/heartbeat/complete/fail, auto-abort, sweeper
      results/                   consumer callbacks: files, tmp, done, error, metadata (+ csv stub)
      import/                    PDF auto-import and its completion
      services/                  registry (persisted), descriptor normalisation, consumer liveness,
                                 matching services to a node, install/forget/reload
      service-help/              help ingest (crawler and archive), help asset serving
      help/                      static help pages
      service-groups/
      nomad/                     status and start/stop routes
      tags/                      entities, entity types, TagLink, tags, machine tags, autotag
      ner/                       ner.json regions and label browsing (Faceted ROI-data)
      rois/
      filters/                   filter list, tag-filter set
      prompts/
      search/                    Solr search/info, tag sync to Solr
  test/
    contract/                    HTTP contract tests run against old and new backend
    unit/                        per-module tests with fakes
    fixtures/                    seed data and recorded responses
  wiki/                          copied from MessyDesk and corrected as modules land
```

Each module has the same files where they apply: `routes.ts` (Hapi route table only),
`service.ts` (use cases), `repo.ts` (ArcadeDB/Solr/disk access), `types.ts`, and tests.

### Module boundaries that matter

- **`results` is the heart of processing** and today the most tangled code
  (`processFilesController.mjs`). It becomes a small dispatcher that classifies a callback
  (thumbnail, internal rotate, import, normal output, reference output, error) and hands it to
  one handler each. The classification rules (role, `process.kind`, `task.id`, service id) live in
  one function with tests for every message shape listed in consumer-calls.md, including the
  whitelisted `/tmp` shape from `elg_fs`, which lacks fields the full-message adapters send.
- **`processing` owns message building.** One `buildMessage()` replaces the six places that build
  queue payloads today, so field names stay identical everywhere. One `dispatchFiles()` replaces
  the three loops.
- **`thumbnails` owns all thumbnail rules**: which topic (`md-thumbnailer`, `md-poppler`,
  `md-poppler_fs`), which params, which role, the set-preview refresh and the split-PDF cover
  mirroring. Service ids become named constants in one file.
- **`queue` knows nothing about the graph.** Today `queue.mjs` imports `graph.mjs` (to create
  process nodes and resolve project rids) and `graph.mjs` imports `queue.mjs`. In the rewrite
  `processing` creates nodes and then calls `queue.publish()` with a finished message;
  `queue.fail()` returns an "auto-aborted" result and `batches` updates the graph and sends SSE.
- **`access` is the only place that decides ownership.** Most nodes carry `project_rid`, so the
  check becomes "load node → its project → HAS_OWNER user", with the old traversal as fallback for
  nodes without `project_rid`. Behaviour stays the same; it just becomes one query instead of four styles.
- **`desk-graph` keeps the Vue Flow conversion** (`convert2VueFlow`) out of the database client,
  where it lives today.

## 4. Preserving the API exactly

1. **Freeze the contract.** Done for routes in [endpoints.md](endpoints.md). Still to do before
   coding: one JSON example per response shape, captured from the running old backend.
2. **Contract test harness** (first code to be written, in `test/contract/`):
   - Seed script that builds a known database and data dir: users (admin and normal), two projects,
     sets, files of each type (image, pdf, text, ner.json, roi.json), a finished batch, tags.
   - Tests call each route over HTTP with the `mail` header, and fake consumers drive the queue and
     callback routes the way `elg`, `elg_fs`, `poppler` and `solr` do.
   - Responses are compared to recorded fixtures with volatile fields masked (rids, uuids,
     timestamps, absolute paths).
   - SSE is recorded per test and compared the same way.
   - The same suite runs against `MESSYDESK_URL=old` and `=new`.
3. **Shadow reads during development.** A small script replays GET requests against both backends
   pointed at copies of the same data and diffs the JSON.
4. **Message contract tests.** Types in `contracts/queue-message.ts` plus golden payloads for every
   job the backend publishes (single file, set batch, many-to-one grouped, source, thumbnail ×3,
   rotate, import split, zip, solr index, solr update_tags, source init).
5. **UI smoke run.** MessyDesk-UI's own Playwright tests (`npm run test:e2e`, and
   `E2E_WRITE=1` for data-changing tests) run against the new backend before cutover.

## 5. Build order

Each step ends with its contract tests passing against the new backend.

| Step | Scope | Why this order |
|---|---|---|
| 0 | Contract harness, seed data, recorded fixtures from the old backend | Everything else is measured against it |
| 1 | Platform: config, logger, ArcadeDB client, storage paths, ids, Hapi server, auth, errors, SSE hub, static files | Shared by all modules |
| 2 | `access`, `users`, read-only `projects`, `desk-graph`, `graph` reads, `files` reads (download, documents, ancestors), `thumbnails` serving, `sets` listing, `help` | Read paths are easy to compare and unblock the UI's main screens |
| 3 | `queue` (store, claim/heartbeat/complete/fail, sweeper) and `services` (registry, register, adapters, liveness, matching) | Consumers can connect to the new backend |
| 4 | `results` callbacks, `thumbnails` jobs, `import` | The hardest part; needs steps 2–3 |
| 5 | `processing` and `batches`: single-file, set (all three behaviours, root-source grouping), source, pipeline, pause/resume/cancel, dismiss | Builds on 3 and 4 |
| 6 | Writes: upload, versions/revert, project/set/source create/update/delete, cascade delete, `tags`, `ner`, `rois`, `filters`, `prompts`, `service-groups`, settings, users | Many small modules |
| 7 | Admin and ops: install/forget/reload, `service-help` ingest, `nomad`, queue cleanup/flush, reindex-search, update-size, `search` | Lower traffic, more external systems |
| 8 | Full UI Playwright run, real consumers on a copy of production data, then cutover | |

Cutover: stop old backend, back up ArcadeDB, `data/` and `queue.sqlite`, start the new backend on
the same port with the same env, keep the old one ready for rollback (same data, so rollback is just
starting it again, as long as no schema change was made).

## 6. Data compatibility

- ArcadeDB: same vertex, document and edge types, properties and indexes as `db.mjs createDB` /
  `ensureIndexes` and `graph.initDB`. The rewrite creates them idempotently in the same way.
- Disk: same `DATA_DIR` layout (`projects/<rid>/{files,processes,sets,sources}/<uuid shard>/…`),
  same `set.json`, `message.json`, `params.json`, `error.json`, `preview.jpg`/`thumbnail.jpg`,
  `.original` backups and `tmp/` job files.
- Queue: same `queue_jobs` table and pragmas; the only addition I'd propose is a table for
  paused/cancelled batches (question D8), which the old backend would ignore.
- Service registry: same `service-registry.json` format.
- Env vars: every variable the old backend reads keeps its name and default, including the odd
  `DISK_QUOTA` (documented as `DISK_QUOTA_GB`).

## 7. Risks

- **Undocumented message fields.** Services downstream of `elg`/`elg_fs` read the whole message
  (for example md-zip_fs needs `set_files`, `zip_output_name`, `db_name`). Mitigation: golden
  payload tests for every published job, and a field-by-field diff of `message.json` files written
  by old and new backends for the same action.
- **Timing-dependent batch logic** (counters advanced by callbacks, `current_file >= total_files`,
  updates every 10th file, grouped many-to-one duplicates guard). Mitigation: contract tests with a
  fake consumer that sends callbacks in order, out of order and twice.
- **ArcadeDB 23.7.1 quirks** already worked around in the code (no `IF NOT EXISTS` on indexes,
  retry on MVCC conflicts). Mitigation: keep the same server version during the rewrite.
- **No staging data with real images/OCR locally** (the UI wiki notes the same). Mitigation: run
  step 8 on a copy of a real installation.

## 8. Decisions

All questions are answered in [decisions.md](decisions.md): TypeScript, Hapi, legacy edges dropped,
one cutover, all security holes fixed, a separate service credential for consumers (with a logged
legacy fallback until MD-consumers are updated), debug and unused routes dropped, wiki updated in
MessyDesk-new, and MD-consumers problems listed as follow-up work.
