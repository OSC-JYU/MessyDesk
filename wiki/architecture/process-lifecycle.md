# Process Lifecycle

This document describes how a file processing job flows from user action to result materialization.

## Overview

```
User triggers pipeline
    ↓
Backend creates Process node in graph
    ↓
Backend publishes message to NATS JetStream (stream: PROCESS)
    ↓
MD-consumers adapter picks up message
    ↓
Adapter calls service HTTP endpoint
    ↓
Service processes file, returns result
    ↓
Adapter POSTs result to backend callback endpoint
    ↓
Backend materializes output files in graph + filesystem
    ↓
Backend sends SSE/WebSocket update to UI
```

## Step 1: Pipeline Trigger

**[verified]** from `src/routes/queues.mjs`:

User submits a processing request via the UI. The API endpoint is:

```
POST /api/pipeline/files/{file_rid}/{roi?}
```

Payload includes service ID, task ID, parameters, and optionally a set of files.

## Step 2: Process Node Creation

**[verified]** from `graph.mjs` `createProcessNode_queue()`:

1. Create directory: `data/{project}/processes/{uuid}/files/`
2. Create `Process` vertex with: uuid, status `queued`, task, service_id, description, model info
3. Link to Project via `BELONGS_TO` edge
4. Save full message as `message.json` in process directory (enables replay/debugging)

### Task Behaviour Modes

**[verified]** from `graph.mjs` `resolveTaskBehaviour()`:

Resolution order: task definition → service definition → default `one-to-one`.

| Mode | Meaning | Example |
|------|---------|---------|
| `one-to-one` | 1 input file → 1 Process → output file(s) in same context | Rotate image, OCR |
| `one-to-many` | 1 input file → 1 Process → multiple output files in new Set | Split PDF into pages |
| `many-to-one` | N input files → 1 SetProcess → 1 aggregated output | Merge documents |

**Non-obvious**: Search-related tasks (Solr/FAISS) are automatically treated as `many-to-one`. **[verified]**

### Output Set Creation

For `one-to-many` tasks, `createOutputSetNode()` creates a new Set linked to the input file via `DERIVED_FROM` with `process_rid` on the edge. **[verified]**

## Step 3: Message Construction

**[verified]** from `src/messageFactory.mjs`:

Messages are enriched before publishing:

```json
{
    "service": { "id": "md-ocr" },
    "task": { "id": "ocr", "params": { "lang": "fin" } },
    "file": {
        "@rid": "#12:0",
        "@type": "File",
        "path": "data/messydesk/.../source.txt",
        "metadata": { "width": 1024, "height": 768 },
        "project_rid": "#11:0"
    },
    "process": { "@rid": "#14:0" },
    "output_set": "#15:0",
    "set_process": "#16:0",
    "project_rid": "#11:0",
    "userId": "user@email.com",
    "total_files": 100,
    "current_file": 1
}
```

**Key invariant**: `project_rid` is auto-populated from file → process → node traversal, ensuring access control context is always present during async processing. **[verified]**

### ROI Handling

If processing a Region of Interest, `media.ROIPercentagesToPixels()` converts percentage coordinates to pixel values based on image metadata before message construction. **[verified]** from `media.mjs`.

## Step 4: Queue Publication

**[verified]** from `src/queue.mjs`:

Message published to NATS subject `process.{service_id}`. Stream is `PROCESS` with Workqueue retention policy.

For batch processing (`dispatchSetFilesForBatch`): one message per file, each with its own Process node. All share a parent `SetProcess` node.

## Step 5: Consumer Picks Up Message

**[verified]** from `MD-consumers/src/index.mjs`:

Each consumer process:
1. Listens on two NATS consumers: `{TOPIC}` and `{TOPIC}_batch`
2. Processes one message at a time (`max_messages: 1`)
3. Dynamically loads adapter: `import('./adapters/{adapter_name}.mjs')`
4. Calls `process_msg(service_url, message)`
5. ACKs message after processing (even on error in NATS mode)

## Step 6: Adapter Calls Service

