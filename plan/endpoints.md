# Backend endpoint inventory (the contract to preserve)

Every route the current backend (`MessyDesk` @ `d4c6654`) registers, with who calls it today.
Callers: **UI** = MessyDesk-UI (`src/api/client.js` and URL helpers), **C** = MD-consumers,
**—** = no caller found. Details of request bodies, response fields read and call sites are in
[ui-calls.md](ui-calls.md) and [consumer-calls.md](consumer-calls.md).

Rule for the rewrite: every row stays, with the same method, path, status codes and JSON shape,
except where [decisions.md](decisions.md) says otherwise: auth is tightened on the B-rows, consumer
routes move to the service credential (B8), and the routes listed under D5, E1 and E2 are dropped.

"Auth" column: `user` = trusted `mail` header (or dev bypass), `admin` = `user.access === 'admin'`
checked in the handler, `open` = `auth: false`.

## Session, users, permissions (`routes/auth.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/api` | user | UI | Returns the text `MessyDesk API`; the UI uses it only as a session check (401/302) |
| GET | `/api/sso` | open | UI | `{mail, name}` from `mail`/`displayname` headers |
| GET | `/api/me` | user | UI | `{rid, admin, group, access, id, mode, settings}` |
| PUT | `/api/me/settings` | user | UI | partial merge; 400 on unknown key/value |
| GET | `/api/me/usage` | user | UI | **New (llm-adapter.md 4.9).** `{month_since, groups: [{id, name, period, since, limits, used_by_me, used_by_group}], services: [{service, model, tokens_in, tokens_out, total}]}` |
| GET | `/api/users` | admin | UI | raw User rows |
| POST | `/api/users` | admin | UI | `{id, label}` |
| PUT | `/api/users/{rid}/service-groups` | admin | UI | `{service_groups: []}` |
| GET | `/api/permissions/request` | user (not admin-checked) | UI | raw Request rows |
| POST | `/api/permissions/request` | open | UI | identity from headers |
| DELETE | `/api/permissions/request/{rid}` | user (not admin-checked) | UI | |

## Projects and sets (`routes/projects.mjs`, `routes/files.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| POST | `/api/projects` | user | UI | `{label, description, position}` |
| GET | `/api/projects` | user | UI | list with `node_count`, `file_count`, `paths`?, `size`, `expiration_date` |
| POST | `/api/projects/update-size` | user | UI | recomputes `size` (MB) from disk |
| GET | `/api/projects/storage-summary` | user | UI | `{used_mb, quota_gb, quota_mb, used_percent}` |
| GET | `/api/projects/{rid}` | user | UI | Vue Flow graph `{nodes, edges}` (built in `db.mjs convert2VueFlow` + `getSetThumbnails`) |
| PUT | `/api/projects/{rid}` | user | UI | `{key: label|description|position, value}` |
| DELETE | `/api/projects/{rid}` | user | UI | cascade delete |
| GET | `/api/projects/{rid}/files` | user | — | queries the retired `HAS_FILE` edge |
| POST | `/api/projects/{rid}/sets` | user | UI | |
| POST | `/api/projects/{rid}/sources` | user | UI | publishes `init` to `md-<type>` |
| POST | `/api/projects/{rid}/reindex-search` | user | UI | |
| POST | `/api/projects/{rid}/upload/{set?}` | user | UI | multipart `file` (1..n), 1 GB, PDF gate 503, set lock 409 |
| GET | `/api/sets/{rid}/files` | user | UI | `{file_count, limit, skip, files}` |
| POST | `/api/sets/{rid}/thumbnails` | user | UI | 202 |
| POST | `/api/sets/{rid}/files/zip/jobs` | user | UI | 202 `{job_id, status, status_url, download_url}` |
| GET | `/api/sets/{rid}/files/zip/jobs/{job_id}` | user | UI | `processing` / `ready` / 504 `failed` |
| GET | `/api/sets/{rid}/files/zip/jobs/{job_id}/download` | user | UI (navigation) | file download |
| GET | `/api/sets/{rid}/files/zip` | user | C (`elg` adapter, expects a zip, gets 202 JSON) | same as POST jobs |

## Files (`routes/files.mjs`, `routes/ner.mjs`, `routes/rois.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/api/files/{rid}` | user | UI, C (download with `mail: msg.userId`) | streams content; falls back to sibling `error.json`; content types by `type` |
| PUT | `/api/files/{rid}` | user | — | no-op, returns the file node |
| POST | `/api/files/{rid}/version` | user | UI | multipart `file`+`operation`+`params`, or JSON `{content}` |
| POST | `/api/files/{rid}/revert` | user | UI | |
| POST | `/api/files/{rid}/thumbnail` | user | UI | queues md-thumbnailer / md-poppler; 503 if no consumer |
| GET | `/api/files/{rid}/ancestors` | user | UI | DERIVED_FROM chain |
| GET | `/api/files/{rid}/source` | user | — | joins `DATA_DIR` + path (double prefix) |
| GET | `/api/documents/{rid}` | user | UI | node attributes + `entities` |
| GET | `/api/thumbnails/{param*}` | user | UI (img src) | `param` is a filesystem path; 404 when not made |
| GET | `/api/files/{rid}/ner` | user | — (UI client method is dead) | |
| POST | `/api/files/{rid}/sets/{set_rid}/ner` | user | — | |
| GET | `/api/images/{rid}/sets/{set_rid}/rois` | user | UI | |
| POST | `/api/images/{rid}/sets/{set_rid}/rois` | user | UI | upsert |
| PUT | `/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}` | user | UI | |
| DELETE | `/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}` | user | UI | |

