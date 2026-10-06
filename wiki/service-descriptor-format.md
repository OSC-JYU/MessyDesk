# Service Descriptor Format

Every processing service is described by a `service.json` descriptor. This document explains the format and how it is used by the platform.

## Descriptor Location

Descriptors can come from multiple sources, resolved in priority order by `resolveDescriptorSourceChain()` in MD-consumers:

1. **Runtime `/config`** — service exposes its current config via HTTP
2. **Explicit path** — `SERVICE_JSON_PATH` env var
3. **Adapter directory** — `descriptors/{topic}/service.json` in MD-consumers
4. **Backend registry** — `GET /api/services/{topic}` from MessyDesk
5. **Topic fallback** — minimal `{ id: topic, tasks: {} }`

**[verified]** from `MD-consumers/src/funcs.mjs`.

## Schema

```json
{
    "id": "md-sharp",
    "adapter": "elg",
    "name": "Sharp",
    "description": "Image operations service",
    "location": "on-premise",
    "access": "free",
    "category": "preparation",
    "source_url": "https://sharp.pixelplumbing.com/",

    "local_url": "http://localhost:9000",
    "dev_url": "http://localhost:9001",

    "supported_types": ["image"],
    "supported_formats": ["png", "jpg", "jpeg", "webp", "tiff"],

    "service_groups": ["IMAGE"],

    "params_help": {
        "width": {
            "name": "width",
            "default": 200,
            "help": "Width of the image in pixels",
            "display": "textinput"
        }
    },

    "tasks": {
        "resize": {
            "name": "Resize by width",
            "description": "Resize image",
            "behaviour": "one-to-one",
            "params": { "width": 400 },
            "params_help": { }
        }
    }
}
```

## Field Reference

### Top-level fields

