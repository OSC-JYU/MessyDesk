# Invariants & Non-Obvious Behavior

This page documents invariants, edge cases, and design decisions that are not immediately apparent from reading the code. Breaking any invariant listed here will likely cause subtle bugs.

## Graph Topology Invariants

### 1. HAS_OWNER reachability determines access

**[verified]** — `AccessService.findOwned` (src/modules/access/access.ts) matches
`User <-HAS_OWNER- Project <-- node` following incoming edges from the project (in practice
`BELONGS_TO` and `DERIVED_FROM` pointing at it) up to 40 levels. Every route that takes a RID uses
it, and other users' nodes answer 404.

**Consequence**: Any node without a path to a Project owned by a User is invisible to all users. Orphaned nodes become permanently inaccessible.

**Risk scenarios**:
- Manual database edits that remove edges
- Cascade delete that breaks intermediate links
- Creating nodes without linking to a project that has HAS_OWNER

### 2. File `set` attribute is effectively immutable

**[inferred]** — No code path reassigns a file's `set` attribute after initial creation. Files belong to the set they were created in.

### 3. DERIVED_FROM edges carry process context

**[verified]** — `connectDerivedFrom()` stores `process_rid`, `process_id`, `cruncher`, `task` directly on the edge. This is intentional: it avoids extra traversals for lineage queries.

**Consequence**: If you need the process that created a file, query the DERIVED_FROM edge attributes — don't traverse to a Process node.

### 4. Cascade delete is breadth-first and exhaustive

**[verified]** — `GraphService.deleteNode()` discovers children via:
- DERIVED_FROM incoming edges (descendants)
- DERIVED_FROM edges with matching `process_rid` (process-linked outputs)
- Set members (files where `set = current_rid`)
- SetProcess children (processes where `set_process = current_rid`)

**Does NOT delete**: upstream source files, parent SetProcess nodes.

**Consequence**: Deleting a file deletes all its derivatives recursively. Deleting a set deletes all its member files and their derivatives.

