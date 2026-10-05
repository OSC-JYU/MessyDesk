# S9: deleting sets and desks, on ArcadeDB 26.9.1 (2026-10-05)

Scenario S9 of [plan/performance-testing.md](../../plan/performance-testing.md), run on ArcadeDB
26.9.1 (newest stable; Ari decided to move off 25.3.1) through the API (`perf/s9-delete.ts`). Raw
results: `s9-delete.*.json`.

## Moving to ArcadeDB 26.9.1

Two incompatibilities, fixed (contract tests pass on 26.9.1 and 23.7.1):

- `sysdate('YYYY-MM-DD HH:MM:SS')` as the default of `created` failed every Project, Process,
  SetProcess and File insert: 26.x reads the argument as a time zone. The current mode uses
  `sysdate()` and corrects the default on databases created by 23.7.1.
- `MATCH … RETURN node.outE()` is gone; the desk graph reads the nodes' edges separately.

Re-run on 26.9.1 with the earlier fixes: 10 000-file upload in 47 s (79 s on 25.3.1), 2 000 files
with 8 parallel uploads at 266 files/s with nothing lost, a 10 000-file batch at 6 400 outputs/min
(4 600), autotag at 3 000 outputs/min (2 000). `CHECK DATABASE` clean and every index lookup matches
a scan (`perf/check-indexes.ts`).

One more bug showed there: **parallel autotag created duplicate tags** (162 copies of existing
labels in a run of 1 000 files) because each callback checked and created on its own. Tag creation
is now serialised per user, type and label.

## Found and fixed

1. **Deleting a desk left everything on it behind.** Only the Project node went; its files, sets,
   processes, tag links and directories stayed in the database and on disk. The delete now takes
   everything on the desk (`project_rid` and BELONGS_TO) and the desk's directory. Tags made by
   users stay, as before; machine tags without links are removed.
2. **Every query returned at most 20 000 rows.** ArcadeDB's HTTP API caps results at 20 000 unless
   told otherwise, on 23.7.1 and 26.x alike. A 300 000-file desk delete removed 120 000 files and
   stopped; desk views and other large reads were cut the same way without any error. The client
   now asks for up to 100 000 000 rows (`-1`, "no limit", returns nothing on 23.7.1). The old
   backend in production has the same cap.
3. **One Solr delete-and-commit per file** and **one query per node**: the delete cascade now reads
   a whole level of the graph at once, deletes nodes 500 per statement and sends Solr one delete per
   500 files with a single commit.

## Results

| Delete | Before | After |
|---|---|---|
| Set of 10 000 files with 10 000 outputs (20 003 nodes) | 88.5 s | **13.6 s** |
| Desk with 1 000 files, 1 000 NER outputs, 5 000 tag links | Project node only; 2 000 files, 5 000 links and 2 002 files on disk left | **11.5 s, nothing left** |
| Desk with 100 000 pages, 200 000 outputs, 200 000 tag links | 75 s, 179 851 files left (20 000-row cap) | **217 s, nothing left** |

Everything is gone afterwards in all three: nodes, tag links, Solr docs and directories.

## In the background (decision G5)

Deletes now answer at once and finish in the background: the request checks ownership, marks the
node `_deleting` (gone for the user from then on: reads give 404, a desk's content too, the desk
list and desk graph leave it out), records it so a restart resumes it, and returns. The UI reloads
the desk or desk list on the `delete_finished` / `delete_failed` event (MessyDesk-UI branch
`tags-api`).

| | Before | After |
|---|---|---|
| `DELETE /api/projects/{rid}`, desk with 100 000 pages, 200 000 outputs, 200 000 tag links | 217 s in the request | **13 ms**; finished in the background after ~230 s |
