# MessyDesk AI coding instructions

## Big picture
- Backend is a Node.js Hapi server in [src/index.mjs](src/index.mjs) that wires route modules from [src/routes/](src/routes) and initializes core subsystems.
- Core subsystems:
  - Graph/DB layer in [src/graph.mjs](src/graph.mjs) uses ArcadeDB via [src/db.mjs](src/db.mjs) and persists file-centric nodes under DATA_DIR.
  - Queueing uses NATS Jetstream in [src/queue.mjs](src/queue.mjs) with stream `PROCESS` and subjects `process.<serviceId>`.
  - Service definitions are loaded from services/*/service.json (plus optional nomad.hcl) in [src/services.mjs](src/services.mjs).
  - Nomad integration lives in [src/nomad.mjs](src/nomad.mjs) and is enabled via NOMAD=true.
- The UI is a separate Vue 3 + Vite app under the sibling repo MessyDesk-UI (see [../MessyDesk-UI/README.md](../MessyDesk-UI/README.md)).

## Messaging & processing flow
- Queue endpoint: POST /api/queue/:topic/files/:file_rid (see [docs/work-queue.md](docs/work-queue.md) and [docs/workflow.md](docs/workflow.md)).
- Message shape is documented in [docs/messages.md](docs/messages.md); services consume a message with `service`, `task`, `file`, `process`, `userId`, etc.
- UI update messages and process state transitions are described in [docs/UI-messaging.md](docs/UI-messaging.md).

## Service/task conventions
- Services are discovered from services/*/service.json; tasks can override matching via `supported_types`/`supported_formats` (see [docs/services.md](docs/services.md)).
- Matching order is task `supported_types`, task `supported_formats`, then service-level `supported_types`, `supported_formats`.
- Some services are “external_tasks” and use prompts to generate tasks in [src/services.mjs](src/services.mjs).

## Dev workflows (local)
- Minimal local stack: ArcadeDB + NATS Jetstream + backend + UI + MD-consumers + Imaginary. See [docs/quick_start_without_nomad.md](docs/quick_start_without_nomad.md).
- Backend start example (development auth bypass):
  - MODE=development DB_PASSWORD=node_master node src/index.mjs
- UI dev server: npm install && npm run dev (see [../MessyDesk-UI/README.md](../MessyDesk-UI/README.md)).
- Tests: npm test (Mocha), defined in [package.json](package.json).

## Project-specific patterns
- Development auth bypass sets a default user via `DEV_USER` and the `mail` header in [src/index.mjs](src/index.mjs).
- File paths are generated with DATA_DIR + rid-based paths (see [src/graph.mjs](src/graph.mjs) and [src/media.mjs](src/media.mjs)).
- Queue consumers are created per service id at startup; topics are `process.<serviceId>` in [src/queue.mjs](src/queue.mjs).
