# MessyDesk backend

Digital humanities desktop for collecting, organising and processing research materials. This is
the rewritten backend: same HTTP API, events, queue messages, database schema and data layout as
the old `MessyDesk` backend, so MessyDesk-UI and MD-consumers work against it unchanged.

**No release yet — this is under active development.**

## Run locally

Needs Node.js >= 22.5, ArcadeDB and Solr (`docker compose up -d` starts both).

```bash
npm install
npm run build
MODE=development DB_PASSWORD=node_master npm start
```

The API listens on `http://localhost:8200`. Configuration is environment variables, all listed in
[wiki/environment-variables.md](wiki/environment-variables.md). The ones you most likely set:

| Variable | Notes |
|---|---|
| `DB_PASSWORD` | required |
| `LEGACY_ARCADEDB` | `true` (default) for ArcadeDB 23.7.1, `false` for newer servers |
| `SERVICE_TOKEN` | shared secret for MD-consumers (`Authorization: Bearer ...`) |
| `SERVICE_AUTH_LEGACY_MAIL` | `true` (default) until MD-consumers send the token |
| `MODE=development` | every request is `DEV_USER` (no proxy needed) |

## Tests

```bash
npm test                      # unit tests
# HTTP contract tests against a running backend (they create their own projects):
BASE_URL=http://localhost:8200 SERVICE_TOKEN=... npm run test:contract
```

The contract tests also run against the old backend with `TARGET=old`; tests for behaviour that
changed on purpose are skipped there (see [plan/decisions.md](plan/decisions.md)).

## Layout

- `src/` — TypeScript sources; see [wiki/architecture/backend-structure.md](wiki/architecture/backend-structure.md)
- `test/contract/`, `test/unit/` — tests
- `public/` — static files and the built help pages (`npm run build:help` from `docs/help`)
- `filters/` — filter definitions (`filter.json`)
- `wiki/` — engineering wiki
- `plan/` — the rewrite plan, the API inventory and the decisions

Help markdown lives in `docs/help/*.md`; images go in `docs/images`.
