# Service Registration (New System)

## Summary

The new registration system separates two concerns:

- Capability descriptor: what a service can do (tasks, behaviour, supported types and formats).
- Deployment/runtime state: where service runs and which adapters are currently alive.

Registration flow at a glance:

1. Service descriptor is stored as JSON in the service repository.
2. Service exposes `/config` that reads that JSON (and may add runtime fields like local_url).
3. Consumer resolves descriptor with source priority:
   - runtime `/config`
   - adapter descriptor file
   - backend registry copy
   - topic fallback
4. Consumer registers descriptor to backend with `POST /api/services/register`.
5. Consumer also announces liveness with `POST /api/services/{topic}/adapter/{id}` heartbeat.
6. Backend persists descriptors and restores them on restart.

Important responsibility split:

- Service process does not call MessyDesk API directly.
- Consumer process is responsible for registration and liveness calls.

## Why This Model

- Service capabilities are versioned near service code.
- Existing external APIs can still participate through adapter-owned descriptors.
- Backend restart does not lose capability metadata.
- Adapter liveness remains dynamic and self-healing via heartbeat.

## Descriptor Requirements

Each service descriptor JSON must include at least:

- `id` (string, non-empty)
- `tasks` (object)

Recommended fields:

- `name`
- `adapter`
- `description`
- `supported_types` (array)
- `supported_formats` (array)
- task-level `behaviour` (`one-to-one`, `one-to-many`, `many-to-one`)

## Developer Directions

### 1. Add descriptor JSON to service repository

Create `service.json` in the service repo (example for Python service).

Keep this file as the source of truth for capabilities.

### 2. Implement `/config` in the service

Expose `GET /config` that:

- reads descriptor JSON from local file
- validates minimal shape (object, non-empty `id`, object `tasks`)
- optionally overlays runtime fields (for example `local_url`, runtime port)

Do not hardcode capability metadata in code if it already exists in `service.json`.

### 3. Ensure consumer can resolve descriptor

Consumer source chain should be:

1. runtime `/config`
2. adapter descriptor file
3. backend `GET /api/services/{topic}`
4. topic fallback descriptor

### 4. Register descriptor to backend

Consumer (not the service) must call:

- `POST /api/services/register`

Payload shape:

- `source`: string describing source (`runtime-config`, `adapter-descriptor`, etc.)
- `service`: descriptor object

Backend behavior:

- validates and normalizes descriptor
- idempotent upsert (`created` or `updated`)
- persists registry to disk

### 5. Register adapter liveness

Consumer must also call:

- `POST /api/services/{topic}/adapter/{id}` on startup
- same endpoint periodically as heartbeat
- `DELETE /api/services/{topic}/adapter/{id}` on shutdown (best effort)

Descriptor registration and adapter liveness are separate and both are required.

## Local Development Without Discovery

When not using Nomad/service discovery, consumer may not know the runtime service address automatically.

Use `DEV_URL` to tell consumer where the service is running.

Example:

`TOPIC=md-hello-world DEV_URL=http://localhost:9010 node src/index.mjs`

Notes:

- `ADAPTER` is usually not required as CLI parameter if descriptor already contains adapter information.
- Consumer can resolve adapter from descriptor source chain (runtime config or adapter descriptor file).

## Nomad Deployment From Service Repository

Nomad specification can live in the service repository (for example `nomad.hcl`).

When starting consumer in Nomad mode, pass the file path to consumer:

`TOPIC=md-hello-world NOMAD=true NOMAD_HCL_PATH=/absolute/path/to/service/nomad.hcl node src/index.mjs`

Consumer behavior in this mode:

1. If service is not running, consumer calls backend start endpoint.
2. Consumer sends `nomad_hcl` content read from `NOMAD_HCL_PATH`.
3. Backend uses that HCL to start Nomad job.
4. Consumer continues with `/config` validation and registration.

Notes:

- This keeps deployment metadata in service repository while backend still controls Nomad API call.
- If `NOMAD_HCL_PATH` is missing, backend falls back to its existing service configuration.

### 6. Add retry/backoff for registration

Registration calls should use retry with exponential backoff:

- startup registration: stronger retries
- heartbeat registration: fewer retries, continue loop

This avoids gaps during temporary backend unavailability.

## Backend Notes

- Registry persistence path defaults under data directory and can be overridden by `SERVICE_REGISTRY_PATH`.
- On startup, backend loads filesystem descriptors and overlays persisted registry descriptors.
- Runtime-only fields (for example active consumers) are rebuilt by heartbeat after restart.

## Restart Behavior

When backend restarts:

- capability descriptors are restored from persisted registry
- active adapter presence starts empty in memory
- running consumers repopulate presence via heartbeat

So capability metadata survives restart; live adapter state converges shortly after.

## Optional NATS Consumer Cleanup

Backend can safely prune stale NATS PROCESS consumers when enabled:

- enable with `NATS_PRUNE_STALE_CONSUMERS=true`
- stale threshold via `NATS_STALE_CONSUMER_IDLE_MS`

This is targeted pruning, not delete-all.

## Quick Validation Checklist

Before merging a new service:

1. Descriptor JSON exists in service repository.
2. Service `GET /config` returns descriptor from file.
3. Descriptor includes explicit task `behaviour`.
4. Consumer registers descriptor successfully.
5. Consumer heartbeat updates adapter liveness.
6. Backend restart preserves descriptor visibility in API.
