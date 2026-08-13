# Invariants & Non-Obvious Behavior

This page documents invariants, edge cases, and design decisions that are not immediately apparent from reading the code. Breaking any invariant listed here will likely cause subtle bugs.

## Graph Topology Invariants

### 1. HAS_OWNER reachability determines access

**[verified]** — `graph.hasAccess()` does `TRAVERSE out() FROM {item_rid}` and checks if user_rid appears in results.

**Consequence**: Any node without an outgoing path to a User vertex (through HAS_OWNER) is invisible to all users. Orphaned nodes become permanently inaccessible.

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

**[verified]** — `deleteNode()` discovers children via:
- DERIVED_FROM incoming edges (descendants)
- DERIVED_FROM edges with matching `process_rid` (process-linked outputs)
- Set members (files where `set = current_rid`)
- SetProcess children (processes where `set_process = current_rid`)

**Does NOT delete**: upstream source files, parent SetProcess nodes.

**Consequence**: Deleting a file deletes all its derivatives recursively. Deleting a set deletes all its member files and their derivatives.

## Processing Pipeline Invariants

### 5. SQLite queue retries failed jobs (max 3 attempts)

**[verified]** — The SQLite queue (`src/queue.mjs`) stores jobs with `max_attempts = 3`. On failure, jobs are requeued with exponential backoff (`500ms × 2^(attempts-1)`, capped at 30s). After max attempts, status is set to `failed` with `last_error` recorded.

**Consequence**: Transient service failures are retried automatically. Permanent failures surface as `failed` status in the queue table.

### 6. SetProcess status gates output materialization

**[verified]** — `processFilesController.mjs` checks `SetProcess.status` before writing each output. If status is `paused`, `cancelling`, `cancelled`, or `done`, the output is silently dropped.

**Consequence**: Pausing a batch during processing means in-flight results may be lost (not queued for later). Services still process, but results are discarded by the backend.

### 7. Task behaviour must be valid before processing begins

**[verified]** — Invalid `behaviour` values are rejected with HTTP 400 before any Process nodes are created. Allowed values: `one-to-one`, `one-to-many`, `many-to-one`.

### 8. Search tasks are automatically many-to-one

**[verified]** — `resolveTaskBehaviour()` treats Solr/FAISS tasks as `many-to-one` regardless of descriptor setting.

### 9. Project context auto-populated in messages

**[verified]** — `messageFactory.mjs` enriches messages with `project_rid` from file, process, or node traversal. This ensures async processing can always check access control.

## File System Invariants

### 10. File paths embed date-based partitioning

**[verified]** — `createOriginalFileNode()` computes paths as `data/{db_name}/{year}/{month}/{day}/{uuid}/{filename}`.

**Consequence**: Moving the clock backward during file creation could create unexpected directory structures.

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

## Service Architecture Invariants

### 17. Services must not call MessyDesk APIs directly

**[verified]** — Documented in `service_architecture.md` and enforced by architecture: services receive input and return output, all integration is via adapters.

### 18. Adapter heartbeat every 30 seconds

**[verified]** — Consumer re-registers adapter and descriptor every 30 seconds. If a consumer crashes without graceful shutdown (SIGINT), the adapter registration persists until the backend notices heartbeat absence.

**[inferred]**: There is no explicit heartbeat timeout on the backend side. Stale adapter entries may persist.

### 19. Descriptor source chain has strict priority

**[verified]** — Runtime `/config` → explicit path → adapter directory → backend registry → topic fallback. A service that exposes `/config` always wins.

## Authentication Invariants

### 20. Production auth trusts upstream proxy entirely

**[verified]** — The `mail` HTTP header is trusted without verification. There is no token, no signature, no session. Security depends entirely on the upstream proxy (Shibboleth, Apache mod_auth, etc.) setting this header correctly.

**Consequence**: If the backend is exposed directly (without the proxy), anyone can impersonate any user by setting the `mail` header.

### 21. Dev mode fails if DB is unreachable

**[verified]** — Even in dev mode, `Graph.myId()` is called for the default user. If ArcadeDB is down, the server returns 503 for all requests.

## ROI Invariants

### 22. One ROI JSON per image per set (upsert)

**[verified]** — Creating ROIs for an image in a set replaces any existing ROI. The POST endpoint acts as an upsert.

### 23. ROI coordinates are percentage-based

**[verified]** — ROIs store coordinates as percentages (0.0–1.0). Conversion to pixels happens at processing time via `media.ROIPercentagesToPixels()`, using the image's stored metadata dimensions.

## Solr Integration

### 24. Solr queries always filter by owner

**[verified]** — Every search query includes the user's RID as a filter. Users cannot search other users' documents.

### 25. Maximum 1000 search results

**[verified]** — Hard cap in `solr.search()`: `Math.min(rows, 1000)`.
