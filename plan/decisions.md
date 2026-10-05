# Decisions

Decided by Ari on 2026-10-01 for the questions in [questions.md](questions.md). Where Ari gave
no answer, the recommendation in questions.md applies, as Ari asked.

## A. Whole rewrite

| # | Decision |
|---|---|
| A1 | TypeScript, run with Node's type stripping; `tsc --noEmit` as a check |
| A2 | Stay on Hapi 21 |
| A3 | Drop the legacy-edge fallbacks (`HAS_ITEM`, `CONTAINS`, `PROCESSED_BY`/`PRODUCED`, `HAS_FILE`, `HAS_SOURCE`). Ship a check script that counts such edges before cutover |
| A4 | Switch over at once, after the contract tests and the UI Playwright run pass |

## B. Security: fix all of them

The paths stay the same; only requests that should not succeed change.

| # | Fix |
|---|---|
| B1 | `POST`/`DELETE /api/graph/edges/{rid}`: ownership check on both ends of the edge |
| B2 | `GET /api/files/{rid}/ner`, `/api/files/{rid}/source`, `/api/errors/{rid}`: ownership check, 404 otherwise |
| B3 | `GET /api/thumbnails/{path}`: path must resolve inside `DATA_DIR`, and the file node it belongs to must be the caller's |
| B4 | `/api/queue/{topic}/flush`: admin only. `/api/queue/jobs/active`: only the caller's jobs (admins see all). Batch pause/resume/cancel and job dismiss: caller must own the batch |
| B5 | `GET`/`DELETE /api/permissions/request`: admin only |
| B6 | `POST /api/services/register` and `/api/services/{id}/help/ingest`: service credential (B8) or admin only |
| B7 | Bound parameters for every query |
| B8 | Separate service credential for consumers, see below |

### B8. Service credentials for consumers

- New env var `SERVICE_TOKEN` (one shared secret to start with; a list of named tokens if needed later).
- Consumers send `Authorization: Bearer <token>`. A second Hapi auth strategy, `service`, accepts it.
- Routes that only consumers call accept only the `service` strategy: queue claim/heartbeat/
  complete/fail, `/api/nomad/process/*` callbacks, `/api/services/register`,
  `/api/services/{id}/adapter/{adapter_id}` (POST and DELETE), `/api/services/{id}/help/ingest`,
  `/api/entities/link/{rid}`.
- Routes both call (`GET /api/files/{rid}`, `GET /api/services/{id}`, `DELETE /api/services/{id}`,
  `/api/nomad/service/{name}`) accept either a user (with the existing checks) or the service token.
  With the service token, file downloads act on behalf of the message's `userId`, which must own the file.
- **Transition:** MD-consumers send only the `mail` header today and changing them is outside this
  rewrite. `SERVICE_AUTH_LEGACY_MAIL=true` (default `true` until MD-consumers are updated) lets the
  `service` routes also accept the old `mail: local.user@localhost` header; it logs a warning on
  every such request. Updating MD-consumers to send the token is listed in section F as follow-up.

## C. Response shapes

| # | Decision (recommendation) |
|---|---|
| C1–C4 | Keep exactly |
| C5 | Store new prompts as typed (clean); existing prompts untouched. Check the LLM adapters before cutover |
| C6 | Return 400/409 with a `message` instead of the generic 500 |

## D. Broken today (recommendations)

| # | Decision |
|---|---|
| D1 | Fix: error callbacks create the error node and `error.json` |
| D2 | Serve the repo's `public/` as static files |
| D3 | Keep: node drag positions are not stored |
| D4 | Fix the `GET /api/files/{rid}/source` path |
| D5 | Drop `GET /api/entities/{rid}`, `DELETE /api/filters/{type}/files/{rid}`, `GET /api/projects/{rid}/files`; stop computing project `paths` from `HAS_FILE` |
| D6 | Allow several SSE connections per user |
| D7 | Consumer liveness expires 90 s after the last heartbeat |
| D8 | Persist paused/cancelled batches in the queue SQLite file |
| D9 | Keep: the `roi` segment is ignored |
| D10 | Check for files before creating many-to-one nodes |
| D11 | Keep the pause behaviour |

