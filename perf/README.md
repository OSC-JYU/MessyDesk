# Performance tools

Tools for [plan/performance-testing.md](../plan/performance-testing.md). They are compiled with
the backend (`npm run build`; the Node here has no TypeScript stripping) and run from `dist/perf/`.

## Test database

A separate ArcadeDB on port 2481, so the local compose stack can keep running:

```bash
podman run -d --name md-perf-arcadedb -p 2481:2480 \
  -e JAVA_OPTS="-Darcadedb.server.rootPassword=perf_master -Xms4g -Xmx8g" \
  -v md_perf_arcadedb:/home/arcadedb/databases:Z docker.io/arcadedata/arcadedb:25.3.1
```

Environment: `PERF_DB_HOST` (default `http://localhost:2481`), `PERF_DB_USER` (`root`),
`PERF_DB_PASSWORD` (`perf_master`), `LEGACY_ARCADEDB` (`false`).

## seed: direct loader

Writes users, projects, sets, files with pipeline outputs, entities and tag links straight into
ArcadeDB, with the backend's schema and the same properties and edges the backend creates. No files
on disk. About 2 000 file nodes per second.

```bash
# 1 user, 1 project, 2 sets of 1 000 files, 2 pipeline stages, 1 000 entities, 2 tags per file
node dist/perf/seed.js --db perf_profile --drop --users 1 --projects 1 --sets 2 --files 1000 --depth 2 --entities 1000 --links 2
# 20 more users as background data (user numbers 1..20)
node dist/perf/seed.js --db perf_profile --users 20 --user-offset 1 --projects 2 --sets 5 --files 1000 --depth 2
```

Running again with an existing user's number adds projects to that user. Each run writes
`perf/results/<db>.seed[.<offset>].json` with counts and sample rids; `profile` reads the one
without an offset.

## profile: plan step 1

Runs the queries behind the suspected bottlenecks with the backend's statements, and records
median time, rows, records read and whether ArcadeDB scanned a whole type.

```bash
node dist/perf/profile.js --db perf_profile --label S          # all probes
node dist/perf/profile.js --db perf_profile --label x --only grouping
```

Results: `perf/results/<db>.profile.<label>.json`. The findings so far are in
[results/step1-query-profile.md](results/step1-query-profile.md).

## Load scenarios against a running backend

Start the backend on a test database, for example
`DB_PASSWORD=perf_master DB_PORT=2481 DB_NAME=perf_run LEGACY_ARCADEDB=false SERVICE_TOKEN=perf-token DATA_DIR=/tmp/perf-data node dist/src/main.js`,
then with `SERVICE_TOKEN=perf-token` (and `BASE_URL` if not `http://localhost:8200`):

```bash
# S1: upload into one set like the UI (chunks of 20, 3 in parallel); prints the set rid
node dist/perf/s1-upload.js --files 10000
# S5: one-to-one batch over that set with 16 instant fake consumers; --late starts them after the
# start request returns, to time it alone
node dist/perf/s5-batch.js --db perf_run --set '#145:0' --workers 16 [--late]
```

`fake-consumer.ts` is the consumer used by S5; it registers a service with one-to-one, one-to-many
and many-to-one tasks and answers every job at once. Findings: [results/upload-and-batch.md](results/upload-and-batch.md).
