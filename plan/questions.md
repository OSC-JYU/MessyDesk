# API oddities: questions for Ari

The rewrite keeps the API exactly as it is. These are the places where "exactly" includes
something that looks like a bug, a security hole or leftover code. Each item says what happens
today, what I recommend, and what the answer changes. Nothing here is changed until you decide.

Evidence is `file:line` in the current `MessyDesk` repo (`src/`) unless said otherwise.

## A. Decisions that shape the whole rewrite

**A1. Language.** Plain JavaScript (ESM, as today) or TypeScript run by Node's built-in type
stripping (no build step, `tsc --noEmit` only as a check)?
Recommendation: **TypeScript**, because the message contract and the many look-alike fields
(`set_rid`/`input_set`/`output_set`, `status`/`state`, …) are exactly what types catch.

**A2. Web framework.** Stay on Hapi 21?
Recommendation: **yes**. The Boom error body (`{statusCode, error, message}`, which the UI reads
as `data.message`), multipart parsing into temp files (`output: 'file'`), payload limits and the
SSE plugin are all part of the observable behaviour. Switching frameworks adds risk for no user gain.

**A3. Legacy graph shapes.** Many queries fall back to retired edges: `HAS_ITEM`, `CONTAINS`,
`PROCESSED_BY`/`PRODUCED`, `HAS_FILE`, `HAS_SOURCE` (e.g. `graph.mjs` 730, 952, 960, 1216, 1719,
2199, 2281, 2721, 3041, 3854). Does any database you run still rely on them?
Recommendation: **drop them** and ship a one-off check script that counts such edges, so we know
before cutover. If old data exists, migrate it once instead of carrying fallbacks forever.

**A4. Cutover style.** One switch-over after the whole new backend passes contract tests, or
module-by-module behind a proxy?
Recommendation: **one switch-over**. The SSE connections, the service/consumer registry and the
in-memory pause/cancel sets live in one process, and processing touches almost every module, so
two backends sharing one database and queue file would step on each other.

## B. Security holes (keep, or close while keeping the same paths?)

Closing these changes behaviour only for requests that should not succeed today. Recommendation
for all of B: **close them**, but I will not do it without your yes.

B1. `POST`/`DELETE /api/graph/edges/{rid}` have no ownership check (`graph.mjs` 2630, 2637). No caller.
B2. `GET /api/files/{rid}/ner`, `GET /api/files/{rid}/source`, `GET /api/errors/{rid}` read any
node without an ownership check (`graph.mjs` 1870, 2191; `db.mjs` 440).
B3. `GET /api/thumbnails/{path}` serves any `preview.jpg`/`thumbnail.jpg` under the working
directory with no ownership check, and `path` can contain `..` (`media.mjs` 476).
B4. Queue admin with no admin check: `GET /api/queue/{topic}/flush` deletes every job of a topic
for all users, `POST /api/queue/cleanup`, and `GET /api/queue/jobs/active` lists every user's
jobs. Batch pause/resume/cancel/dismiss do not check that the batch is yours.
B5. `GET`/`DELETE /api/permissions/request` are not admin-only (`routes/auth.mjs` 24, 33).
B6. `POST /api/services/{id}/help/ingest` makes the server fetch any URL (`help_url` query) for any
user; `POST /api/services/register` lets any user overwrite a service descriptor.
B7. Almost every query is built by string interpolation (labels, prompt text, `service_id`/`task`
query params, the `direction` path segment of `/api/graph/traverse`). The rewrite will use bound
parameters everywhere. That is invisible to normal input; see C5 for the one place it changes stored data.
B8. Consumers authenticate as `local.user@localhost` through the same trusted `mail` header as
people, and that user must be an admin because consumers call `DELETE /api/services/{id}` and
`/api/nomad/service/*`. Do you want a separate service credential (for example a shared token
header that only the consumer endpoints accept), or keep the header as is?
Recommendation: **keep it for the cutover**, add the token later together with MD-consumers.

## C. Response shapes that look accidental (keep byte-for-byte?)

Recommendation for C1–C4: **keep exactly**, the UI already works around them.

C1. `POST /api/graph/vertices/{rid}` returns `{nodes: [], edges: []}` (an UPDATE run through the
Vue Flow converter, `db.mjs` 379). `POST /api/entities` and `GET/POST /api/tags` return the raw
ArcadeDB envelope `{user, version, result: […]}`.
C2. Thumbnail and set preview URLs are absolute (`API_URL + 'api/thumbnails/…'`) in
`/api/sets/{rid}/files` `thumb`, set `paths` and SSE updates, but relative (`/api/thumbnails/…`) in
graph `node.data.image`. The UI builds a third form itself.
C3. `GET /api/files/{rid}` labels every image `image/png`, whatever the real format.
C4. Batch objects carry both `status` and `state`; the UI reads `status || state`.
C5. `POST /api/prompts` stores text mangled: `"` becomes `'`, newlines become the two characters
`\n`, and `json_schema` is stored with escaped quotes (`graph.mjs` 342–413). With bound parameters
the text would be stored as typed. Should new prompts be stored clean (old ones stay as they are),
or should the rewrite reproduce the mangling? Recommendation: **store clean**, if the LLM adapters
don't depend on the escaped form.
C6. Thrown strings become generic 500s: duplicate project name, `POST /api/projects` without a
label, set creation on a missing project. A duplicate permission request also ends in 500 because
`logger` is not imported in `routes/auth.mjs` (line 74). Keep the 500s, or answer 400/409 with a
message? Recommendation: **409/400 with a message**; the UI shows `message` and does not branch on these codes.

