# API Surface

Backend HTTP routes by domain. All paths are under `/api` except `/events` and static files.
RIDs in paths are written without `#` (`12:3`). **[verified]** from `src/modules/*/routes.ts`;
the contract tests in `test/contract/` pin request and response shapes.

Auth: **user** = `mail` header (or dev mode), **admin** = user with `access: admin`,
**service** = consumer token (see [backend structure](architecture/backend-structure.md#authentication)),
**open** = no auth.

## Session and users

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api` | user | `MessyDesk API` (session check) |
| GET | `/api/sso` | open | `{mail, name}` from proxy headers |
| GET | `/api/me` | user | `{rid, group, access, id, mode, settings}` |
| PUT | `/api/me/settings` | user | partial `{theme, cookie, motion}`; 400 on unknown keys/values |
| GET / POST | `/api/users` | admin | list / create `{id, label}` (400 invalid, 409 exists) |
| PUT | `/api/users/{rid}/service-groups` | admin | `{service_groups: []}` |
| POST | `/api/permissions/request` | open | identity from headers; 409 when already requested or a user |
| GET | `/api/permissions/request` | admin | |
| DELETE | `/api/permissions/request/{rid}` | admin | |

## Projects and sets

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/projects` | user | `{label, description, position}`; 400 no label, 409 duplicate label |
| GET | `/api/projects` | user | own projects with `node_count`, `file_count`, sorted by label |
| PUT | `/api/projects/{rid}` | user | `{key: label, description or position, value}` |
| DELETE | `/api/projects/{rid}` | user | cascade delete; returns the rid |
| GET | `/api/projects/{rid}` | user | desk graph `{nodes, edges}` (Vue Flow) |
| POST | `/api/projects/update-size` | user | recompute sizes from disk |
| GET | `/api/projects/storage-summary` | user | `{used_mb, quota_gb, quota_mb, used_percent}` |
| POST | `/api/projects/{rid}/sets` | user | create a set |
| POST | `/api/projects/{rid}/sources` | user | create a Source; queues `init` to `md-<type>` |
| POST | `/api/projects/{rid}/reindex-search` | user | drop the desk's search docs and re-queue indexing |
| POST | `/api/projects/{rid}/upload/{set?}` | user | multipart `file` (several only into a set). One file returns the node (errors as 400), several return `{uploaded, failed, total}`. 409 when the set was already processed |
| GET | `/api/sets/{rid}/files` | user | `{file_count, limit, skip, files}` with `thumb`, `entities` |
| POST | `/api/sets/{rid}/thumbnails` | user | re-queue thumbnails, 202 |
| POST | `/api/sets/{rid}/files/zip/jobs` | user/service | ZIP export job, 202 `{job_id, status, status_url, download_url}` |
| GET | `/api/sets/{rid}/files/zip` | user/service | same, with a `message` |
| GET | `/api/sets/{rid}/files/zip/jobs/{id}` | user | `processing`, `ready`, or 504 `failed` |
| GET | `/api/sets/{rid}/files/zip/jobs/{id}/download` | user | the ZIP; 409 not ready |

## Files

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/files/{rid}` | user/service | content; sibling `error.json` when the job failed |
| GET | `/api/files/{rid}/source` | user | content of the file it derives from |
| GET | `/api/files/{rid}/ancestors` | user | DERIVED_FROM chain; 403 when not yours |
| GET | `/api/files/{rid}/ner` | user | ner.json runs of a file |
| POST | `/api/files/{rid}/version` | user | multipart `file`+`operation`+`params`, or JSON `{content}` |
| POST | `/api/files/{rid}/revert` | user | back to `<path>.original`; 409 when none |
| POST | `/api/files/{rid}/thumbnail` | user | queue a thumbnail; 503 when no thumbnailer/poppler consumer |
| GET | `/api/documents/{rid}` | user | node attributes + `entities` |
| GET | `/api/thumbnails/{path*}` | user | `preview.jpg` / `thumbnail.jpg` next to a file; 404 when not ready or not yours |
| GET / POST | `/api/images/{rid}/sets/{set_rid}/rois` | user | read / upsert the roi.json |
| PUT / DELETE | `/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}` | user | update / delete |

## Graph

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/graph/traverse/{rid}/{direction}` | user | `in`, `out` or `both` along DERIVED_FROM |
| GET | `/api/graph/vertices/{rid}/init` | user | a Source's `init.json` |
| POST | `/api/graph/vertices/{rid}` | user | `{key, value}` for description, label, info, expand, metadata, response, node_error, path, edited |
| DELETE | `/api/graph/vertices/{rid}` | user | cascade delete; 409 with active jobs |
| POST / DELETE | `/api/graph/edges/{rid}` | user | edge attribute / delete (both ends must be yours) |
| GET | `/api/errors/{rid}` | user | a node's error fields |

## Processing, batches and the queue

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/queue/{service}/files/{rid}/{roi?}` | user | run a task on a file; returns the rid |
| POST | `/api/queue/{service}/sets/{rid}` | user | batch over a set; returns the set rid |
| POST | `/api/queue/{service}/sources/{rid}` | user | request to a Source |
| GET | `/api/queue/jobs/active` | user | the caller's active jobs (admins: all) |
| POST | `/api/queue/jobs/{rid}/dismiss` | user | batch rid or `job_N` |
| GET | `/api/queue/{topic}/flush` | admin | delete every job of a topic |
| GET | `/api/batches/{rid}` | user | batch node, or job info for `job_N` |
| POST | `/api/batches/{rid}/pause`, `/resume`, `/cancel` | user | |
| POST | `/api/queue/claim` | service | `{topic, adapter_id}` -> `{job}` |
| POST | `/api/queue/{job_id}/heartbeat`, `/complete`, `/fail` | service | `{adapter_id[, error]}` |

## Consumer callbacks

| Method | Path | Auth | Notes |
|---|---|---|---|
| POST | `/api/nomad/process/files` | service | multipart `content` + `message`, 500 MB |
| POST | `/api/nomad/process/files/tmp` | service | `{message, tmp_path}` (disk mode) |
| POST | `/api/nomad/process/files/done` | service | job finished without output |
| POST | `/api/nomad/process/files/error` | service | `{error, message}` |
| POST | `/api/nomad/process/files/metadata` | service | AI usage (`Usage` documents) |

## Services, help, Nomad

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET | `/api/services` | user | registry keyed by id, with live `consumers` |
| GET | `/api/services/{id}` | user/service | one descriptor (204 when unknown) |
| GET | `/api/services/files/{rid}` | user | `{for_type, for_format, filters}` for a node |
| POST | `/api/services/register` | service | `{source, service}` |
| POST / DELETE | `/api/services/{id}/adapter/{adapter_id}` | service | consumer heartbeat / goodbye |
| POST | `/api/services/install` | admin | `kind`: nomad, external or local |
| POST | `/api/services/reload` | admin | reload the persisted registry |
| DELETE | `/api/services/{id}` | admin/service | forget a service |
| POST | `/api/services/{id}/help/ingest` | service/admin | fetch and store the service's help |
| GET | `/api/services/{id}/help`, `/api/services/{id}/help/assets/{path*}` | open | |
| GET | `/api/help/{slug?}`, `/api/help/images/{path*}`, `/api/help/styles/{path*}` | open | built help pages |
| POST / DELETE | `/api/nomad/service/{name}` | admin/service | start (`{nomad_hcl}`) / stop |

## Tags, filters, prompts, search, service groups

| Method | Path | Auth | Notes |
|---|---|---|---|
| GET / POST | `/api/entities` | user | grouped by type (`project_rid(s)` scope) / create a human tag (`project_rid` and an existing `type` required: it joins the desk's vocabulary) |
| GET / POST | `/api/entities/types` | user | the user's tag types (`?counts=1` adds `count` and `protected`) / add one (`type`, optional `color`; 400 invalid, 409 duplicate) |
| DELETE | `/api/entities/types/{type}` | user | only when no tag has the type (409 with the count); `Tag` is protected (400) |
| GET | `/api/entities/items`, `/api/entities/sets/{rid}` | user | `items`: files with any of `entities` (default) or all of them (`match=and`), paged with `skip` / `limit` (default 24, at most 200): `{ total, skip, limit, items }` |
| POST / DELETE | `/api/entities/{eid}/vertex/{rid}` | user | link / unlink (204 when not yours, or when the file's desk does not have the human tag) |
| PATCH / DELETE | `/api/entities/{eid}` | user | rename a human tag in every desk that has it (409 when a desk already has that label) / delete it everywhere; 400 for machine tags |
| GET | `/api/entities/{eid}/usage` | user | desks and file counts of a human tag, for the rename/delete warnings |
| POST | `/api/entities/link/{rid}` | user/service | create and link a list |
| GET / POST | `/api/tags` | user | raw `{result: [...]}` envelope; `GET ?project_rid=` lists the desk's human tags; `POST` needs `project_rid` |
| GET | `/api/tags/admin` | user | tag admin list: human tags of a desk (`project_rid`) or all, with `desks`, `files`, `creator`; `search`, `skip`, `limit` |
| POST | `/api/projects/{rid}/tags` | user | create a human tag in the desk (returns the existing one with that type and label) |
| POST | `/api/projects/{rid}/tags/import` | user | `{entity_rids}` or `{from_project_rid}`: adds tags of other desks (same ids) → `{imported, skipped, conflicts}` |
| DELETE | `/api/projects/{rid}/tags/{eid}` | user | removes the tag from the desk and its links there; deletes the tag when no desk has it |
| GET | `/api/tags/machine` | user | Autotag tags grouped by service/task/model, with `service_name`; `project_rid(s)` limits to desks |
| GET | `/api/tags/ner/labels`, `/api/tags/ner/labels/mentions` | user | Faceted ROI-data browsing (read from the `ner.json` files); `tag_rids` (+ `tag_match`) narrows them to the files with those tags |
| GET | `/api/tags/roi/labels` | user | ROI labels from the Solr `roi_run` documents, `{items: [{service_id, task, model, label, count}], hasMore}`; `project_rid(s)`, `search`, `offset`, `limit` |
| POST | `/api/filters/{id}/files/{rid}` | user | `mdf-set-filter` (`selected_entity_rids` and/or `selected_roi_labels`; 502 when ROI labels are asked and Solr is down) or a region set |
| GET / POST | `/api/prompts` | user | list / create or update own prompt |
| POST | `/api/search` | user | Solr response; `[]` for an empty query |
| GET | `/api/search/info` | user | doc counts per project |
| GET / POST / PUT / DELETE | `/api/service-groups[/{id}]` | admin | |
| POST | `/api/service-groups/{id}/logo` | admin | resized by md-sharp |
| GET | `/api/service-groups/{id}/logo` | user | PNG |

## Events

`GET /events` (user): server-sent events, `id: <ms>\r\ndata: <json>\r\n\r\n`, unnamed. A user may
have several open connections. Commands: `add`, `update`, `process_update`, `process_finished`.

## Removed in the rewrite

Debug and unused routes were dropped (plan/decisions.md D5, E1, E2): `/events/test*`,
`/api/pipeline/files/*`, `/api/queue/{topic}/drain/*`, `/api/queue/drain/*`,
`/api/queue/{topic}/status`, `/api/queue/cleanup`, `/api/queue/sweeper/summary`,
`PUT /api/files/{rid}`, `POST /api/files/{rid}/sets/{set}/ner`,
`/api/tags/machine/{rid}/files`, `/api/tags/machine/{rid}/mentions`, `/api/tags/ner/labels/files`,
`GET /api/graph/vertices/{rid}`, `GET /api/nomad/status`, `/api/nomad/process/csv/append`,
`GET /api/entities/{rid}`, `DELETE /api/filters/{id}/files/{rid}`, `GET /api/projects/{rid}/files`.
Pipelines (chaining a task after another through `message.pipeline`) went with them.
