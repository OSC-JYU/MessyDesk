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
| GET | `/api/thumbnails/{param*}` | Serve thumbnail images |
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
| GET/POST | `/api/entities/{rid}/vertex/{vid}` | Link entity to vertex |
| GET | `/api/entities/sets/{rid}` | Get entities for a set |

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
| POST | `/api/services/register` | Register service descriptor |
| POST | `/api/services/refresh` | Refresh service registry |
| POST | `/api/services/{service}/adapter/{id}` | Register adapter heartbeat |
| DELETE | `/api/services/{service}/adapter/{id}` | Unregister adapter |

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
| POST | `/api/nomad/service/{name}` | Deploy service |
| DELETE | `/api/nomad/service/{name}` | Stop service |

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
| GET | `/api/permissions/request` | Permission request |
| DELETE | `/api/logout` | Logout |

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