**[verified]** from various adapter files in `MD-consumers/src/adapters/`:

Adapters translate the queue message into service-specific HTTP calls. Common patterns:

| Adapter Type | Service Call Pattern |
|-------------|---------------------|
| `imaginary` | `POST {service_url}/{task.id}?{params}` with FormData (image) |
| `elg` / `elg_fs` | `POST {service_url}/process` with multipart (message JSON + content file) |
| `poppler` | `POST {service_url}/{task.id}` with FormData |
| `ollama` | `POST {service_url}/api/generate` or `/api/chat` with JSON |
| `gemini-ai` | Google GenAI SDK call with uploaded file |
| `azure-ai` | Azure OpenAI SDK call |
| `solr` | `POST {solr_url}/update` with document JSON |

## Step 7: Result Callback

**[verified]** from `MD-consumers/src/funcs.mjs`:

Adapters send results back to the backend via HTTP:

| Endpoint | Purpose |
|----------|---------|
| `POST /api/nomad/process/files` | File result (multipart: content + message JSON). Max 500MB. |
| `POST /api/nomad/process/files/done` | Processing complete signal |
| `POST /api/nomad/process/files/error` | Processing error |
| `POST /api/nomad/process/files/metadata` | Metadata-only result. Max 200MB. |
| `POST /api/nomad/process/files/tmp` | Temp file staging (disk mode) |

## Step 8: Result Materialization

**[verified]** from `src/controllers/processFilesController.mjs`:

### Normal files
1. Create `File` vertex in graph
2. Write file bytes to disk
3. Extract metadata (dimensions, text summary)
4. Link via `DERIVED_FROM` edge (with process_rid, cruncher, task on edge)
5. If `output_set` present: set `set` attribute, sync manifest, increment count

### Reference files (`isReference=true`)
1. Create `File` vertex with `ref` attribute pointing to source file RID
2. **No bitstream written** — shares source file path on disk
3. Skip metadata extraction

**[verified]** from `processFilesController.mjs`.

### Batch state checking

Before materializing each file output, the controller checks `SetProcess.status`. If status is `paused`, `cancelling`, `cancelled`, or `done`, the output is silently skipped. **[verified]**

## Step 9: UI Update

**[verified]** from `src/routes/nomad.mjs`:

After successful processing:
1. `batch_processed` counter incremented with processing time
2. `process_finished` WebSocket/SSE event sent to user
3. UI reactively updates file lists

### Error handling in callbacks

**[verified]** from `src/routes/nomad.mjs`:

| Condition | Behavior |
|-----------|----------|
| Thumbnail failure (`role=thumbnail`) | Warning logged, no error node created |
| Internal versioning failure (`role=internal_versioning`, `role=exif_rotate`) | Logged, no error node created |
| All other errors | Error node created in graph, `error.json` written to disk, WebSocket update sent |

## Batch Processing (SetProcess)

**[verified]** from `graph.mjs` and `queues.mjs`:

For processing multiple files:

1. `SetProcess` vertex created as parent
2. One `Process` child per file, each linked to SetProcess via `set_process` attribute
3. Messages published individually to queue
4. Each consumer processes independently
5. Each callback increments `SetProcess.batch_processed`
6. Completion detected when all files processed

### Queue control

| Endpoint | Action |
|----------|--------|
| `POST /api/queue/{topic}/pause` | Pause queue consumption |
| `POST /api/queue/{topic}/resume` | Resume queue consumption |
| `POST /api/queue/{topic}/cancel` | Cancel queued jobs |
| `GET /api/queue/{topic}/drain/{process_rid?}` | Flush queued jobs |

**[verified]** from `src/routes/queues.mjs`.

## State Machine

```
Process status transitions:
    queued → running → done
    queued → running → error
    queued → cancelled (via drain)

SetProcess status transitions:
    queued → running → done
    queued → running → paused → running → done
    queued → running → cancelling → cancelled
```

**[inferred]** from reading status checks in processFilesController and queue routes. The status values are set as strings; there is no formal state machine enforcer.
