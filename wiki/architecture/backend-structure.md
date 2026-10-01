# Backend Structure

How the backend code is organised. The code is TypeScript compiled with `tsc` to `dist/` (the
local Node build has no type stripping), on Hapi 21. **[verified]** from `src/`.

## Layers

```
src/
  main.ts           composition root: config -> clients -> services -> Hapi server
  config.ts         every environment variable, one typed object
  app/deps.ts       the object graph handed to every route module
  platform/         no domain knowledge
    arcade/         ArcadeDB HTTP client (bound parameters, retries, legacy/current mode), schema
    http/           server, auth strategies (mail, service), error mapping, request typing
    sse/            event stream hub (several connections per user)
    solr/           Solr client
    nomad/          Nomad client
    storage/        data directory layout (sharded paths), file helpers
    ids.ts          RIDs and UUIDv7
    logger.ts       winston, console + daily rotated JSON under <DATA_DIR>/logs
  shared/
    graph-store.ts  create vertex, set attributes, connect, connectDerivedFrom
    service-ids.ts  service ids and message roles the backend relies on
  modules/
    access/         the one ownership check (AccessService)
    users/          /api/me, settings, users, permission requests, /api/sso
    projects/       projects, storage, the desk graph (Vue Flow projection)
    nodes/          creating File/Set/Process/SetProcess/error nodes, set manifests and counts
    graph/          vertex/edge routes, lineage, cascade delete
    files/          upload, download, documents, versions, set listings, file metadata
    thumbnails/     thumbnail jobs (every variant) and serving thumbnails
    sets/           ZIP export jobs
    import/         PDF auto-import (split on upload)
    services/       registry (persisted), consumer liveness, matching services to nodes
    service-help/   help bundle ingest and serving
    processing/     dispatch of single files, sets (all behaviours) and sources; resume; reindex
    batches/        batch progress stored on SetProcess nodes
    queue/          SQLite job queue, publisher (message enrichment)
    results/        consumer callbacks (/api/nomad/process/*)
    tags/           entities, TagLink, autotag, machine tags, NER (ner.json) browsing
    filters/        mdf-set-filter and region-set filters
    rois/ prompts/ service-groups/ misc/
```

Rules:

- A route file only parses input, checks the caller and calls one service method.
- Only services and `shared/graph-store.ts` talk to ArcadeDB, and only with bound parameters.
  Type, edge and property names come from fixed lists or pass `assertIdentifier`; RIDs pass
  `toRid` before being inlined.
- Dependencies are passed in by `main.ts`; no module keeps global state except the logger.
- `queue/` knows nothing about the graph. `processing/` builds complete messages and publishes
  them; `results/` and `batches/` update the graph.

## Access control

`AccessService.findOwned(rid, userRid)` decides whether a user may see a node: following the
node's outgoing `DERIVED_FROM`/`BELONGS_TO` edges must reach a Project that `HAS_OWNER` the user
(up to 40 levels), or the node is the project itself. Every route that takes a RID uses it (or
`isProjectOwner`). Other users' nodes answer 404, not 403, unless the old API answered 403 for
that route. **[verified]**

## ArcadeDB modes (`LEGACY_ARCADEDB`)

`true` (default) runs against ArcadeDB 23.7.1 with its workarounds; `false` uses the plain forms,
tested with 25.3.1. **[verified]** by the contract suite in both modes.

| Topic | Legacy (23.7.1) | Current |
|---|---|---|
| Creating an index that may exist | plain `CREATE INDEX`, "already exists" ignored (`IF NOT EXISTS` throws a NullPointerException) | `CREATE INDEX IF NOT EXISTS` |
| `TRAVERSE ... FROM <rid>` | RID inlined after validation (a bound parameter is ignored) | bound parameter |
| Project list, duplicate project label, SetProcess path, edge delete/update | the old Cypher statements, values inlined with `cypherString()` (bound Cypher parameters silently match nothing with two conditions) | SQL only, no Cypher |

Note: on 23.7.1 the `created` default (`sysdate()` property default) is evaluated once, so all
records get the database creation time. 25.3.1 stamps each record. The old backend had the same
behaviour on 23.7.1.

## Authentication

- `mail` (default): the upstream proxy sets the `mail` header. `MODE=development` makes every
  request the `DEV_USER`.
- `service`: consumers send `Authorization: Bearer <SERVICE_TOKEN>`; they may add `mail` to act
  for a user (file downloads). While `SERVICE_AUTH_LEGACY_MAIL=true`, the `mail` header of an
  admin user is also accepted on service routes (MD-consumers send `local.user@localhost`), with
  a warning logged once an hour.
- Consumer-only routes (queue claim/heartbeat/complete/fail, result callbacks, register, adapter
  heartbeat) accept only `service`. Routes both use (`GET /api/files/{rid}`, `GET/DELETE
  /api/services/{id}`, help ingest, Nomad start/stop, set zip, `/api/entities/link`) accept both.

## Tests

- `test/contract/`: HTTP tests that run against any backend (`BASE_URL`, `TARGET=old|new`,
  `SERVICE_TOKEN`). They pin the API and were first made to pass against the old backend.
- `test/unit/`: queue, SSE hub and the pure rules.