## E. Dead and debug routes

| # | Decision |
|---|---|
| E1 | Drop `GET /events/test`, `POST /events/test/message` |
| E2 | Drop every route listed in E2: `POST /api/pipeline/files/{rid}/{roi?}`, `GET /api/queue/{topic}/drain/{rid?}`, `GET /api/queue/drain/{rid}`, `GET /api/queue/{topic}/status`, `POST /api/queue/cleanup`, `GET /api/queue/sweeper/summary`, `PUT /api/files/{rid}`, `POST /api/files/{rid}/sets/{set_rid}/ner`, `GET /api/tags/machine/{rid}/files`, `GET /api/tags/machine/{rid}/mentions`, `GET /api/tags/ner/labels/files`, `GET /api/graph/vertices/{rid}`, `GET /api/nomad/status`, `POST /api/nomad/process/csv/append`. The queue sweeper itself keeps running; only its HTTP routes go |
| E3 | Update the wiki in MessyDesk-new to match the code |

## F. MD-consumers follow-up (can be fixed later)

Not part of this rewrite. To fix later in MD-consumers:

1. Send the service token (B8) instead of `mail: local.user@localhost`, then set `SERVICE_AUTH_LEGACY_MAIL=false`.
2. Report failures through `/api/queue/{id}/fail` instead of `complete`, so queue retries and batch auto-abort work.
3. Invalid-payload errors post to a wrong URL (`…/files/api/nomad/process/files/error`); error objects serialise to `{}`.
4. `elg` expects `GET /api/sets/{rid}/files/zip` to return a zip; it now returns a 202 job.
5. `gemini-ai` (double JSON parse), `dspace7` (missing `cld`), `annif` (uploads `'test'`), `json-tagger` (legacy payload) are broken; `paddleocr` sends no auth header.
6. Shutdown deletes the whole service registration even when other instances share the topic.
7. The pause/resume/cancel control server is never consulted and registers a `localhost` URL.

Details: [consumer-calls.md §7](consumer-calls.md).

## G. Performance (2026-10-05)

Decided by Ari after the upload and batch tests ([../perf/results/upload-and-batch.md](../perf/results/upload-and-batch.md)).

| # | Decision |
|---|---|
| G1 | `set.json` is written once, not for every added file: when the set has had no new files for 5 s, when a batch finishes, and on shutdown. Nothing in the backend, UI or consumers reads it |
| G2 | Starting a set batch (`POST /api/queue/{topic}/sets/{rid}`) and resuming one answer as soon as the batch node exists; the jobs are published in the background. A dispatch failure is logged and stored on the batch as `dispatch_error` |
| G3 | `GET /api/entities` returns the tag types with counts only (`[{type, count, icon, color}]`), filtered by desks, `created_by` and `search`. A type's tags come from the new `GET /api/entities/by-type/{type}`, one page at a time. Returning every tag was 21 MB at 100 000 tags. MessyDesk-UI's tags page and file tag tool load a type when it is opened |
| G4 | Each TagLink stores the desk of its target (`project_rid`, indexed), so the desk filter of the tag lists reads links by desk instead of by every file of the desk. Existing links get it in the background at startup |
| G5 | Deleting a node (`DELETE /api/graph/vertices/{rid}`) or a desk (`DELETE /api/projects/{rid}`) answers at once and finishes in the background. The node is marked `_deleting` and is gone for the user immediately (reads give 404, a desk's content too, desk lists and the desk graph leave it out); the cascade ends with SSE `delete_finished` (or `delete_failed`, and the node comes back). A restart resumes unfinished deletes (`pending_deletes` table in the queue database). The vertex route answers `{path: null, deleted: null, status: 'deleting'}` |
| G6 | Search gets an "Fuzzy search" option (`fuzzy: true` in `POST /api/search`): each word of 4+ letters also matches words one edit away and its common two-edit OCR confusions (m↔rn, d↔cl, w↔vv, h↔li), on the whole-word field, in addition to the normal search. md-solr's index task gets an `index_mode` option: `full` ("Partial word match", default, today's n-gram index) or `light` ("Whole word match", whole words only, about 7× smaller). Re-indexing keeps a run's mode |
