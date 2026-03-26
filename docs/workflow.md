# Workflow

This document describes end-to-end processing flow in current MessyDesk backend.

## Single file crunch flow

1. UI sends request to:
    - `POST /api/queue/{topic}/files/{file_rid}/{roi?}`
2. Backend resolves service/task and creates process node metadata.
3. Backend writes process payload snapshot to process directory.
4. Backend sends SSE `add` event so UI shows process node.
5. Backend publishes one or more NATS messages:
    - `process.<topic>`
    - or `process.<topic>_batch` for configured tasks.
6. Consumer executes task and posts result files to:
    - `POST /api/nomad/process/files`
    - or `POST /api/nomad/process/files/tmp` when output is already in `data/<DB_NAME>/tmp`
7. Backend stores outputs, updates graph, and emits SSE updates.
8. Backend may trigger additional thumbnail processing for image/pdf outputs.

## Set crunch flow (batch)

1. UI sends request to:
    - `POST /api/queue/{topic}/sets/{set_rid}`
2. Backend creates a visible set-level process (`SetProcess`) and usually an output set.
3. Backend emits SSE `add` event for process (and output set when created).
4. Backend enumerates files in the input set and creates per-file processing messages.
5. Messages are published to `process.<topic>_batch`.
6. Consumers process files and post results to `POST /api/nomad/process/files`.
7. Backend updates set count and emits throttled SSE progress (`process_update`).
8. When last file is done, backend emits `process_finished`.

Notes:

- For some task types (`many-to-one`) the set-level flow is different and can use a single process node and/or fewer requests.
- Current progress updates are intentionally throttled to reduce event traffic.

## Source flow

1. Source node is created in graph under a project.
2. UI starts source task via:
    - `POST /api/queue/{topic}/sources/{source_rid}`
3. Backend creates process + output set and publishes to batch queue.
4. Consumer imports content, posts files back, and normal file/set update flow continues.

## Error and completion callbacks

Service/consumer callbacks:

- Success with files: `POST /api/nomad/process/files`
- Success with files already staged in data dir tmp: `POST /api/nomad/process/files/tmp`
- Explicit done signal: `POST /api/nomad/process/files/done`
- Error signal: `POST /api/nomad/process/files/error`

UI update channel:

- Server-Sent Events from `GET /events`

## Batch scale requirements (target)

To support very large sets cleanly, workflow should evolve with:

1. Persisted batch state machine.
2. Pause/resume/cancel controls.
3. ETA based on completed file timings.
4. Windowed dispatch to avoid queue flooding.

See `docs/batch-processing-plan.md` for implementation details.

