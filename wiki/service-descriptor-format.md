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
    "id": "md-imaginary",
    "adapter": "imaginary",
    "name": "Imaginary",
    "description": "Image operations service",
    "location": "on-premise",
    "access": "free",
    "source_url": "https://github.com/h2non/node-imaginary",

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
| `adapter` | string | **Yes** | Adapter file name (e.g., `imaginary` → `adapters/imaginary.mjs`) |
| `name` | string | No | Display name in UI |
| `description` | string | No | Service description |
| `local_url` | string | No | Default service endpoint |
| `dev_url` | string | No | Alternative dev endpoint |
| `location` | string | No | `"on-premise"`, `"cloud"`, etc. |
| `access` | string | No | `"free"`, `"proprietary"`, `"commercial"` |
| `source_url` | string | No | Documentation/source URL |
| `supported_types` | string[] | No | File types this service accepts (e.g., `["image", "text"]`) |
| `supported_formats` | string[] | No | File extensions accepted (e.g., `["png", "jpg"]`) |
| `service_groups` | string[] | No | Category tags for UI grouping |
| `tasks` | object | Yes* | Task definitions (see below) |
| `external_tasks` | string | No | If set (e.g., `"prompts"`), tasks defined externally |
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

**[verified]** from `MD-consumers/descriptors/md-azure-ai/service.json`.

## Task Behaviour

**[verified]** from `graph.mjs` `resolveTaskBehaviour()`:

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
