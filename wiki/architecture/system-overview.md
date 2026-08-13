# System Overview

MessyDesk is a document processing platform built around a graph database. Users upload files into projects, apply processing services (OCR, NER, image manipulation, LLM prompts), and browse results as a derivation graph. The platform is split across multiple repositories with a message queue connecting them.

## Repositories

| Repository | Language | Role |
|------------|----------|------|
| `MessyDesk` | Node.js (ESM) | Backend API server, graph database management, queue orchestration |
| `MessyDesk-UI` | Vue 3 + Vite | Single-page frontend |
| `MD-consumers` | Node.js (ESM) | Adapter layer: translates queue messages into service HTTP calls and routes results back |
| `MD-text-base_fs` | Python (FastAPI) | Text processing service (wordcloud, split, stopwords, json2csv) |
| `MD-opencv` | Python (FastAPI) | Image ROI operations (extract, fill, blur, grayscale, border) |
| `MD-zip_fs` | Python (FastAPI) | ZIP file extraction and creation |
| `MD-finbert-ner` | Python (FastAPI) | Finnish NER via FinBERT model |

**[verified]** All repository roles confirmed by reading entry points and package.json/requirements.txt files.

## Infrastructure Dependencies

| Component | Image/Version | Port | Purpose |
|-----------|--------------|------|---------|
| ArcadeDB | `arcadedata/arcadedb:23.7.1` | 2480 | Graph database (vertices, edges, SQL+Cypher queries) |
| Apache Solr | `solr:9.7` | 8983 | Full-text search, core name `messydesk` |
| HashiCorp Nomad | (optional) | 4646 | Service orchestration for production deployments |

**[verified]** From `docker-compose.yml`. NATS removed in `sqlite-queue` branch.

## Component Interaction Diagram

```
┌─────────────────────────────────┐
│  MessyDesk-UI (Vue 3, :3000)   │
│  Vite dev proxy → :8200        │
└──────────┬──────────────────────┘
           │ HTTP /api, SSE /events
           ▼
┌──────────────────────────────────────────────┐
│  MessyDesk Backend (Hapi.js, :8200)          │
│  ┌──────────┐ ┌────────┐ ┌──────┐ ┌───────┐ │
│  │ ArcadeDB │ │ SQLite │ │ Solr │ │Nomad? │ │
│  │  :2480   │ │ queue  │ │:8983 │ │:4646  │ │
│  └──────────┘ └───┬────┘ └──────┘ └───────┘ │
└───────────────────┼──────────────────────────┘
                    │ HTTP /api/queue/claim
                    ▼
┌──────────────────────────────────────────────┐
│  MD-consumers (one process per service)      │
│  Polls backend queue API for jobs            │
│  Heartbeat + registration every 30s          │
└──────────┬───────────────────────────────────┘
           │ HTTP (service-specific API)
           ▼
┌──────────────────────────────────────────────┐
│  Services (FastAPI, Imaginary, Ollama, etc.) │
│  Stateless; receives file, returns result    │
└──────────┬───────────────────────────────────┘
           │ HTTP callback
           ▼
  MessyDesk /api/nomad/process/files/*
  (result materialization, graph updates)
```

**[verified]** Data flow confirmed by reading `queue.mjs`, and `routes/nomad.mjs`. Consumer interaction defined in proposals.

## Startup Sequence

The backend (`src/index.mjs`) initializes in this order:

1. `media.createDataDir(DATA_DIR)` — ensure data directory exists
2. `nomad.getStatus()` — check Nomad if enabled
3. `services.loadServiceAdapters('services', NOMAD)` — load service descriptors from `services/` directory
4. `queue.init()` — initialize SQLite queue (creates DB file and schema if needed)
5. `Graph.initDB()` — connect to ArcadeDB, create schema (vertex/edge types and indexes)
6. Hapi server starts on port 8200

**[verified]** From `src/index.mjs` lines 44–55.

## Authentication

**Development mode** (`MODE=development`): Every request gets `mail` header set to `DEV_USER` (default `local.user@localhost`). User looked up in graph; 401 if not found, 503 if DB unreachable. **[verified]**

**Production mode**: Custom `mail-auth` scheme reads `mail` HTTP header, looks up user via `Graph.myId(mail)`. No token validation — the identity provider is assumed to be an upstream proxy (e.g. Shibboleth, Apache mod_auth) that sets the header. **[verified]** from `src/index.mjs` lines 70–135.

**Authorization**: Graph-traversal based. `Graph.hasAccess(item_rid, user_rid)` traverses all outgoing edges from the item; if any path reaches the user vertex, access is granted. No role-based access control beyond implicit graph topology. **[verified]** from `graph.mjs`.

## Technology Choices

| Decision | Choice | Notes |
|----------|--------|-------|
| Web framework | Hapi.js 21 | With `@hapi/inert` (static files), `@hapi/boom` (errors), `susie` (SSE) |
| Database | ArcadeDB (HTTP API) | No ORM; raw SQL and Cypher queries via `got` HTTP client |
| Queue | SQLite (WAL mode) | Local file-based queue with retry logic; no external service needed |
| Frontend framework | Vue 3 + Vuetify 3 | Reactive singleton store (not Vuex/Pinia) |
| Frontend build | Vite | Dev proxy to backend on :8200 |
| Module system | ESM throughout | `.mjs` extensions; Node.js ≥22.3 required |
| Service framework (Python) | FastAPI | CORS enabled globally; multipart file I/O |
| Logging | Winston + daily-rotate-file | JSON format, 14-day retention, 20MB rotation |

**[verified]** All confirmed from `package.json`, `requirements.txt`, and source code.
