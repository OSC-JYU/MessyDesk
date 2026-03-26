# Work queues

MessyDesk uses [NATS JetStream](https://docs.nats.io/nats-concepts/jetstream) for processing queues and optional [Nomad](https://www.nomadproject.io/) for service runtime orchestration.

This document describes the current queue structure and the recommended direction for scalable batch processing.

## Current queue structure

- Stream: `PROCESS`
- Subjects: `process.>`
- Per service consumers:
  - `process.<serviceId>`
  - `process.<serviceId>_batch`
- Retention: `Workqueue`

Core code:

- Queue initialization: `src/queue.mjs`
- Queue routes: `src/routes/queues.mjs`
- Process callback handlers: `src/routes/nomad.mjs`, `src/controllers/processFilesController.mjs`

## Current API entry points

Queue creation:

- `POST /api/queue/{topic}/files/{file_rid}/{roi?}`
- `POST /api/queue/{topic}/sets/{set_rid}`
- `POST /api/queue/{topic}/sources/{source_rid}`

Queue control/status:

- `GET /api/queue/{topic}/status`
- `GET /api/queue/{topic}/drain/{process_rid?}`

Service callback endpoints:

- `POST /api/nomad/process/files`
- `POST /api/nomad/process/files/tmp` (for outputs already written under `data/<DB_NAME>/tmp`)
- `POST /api/nomad/process/files/done`
- `POST /api/nomad/process/files/error`

## Current processing flow

1. UI calls a queue endpoint.
2. Backend creates process nodes (and output set node when needed).
3. Backend publishes message(s) to `process.<topic>` or `process.<topic>_batch`.
4. Consumer reads message, runs service, then posts results back to MessyDesk.
5. MessyDesk creates/updates file and process/set nodes.
6. Backend sends SSE events (`add`, `update`, `process_update`, `process_finished`) to UI.

## Current batch behavior

- Set processing creates one visible `SetProcess` and many per-file internal process nodes (for set-to-set paths).
- Progress events are intentionally throttled in backend (currently every 10 files) to avoid UI flooding.
- `drain` can stop pending messages for a process/set process.

## Known gaps for large batches

- Pause/resume is implemented at batch-dispatch level (not consumer level) and resume logic still needs stress-testing for very large sets.
- No canonical persisted batch state machine (`queued/running/paused/...`).
- No ETA field exposed to UI.
- Message emission and queueing strategy can still overload large sets if enqueue windowing is not used.

## Target direction (summary)

1. Add a canonical batch run model and state machine.
2. Keep control APIs (`pause`, `resume`, `cancel`) batch-scoped and never pause shared consumers.
3. Add aggregated progress + ETA updates at bounded frequency.
4. Move to windowed dispatch for very large sets.

Detailed implementation steps are in `docs/batch-processing-plan.md`.