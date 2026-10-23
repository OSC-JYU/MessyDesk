# S1 upload and S5 batch (2026-10-05)

**Update:** Ari decided both questions at the end (plan/decisions.md G1, G2); the fixes and the
reruns are in "After G1 and G2" at the end.

Scenarios S1 and S5 of [plan/performance-testing.md](../../plan/performance-testing.md), run against the
backend itself (`node dist/src/main.js`) with the query fixes of step 1, on ArcadeDB 25.3.1 unless
noted, on the same laptop as step 1. Uploads are 1×1 JPEGs without thumbnails; batches use the fake
consumer (`perf/fake-consumer.ts`), which answers every job at once with one text output, so the
numbers are the backend's own cost. Raw results are the JSON files next to this one.

## Found and fixed on the way

**1. ArcadeDB 25.3.1 lost uploads and corrupted records under parallel writes.** ArcadeDB 23.7.1 gives
every type 8 buckets; 25.x gives one, so parallel inserts of one type all conflict on the same
pages. With 8 parallel upload requests of 2 000 files:

| Server, buckets per type | Files/s | Upload failures | Damage (`CHECK DATABASE`) |
|---|---|---|---|
| 23.7.1, 8 (its default) | 107 | 0 | none |
| 25.3.1, 1 (its default) | 57 | **174 of 2 000** (1 413 page conflicts) | **8 corrupted records**; 3 files created although reported failed |
| 25.3.1, 8 | 111 | 0 (176 conflicts, all retried) | none |
| latest snapshot (26.10.1), 1 | 145 | 0 | none |

The loss looks like an ArcadeDB 25.3.1 bug that later builds fixed, but one bucket per type also
halves throughput. **Fix:** the backend now creates every type with 8 buckets (`schema.ts`), which only
affects databases and types created from now on. A database moved from 23.7.1 keeps its 8 buckets.
The large step 1 test database was damaged the same way and was not used for writes.

**2. Batch counters lost most of their updates with parallel consumers.** `incrementProcessed` read
the batch node, added one and wrote it back. With 16 consumers it counted 2 842 of 10 000 outputs,
so the batch stayed `running` forever and the UI never got `process_finished` (even 4 consumers on
200 files ended at 199/200). **Fix:** the counters are incremented in the database
(`UPDATE … SET processed_files = processed_files + 1 RETURN AFTER`, `batch-state.ts`); after it every
run counted exactly 10 000 and finished.

Contract tests after both fixes: 68 of 71 pass on 25.3.1 and 23.7.1, the same as before (the zip
test needs an md-zip consumer that was not running).

## S1: uploading 10 000 files into one set

UI pattern: chunks of 20 files, 3 in parallel. 10 000 files in 273 s (37 files/s); no failures;
members, stored count and `set.json` all 10 000.

| Files already in the set | Chunk of 20, p50 | p95 |
|---|---|---|
| 0–1 000 | 0.48 s | 0.69 s |
| 2 000–3 000 | 1.10 s | 1.36 s |
| 5 000–6 000 | 1.73 s | 2.12 s |
| 9 000–10 000 | 2.72 s | 3.09 s |

Chunk time grows linearly with the set (B4): each added file recounts the set and rewrites
`set.json` with every member, about 90 ms at 10 000 members. Within the limits at the 10 000-file
cap, but the total upload time grows with the square of the set size.

## S5: a one-to-one batch over 10 000 files

| Consumers | Start request | Outputs/min | Callback p50 / p95 | Bookkeeping |
|---|---|---|---|---|
| 16, counters not yet fixed | **279 s** (consumers running) | 1 451 | 0.57 / 1.05 s | **2 842 / 10 000 counted, never done** |
| 4 | 21 s | 1 164 | 0.17 / 0.30 s | all correct, done |
| 16 | 20 s | 1 281 | 0.61 / 1.04 s | all correct, done |
| 64 | 20 s (consumers running: **> 300 s**, client timed out) | 1 263 | 2.59 / 3.94 s | all correct, done |

All runs with the fix: 10 000 outputs, one per input, no duplicates, `processed_files` 10 000, status
`done`, output set count 10 000. The 16-consumer run reports `ok: false` only because the first
version of the check also counted the output set's own edge.

**What limits it:**

- **The backend tops out at about 20 outputs per second** (1 200–1 450 a minute) whatever the number
  of consumers; more consumers only make each callback wait longer. Each output into a set rewrites
  the output set's `set.json` twice (after creating the file and after recounting), about 90 ms each
  at 10 000 members, so the cost per output grows with the set. Real services are much slower than
  this (OCR takes seconds per page), so for them the backend is not yet the bottleneck at 10 000.
- **Starting a batch publishes every job inside the HTTP request.** Alone it takes 20 s for 10 000
  files (2 ms per file), but while consumers are already working on other jobs it took 279 s with 16
  and over 300 s with 64, beyond any proxy timeout. The UI then shows an error although the batch runs.

## Questions for Ari (not changed)

1. **`set.json` on every added file** (plan question 4): who reads it? Writing it once when an upload
   or batch finishes would remove most of the per-file cost in both S1 and S5.
2. **Starting a batch in the background**: the request could answer as soon as the batch node exists
   and publish the jobs afterwards. The UI already follows progress by SSE, but the response would
   come before the jobs are queued. OK to change?
3. **ArcadeDB version**: 25.3.1 has the parallel-write bug above. If production moves to a newer
   ArcadeDB, use a newer stable release than 25.3.1 (the build that passed was a snapshot).

## After G1 and G2

`set.json` is now written once (5 s after a set's last change, when a batch finishes, and on
shutdown), and a batch's jobs are published after the start request has answered. Same tests, new
database:

| | Before | After |
|---|---|---|
| S1: upload 10 000 files (chunks of 20, 3 parallel) | 273 s (37 files/s) | **79 s (127 files/s)** |
| S1: chunk of 20 at 9 000–10 000 files, p50 | 2.72 s | **0.58 s** |
| S5: start request, 16 consumers already working | 279 s | **0.28 s** |
| S5: outputs per minute, 16 consumers | 1 281–1 451 | **4 600** |
| S5: result callback p50 (first / last third of the batch) | 0.54 / 0.61 s | **0.13 / 0.13 s** |

All checks pass: 10 000 members, stored count and `set.json` items after the upload; 10 000 outputs,
one per input, `processed_files` 10 000, status `done`, and 10 000 items in the output set's
`set.json` after the batch. Callback time no longer grows with the set. Contract tests: 68 of 71 on
both ArcadeDB versions, as before; the test that listed a batch's jobs right after starting it now
waits for them (G2).