## Graph (`routes/graph.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/api/graph/traverse/{rid}/{direction}` | user | UI (`out`) | |
| GET | `/api/graph/vertices/{rid}` | user | — | `[]` when not found, else `{file: …}` |
| GET | `/api/graph/vertices/{rid}/init` | user | UI (DSpace form) | reads `init.json` |
| POST | `/api/graph/vertices/{rid}` | user | UI | `{key, value}`; returns `{nodes:[], edges:[]}`; SSE `update` for description |
| DELETE | `/api/graph/vertices/{rid}` | user | UI | 409 if active queue jobs |
| POST | `/api/graph/edges/{rid}` | user (no ownership check) | — | |
| DELETE | `/api/graph/edges/{rid}` | user (no ownership check) | — | |

## Processing and queue (`routes/queues.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| POST | `/api/queue/{topic}/files/{rid}/{roi?}` | user | UI | returns the file rid string; `roi` param is ignored |
| POST | `/api/queue/{topic}/sets/{rid}` | user | UI | one-to-one/one-to-many batch, or many-to-one with root-source grouping |
| POST | `/api/queue/{topic}/sources/{rid}` | user | UI | |
| POST | `/api/pipeline/files/{rid}/{roi?}` | user | — | |
| GET | `/api/queue/jobs/active` | user (all users' jobs) | UI | |
| POST | `/api/queue/jobs/{rid}/dismiss` | user | UI | |
| GET | `/api/batches/{rid}` | user | UI | also accepts `job_N` |
| POST | `/api/batches/{rid}/pause` | user | UI | |
| POST | `/api/batches/{rid}/resume` | user | UI | set-to-set batches only |
| POST | `/api/batches/{rid}/cancel` | user | UI | also accepts `job_N` |
| GET | `/api/queue/{topic}/status` | user | — | |
| GET | `/api/queue/{topic}/flush` | user (no admin check) | UI (Services page) | GET that deletes every job of the topic |
| GET | `/api/queue/{topic}/drain/{rid?}` | user | — | GET with side effects |
| GET | `/api/queue/drain/{rid}` | user | — (UI method dead) | GET with side effects |
| POST | `/api/queue/cleanup` | user (no admin check) | — | |
| GET | `/api/queue/sweeper/summary` | user | — | |
| POST | `/api/queue/claim` | user | C | `{topic, adapter_id}` → `{job}` |
| POST | `/api/queue/{job_id}/heartbeat` | user | C | |
| POST | `/api/queue/{job_id}/complete` | user | C | |
| POST | `/api/queue/{job_id}/fail` | user | C | may auto-abort the batch |

## Result callbacks from consumers (`routes/nomad.mjs`, `controllers/processFilesController.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| POST | `/api/nomad/process/files` | user | C | multipart `content` + `message`, 500 MB |
| POST | `/api/nomad/process/files/tmp` | user | C (`elg_fs`) | JSON `{message, tmp_path}`; whitelisted message fields only |
| POST | `/api/nomad/process/files/done` | user | C (`elg_fs`, `solr`, `json-tagger`) | |
| POST | `/api/nomad/process/files/error` | user | C | `{error, message}` |
| POST | `/api/nomad/process/files/metadata` | user | C (AI adapters, dspace7) | writes `Usage` |
| POST | `/api/nomad/process/csv/append` | user | — | stub, does nothing |
| GET | `/api/errors/{rid}` | user (no ownership check) | — (UI method dead) | |

## Services, help, Nomad (`routes/services.mjs`, `routes/help.mjs`, `routes/nomad.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/api/services` | user | UI | object keyed by id, full descriptors incl. `consumers`, `nomad_hcl` |
| GET | `/api/services/{service}` | user | C (descriptor fallback) | |
| GET | `/api/services/files/{rid}` | user | UI | `{for_type, for_format, filters}` |
| POST | `/api/services/register` | user | C | `{source, service}` |
| POST | `/api/services/{service}/adapter/{id}` | user | C | body `{control_url}` ignored |
| DELETE | `/api/services/{service}/adapter/{id}` | user | C | may stop the Nomad job |
| POST | `/api/services/install` | admin | UI | |
| POST | `/api/services/reload` | admin | UI | returns the whole `services` module object |
| DELETE | `/api/services/{service}` | admin | UI, C (on consumer shutdown) | |
| POST | `/api/services/{service}/help/ingest` | user | C | backend fetches a URL; **new:** body `{content: "<markdown>"}` stores that markdown instead (consumers of providers we do not run, llm-adapter.md 4.4) |
| GET | `/api/services/{service}/help` | open | UI | |
| GET | `/api/services/{service}/help/assets/{path*}` | open | UI | |
| GET | `/api/help/{slug?}` | open | UI | |
| GET | `/api/help/images/{path*}` | open | UI (inside help HTML) | |
| GET | `/api/help/styles/{path*}` | open | help HTML | |
| GET | `/api/nomad/status` | user | — | |
| POST | `/api/nomad/service/{name}` | admin | UI, C | `{nomad_hcl}` |
| DELETE | `/api/nomad/service/{name}` | admin | UI, C | |

## Service groups (`routes/service-groups.mjs`)

| Method | Path | Auth | Callers |
|---|---|---|---|
| GET | `/api/service-groups` | admin | UI |
| POST | `/api/service-groups` | admin | UI |
| PUT | `/api/service-groups/{id}` | admin | UI | **New field** `token_limits: {period, per_user, group_total, per_job_max_output}` (also on POST; `null`/empty removes) |
| GET | `/api/service-groups/{id}/usage` | admin | UI | **New.** `{id, period, since, limits, total, users: [{user, total}]}` |
| DELETE | `/api/service-groups/{id}` | admin | UI |
| POST | `/api/service-groups/{id}/logo` | admin | UI (calls md-sharp `/process` synchronously) |
| GET | `/api/service-groups/{id}/logo` | user | UI (img src) |

## Tags, entities, filters, prompts, search

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/api/entities` | user | UI | tag types with counts `[{type, count, icon, color}]`; `project_rid(s)`, `created_by`, `search` (decision G3) |
| GET | `/api/entities/by-type/{type}` | user | UI | one page of a type's tags by label: `{type, total, skip, limit, items}`; `skip`, `limit` (≤ 1000, default 200), same filters (G3) |
| POST | `/api/entities` | user | UI | returns raw ArcadeDB envelope |
| GET | `/api/entities/types` | user | UI | |
| GET | `/api/entities/items` | user | UI | `entities` comma list |
| GET | `/api/entities/sets/{rid}` | user | UI | |
| GET | `/api/entities/{rid}` | user | — | matches on `id`, always empty |
| POST | `/api/entities/{rid}/vertex/{vid}` | user | UI | |
| DELETE | `/api/entities/{rid}/vertex/{vid}` | user | UI | |
| POST | `/api/entities/link/{rid}` | user | C (`json-tagger`, legacy) | |
| GET | `/api/tags` | user | UI | raw envelope `{result: [{rid, …}]}` |
| POST | `/api/tags` | user | UI | |
| GET | `/api/tags/machine` | user | UI | |
| GET | `/api/tags/machine/{rid}/files` | user | — | |
| GET | `/api/tags/machine/{rid}/mentions` | user | — | |
| GET | `/api/tags/ner/labels` | user | UI | |
| GET | `/api/tags/ner/labels/files` | user | — | |
| GET | `/api/tags/ner/labels/mentions` | user | UI | |
| POST | `/api/filters/{type}/files/{rid}` | user | UI | `mdf-set-filter` builds a tag-filtered Set |
| DELETE | `/api/filters/{type}/files/{rid}` | user | — | calls `Graph.removeFilter`, which does not exist |
| GET | `/api/prompts` | user | UI | |
| POST | `/api/prompts` | user | UI | create and update |
| POST | `/api/search` | user | UI | Solr response passed through |
| GET | `/api/search/info` | user | UI | |

## Server-sent events (`routes/events.mjs`, `userManager.mjs`)

| Method | Path | Auth | Callers | Notes |
|---|---|---|---|---|
| GET | `/events` | user | UI (EventSource) | one connection per user; a new tab replaces the old one |
| GET | `/events/test` | user | — | debug |
| POST | `/events/test/message` | user | — | debug, sends any payload to the caller |

SSE messages are unnamed events with JSON `data`. Commands the backend sends: `add`, `update`,
`process_update`, `process_finished`. The UI also handles `add_and_finish` and `batch_*`, which the
backend never sends. Field-level detail per command is in [ui-calls.md](ui-calls.md#sse).

## Static files

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/{param*}` | open | directory handler rooted at `src/public`, which does not exist, so every request 404s. SSE `add` events still point at `API_URL + 'icons/wait.gif'` |

## Queue message contract (backend → consumers → services)

Not an HTTP route, but just as binding: the JSON payload the backend publishes and later gets back
in callbacks. Fields the consumers and services read, and the fields the backend reads back on
`/files`, `/tmp`, `/done`, `/error`, are listed in [consumer-calls.md §4–5](consumer-calls.md).
The rewrite keeps every field name and shape, including `userId` (a user RID, despite the name),
`file['@rid']` meaning the *source* file on callbacks, `role`, `process.kind`, `target`,
`set_process`, `output_set`, `input_set`, `set_rid`, `root_source*`, `current_file`/`total_files`/
`batch_total_files`/`file_count`/`file_total`, `queue_options`, `tag_fields`, `output_file`,
`set_files`, `zip_output_name` and `db_name`, and the `<topic>` / `<topic>_batch` queue naming.