A file's directory is removed only when it is the file's own directory (named after its uuid or
legacy rid). Files stored inside another file's directory, like `roi.json` next to its image, are
removed on their own. (The old backend removed the image's whole directory when a ROI was deleted.)

## Processing Pipeline Invariants

### 5. SQLite queue retries failed jobs (max 3 attempts)

**[verified]** — The SQLite queue (`src/modules/queue/queue.ts`) stores jobs with `max_attempts = 3`. On failure, jobs are requeued with exponential backoff (`500ms × 2^(attempts-1)`, capped at 30s). After max attempts, status is set to `failed` with `last_error` recorded.

**Consequence**: Transient service failures are retried automatically. Permanent failures surface as `failed` status in the queue table.

### 6. SetProcess status gates output materialization

**[verified]** — `src/modules/results/results.ts` checks `SetProcess.status` before writing each output. If status is `paused`, `cancelling`, `cancelled`, or `done`, the output is silently dropped.

**Consequence**: Pausing a batch during processing means in-flight results may be lost (not queued for later). Services still process, but results are discarded by the backend.

### 7. Task behaviour must be valid before processing begins

**[verified]** — Invalid `behaviour` values are rejected with HTTP 400 before any Process nodes are created. Allowed values: `one-to-one`, `one-to-many`, `many-to-one`.

### 8. Search tasks write into a search Set

**[verified]** — `isSearchOutputTask()` (src/modules/processing/processing.ts): a many-to-one task of a Solr/FAISS service, or a task with `search_output: true`, gets an output Set of type `search`. The behaviour itself still comes from the descriptor (the old wiki said search tasks were forced to many-to-one; the code never did that).

### 9. Project context auto-populated in messages

**[verified]** — `src/modules/queue/publisher.ts` enriches messages with `project_rid` from file, process, or node traversal. This ensures async processing can always check access control.

### 9a. All processing must go through the queue — never inline

**[verified]** — MessyDesk is a multi-user server application. CPU-intensive work (image resizing, OCR, AI inference, thumbnail generation) must be dispatched to external consumer processes via the queue, never executed inline in a request handler. Inline processing blocks the single-threaded Node.js event loop and degrades performance for all connected users. See [queue-system.md](queue-system.md).

### 10. An uploaded PDF is an `original-pdf`; only the splitter makes `pdf`

**[verified]** — `detectType()` in `src/modules/files/metadata.ts` returns `original-pdf` for every PDF, and `FilesService.upload` stores it without needing any service. `ResultsService.handleOutput` retypes PDF outputs to `original-pdf` unless they come from `md-pypdf_fs` task `split`; those are `pdf` (one page, with `page_number`). Service matching is by `supported_types`: `md-pypdf_fs` lists `original-pdf` and is the only cruncher for it, Poppler lists `pdf`, so Poppler cannot be applied to an original PDF. Use `isPdfType()` (`src/shared/service-ids.ts`) where both count as a PDF (thumbnails, download, viewer).

**Consequence**: splitting is a normal user-triggered task. There is no import flow, no `processable` flag and no `importing` lock.

### 11. The split deletes the original only through the task param

**[verified]** — `ResultsService.finishSplit` runs after the last page of an input PDF arrived (`file_count >= file_total`). It removes the original from disk and sets `_file_removed: true` unless `task.params.delete_original` is `false`. This happens also for a split of a page range. The node stays as provenance. A failed split keeps the original.

### 12. Page ranges are validated before queueing and applied by the backend for sets

**[verified]** — A task param with `format: "page_range"` is checked in `ProcessingService.prepareTask` (400 on a bad range; grammar in `src/shared/page-range.ts`, mirrored in `MD-pypdf_fs/api.py`). A param with `filter: "set_pages"` is applied in `queueSet` and on resume: only files whose `page_number` is in the range are queued, and the param is removed from the task.

### 13. Grouping by original PDF is a view only

**[verified]** — `origin_rid` / `origin_label` on a File (set in `NodesService.createProcessFile` / `createReferenceFile` from the file it derives from) only drive `GET /api/sets/{rid}/files?group=origin` and the set browser. Processing, lineage, tags and search do not read them. The order of the grouped view (PDFs by label, pages by `page_number`, files without a PDF last) is the one order the file viewer steps in (`order=flat`), also when grouping is switched off, so a position in the set means the same in both. The user setting `group_pdf` (`on`/`off`, default `on`) and a toggle in the set view only choose how the set browser shows it. Files made before `origin_rid` existed have none and show flat.

## File System Invariants

### 10. File paths are sharded by uuid

**[verified]** — `DataLayout.filePath()` (src/platform/storage/layout.ts) builds
`<DATA_DIR>/projects/<project rid>/files/aa/bb/cc/<uuid hex>/<uuid hex>.<ext>`; the first bytes of
a UUIDv7 are its timestamp, so files created together share directories. Old RID-based paths
(`<cluster>/<pos div 1000>/<pos>`) are still understood.

### 11. UUIDs embed timestamps (custom UUIDv7)

**[verified]** — First 6 bytes of generated UUIDs contain the timestamp. Used for both sorting and identification.

### 12. Cascade delete sorts paths by length descending

**[verified]** — File paths are sorted longest-first before deletion, ensuring child directories are removed before parents.

### 13. Reference files share source file's disk path

**[verified]** — When `isReference=true`, the output File node points to the source file's path. No bytes are copied. The `ref` attribute stores the source file's RID.

**Consequence**: Deleting a source file while reference files point to it leaves broken references.

## UI Invariants

### 14. Display routing uses `file.type`, not filename

**[verified]** — GraphMain selects display components based on `store.file.type` and `extension`. Users can relabel files, so filename is unreliable for type detection.

### 15. Store is a reactive singleton, not Vuex/Pinia

**[verified]** — `Store.js` exports a single `reactive()` object. All components read/write it directly. No action/mutation pattern.

### 16. Default locale is Finnish (`fi`)

**[verified]** — `createI18n` in `main.js` sets `locale: 'fi'` with `fallbackLocale` from env.

## Events

### 26. Several event streams per user

**[verified]** — `SseHub` keeps every open `/events` connection of a user and sends each event to
all of them. (The old backend kept one per user, so a second tab silenced the first.)

## Service Architecture Invariants

### 17. Services must not call MessyDesk APIs directly

**[verified]** — Documented in `service_architecture.md` and enforced by architecture: services receive input and return output, all integration is via adapters.

### 18. Adapter heartbeat every 30 seconds

**[verified]** — Consumer re-registers adapter and descriptor every 30 seconds. If a consumer crashes without graceful shutdown (SIGINT), the adapter registration persists until the backend notices heartbeat absence.

**[verified]**: The backend drops an adapter not seen for `CONSUMER_TTL_SECONDS` (default 90), so a crashed consumer stops counting as live (PDF gate, cruncher list).

### 19. Descriptor source chain has strict priority

**[verified]** — Runtime `/config` → explicit path → adapter directory → backend registry → topic fallback. A service that exposes `/config` always wins.

## Authentication Invariants

### 20. Production auth trusts upstream proxy entirely

**[verified]** — The `mail` HTTP header is trusted without verification. There is no token, no signature, no session. Security depends entirely on the upstream proxy (Shibboleth, Apache mod_auth, etc.) setting this header correctly.

**Consequence**: If the backend is exposed directly (without the proxy), anyone can impersonate any user by setting the `mail` header.

Consumers use a separate `service` credential (`SERVICE_TOKEN`). While
`SERVICE_AUTH_LEGACY_MAIL=true`, the `mail` header of an admin user is still accepted on consumer
routes, because MD-consumers do not send the token yet.

### 21. Dev mode fails if DB is unreachable

**[verified]** — Even in dev mode, `UsersService.find()` is called for the default user. If ArcadeDB is down, the server returns 503 for all requests.

## ROI Invariants

### 22. One ROI JSON per image per set (upsert)

**[verified]** — Creating ROIs for an image in a set replaces any existing ROI. The POST endpoint acts as an upsert.

### 23. ROI coordinates are percentage-based

**[inferred]** — The UI stores ROI coordinates as percentages. The backend stores the JSON as
given and does not convert it; the old `media.ROIPercentagesToPixels()` was never called and was
not ported.

## Solr Integration

### 24. Solr queries always filter by owner

**[verified]** — Every search query includes the user's RID as a filter. Users cannot search other users' documents.

### 25. Maximum 1000 search results

**[verified]** — Hard cap in `SolrClient.search`: `Math.min(rows, 1000)`.