## D. Things that are broken today

D1. `POST /api/nomad/process/files/error` uses `DATA_DIR` without importing it
(`routes/nomad.mjs` 155), so for every real processing error the error node and `error.json` are
never created and the request fails after the `update` SSE. Fix in the rewrite? Recommendation: **fix**.
D2. Static files are served from `src/public`, which does not exist, so `/icons/wait.gif`,
`/favicon.ico` and `/maintenance.html` 404, while SSE `add` events point at `…/icons/wait.gif`.
Serve the repo's `public/` (as probably intended)? Recommendation: **yes**.
D3. Drag positions: the UI saves every node's position with `PUT /api/projects/{node rid}`; for
anything but a project the ownership check fails and the error is swallowed, so positions are
never stored, and they are never read back either. Keep as is? Recommendation: **keep** (no visible effect).
D4. `GET /api/files/{rid}/source` joins `DATA_DIR` to a path that already contains it, so it
always fails (403). No caller. Drop or fix? Recommendation: **fix the path, keep the route**.
D5. `GET /api/entities/{rid}` matches on a field `id` that entities don't have, so it always
returns an empty result. `DELETE /api/filters/{type}/files/{rid}` calls `Graph.removeFilter`,
which does not exist (500). `GET /api/projects/{rid}/files` and project thumbnail `paths` query
the retired `HAS_FILE` edge. No caller for any of them. Keep the routes returning the same
results, or drop them? Recommendation: **drop** these four.
D6. SSE allows one connection per user; opening a second tab silently stops events in the first
(`userManager.mjs` 10). Allow several connections per user? Recommendation: **yes** (a superset of today).
D7. Consumer liveness never expires: a consumer that dies without SIGINT stays "active", so the
PDF upload gate and the cruncher list keep offering it. Add an expiry (for example 90 s without
the 30 s heartbeat)? Recommendation: **yes**.
D8. Paused and cancelled batches are kept in memory (`queue.mjs` 35), so a restart forgets that a
batch was cancelled and a retried job can run again. Persist them? Recommendation: **yes**, in the
queue SQLite file.
D9. `POST /api/queue/{topic}/files/{rid}/roi`: the `roi` segment is ignored, so ROI processing
is the same as file processing. Keep? Recommendation: **keep**, and ask separately what ROI
processing should do.
D10. Many-to-one set processing creates the process node and output set before it checks that
the set has files, then fails with 400 and leaves them behind (`routes/queues.mjs` 733–754).
Recommendation: **check first**.
D11. Pausing a batch drops results that arrive while paused (wiki invariant 6), and resume
re-dispatches only files without outputs, so those files are processed again. Keep? Recommendation: **keep** for now.

## E. Dead or debug routes

E1. Debug: `GET /events/test`, `POST /events/test/message`. Drop? Recommendation: **drop**.
E2. No caller: `POST /api/pipeline/files/{rid}`, `GET /api/queue/{topic}/drain/{rid?}`,
`GET /api/queue/drain/{rid}`, `GET /api/queue/{topic}/status`, `POST /api/queue/cleanup`,
`GET /api/queue/sweeper/summary`, `PUT /api/files/{rid}` (no-op), `POST /api/files/{rid}/sets/{set}/ner`,
`GET /api/tags/machine/{rid}/files|mentions`, `GET /api/tags/ner/labels/files`,
`GET /api/graph/vertices/{rid}`, `GET /api/nomad/status`, `POST /api/nomad/process/csv/append` (stub).
Keep all of them as they are? Recommendation: **keep** (cheap, and some are ops tools), except
`csv/append`, which does nothing.
E3. The wiki API page lists routes that don't exist (`DELETE /api/files/{rid}`,
`GET /api/projects/export/{rid}`, `/api/queue/{topic}/pause|resume|cancel`,
`/api/images/{rid}/rois/{roi_id}`, `/api/service-groups/{id}/logo/source`, `/api/queue/events`,
`POST /api/services/refresh`, `DELETE /api/logout`). I'll treat the code as the contract and fix
the wiki in MessyDesk-new. OK?

## F. Things for MD-consumers (outside this rewrite, for later)

Not changed by the backend rewrite, listed so they are not lost: most adapters report failures as
`complete` (queue retries never run); invalid-payload errors go to a wrong URL; `elg` expects
`GET /api/sets/{rid}/files/zip` to return a zip; `gemini-ai`, `dspace7`, `annif` and `json-tagger`
are broken; consumer shutdown deletes the whole service registration. Details in
[consumer-calls.md §7](consumer-calls.md).
