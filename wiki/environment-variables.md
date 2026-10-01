# Environment Variables

All configuration across the MessyDesk platform, organized by repository.

## MessyDesk Backend

**[verified]** from `src/config.ts` (every variable the backend reads is there).

### Database (ArcadeDB)

| Variable | Default | Notes |
|----------|---------|-------|
| `DB_HOST` | `http://127.0.0.1` | ArcadeDB host URL |
| `DB_PORT` | `2480` | ArcadeDB HTTP API port |
| `DB_NAME` | `messydesk` | Database name; also the default data directory `data/<DB_NAME>` |
| `DB_USER` | `root` | |
| `DB_PASSWORD` | — | **Required** |
| `LEGACY_ARCADEDB` | `true` | `true` for ArcadeDB 23.7.1 (keeps its workarounds), `false` for newer servers (SQL only). See [backend structure](architecture/backend-structure.md#arcadedb-modes-legacy_arcadedb) |
| `DB_WRITE_RETRIES` | `5` | Attempts for transient database errors (MVCC conflicts, timeouts) |
| `DB_WRITE_BACKOFF_BASE_MS` / `DB_WRITE_BACKOFF_MAX_MS` | `200` / `5000` | Jittered exponential backoff between attempts |

### Server and paths

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `8200` | HTTP port |
| `MODE` | — | `development`: every request is `DEV_USER` |
| `DEV_USER` | `local.user@localhost` | |
| `LOG_LEVEL` | `info` | |
| `API_URL` | `http://localhost:8200/` | Prefix of absolute thumbnail and icon URLs in responses and events |
| `DATA_DIR` | `data/<DB_NAME>` | Data directory (relative to the working directory unless absolute) |
| `SERVICE_REGISTRY_PATH` | `<DATA_DIR>/service-registry.json` | Persisted service descriptors |
| `SET_ZIP_JOB_TTL_MS` | `1800000` | A ZIP export not ready by then reports `failed` |
| `MAX_VERSION_TEXT_BYTES` | `10485760` | Largest text edit accepted by `POST /api/files/{rid}/version` |

### Consumers

| Variable | Default | Notes |
|----------|---------|-------|
| `SERVICE_TOKEN` | — | Shared secret consumers send as `Authorization: Bearer <token>` |
| `SERVICE_AUTH_LEGACY_MAIL` | `true` | Also accept the `mail` header of an admin user on consumer routes (current MD-consumers). Set `false` once MD-consumers send the token |
| `CONSUMER_TTL_SECONDS` | `90` | A consumer not seen for this long is no longer counted as live (they heartbeat every 30 s) |

### Search, Nomad, help

| Variable | Default | Notes |
|----------|---------|-------|
| `SOLR_URL` / `SOLR_CORE` | `http://localhost:8983/solr` / `messydesk` | |
| `NOMAD` | `false` | `1/true/yes/on`: check Nomad at startup (exit when unreachable) and stop Nomad jobs when their last consumer leaves |
| `NOMAD_URL` | `http://localhost:4646/v1` | |
| `PODMAN` | — | Rewrite `driver = "docker"` to podman in Nomad specs |
| `SERVICE_HELP_BUNDLE_MAX_FILES` / `SERVICE_HELP_ARCHIVE_MAX_BYTES` / `SERVICE_HELP_ARCHIVE_MAX_ENTRIES` | `120` / `26214400` / `500` | Limits for help ingest |

### Quotas

| Variable | Default | Notes |
|----------|---------|-------|
| `DISK_QUOTA` (or `DISK_QUOTA_GB`) | `100` | Per-user storage quota in GB, shown by the storage summary (not enforced) |
| `PROJECT_EXPIRATION_DAYS` | `180` | Sets `expiration_date` on new projects (not enforced) |

### Queue

See [queue-system.md](architecture/queue-system.md#configuration): `QUEUE_DB_PATH`,
`QUEUE_DB_MAX_ATTEMPTS`, `QUEUE_DB_LEASE_SECONDS`, `QUEUE_DB_KEEP_FAILED_MINUTES`,
`QUEUE_DB_SWEEPER_ENABLED`, `QUEUE_DB_SWEEPER_INTERVAL_SECONDS`,
`QUEUE_DB_SWEEPER_DONE_CANCELLED_MINUTES`, `QUEUE_BATCH_ABORT_CONSECUTIVE`,
`QUEUE_BATCH_ABORT_PERCENT`, `LOG_QUEUE_CONTEXT`.

## MD-consumers

**[verified]** from `MD-consumers/src/index.mjs` and `MD-consumers/src/funcs.mjs`:

### Core

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `TOPIC` | — | **Yes** | Registry/queue identity to attach to (throws immediately at startup if unset — no hidden/derived ids). Overrides the service's own descriptor `id` (lets one physical service listen on multiple topics, e.g. `md-sharp` + `md-thumbnailer`, and lets multiple physical instances share one topic for parallel processing). |
| `NATS_URL` | `nats://localhost:4222` | No | NATS server |
| `MD_URL` | `http://localhost:8200` | No | MessyDesk backend URL |

### Service Discovery

| Variable | Default | Notes |
|----------|---------|-------|
| `DEV_URL` | — | Override service URL for local development |
| `NOMAD_URL` | `http://localhost:4646/v1` | Nomad cluster API |
| `NOMAD_INSTANCE_ID` | `TOPIC` | Nomad job/service identity (defaults to `TOPIC`). Each consumer owns exactly one Nomad job — set this to a unique value per consumer to run several dedicated instances behind one shared `TOPIC` (e.g. `TOPIC=md-sharp` with `NOMAD_INSTANCE_ID=md-sharp-1`/`md-sharp-2`), rather than a single job shared/load-balanced across consumers. |
| `SERVICE_JSON_PATH` | — | Explicit descriptor file path |
| `ADAPTER` | — | Override adapter name (bypasses descriptor) |
| `HELP_URL` | — | Override help documentation URL |

### Service Registration

| Variable | Default | Notes |
|----------|---------|-------|
| `REGISTRATION_MAX_ATTEMPTS` | `5` | Registration retry count |
| `REGISTRATION_INITIAL_DELAY_MS` | `500` | Initial backoff delay |

### Nomad Mode

| Variable | Default | Notes |
|----------|---------|-------|
| `NOMAD` | — | Enable Nomad service management (`1`, `true`, `yes`, `on`) |

### SQLite Queue (index-db.mjs)

| Variable | Default | Notes |
|----------|---------|-------|
| `QUEUE_DB_PATH` | `/tmp/messydesk-queue.sqlite` | Database file |
| `QUEUE_DB_POLL_MIN_MS` | `100` | Min poll interval |
| `QUEUE_DB_POLL_MAX_MS` | `2000` | Max poll interval |
| `QUEUE_DB_LEASE_SECONDS` | `120` | Lease duration |
| `QUEUE_DB_MAX_ATTEMPTS` | `3` | Max retry attempts |
| `QUEUE_BATCH_ABORT_CONSECUTIVE` | `5` | Max consecutive permanent failures before batch auto-abort |
| `QUEUE_BATCH_ABORT_PERCENT` | `50` | Max failure percentage before batch auto-abort |

### Storage

| Variable | Default | Notes |
|----------|---------|-------|
| `STORAGE_MODE` | — | `http` or `disk` |
| `FILE_STORAGE_MODE` | — | Backward-compatible alias for STORAGE_MODE |
| `MD_PATH` | — | MessyDesk root directory (required for disk mode) |
| `CONTAINER` | — | Running in container flag |

### AI Credentials (adapter-specific)

| Variable | Notes |
|----------|-------|
| `AZURE_OPENAI_API_KEY` | Azure OpenAI access |
| `GOOGLE_API_KEY` | Google Gemini access |
| `OLLAMA_MODEL` | Default Ollama model |

## MessyDesk-UI

**[verified]** from `vite.config.js` and `src/main.js`:

| Variable | Notes |
|----------|-------|
| `VITE_PUBLIC_PATH` | Base URL path for deployment (e.g., `/messydesk`) |
| `VITE_API_PATH` | Axios baseURL for API calls |
| `VITE_FALLBACK_LOCALE` | i18n fallback locale (default locale is `fi`) |

## Python Services

**[verified]** from `api.py` files across MD-text-base_fs, MD-opencv, MD-zip_fs, MD-finbert-ner:

| Variable | Default | Service | Notes |
|----------|---------|---------|-------|
| `STORAGE_MODE` | `http` | text-base, zip_fs | `http` or `disk` |
| `MD_PATH` | — | text-base, zip_fs | MessyDesk root (disk mode) |
| `COPY_CHUNK_SIZE` | `1048576` (1MB) | zip_fs | Chunk size for file copy |
