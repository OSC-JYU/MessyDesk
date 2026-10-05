# Step 1: query profile (2026-10-05)

Plan step 1 of [plan/performance-testing.md](../../plan/performance-testing.md): the queries behind
the suspected bottlenecks, run with the backend's statements and parameters on direct-loaded data.
Raw numbers and execution plans are in `perf_profile.profile.{S,M,L}.json` next to this file.

**Setup.** ArcadeDB 25.3.1 (`LEGACY_ARCADEDB=false`) in podman, `-Xmx8g`, on a 12-core laptop with
NVMe and 30 GB RAM. Times are the median of 3 runs after a warm-up, measured from Node over HTTP.
Data: users with projects of sets of 1 000 image files, each run through a 2-stage pipeline
(rotate, OCR), so every original has two outputs linked by DERIVED_FROM.

| Dataset | Files in database | DERIVED_FROM edges | Files owned by the profiled user |
|---|---|---|---|
| S | 6 000 | 4 004 | 6 000 (1 project) |
| M | 606 000 | 404 404 | 6 000 (1 project); 20 other users own the rest |
| L | 756 000 | 504 504 | 156 000 (11 projects) |

S → M grows the whole database, M → L grows the profiled user's own data. Production targets are
10 M files in the database and 100 000 pages in one project (plan section 4.3), so M is 6 % of the
database target.

## Results

Median ms. "Scan" means ArcadeDB read every record of the type (from PROFILE).

| Bottleneck | Query (code) | S | M | L | Scan | Verdict |
|---|---|---|---|---|---|---|
| B2 | edge lookup in `connectDerivedFrom` (graph-store.ts:413), runs for **every output file** | 4 | 254 | 325 | DERIVED_FROM | **confirmed**, grows with the whole database |
| B2 | `processedSetRids` (desk-graph.ts:606), runs on every upload into a set and every desk open | 11 | 741 | 920 | DERIVED_FROM | **confirmed** |
| B2 | `processedInputs` (batch-state.ts:90), batch resume | 10 | 341 | 427 | DERIVED_FROM | **confirmed** |
| B10 | delete: outputs of a node (graph.ts:155) | 5 | 308 | 397 | DERIVED_FROM | **confirmed**; 3 such scans per deleted node |
| B10 | delete: edges either way (graph.ts:160) | 6 | 428 | 548 | DERIVED_FROM | **confirmed** |
| B3 | `projectRidOf` (graph-store.ts:427) | 19 | 1 068 | 1 303 | Project, then in-edges | **confirmed** |
| new | `sourceFileOf` / `files.source` / `usePdfThumbnail` MATCH from `{type:File, where:(@rid = …)}` (processing.ts:124, files.ts:177, desk-graph.ts:624, results.ts:169) | 6 | 378 | 478 | **File** | **new finding**: the MATCH reads every File to find one rid. `usePdfThumbnail` runs it per PDF on a set page (B15) |
| new | many-to-one grouping, parents of 1 000 files: `DERIVED_FROM WHERE @out IN :rids` (grouping.ts:63) | 767 | 86 943 | 108 378 | DERIVED_FROM, then the IN list per record | **broken**: 108 s for a 1 000-file set; a many-to-one run over a PDF set cannot start |
| new | 500 files by `File WHERE @rid IN :rids` (processing.ts:307, grouping.ts:73, tags.ts:177) | – | – | 81 372 | **File** | **broken**: 81 s for 500 rids. Whole-set runs (`attachSources`) do this per 500 files |
| B1 | `access.findOwned` (access.ts:28), runs on **every request with a rid** | 28 | 12 | 272 | Project, User; then walks the user's projects | **confirmed**, grows with the user's own data (6 k → 156 k files: 12 → 272 ms) |
| B8 | desk MATCH (desk-graph.ts:463), small project | 27 | 14 | 14 | – | not a problem at 6 000 files; needs S3 with a 100 000-page project |
| B8 | `decorateSets` all members (desk-graph.ts:563) | 82 | 78 | 71 | – | 6 000 rows; grows with the project, not the database |
| B9 | project list count, per project (projects.ts:79) | 44 | 34 | 33 | – | per project; the list runs it for every project, so a user with 11 projects pays 11 traversals |
| B14 | set listing: count, first page, last page (files.ts:260) | 4–6 | 2–5 | 2–4 | – | fine: uses the `File.set` index |
| B5/B6 | set run read, 10 000 limit (processing.ts:222) | 26 | 18 | 17 | – | fine at 1 000; per-file `findOwned` in the dispatch loop is the cost (B1 × N) |
| B4 | `syncSetManifest` items (nodes.ts:118) | 10 | 8 | 8 | – | 8 ms × every added file: O(N²) per set but small at 10 000 (≈ 80 s of DB time per 10 000-file set) |
| B7 | `batches.get` by @rid (batch-state.ts:24) | – | – | 1 | – | fine |
| B12 | tags: grouped entities, project filter, set entities | 8–40 | 8–18 | 8–19 | – | fine at 1 000 entities / 4 000 links; tag scale not grown yet |
| B13 | `findEntity`, `machineTags` | 2–14 | 2–10 | 2–10 | TagLink (machineTags) | fine at 4 000 links; `machineTags` scans all TagLinks, grow in step 4 |
| – | `isProjectOwner`, `createTagLink` lookup, `pruneOrphanMachineTag` | ≈1 | ≈1 | ≈1 | – | fine |

