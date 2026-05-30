# Consumers

This document explains the key consumer options and why you would use each one.

Consumers are implemented in the sibling repository `MD-consumers` and connect MessyDesk queue messages to service APIs.

## Repositories and paths

- MessyDesk backend: `../MessyDesk`
- Consumers: `../MD-consumers`
- Main consumer entry points:
  - `../MD-consumers/src/index.mjs` (default)
  - `../MD-consumers/src/index-db.mjs` (SQLite-backed queue processing)

## Default run

Use this for most services.

Run from `MD-consumers`:

```bash
TOPIC=md-imaginary node src/index.mjs
```

What it does:

- Registers service descriptor to MessyDesk.
- Registers consumer adapter heartbeat to MessyDesk.
- Consumes from `TOPIC` and `TOPIC_batch`.
- Resolves service endpoint from descriptor `local_url` (or Nomad when enabled).
- Triggers service help ingestion after registration.

## Queue backend option

### Option A: JetStream loop (`index.mjs`)

Why needed:

- Lowest operational complexity.
- Fits default MessyDesk deployments.
- Directly consumes from NATS JetStream subjects.

### Option B: SQLite-backed queue worker (`index-db.mjs`)

Why needed:

- More explicit local job state and retry/lease behavior.
- Easier to inspect queue state from SQLite file.
- Useful when debugging long-running or retrying jobs.

Run from `MD-consumers`:

```bash
TOPIC=md-imaginary node src/index-db.mjs
```

Useful env vars:

- `QUEUE_DB_PATH` (default `/tmp/messydesk-queue.sqlite`)
- `QUEUE_DB_POLL_MIN_MS`
- `QUEUE_DB_POLL_MAX_MS`
- `QUEUE_DB_LEASE_SECONDS`
- `QUEUE_DB_MAX_ATTEMPTS`

## Service URL resolution options

### Option A: Descriptor/Nomad-based resolution (default)

Why needed:

- Works with normal MessyDesk + Nomad service lifecycle.
- Keeps service location in descriptor config.

### Option B: Direct development URL (`DEV_URL`)

Why needed:

- Fast local development against manually started service.
- Bypasses service discovery issues.

Example:

```bash
TOPIC=md-imaginary DEV_URL=http://localhost:9000 node src/index.mjs
```

## Descriptor source options

### Option A: Runtime `/config` descriptor (preferred)

Why needed:

- Service is source of truth for its current runtime config.

### Option B: Explicit descriptor path (`SERVICE_JSON_PATH`)

Why needed:

- Service does not expose `/config`.
- Descriptor is outside default adapter descriptor locations.
- External/API services (for example Azure AI).
- Future-proofing when descriptors are not stored under `MessyDesk/services`.

Important:

- If your service does not provide runtime `/config`, you must provide an explicit descriptor file path (`SERVICE_JSON_PATH` or `SERVICE_DESCRIPTOR_PATH`).

Supported variables:

- `SERVICE_JSON_PATH`
- `SERVICE_DESCRIPTOR_PATH` (alias)

Descriptor fallback order:

1. Runtime `/config`
2. Explicit descriptor path (`SERVICE_JSON_PATH` / `SERVICE_DESCRIPTOR_PATH`)
3. Local adapter descriptors (`descriptors/*.json`, `src/adapters/*.service.json`)
4. Backend registry descriptor
5. Topic fallback descriptor

Preferred descriptor locations for long-term use:

- `MD-consumers/descriptors/<topic>.json`
- `MD-consumers/src/adapters/<adapter>.service.json`

Explicit descriptor examples:

```bash
TOPIC=md-azure-ai SERVICE_JSON_PATH=./descriptors/md-azure-ai.json node src/index.mjs
```

```bash
TOPIC=md-azure-ai SERVICE_DESCRIPTOR_PATH=./descriptors/md-azure-ai.json node src/index.mjs
```

## Help source options

### Option A: Service `/help` endpoint (default)

Why needed:

- Best for first-party services that provide markdown help.

### Option B: Explicit help URL (`HELP_URL`)

Why needed:

- External API service does not have `/help` endpoint.
- You want to ingest vendor docs page directly.

Help source selection order:

1. `HELP_URL`
2. Descriptor `help_url`
3. Descriptor `source_url`
4. Default `${service_base_url}/help`

## Infrastructure options

### Option A: Local/default URLs

Why needed:

- Development on one machine with default ports.

### Option B: Custom environment URLs

Why needed:

- Running components in containers, remote hosts, or custom ports.

Common variables:

- `MD_URL` (default `http://localhost:8200`)
- `NATS_URL` (default `nats://localhost:4222`)
- `NOMAD_URL` (default `http://localhost:4646/v1`)
- `NOMAD` (`1|true|yes|on`)
- `NOMAD_HCL_PATH`

## Registration behavior options

Why needed:

- Different environments may need different retry tolerance.

Variables:

- `REGISTRATION_MAX_ATTEMPTS`
- `REGISTRATION_INITIAL_DELAY_MS`

## Containerized run

Example using Podman:

```bash
podman run --rm -it \
  -e TOPIC=md-thumbnailer \
  -e NOMAD=true \
  --network=host \
  osc.repo.kopla.jyu.fi/messydesk/md-consumer:26.01.12 \
  "node src/index.mjs"
```

## Example: external API service

```bash
TOPIC=md-azure-ai \
SERVICE_JSON_PATH=./descriptors/md-azure-ai.json \
HELP_URL=https://learn.microsoft.com/en-us/azure/ai-services/openai/reference \
node src/index.mjs
```
