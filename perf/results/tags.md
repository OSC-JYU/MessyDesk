# S7: tags at scale (2026-10-05)

Scenario S7 of [plan/performance-testing.md](../../plan/performance-testing.md): one user's tags
grown in steps directly in the database, then the tag calls the UI makes timed over HTTP
(`perf/s7-tags.ts`), plus an autotag batch (`perf/s7-autotag.ts`). ArcadeDB 25.3.1, same laptop as
before. The user's biggest desk has 20 000 files (10 000 uploads and 10 000 outputs); links are
spread over those files, half made by users, half by machine. Raw results: `s7-*.json`.

## Tag calls as tags grow (before the fixes below)

Median of 5, response size in brackets.

| Call | 1 000 tags / 10 000 links | 10 000 / 100 000 | 100 000 / 1 000 000 |
|---|---|---|---|
| Tags page: `GET /api/entities` | 18 ms (0.2 MB) | 136 ms (2.1 MB) | **1.39 s (21 MB)** |
| Tags page for one desk: `?project_rid=` | 207 ms | 538 ms | **2.51 s** (4.3 MB) |
| `GET /api/tags` | 7 ms | 43 ms | 1.17 s (2.1 MB) |
| Machine tags: `GET /api/tags/machine` | 26 ms | 240 ms | **1.88 s** |
| Set's tag summary, 10 000-file set | 108 ms | 328 ms | 1.44 s (1.4 MB) |
| Files of 5 tags (`/api/entities/items`) | 4 ms | 3 ms | 3 ms |
| A file's tags (`/api/documents`) | 4 ms | 4 ms | 4 ms |
| Set page with tags (10 files) | 37 ms | 38 ms | 39 ms |
| Tag and untag one file | 25 ms | 47 ms | 306 ms |

Everything that touches one file or one page stays flat. The calls that summarise all of a user's or
a desk's tags grow with the number of tags and links. 1 000 000 links is 50 per file here, more than
real NER output is likely to give on a 100 000-page desk, so these are upper bounds.

## Autotag: 1 000 outputs with 5 labels each

An md-solr service with `update_tags` was registered, as in production, so each tag change went
through the search sync.

| | Before | After |
|---|---|---|
| Process nodes created | **5 000** (one per label) | 0 |
| md-solr `update_tags` jobs | 5 000 | 1 000 (one per file) |
| Outputs per minute (8 consumers) | 322 | **1 996** |
| Result callback p50 | 1.48 s | 0.22 s |

## Fixed

1. **No Process node for search tag syncs** (schema review P7, Ari's answer 3). The md-solr job is
   published without one; the adapter only echoes the message to `/done`, which falls back to the
   file rid. This also removes one directory and one `message.json` per tag change.
2. **Autotag syncs a file's search tags once**, after all its labels, instead of once per label.
3. **`SELECT FROM <Type> WHERE @rid = :rid` reads the whole type**: 160 ms for the tag ownership
   check at 100 000 entities, done for every label. Same for File, Set, Process and SetProcess
   lookups elsewhere. They now read the record by RID (`ArcadeClient.firstByRid`). Left as they
   are: Project, Prompt and Request lookups, small types.
4. **Index on `Entity (owner, type, label)`**: `/api/tags` 1.17 s → 0.15 s at 100 000 tags, and the
   tag lookup for every autotag label uses it.

Not kept: a `TagLink (owner, created_by)` index for machine tags. On ArcadeDB 25.3.1, queries on
`owner` alone then returned 24 million rows for 1 million links, so it was dropped again.

After the fixes, at 100 000 tags and 1 000 000 links: `/api/tags` 158 ms, tag and untag 18 ms; the
others as in the table. Contract tests: 68 of 71 on 25.3.1 and 23.7.1, as before.

## Still slow at 100 000 tags (for Ari)

1. **`GET /api/entities` returns every tag with its full record**: 21 MB and 1.4 s at 100 000 tags,
   which the tags page then has to draw. It could return the groups with counts and let the page
   load a type's tags when it is opened, or page them. This changes the API.
2. **The desk filter, machine tags and a set's tag summary** read every link of the desk, user or
   set (up to 1 000 000 here): 1.4–2.3 s. Storing `project_rid` on each TagLink would let the desk
   filter use an index; machine-tag counts could be kept up to date when links change instead of
   counted on every request. Both are schema changes.
