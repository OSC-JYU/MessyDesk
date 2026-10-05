# Database schema review

Plan step 1b (Ari's answer 3 in [performance-testing.md](performance-testing.md)). This compares
the schema the backend creates (`src/platform/arcade/schema.ts`) with how the code queries it, and
uses the step 1 profile ([../perf/results/step1-query-profile.md](../perf/results/step1-query-profile.md))
for the costs. Nothing here is changed yet; section 5 lists the proposals for Ari.

## 1. Types

| Kind | Types | Notes |
|---|---|---|
| Vertex, in use | Project, Source, User, File, Process, Set, SetProcess, Entity, EntityType, Request, Prompt, ServiceGroup | |
| Vertex, unused | `ErrorNode`, `Person` | Errors are `File` nodes of type `error.json`; "Person" is an Entity `type`, not a vertex type. Nothing creates or reads these |
| Vertex, missing | `Filter` | The project list counts `@type="Filter"` nodes and delete skips their path, but the schema has no Filter type and nothing creates one (filters create a `Process`). Dead condition |
| Document | Usage, TagLink | |
| Edge, in use | BELONGS_TO, DERIVED_FROM, HAS_OWNER, HAS_PROCESS | HAS_PROCESS only for source processes (`processing.ts:387`) |
| Edge, legacy | PROCESSED_BY, PRODUCED, HAS_ITEM, HAS_ENTITY, HAS_SET, HAS_SOURCE | Kept so a rollback to the old backend works (decision A3); no query reads them |

Each type has one bucket, so concurrent inserts of the same type contend on the same pages
(seen while loading test data). That limits parallel consumer callbacks; S5 will measure it.

## 2. Properties and indexes

Only 10 properties are declared; everything else is schemaless. ArcadeDB can only index declared
properties, so an index on, for example, `DERIVED_FROM.process_rid` first needs the property.

| Lookup the code does | Where (count) | Index today | Cost at 756 000 files |
|---|---|---|---|
| `File.set = ?` | 7 places | `File[set]` | 2–8 ms |
| `File.project_rid IN ?` | tags, semantic | `File[project_rid]` | 17 ms |
| `File.uuid = ?` | thumbnails | `File[uuid]` | – |
| `File / Entity WHERE @rid IN ?` | grouping, attachSources, tags, entityItems (6) | none possible: it scans the type | **81 s for 500 rids** |
| `MATCH {type:File, where:(@rid = ?)}…` | source file, PDF thumbnail check (4) | scans File | **478 ms** |
| `DERIVED_FROM WHERE @in / @out = ?` | lineage, delete, set lock, batches (10) | none: edge ends cannot be indexed this way | **300–550 ms each** |
| `DERIVED_FROM WHERE @out IN ?` | grouping, attachSources (3) | none | **108 s for 1 000** |
| `DERIVED_FROM.process_rid = ?` | resume, delete, outputFor (4) | none | 427 ms (11 ms with an index) |
| `Process.set_process = ?` | delete | none | scan of Process |
| `SetProcess / Process.project_rid IN ?` | reindex | none | scan |
| `TagLink.target_rid`, `TagLink.entity_rid` | most tag queries | both indexed | ≈1 ms |
| `TagLink.owner`, `TagLink.created_by` | machine tags, project tag filter | none | scans TagLink (10 ms at 4 000 links; grows) |
| `Entity (type, label, owner)` | every autotag label, every entity link | `Entity[owner]` only | scans the user's entities |
| `User.id = ?` | every request (auth) | **none** | scans User; small, but on every request |
| `Request.id`, `Prompt.owner`, `EntityType.owner` | rare | none | small types |

Edge-end lookups are better done as graph traversals than indexed: starting from the known vertex,
`outE('DERIVED_FROM')` / `inE('DERIVED_FROM')` read only that vertex's edges (10–23 ms in step 1,
for one vertex or for 500 at once).

## 3. Nodes that exist only for bookkeeping

- **A Process per tag change.** `processing.syncTags` (processing.ts:470) creates a `Process` node
  linked to the project, a process directory with `message.json`, and an md-solr `update_tags`
  job for every tag link or unlink, and for every label of every autotag run. Ari agrees the node
  is not needed (answer 3). The UI does not draw Process nodes that have no outputs; they only
  inflate the project's `node_count` and fill `processes/` on disk. Over time this is the largest
  source of Process nodes: tagging 10 000 pages with 3 labels each leaves 30 000.
- **Process per filter run** (`filters.ts:47`): one per use, small.
- **`set.json` per set** (not a node): rewritten on every added file (B4). Its readers are not
  known yet (question 4).

## 4. Data held in two places

- A File's set membership is the string property `set`, while a Set's link to its project is a
  `BELONGS_TO` edge plus `project_rid`. Files also carry `project_rid` and, for uploads, a
  `BELONGS_TO` edge. Outputs get `project_rid` but no `BELONGS_TO`. Access checks and the desk
  traverse edges, while listings filter on properties. The properties are the cheap path: every
  File, Set, Process and SetProcess already has `project_rid`.
- Lineage is the DERIVED_FROM edge plus copies of process data on the edge (`process_rid`,
  `process_id`, `cruncher`, `task`), written by a second UPDATE after the edge is created
  (graph-store.ts:398). Setting them in the `CREATE EDGE … SET` would remove the scan (B2).
- Set counts are stored (`Set.count`) and recomputed with `count(*)` after every added file.

## 5. Proposals (not done; for Ari)

All of these keep the API and the data layout. Indexes and properties are additive: the old
backend ignores them, so rollback still works.

| # | Change | Fixes | Measured gain |
|---|---|---|---|
| P1 | Create DERIVED_FROM with its properties in one statement (`CREATE EDGE … SET process_rid = …`) instead of create + UPDATE by scan | B2, every output file | 325 ms → 0 extra per output file |
| P2 | Edge-end lookups as traversals from the known vertex (`inE`/`outE`), including delete, set lock, grouping, attachSources | B2, B10, grouping | 300–550 ms → ≈10 ms; grouping 108 s → 23 ms |
| P3 | `SELECT FROM [rids]` instead of `WHERE @rid IN :rids`; traversal instead of `MATCH {type:File, where:(@rid…)}` | @rid IN, source file, PDF thumbnails | 81 s → 19 ms; 478 ms → 8 ms |
| P4 | Declare and index `DERIVED_FROM.process_rid`, `Process.set_process`, `User.id`, `Process.project_rid`, `SetProcess.project_rid` | resume, delete, auth, reindex | 427 ms → 11 ms (process_rid) |
| P5 | Composite indexes `Entity (owner, type, label)` and `TagLink (owner, created_by)` | B13 | to measure in step 4 |
| P6 | Access check from the node's `project_rid` (one lookup) with the traversal only as fallback for nodes without it | B1 | 272 ms → expected ≈2 ms; to measure |
| P7 | Drop the Process node for tag syncs; publish the md-solr `update_tags` job without it. The md-solr adapter only echoes the message to `/done`, which falls back to the file rid when there is no process (results.ts:382) | B11 | removes one node, one directory and one file per tag change |
| P8 | Remove `ErrorNode` and `Person` from the type list and the dead `Filter` conditions | tidiness | – |

P1–P4 change only how the backend queries; P6 changes how access is decided, so it needs the
contract tests to prove the same answers; P7 changes what nodes exist (not visible in the UI).