## What it means

1. **Anything that looks up a DERIVED_FROM edge by its ends or by `process_rid` reads every
   DERIVED_FROM edge in the database.** The time grows linearly: about 0.65 ms per 1 000 edges. A
   10 M-file database has roughly 7 M such edges, so each lookup takes about 4–5 s. Every output
   file a consumer returns does at least one (`connectDerivedFrom`), so batch throughput falls with
   database size, for every user, whatever their own data. Deleting a 1 000-file set does three
   per deleted node (members and their outputs, 3 000 nodes here): at M size 20–50 minutes, at
   10 M files many hours, inside one HTTP request.
2. **`WHERE @rid IN :list` and `MATCH {type:File, where:(@rid = :rid)}` read the whole File type.**
   `IN` lists are also checked record by record, so the cost is files × list length: 81–108 s for
   500–1 000 rids at 756 000 files. Many-to-one runs (combine pages of split PDFs, the main use of
   PDF import) and whole-set runs over sets of hundreds of files cannot be started on a database
   of this size, and at 10 M files not even on small sets.
3. **The access check grows with the user's own data**: 272 ms per request for a user with 156 000
   files. A user with one 100 000-page project and its OCR and translation outputs (≈ 300 000
   files) would pay about 0.5 s on every file open, thumbnail, tag and download, and the set-run
   dispatch pays it once per file (10 000 files ≈ 45 minutes inside one HTTP request).
4. **Set listings, counts and the set manifest are fine**: they use the `File.set` index.

All the broken cases have cheap fixes that keep the API as it is. Tried on the L dataset:

| Today | Alternative | L time |
|---|---|---|
| `SELECT … FROM DERIVED_FROM WHERE @out = A AND @in = B` | `SELECT FROM (SELECT expand(outE('DERIVED_FROM')) FROM A) WHERE @in = B` | 325 ms → 13 ms |
| `… FROM DERIVED_FROM WHERE @in = A` | `SELECT expand(inE('DERIVED_FROM')) FROM A` | 397 ms → 10 ms |
| `… FROM DERIVED_FROM WHERE @out IN :rids` (500) | `SELECT expand(outE('DERIVED_FROM')) FROM [rid, …]` | ≈100 s → 23 ms |
| `SELECT FROM File WHERE @rid IN :rids` (500) | `SELECT FROM [rid, …]` | 81 s → 19 ms |
| `MATCH {type:File, where:(@rid = :r)}-DERIVED_FROM->{…}` | `SELECT expand(out('DERIVED_FROM')) FROM :r` | 478 ms → 8 ms |
| `… FROM DERIVED_FROM WHERE process_rid = :p` | same query with a new index on `DERIVED_FROM.process_rid` | 427 ms → 11 ms |

The index was created on the test database only and dropped again. These are not changes to the
backend yet; the access check (B1) needs a separate design (for example a stored owner or
`project_rid` lookup instead of the traversal) and is not in this table.

## Loader note

The direct loader first used `COMMIT RETRY` in sqlscript batches. On ArcadeDB 25.3.1 a retried
block reused the record ids of the failed attempt, which produced an edge to the wrong record and a
lost vertex. The loader now retries the whole script instead, and a check after loading finds no
duplicate edges. The backend does not use sqlscript, so this does not affect it. Also seen: all
inserts of one type go to a single bucket, and parallel loaders conflict on its pages
(`ConcurrentModificationException`); parallel consumer callbacks will hit the same, which S5 measures.
