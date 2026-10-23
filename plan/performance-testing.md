# Performance testing plan

Status: plan, nothing built yet (2026-10-05). Ari's answers to section 8 are recorded there and
applied below.

The goal is to know, with numbers, how big a MessyDesk installation can get before something
breaks or becomes unusably slow: how many files a set and a project can hold, how many tags and
tag links a user can have, how large the search index gets, and which part gives out first.
The plan comes from reading the code of this repository, MessyDesk-UI (`rewrite` branch) and
MD-consumers; section 3 lists what the code suggests will break, so the tests can aim there first.

Nothing here changes the API. Where the code does something that looks like it will not scale
because of the API itself, it is listed as a question for Ari in section 8, not fixed.

## 1. Questions the tests answer

| # | Question | Reported as |
|---|---|---|
| Q1 | How many files can one set hold? | largest N where upload, browse, batch run and delete stay within the limits in section 5 |
| Q2 | How many files and nodes can one project (desk) hold? | same, for opening the desk, the project list and project delete |
| Q3 | How many entities (tags) and tag links can one user have? | largest N where tag pages, tagging and autotag stay within limits |
| Q4 | How large does the Solr index get per indexed document and per GB of text, and how does search latency grow with it? | bytes per doc, bytes per MB of text, p95 search latency per index size |
| Q5 | How many jobs per minute does the queue and callback path sustain, and does batch bookkeeping stay correct under load? | jobs/min at the backend with fake consumers; counter drift |
| Q6 | What does the data directory look like at scale? | files and directories per project, `du` vs. sum of node sizes, time of a size scan |
| Q7 | Where does the UI stop being usable? | render time and frame rate of the desk, set browser, tags page and search results |
| Q8 | Which component breaks first, and how? | per scenario: first failing component and failure mode (timeout, 5xx, wrong data, OOM) |

## 2. Environment

- **Stack:** `local/compose.yaml` with podman (`podman-compose up -d --build`), with the newer
  ArcadeDB (25.x, `LEGACY_ARCADEDB=false`) and Solr 9.7 (answer 9). Limits are reported for this
  version. ArcadeDB 23.7.1 (production today) is run only for the baseline at small sizes.
- **Consumers:** real services only where their cost is the thing being measured (Solr indexing,
  thumbnails in S1). Everywhere else a **fake consumer** (section 6) claims jobs and posts results
  instantly, so the backend, ArcadeDB and the queue are measured and not OCR or ML speed.
- **Baseline:** the same scenarios at the smallest size against the old `MessyDesk` backend on a
  copy of the same data (`TARGET=old`, like the contract tests). The rewrite should not be slower
  than what users have today; where it is, that is a finding.
- **Record with every run:** CPU, RAM, disk type, container memory limits, ArcadeDB and Solr heap
  (`JAVA_OPTS`, `SOLR_HEAP`), git commit of each repo, and dataset size. Results without these are
  not comparable.
- **Resource monitoring during runs:** `podman stats` sampled every 5 s to a CSV, ArcadeDB
  `/api/v1/server` metrics, Solr `/admin/metrics`, Node event-loop delay and heap (via
  `perf_hooks.monitorEventLoopDelay` in a test-only env flag, or `--inspect` sampling).

## 3. Likely bottlenecks found in the code

Ordered by how early I expect each to hurt. "N" is files in a set, "P" nodes in a project,
"U" nodes of all of a user's projects, "E" DERIVED_FROM edges in the whole database.

