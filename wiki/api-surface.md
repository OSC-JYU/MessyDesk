# API Surface

Backend HTTP endpoints organized by domain. All endpoints are under `/api` unless noted.

**[verified]** from route files in `src/routes/`.

## Projects

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/projects` | Create project (requires `label`) |
| GET | `/api/projects` | List user's projects |
| GET | `/api/projects/storage-summary` | Storage usage per project |
| POST | `/api/projects/{rid}/upload/{set?}` | Upload file to project (optionally into a set) |
| GET | `/api/projects/export/{rid}` | Export project |

## Files

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/files/{rid}/thumbnail` | Generate thumbnail |
| POST | `/api/files/{rid}/version` | Create file version |
| GET | `/api/documents/{rid}` | Get document content |
| GET | `/api/thumbnails/{param*}` | Serve thumbnail images; 404 when the thumbnail has not been made yet (the UI draws its own placeholder) |
| DELETE | `/api/files/{rid}` | Delete file |

## Graph (Generic Vertex/Edge Access)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/graph/vertices/{rid}` | Get vertex by RID |
| POST | `/api/graph/vertices/{rid}` | Update vertex attributes |
| DELETE | `/api/graph/vertices/{rid}` | Delete vertex (cascade) |
| GET | `/api/graph/traverse/{rid}/{direction}` | Traverse edges |
| GET | `/api/graph/edges/{rid}` | Get edges for vertex |

## Entities

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/entities` | List entities |
| POST | `/api/entities` | Create entity |
| GET | `/api/entities/types` | List entity types |
| GET/POST | `/api/entities/{rid}/vertex/{vid}` | Link entity to vertex (creates/removes a `TagLink`) |
| GET | `/api/entities/sets/{rid}` | Get entities for a set |

## Tags

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/tags` | List the current user's Tag entities |
| POST | `/api/tags` | Create a Tag entity |
| GET | `/api/tags/machine` | List classification-autotag tags (TagLink-backed) grouped by (service_id, task, label) with counts |
| GET | `/api/tags/machine/{entity_rid}/files` | Files tagged by one (service_id, task, entity) combination |
| GET | `/api/tags/machine/{entity_rid}/mentions` | Paged, searchable mention text for one machine-tag combination |
| GET | `/api/tags/ner/labels` | List Faceted ROI-data (service_id, task, label) groups found across a user's `ner.json` runs — no TagLink involved |
| GET | `/api/tags/ner/labels/files` | Files whose `ner.json` contains a given Faceted ROI-data (service_id, task, label) group |
| GET | `/api/tags/ner/labels/mentions` | Paged, searchable mention text (with per-hit start/end/confidence) for one NER label group |

## NER regions

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/files/{rid}/ner` | List `ner.json` runs for a file, each with per-mention regions (label/start/end/confidence) |
| POST | `/api/files/{rid}/sets/{set_rid}/ner` | Manually create a `ner.json` file node (accepts `service_id`/`task` query params) |

## Queue / Pipeline

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/pipeline/files/{file_rid}/{roi?}` | Trigger processing pipeline |
| GET | `/api/queue/{topic}/drain/{process_rid?}` | Drain queue |
| POST | `/api/queue/{topic}/pause` | Pause queue |
| POST | `/api/queue/{topic}/resume` | Resume queue |
| POST | `/api/queue/{topic}/cancel` | Cancel queued jobs |

## Search

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/search` | Full-text search |
| GET | `/api/search/info` | Search statistics |

## Services

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/services` | List registered services |
| GET | `/api/services/{service}` | Get service descriptor |
| POST | `/api/services/register` | Register service descriptor (used by consumers; open) |
| POST | `/api/services/install` | **admin** Install a service (kind: `nomad`\|`external`\|`local`) and persist to registry |
| DELETE | `/api/services/{service}` | **admin** Forget service (remove from registry) |
| POST | `/api/services/reload` | **admin** Reload service descriptors from disk |
| POST | `/api/services/refresh` | Refresh service registry |
| POST | `/api/services/{service}/adapter/{id}` | Register adapter heartbeat (consumers; open) |
| DELETE | `/api/services/{service}/adapter/{id}` | Unregister adapter (consumers; open) |

## ROI (Region of Interest)

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/images/{rid}/sets/{set_rid}/rois` | Create/update ROIs for image |
| GET | `/api/images/{rid}/rois/{roi_id}` | Get ROI |
| PUT | `/api/images/{rid}/rois/{roi_id}` | Update ROI |
| DELETE | `/api/images/{rid}/rois/{roi_id}` | Delete ROI |

## Nomad (Service Orchestration)

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/nomad/status` | Check Nomad cluster status |
| POST | `/api/nomad/service/{name}` | **admin** Deploy service |
| DELETE | `/api/nomad/service/{name}` | **admin** Stop service |

## Process Callbacks (from consumers)

| Method | Path | Max Payload | Purpose |
|--------|------|-------------|---------|
| POST | `/api/nomad/process/files` | 500MB | Receive processed file result |
| POST | `/api/nomad/process/files/done` | — | Signal processing complete |
| POST | `/api/nomad/process/files/error` | — | Signal processing error |
| POST | `/api/nomad/process/csv/append` | 200MB | CSV append operation |
| POST | `/api/nomad/process/files/metadata` | 200MB | Metadata extraction result |

## Events

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/events` | Server-Sent Events stream |
| GET | `/api/queue/events` | Queue-specific events |

## Auth

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/sso` | SSO endpoint |
| GET | `/api/me` | Current user identity/access level and UI `settings` (defaults filled in) |
| PUT | `/api/me/settings` | Save the user's UI settings: `theme` (`light`/`dark`/`system`), `cookie` (`classic`/`chocolate`/`matcha`/`strawberry`/`blueberry`); partial updates merge, unknown keys or values give 400. See `src/userSettings.mjs` |
| GET | `/api/users` | **admin** List users |
| POST | `/api/users` | **admin** Create user |
| PUT | `/api/users/{rid}/service-groups` | **admin** Replace a user's ServiceGroup membership (`service_groups` string array) |
| GET | `/api/permissions/request` | Permission request |
| DELETE | `/api/logout` | Logout |

## Service Groups

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/service-groups` | **admin** List ServiceGroups |
| POST | `/api/service-groups` | **admin** Create a ServiceGroup (`id`, `name`, `description`) |
| PUT | `/api/service-groups/{id}` | **admin** Update `name`/`description` |
| DELETE | `/api/service-groups/{id}` | **admin** Delete a ServiceGroup |
| POST | `/api/service-groups/{id}/logo` | **admin** Upload a logo (multipart); resized to 200x200 async via the `md-sharp` queue, see [service-descriptor-format.md](service-descriptor-format.md#service-groups) |
| GET | `/api/service-groups/{id}/logo/source` | **admin** Fetched by the md-sharp consumer for the pending resize job |
| GET | `/api/service-groups/{id}/logo` | Serves the resized PNG logo |

## Filters

| Method | Path | Purpose |
|--------|------|---------|
| POST | `/api/filters/{type}/files/{node_id}` | Apply filter to file |

## Prompts

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/prompts` | List prompts |
| POST | `/api/prompts` | Save prompt |

## Help

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/help/{service}` | Get service help documentation |
| GET | `/api/help/images/{assetPath*}` | Serve help images |

## Errors

| Method | Path | Purpose |
|--------|------|---------|
| GET | `/api/errors/{rid}` | Get error details |