| Field | Type | Required | Notes |
|-------|------|----------|-------|
| `id` | string | **Yes** | Must match TOPIC and consumer durable name |
| `adapter` | string | **Yes** | Adapter file name (e.g., `elg` → `adapters/elg.mjs`) |
| `name` | string | No | Display name in UI |
| `description` | string | No | Service description |
| `local_url` | string | No | Default service endpoint |
| `dev_url` | string | No | Alternative dev endpoint |
| `location` | string | No | `"on-premise"`, `"cloud"`, etc. |
| `access` | string | No | `"free"`, `"proprietary"`, `"commercial"` |
| `category` | string | No | One of `preparation`, `linguistic`, `ml`, `generative`, `system` (see [3.tools.md](../docs/help/3.tools.md)). Missing/invalid values show as "Uncategorized" in the UI; invalid (non-empty) values are rejected at registration. `system` services are internal-only and are filtered out of `servicesForNode()` entirely, so they never reach the crunchers UI. |
| `source_url` | string | No | Documentation/source URL |
| `supported_types` | string[] | No | File types this service accepts (e.g., `["image", "text"]`) |
| `supported_formats` | string[] | No | File extensions accepted (e.g., `["png", "jpg"]`) |
| `service_groups` | string[] | No | ServiceGroup `id`s gating which users may use the service/task — see [Service Groups](#service-groups) |
| `tasks` | object | Yes* | Task definitions (see below) |
| `external_tasks` | string | No | `"prompts"`: the user's prompts are offered as tasks (LLM services), next to the descriptor's own `tasks` (e.g. `autotag`) |
| `models` | object | No | Model variants for LLM services |

**[verified]** from descriptor files in `MD-consumers/descriptors/` and Python service `service.json` files.

### Task definition

| Field | Type | Notes |
|-------|------|-------|
| `name` | string | Display name |
| `description` | string | Task description |
| `info` | string | Short UI label |
| `behaviour` | string | `"one-to-one"` (default), `"one-to-many"`, `"many-to-one"` |
| `params` | object | Default parameter values |
| `params_help` | object | Per-parameter UI help (see below) |

### Parameter help

| Field | Type | Notes |
|-------|------|-------|
| `display` | string | UI widget: `"textinput"`, `"dropdown"`, `"checkbox"` |
| `help` | string | Help text shown in UI |
| `name` | string | Display name |
| `default` | any | Default value |

### Model definition (LLM services)

```json
{
    "models": {
        "gpt-4o": {
            "name": "GPT-4o",
            "version": "2025-01-01-preview",
            "supported_types": ["image", "text"],
            "supported_formats": ["jpg", "png", "txt"]
        }
    }
}
```

Further model fields used by the LLM services (MD-llm `providers/*.json`, `plan/llm-adapter.md`):
`family` (the same model on several providers; the UI shows it once and asks for the provider),
`max_input_tokens`, `max_output_tokens`, `max_image_edge`, `temperature: false`,
`structured_output: false`. The chosen model is stored on the Process as `model`, `model_version`
and `model_family`.

**[verified]** from MD-llm `providers/*.json` and `src/modules/processing/processing.ts`.

## Task Behaviour

**[verified]** from `resolveBehaviour()` (src/modules/services/registry.ts):

| Value | Meaning | Output handling |
|-------|---------|-----------------|
| `one-to-one` | 1 file → 1 result | Output files in same set/context |
| `one-to-many` | 1 file → N results | New output Set created |
| `many-to-one` | N files → 1 result | Single aggregated output |

Resolution order: task-level `behaviour` → service-level `behaviour` → `"one-to-one"`.

**Important**: Invalid behaviour values are rejected with 400 error before Process nodes are created. Allowed values: `['one-to-one', 'one-to-many', 'many-to-one']`. **[verified]**

## Registration Flow

**[verified]** from `MD-consumers/src/index.mjs`:

1. Consumer starts → resolves descriptor via priority chain
2. Resolves service URL (DEV_URL → Nomad → local_url)
3. Registers adapter: `POST /api/services/{TOPIC}/adapter/{adapter_id}`
4. Registers descriptor: `POST /api/services/register` (with exponential backoff retry)
5. Triggers help ingestion: `POST /api/services/{TOPIC}/help/ingest`
6. Heartbeat every 30 seconds: re-registers adapter + descriptor
7. On SIGINT: `DELETE /api/services/{TOPIC}/adapter/{adapter_id}`

## Python Service Convention

All Python services in this workspace follow this common pattern:

**[verified]** from `service_registration.py` and `api.py` in MD-text-base_fs, MD-opencv, MD-zip_fs, MD-finbert-ner:

- Framework: FastAPI with global CORS middleware
- Endpoints: `GET /health`, `GET /config`, `GET /help`, `POST /process`
- `/config` returns `service.json` content
- `/health` returns `{"status": "ok", "service": "<id>"}`
- `/process` accepts multipart: `message` (JSON metadata) + `content` (file) + optional `source` (image)
- Storage mode: `STORAGE_MODE` env (`http` or `disk`)
- Disk mode validates paths against `MD_PATH` to prevent traversal

## Service Groups

`service_groups` (top-level and per-task) started out as free-text strings (e.g. `"IMAGE"`, `"OSC"`)
gating which users can see/run a service or task (`src/modules/services/registry.ts` `pickTasks()`: a user only sees a
service/task if `user.service_groups` intersects it). These values are now backed by an admin-managed
`ServiceGroup` graph vertex type (the modules under `src/modules/` `createServiceGroup`/`getServiceGroups`/etc., routes in
`src/modules/service-groups/service-groups.ts`), giving each group a stable `id` (the string used in `service_groups`
arrays), a display `name`, a `description`, and an optional `logo`.

**[verified]** from `src/modules/` (see [backend structure](architecture/backend-structure.md)), `src/modules/service-groups/service-groups.ts`, `src/modules/users/routes.ts`.

- Managed from the admin-only Service Groups tab in MessyDesk-UI's `AdminMain.vue`; backend routes
  also enforce `access === 'admin'` independently.
- `ServiceGroup.id` must match `^[A-Za-z0-9_-]{1,64}$` (also enforced defensively wherever the id is
  used to build a filesystem path).
- A user's group membership is edited inline in the Users tab and persisted via
  `PUT /api/users/{rid}/service-groups`, which replaces `User.service_groups`.
- Logo upload (`POST /api/service-groups/{id}/logo`) calls the standalone **MD-sharp** service's
  `/process` endpoint directly and synchronously over HTTP (multipart `message` + `content` fields,
  `fit` task, 200x200 PNG output) — see `src/modules/service-groups/service-groups.ts`. This bypasses the
  queue/consumer pipeline entirely: a ServiceGroup logo isn't a Project/File graph node, so there is
  no `@rid` for a consumer to attach a result to, and no benefit to going through a MD-consumers
  adapter for a one-off admin action. The response is written straight to disk and returned to the
  admin UI in the same request — no polling or pending state.
- Requires the `md-sharp` service to be registered in MessyDesk's service registry with a reachable
  `local_url`/`url` (see [architecture/services/consumers.md](architecture/services/consumers.md)); if
  not registered, the upload fails immediately with a 503 rather than hanging.