| # | Where | What it does | Expected growth | Scenario |
|---|---|---|---|---|
| B1 | `access/access.ts` `findOwned` | Every route that takes a rid runs a MATCH from the user over HAS_OWNER and *all* in-edges of every project up to depth 40 until it meets the rid | O(U) per request, unless ArcadeDB plans it from the rid side; verify with `PROFILE` | S4 |
| B2 | `shared/graph-store.ts` `connectDerivedFrom` | `UPDATE DERIVED_FROM ... WHERE @out = .. AND @in = ..` after every edge create; no index on edge endpoints | O(E) per output file, so O(E²) over a database's life | S5 |
| B3 | `shared/graph-store.ts` `projectRidOf` | MATCH that starts from `{type:Project}` with no filter and walks in-edges up to depth 40 | O(all projects × P) if planned from Project; used when a message lacks `project_rid` | S4, S5 |
| B4 | `nodes/nodes.ts` `syncSetManifest`, `updateFileCount` | Each file added to a set re-counts the set and rewrites `set.json` with every member | O(N) per file, O(N²) per upload or batch; concurrent chunks also race on `set.json` | S1, S5 |
| B5 | `processing/processing.ts` `dispatchBatchFiles`, `:222` | Dispatching a set run loads up to 10 000 files in one query, then per file runs `findOwned` (B1) and a batch-state read inside the HTTP request | O(N × U) inside one request; client and proxy timeouts | S5 |
| B6 | `processing/processing.ts, 457, 514` | Set runs, resume and reindex read `setFiles(..., { limit: 10000 })` | Sets over 10 000 files are silently processed only partly (see question 8.1) | S5 |
| B7 | `batches/batch-state.ts` `incrementProcessed` | Read, add one, write back, with no lock; callbacks run concurrently | Lost updates under parallel consumers: batch never reaches `done`, ETA wrong | S5 (correctness) |
| B8 | `projects/desk-graph.ts, 563` | Opening a desk traverses the whole project (set members included, filtered out after traversal), then loads *every* member of every desk-level set including `info` and `metadata`, to pick 2 thumbnails and 2 text samples per set | O(P) query plus O(total set members) rows and payload | S3 |
| B9 | `projects/projects.ts` `list` | The project list counts nodes by traversing every project fully, on every call | O(U) per page load | S10 |
| B10 | `graph/graph.ts` `deleteNode` | Cascade delete runs 5–6 queries per node, three of them scans of DERIVED_FROM by `@in`/`process_rid` (no index), then one Solr `deleteByQuery` with `commit=true` per file | O(N × E) DB work and N Solr commits for a set delete | S9 |
| B11 | `tags/tags.ts` `link` → `reindexFileTags` → `processing.syncTags` | Every tag link change creates a `Process` node, a `message.json` and a md-solr `update_tags` job, which does a full doc re-post with `commit=true` | Autotag of N files × K labels → N×K process nodes, jobs and Solr commits | S7 |
| B12 | `tags/tags.ts` `groupedEntities` | Returns `LIST(label)` and `LIST(@this)` of every entity per type; with a project filter, first loads every File rid of the project into an `IN` list | Response size O(entities); `IN` list O(P) | S7 |
| B13 | `tags/tags.ts, 379` | `findEntity` by (type, label, owner) has only the `owner` index; `machineTags` groups all TagLinks by `owner`, which has no index | O(user's entities) per autotag label; O(all TagLinks) per tags page | S7 |
| B14 | `files/files.ts` `setFiles` | `ORDER BY label SKIP :skip LIMIT :limit` on the set; deep pages sort the whole set; `limit` has no upper bound | O(N log N) per page; one request can ask for all N | S2 |
| B15 | `files/files.ts`, `results.ts` | One MATCH per PDF in a page / preview to decide the PDF icon | N+1 queries for PDF-heavy sets | S2 |
| B16 | `queue/queue.ts` | Every job payload carries the full service descriptor and file node; whole-set jobs carry every file; `activeJobs` parses up to 200 payloads per call | SQLite file size and jobs-panel latency grow with payload size | S6 |
| B17 | Solr schema `tools/solr-init-v2.sh` | `fulltext` uses NGram 2–15 and is stored, and is copied to a stored `fulltext_exact`; search highlights both | Index many times the text size; highlighting cost grows with document length | S8 |
| B18 | `semantic/semantic.ts` `indexes` | Per index file: reads a header from disk and runs 3–4 queries | O(index files) per Search tab open; small in practice | S8 |
| B19 | `projects/projects.ts` `updateSizes` | Walks every file of every project with `stat` | O(files on disk); blocks one request | S11 |
| B20 | `platform/sse/hub.ts` | Writes to a `PassThrough` with no backpressure | A stalled browser tab buffers every event in backend memory | S13 |
| B21 | UI `useDeskGraph.js`, `GraphCanvas.vue` | Vue Flow renders every desk node and edge; layout runs on every add event | Render time with desk size | S12 |
| B22 | UI `client.js` `uploadFiles` | Chunks of 20 files, 3 in parallel, all into one set | Hits B4 three times in parallel | S1 |
| B23 | `platform/storage/layout.ts` `shard` | The shard is the first 3 bytes of a UUIDv7, which are the top of the millisecond timestamp and change only every 2^24 ms (about 4.7 hours) | Everything a project creates in a 4.7-hour window lands in one leaf directory: a 100 000-file upload or batch is 100 000 subdirectories in one directory | S11 |

The access check (B1) and the DERIVED_FROM scans (B2, B10, and `processedSetRids`,
`processedInputs`, `outputFor`, `processOfSet`) are the two I'd bet on breaking first, because they
grow with the size of the whole database or a user's whole work, not with the thing being touched.

## 4. Test data

### 4.1 Generator

A seeder script (`perf/seed.ts`, to be written) builds datasets of a given shape and size. Two
ways of loading, used for different purposes:

- **Through the API** (upload, queue, fake-consumer callbacks): slow, but exercises the real write
  path. Used for S1 and S5 themselves and for sizes up to about 10 000 files.
- **Directly** (ArcadeDB `CREATE VERTEX`/`CREATE EDGE` batches in one transaction, files written
  to the same sharded layout, Solr docs posted in bulk): fast, for building large read datasets
  (100 000+ nodes). The direct loader must produce exactly what the API would (same properties,
  `project_rid`, `set`, DERIVED_FROM edge properties, `set.json`); a check step compares a small
  direct-loaded dataset with an API-loaded one of the same shape before it is trusted.

File contents are small generated JPEGs (a few KB, varied), short PDFs, and text files from a
public-domain corpus (Project Gutenberg Finnish and English texts) cut to realistic page sizes,
so Solr and thumbnails see real text and images. ArcadeDB and Solr volumes are snapshotted per
dataset so a run starts from a known state.

### 4.2 Shapes

| Shape | Description | Stresses |
|---|---|---|
| **Wide set** | 1 project, 1 set with N image or text files | B4, B5, B6, B14, B15 |
| **Imported PDFs** | M PDFs split into pages (set of N pages), then OCR text outputs per page | lineage depth, grouping (`grouping.ts`), B2 |
| **Deep pipeline** | a set run 5 times in a chain (rotate → OCR → translate → NER → index) | E grows 5× N; B2, B10, desk edges |
| **Busy desk** | 1 project with S sets × F files and many single-file processes on the desk | B8, B21 |
| **Many projects** | 1 user with 50 projects of varied size | B1, B3, B9 |
| **Many users** | 20 users with mid-size projects, concurrent | B1 across users, Solr `owner` filters |
| **Tag heavy** | 1 user with T entities, L TagLinks, both manual and machine | B11, B12, B13 |

### 4.3 Targets and size ladder

Targets (answer 7):

| Level | Must work | Ladder (one step past the target shows the failure mode) |
|---|---|---|
| Set | 10 000 files (the hard limit, answer 1) | 100, 1 000, 5 000, 10 000, then 10 001 to check the limit is enforced |
| Project | 100 000 pages split from PDFs, in several sets of up to 10 000 | 1 000, 10 000, 50 000, 100 000, 200 000 |
| Database | 10 million files over many users | 100 000, 1 M, 5 M, 10 M, 20 M |
| Tags | no target given yet; entities 100 → 100 000, links 1 000 → 1 000 000 | |

The database level is built with the direct loader as background "other users' data", so B1–B3
are measured against a realistic total database, not an empty one. A 10 M-file database also sets
the scale for S11 (disk) and the Solr index (S8: 10 M pages of OCR text is roughly 20–30 GB of text).

## 5. Limits that count as "broken"

| Kind | Limit |
|---|---|
| Interactive read (open desk, browse a set page, open a file, tags page, search) | p95 under 1 s is good, over 3 s is degraded, over 10 s or any 5xx/timeout is broken |
| Interactive write (upload one chunk, tag a file, create a set) | p95 under 2 s good, over 10 s broken |
| Long request (start a set run, delete a set, reindex) | must answer before 60 s (typical proxy timeout); otherwise broken |
| Batch throughput (fake consumer) | backend overhead per job under 100 ms is good; when it exceeds the real services' speed, the backend is the bottleneck |
| Correctness | any of: counter drift (`processed_files` ≠ outputs), batch not reaching `done`, missing or duplicate output nodes, `set.json` not matching the set, Solr doc count ≠ indexed files, is broken at any speed |
| Resources | Node heap over 1.5 GB, ArcadeDB or Solr out of heap, container OOM kill, disk full |
| UI | first render of a view over 3 s, or interaction below 20 fps, or the tab crashing |

These are my defaults; Ari may want different numbers (question 8.7).

## 6. Tooling

- **HTTP load:** [k6](https://k6.io) scripts in `perf/k6/` (scripted scenarios, ramping users,
  p50/p95/p99 out of the box), run from a container next to the stack. `autocannon` for quick
  single-route checks.
- **Fake consumer:** `perf/fake-consumer.ts`, a small Node script using the same HTTP calls as
  MD-consumers (`claim`, `heartbeat`, `complete`, `fail`, `/api/nomad/process/files` and `/done`,
  with `SERVICE_TOKEN`). Options: number of parallel workers, per-job delay, output shape
  (one file, several files, an output set, a ner.json with K labels for autotag), failure rate.
  It records claim-to-callback latency per job.
- **Query analysis:** for every query in section 3, `PROFILE` (ArcadeDB SQL) at 1 000 and 50 000
  to see whether it uses an index and from which side a MATCH starts. This is cheap and should be
  done first: it confirms or rules out most of section 3 without load tests.
- **UI:** Playwright (MessyDesk-UI already has `e2e/`), with a performance trace
  (`page.tracing` / Chrome trace) and `performance.measure` marks around graph load and render.
  Datasets come from the seeder; the UI points at the backend under test.
- **Disk:** `find | wc -l` for file and directory counts, `du -s` per project, and timing of
  `POST /api/projects/update-size`.
- **Results:** each run writes one JSON with environment, dataset, and per-scenario metrics into
  `perf/results/`; a small script turns them into the tables of `wiki/limits.md` (the deliverable,
  section 9).

## 7. Scenarios

Each scenario lists what is measured, how, and what result answers which question.

**S1. Upload into a set (Q1, B4, B22).** Upload N images into one set the way the UI does
(chunks of 20, 3 parallel), with thumbnails on (real md-sharp) and off. Measure time per chunk
as the set grows, total time, ArcadeDB CPU, and after the run: `count` on the Set, number of
members, and `set.json` items, which must all agree. Expect chunk time to grow linearly with set
size (B4). Also one run with 3 browser sessions uploading into the same set, for the `set.json`
race.

**S2. Browse a set (Q1, B14, B15).** `GET /api/sets/{rid}/files` first page, a middle page and the
last page, with `thumbnails=true`, for image-only, PDF-only and text sets of each size. Measure
latency per page position. Also open the file viewer and step next/previous (`skip` one at a time,
as `useFileViewer.js` does) at the end of a large set.

**S3. Open a desk (Q2, B8, B21 backend half).** `GET /api/projects/{rid}` for busy desks with
growing set counts and growing set sizes (keeping the desk node count fixed, to separate the two
costs). Measure latency, response size, and how many ArcadeDB queries one call issues.

**S4. Single-node requests at database scale (Q2, Q8, B1, B3).** Fixed small project, while the
same user's other projects and other users' data grow from 0 to 1 000 000 nodes. Measure
`GET /api/files/{rid}`, `/api/documents/{rid}`, a thumbnail and a tag link. If B1 holds, latency
grows with the user's total nodes although the requested node is the same; this is the most
important single curve in the plan.

**S5. Run a batch (Q1, Q5, B2, B5, B6, B7).** Start a one-to-one set run on sets of growing size
with the fake consumer at 1, 4, 16 and 64 parallel workers and zero delay. Measure: time for
`POST /api/queue/{topic}/sets/{rid}` to answer, jobs/min through claim → callback → node created,
time per callback as E grows, and at the end the correctness checks of section 5 (outputs = N,
`processed_files` = N, status `done`, no duplicate outputs). Repeat with a one-to-many task, a
many-to-one task over imported PDFs (grouping), pause/resume in the middle, and a 5 % failure
rate (auto-abort thresholds). A set of 10 001 files checks B6 and that the 10 000 limit is
enforced visibly (answer 1).

**S5b. Splitting a PDF over 10 000 pages (Q1).** Answer 1 makes 10 000 a hard set limit, but the
PDF splitter writes every page of one PDF into one output set, so a large PDF (or a ZIP of PDFs)
can pass the limit. Import a 12 000-page PDF and record what happens: how many pages land in the
set, whether the user is told, and whether later set runs process only the first 10 000. The
result feeds a decision on how splitting should respect the limit.

**S6. Queue store (Q5, B16).** With 100 000 queued jobs from several batches: claim latency,
`GET /api/queue/jobs/active` latency, `queue.sqlite` size, sweeper run time. Also a whole-set job
over 50 000 files (payload size).

**S7. Tags (Q3, B11, B12, B13).** Grow entities and TagLinks for one user. Measure tags page calls
(`/api/entities`, grouped, with and without project filter, machine tags), linking one tag, the
set entity summary on a large set, and `entityItems`. Then autotag: fake consumer returns ner.json
outputs with K labels for N files; count the Process nodes and md-solr jobs created and measure
time per output. Expect N×K extra jobs (B11).

**S8. Search index (Q4, B17, B18).** Index growing amounts of real text (10 MB → 10 GB of text)
through md-solr. After each step: Solr index size on disk, docs, bytes per doc and per MB of text,
heap use, indexing throughput (docs/min, with its `commit=true` per doc), and search latency p50/p95
for 20 fixed queries (single word, phrase, prefix, rare and common words) with highlighting on, at
1 and 10 concurrent users. One step with very long documents (whole books in one doc) for
highlighting cost. `projectDocCounts` and `dropProjectIndex` timings too.

**S9. Delete (Q1, Q2, B10).** Delete a set, a deep pipeline chain and a whole project at each size.
Measure request time, whether it finishes before 60 s, Solr commits issued, and that nothing is
left behind (nodes, TagLinks, Solr docs, directories).

**S10. Project list and storage (Q2, B9, B19).** `GET /api/projects` and the storage summary for a
user with 1, 10, 50 projects of growing size; `update-size` timing over the data directory.

**S11. Data directory (Q6).** After the large datasets: files and directories per project, depth
of the shard tree, largest directory, `du` vs. the sum of `metadata.size`, leftover `tmp/` files
after S5 with failures. Counts entries per leaf directory to confirm B23: with UUIDv7 ids a whole upload or batch shares
one `aa/bb/cc` leaf. Measure `ls`, `readdir` and backup (`rsync`/`tar`) time on the largest leaf,
since ext4 and XFS handle 100 000 entries but tools and backups slow down.

**S12. UI rendering (Q7, B21).** Playwright with the seeded datasets: desk with 50, 200, 500,
1 000 nodes (open, pan, select, isolate); set browser on the largest set; file viewer next/previous;
tags page with 1 000, 10 000, 100 000 entities; search results grid at 1 000 rows; jobs panel with
many batches; and receiving 1 000 SSE events in a minute while the desk is open (live updates).
Measure first render, long tasks, fps, and JS heap.

**S13. Live events (Q8, B20).** 1 000 SSE connections (10 tabs × 100 users), one paused client
(reads nothing) while a 50 000-file batch runs. Measure backend heap over time; it should stay flat.

**S14. Soak (Q8).** 20 simulated users for 8 hours: uploads, browsing, small batches, tagging,
searching, with the fake consumer. Measure latency drift, memory growth (Node, ArcadeDB, Solr),
`queue.sqlite` and Solr segment growth, error rate.

## 8. Questions for Ari

These are API or behaviour points the tests will run into. Nothing is changed until you decide.

**Answers (Ari, 2026-10-05):**

| # | Answer |
|---|---|
| 1 | 10 000 files per set is a hard limit. It is a problem for PDF splitting, which can produce tens of thousands of files (tested in S5b). Assume a set holds up to 10 000 files and a project several sets |
| 2 | Yes, `limit` on set listings gets a maximum |
| 3 | The Process node per tag change is probably not needed; review the database schema more closely |
| 7 | A project of 100 000 PDF pages must work; with many users, 10 million files in total |
| 9 | Measure against the newer ArcadeDB |
| 4, 5, 6, 8 | No answer yet; the tests go ahead with the recommendation in each question (indexes tested as a separate measured run) |

1. **10 000-file cap.** Set runs, batch resume and search reindex read at most 10 000 files of a set
   (`setFiles(..., { limit: 10000 })` in `processing.ts`). A bigger set is processed only partly
   and nothing says so. Is that an intended limit (then the API should refuse or say so), or should
   these read the whole set?
2. **Unbounded `limit` on `GET /api/sets/{rid}/files`.** Any client can ask for every file of a set
   with thumbnails and entities in one call. Should there be a maximum (for example 1 000)?
3. **A Process node and a search job per tag change.** Each link or unlink, and each label of an
   autotag run, creates a Process node, a `message.json` and an md-solr `update_tags` job with a
   Solr commit. Is the Process node needed (does the UI show it anywhere), or only the index update?
4. **`set.json` rewritten on every added file.** Who reads `set.json`? If only some services
   (md-zip_fs?) or debugging, it could be written once at the end of an upload or batch instead.
5. **Grouped entities return every entity.** `GET /api/entities` returns all labels and records
   per type in one response. Fine for the tags page as it is, or should it be paged?
6. **Project list counts.** `node_count` and `file_count` in the project list come from a full
   traversal of every project on each call. Are those numbers used in the UI, and would a
   slightly stale stored count be acceptable?
7. **Targets.** What sizes must work? It would help to know the biggest real project, set, and
   tag count in production today (a count query on production, or a copy of the database), and
   which hardware production runs on. Without that I'll use the ladder in 4.3 and the limits in 5.
8. **Indexes during testing.** If profiling confirms B1/B2, the fix is likely new indexes or stored
   fields (for example on DERIVED_FROM `process_rid`). Indexes are additive and the old backend
   ignores them, but they are a schema change: OK to test with them, as a separate measured run?
9. **ArcadeDB version.** Should the limits be reported for 23.7.1 only (production today), or is an
   upgrade to 25.x on the table, so both are worth measuring?

## 9. Order of work and deliverables

| Step | Work | Output |
|---|---|---|
| 1 | Profile every query in section 3 at two sizes with direct-loaded data | table of confirmed / ruled-out bottlenecks; cheapest and most informative step |
| 1b | Schema review (answer 3): every vertex, document and edge type, which properties queries filter or join on, which have indexes, and which nodes exist only for bookkeeping (Process per tag change, legacy edge types) | `plan/schema-review.md` with proposed index and node changes |
| 2 | Seeder (API and direct), fake consumer, results format | `perf/` in this repo |
| 3 | S4, S5, S1, S2, S3 (the core size limits) | first version of `wiki/limits.md` |
| 4 | S7, S8, S9, S10, S11 | tags, search and delete limits |
| 5 | S12, S13 | UI and live-event limits |
| 6 | Baseline against the old backend on ArcadeDB 23.7.1 at small sizes | comparison table |
| 7 | S14 soak | stability notes |
| 8 | For each broken limit, a short note: cause, proposed fix, and whether it changes the API | input for decisions.md |

The final deliverable is `wiki/limits.md`: for each question in section 1 the measured limit, the
component that breaks first, how it breaks, and the hardware it was measured on, plus the
fixes proposed in step 8 for Ari to decide on.
