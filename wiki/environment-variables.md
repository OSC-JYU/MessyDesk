# Environment Variables

All configuration across the MessyDesk platform, organized by repository.

## MessyDesk Backend

**[verified]** from `src/env.mjs` and `src/index.mjs`:

### Database (ArcadeDB)

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `DB_HOST` | `http://127.0.0.1` | No | ArcadeDB host URL |
| `DB_PORT` | `2480` | No | ArcadeDB HTTP API port |
| `DB_NAME` | `messydesk` | No | Database name; also determines data directory |
| `DB_USER` | `root` | No | ArcadeDB user |
| `DB_PASSWORD` | — | **Yes** | ArcadeDB password |

### Infrastructure

| Variable | Default | Notes |
|----------|---------|-------|
| `API_URL` | `http://localhost:8200/` | Backend's own URL (used for self-references) |
| `SOLR_URL` | `http://localhost:8983/solr` | Solr server |
| `SOLR_CORE` | `messydesk` | Solr core/collection name |
| `NOMAD` | `false` | Enable HashiCorp Nomad service orchestration |

### Server

| Variable | Default | Notes |
|----------|---------|-------|
| `PORT` | `8200` | HTTP server port |
| `MODE` | — | Set to `development` for auth bypass |
| `DEV_USER` | `local.user@localhost` | Default user email in dev mode |
| `LOG_LEVEL` | — | Winston log level |

### Quotas

| Variable | Default | Notes |
|----------|---------|-------|
| `DISK_QUOTA_GB` | `100` | Per-user storage quota |
| `PROJECT_EXPIRATION_DAYS` | `180` | Auto-deletion threshold |

**Note**: `DISK_QUOTA_GB` reads from env var `DISK_QUOTA` (not `DISK_QUOTA_GB`). **[verified]** from `src/env.mjs`: `Number(process.env.DISK_QUOTA) || 100`.

## MD-consumers

**[verified]** from `MD-consumers/src/index.mjs` and `MD-consumers/src/funcs.mjs`:

### Core

| Variable | Default | Required | Notes |
|----------|---------|----------|-------|
| `TOPIC` | — | **Yes** | Service topic name (e.g., `md-imaginary`) |
| `NATS_URL` | `nats://localhost:4222` | No | NATS server |
| `MD_URL` | `http://localhost:8200` | No | MessyDesk backend URL |

### Service Discovery

| Variable | Default | Notes |
|----------|---------|-------|
| `DEV_URL` | — | Override service URL for local development |
| `NOMAD_URL` | `http://localhost:4646/v1` | Nomad cluster API |
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
| `USE_LEGACY_NOMAD_METADATA` | — | Use `MessyDesk/services/` for metadata |

### SQLite Queue (index-db.mjs)

| Variable | Default | Notes |
|----------|---------|-------|
| `QUEUE_DB_PATH` | `/tmp/messydesk-queue.sqlite` | Database file |
| `QUEUE_DB_POLL_MIN_MS` | `100` | Min poll interval |
| `QUEUE_DB_POLL_MAX_MS` | `2000` | Max poll interval |
| `QUEUE_DB_LEASE_SECONDS` | `120` | Lease duration |
| `QUEUE_DB_MAX_ATTEMPTS` | `3` | Max retry attempts |

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
