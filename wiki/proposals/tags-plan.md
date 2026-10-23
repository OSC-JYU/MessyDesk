# Tags: desk-specific tags, filter picker and tag admin: plan

Implements [tags-md](./tags-md). No backwards compatibility is needed, so existing human tags get no
migration (they stay visible only in the global view until imported into a desk).

## Decisions (agreed)

- A human tag belongs to one or more desks. A new desk starts with no human tags. Importing a tag
  from another desk adds the *same* entity (same id) to this desk's vocabulary.
- Machine tags keep today's model: owner-wide entities, tied to a desk only through `TagLink.project_rid`.
- Several people may tag in the same desk in the future (a desk may get several owners/users). For now we only
  **record who did it**; queries stay `owner`-based. Desk-based access and permission rules are a later step.
- Global view (no desk) shows all the user's tags, each entity as its own row with its desk names as a hint.
  The existing "Tag context" desk picker narrows it. Inside a desk the context is fixed.
- Rename applies everywhere (same id) and warns, listing the other desks that use the tag.
- Delete has two actions: "Remove from this desk" (default; deletes the tag's links in this desk only) and
  "Delete everywhere" (global view only).
- Tag admin manages human tags only. Machine tags are still removed per run, never renamed or deleted here.
- "Tag filter" means the Tag Filter dialog (`mdf-set-filter`, [TagFilterDialog.vue](../../../MessyDesk-UI/src/features/services/crunchers/TagFilterDialog.vue)).

## Out of scope (do later)

- **ROI data (spans, boxes) is not tags and is not in Solr.** `ner.json` outputs (GLiNER entities, per-segment
  language spans) are scanned from disk on request ([ner.ts](../../src/modules/tags/ner.ts)). Only the file-level
  labels derived from a run by *autotag* become `Entity`/`TagLink` rows (and then the `tag_*` Solr fields). So
  "filter by detected language" already works for tasks that autotag (lingua's `create_language_tags`); filtering by
  region-level ROI labels does not. The filter gets a separate ROI section in step 9 below. A proper search index
  of ROI data (mentions, image regions, Solr) is still later work, kept separate from the file-level tag system.

## Backend ([MessyDesk](../../))

### 1. Data model ([schema.ts](../../src/platform/arcade/schema.ts))

- Attribution fields (user rid; `created_by` already means user/machine, so new names are used):
  - `TagLink.tagged_by`: the user who attached the tag. For machine links, the user whose request started the run
    (`message.userId`); `service_id` / `task` / `model` still tell which run.
  - `Entity.creator_rid`: the user who created the tag.
  - `DeskTag.added_by`: the user who created or imported the tag into the desk.
  - Set from the authenticated user in `createEntity`, `createTagLink` (via `LinkMeta.tagged_by`), create and import.
  - `createTagLink` dedupe key for user links gains `tagged_by`, so two people attaching the same tag to the same
    file keep one link each. Counts (`setEntities`, usage) already use DISTINCT per file, so they stay correct.
  - `unlink` still removes all user links of the tag on the file (any tagger); per-tagger removal comes with the
    permission rules later.
- New document type `DeskTag { project_rid, entity_rid, owner, added_by, created }`, like `TagLink` (document, not edge).
  Indexes: unique `(project_rid, entity_rid)` and `entity_rid`. Add to `DOCUMENT_TYPES`.
- Human tag = `Entity` with `created_by = 'user'`. It is in a desk's vocabulary when a `DeskTag` row exists.
- Desk tag list = human `DeskTag` entities of the desk ∪ entities with `TagLink.project_rid` = desk (machine tags).
- Check that the desk delete cascade removes the `DeskTag` rows of the desk.

### 2. [tags.ts](../../src/modules/tags/tags.ts) changes

- `createEntity` / `createTag` / `createEntitiesAndLink` take the desk: a new human tag is created together
  with its `DeskTag`. The find-existing lookup for human tags is limited to the desk's vocabulary (two desks may
  have separate "invoice" tags). Machine entities are still found owner-wide.
- `link()` for a user link: the entity must be in the target file's desk vocabulary (or be a machine entity).
- `entityRidsInProjects` (used by `groupedEntities`, `entitiesOfType`) also includes the desks' `DeskTag` entities,
  so an unused human tag shows in its desk.
- Global listing of human entities adds `desks: [{rid, label}]` per item (one `DeskTag` query per page).
- `tags()` (used by `TagPickerField`) takes an optional desk.

### 3. New admin operations

| Method | Path | Does |
|---|---|---|
| `GET` | `/api/entities/{rid}/usage` | desks and file counts using the tag (for the warning dialogs) |
| `PATCH` | `/api/entities/{rid}` | rename (`label`, optional `description`); rejects a duplicate label of the same type in any desk the tag belongs to; reindexes tag fields of all linked files |
| `POST` | `/api/projects/{rid}/tags` | create a human tag in the desk |
| `POST` | `/api/projects/{rid}/tags/import` | `{ entity_rids }` or `{ from_project_rid }`: adds `DeskTag` rows (idempotent) |
| `DELETE` | `/api/projects/{rid}/tags/{entity}` | remove from the desk: delete `DeskTag` and the tag's `TagLink`s in the desk, reindex those files; delete the entity when no desk is left |
| `DELETE` | `/api/entities/{rid}` | delete everywhere: all `TagLink`s, `DeskTag`s, the entity; reindex all linked files |

Rules: human tags only (`created_by = 'user'`; 400 for machine tags); ownership checks as in `link()`.
Reindexing many files goes through `reindexFileTags` with `defer_reindex`-style batching, in chunks (a popular
tag can be on thousands of files); consider running it after the response and reporting progress.

### 4. Tag filter

- No backend change needed beyond the desk-scoped listings above. `tagFilterSet` already works on entity rids.
- Optional: validate that selected human tags belong to the set's desk.

### 5. Docs and tests

- Update [search.md](../architecture/search.md) (it says `ner.json` is not indexed) and [graph-data-model.md](../architecture/graph-data-model.md), [api-surface.md](../api-surface.md),
  [glossary.md](../glossary.md) (and [invariants.md](../invariants.md) if it mentions user-made tags).
- Tests in `test/` for: create in desk A not visible in desk B; import shares the id; rename visible in both; remove
  from desk keeps links in other desks; delete everywhere; autotag unaffected; desk delete cleans `DeskTag`.
- Check [perf/s7-tags.ts](../../perf/s7-tags.ts) still passes (`DeskTag` lookups must not slow the listings).

## UI ([MessyDesk-UI](../../../MessyDesk-UI/src/features/tags))

### 6. Desk scoping

- [TagsPage.vue](../../../MessyDesk-UI/src/features/tags/TagsPage.vue) / `useTags.js`: "New tag" creates the tag in the
  current desk (in the global view: ask which desk). Show desk names on tags in the global view.
- [AddTagDialog.vue](../../../MessyDesk-UI/src/features/tags/AddTagDialog.vue) and
  [TagPickerField.vue](../../../MessyDesk-UI/src/features/services/crunchers/TagPickerField.vue) use the desk's tags.
- Where a user tags a file in a desk, only that desk's human tags are suggested; typing a new label creates it there.

### 7. Tag admin view

- "Tag admin" button on the Tags page opens a new route/dialog (`TagAdminPage.vue` or dialog) for the current desk
  (global view: all tags, with the desk hint and the "Delete everywhere" action).
- File viewer tag list and the admin table show who attached / created a tag (user name looked up from the rid;
  hidden while the desk has a single user).
- Table of human tags: label, type, files, desks, created by; actions create, rename, remove from desk / delete everywhere.
- Rename and delete confirm dialogs call `GET /api/entities/{rid}/usage` and warn with the file count and the other
  desks affected.
- "Import from another desk": pick desk, list its human tags (searchable, checkboxes, already-imported shown
  as disabled), import selected or all.
- API wrappers in `src/api/entities.js` and `client.js`, strings in `lang/messages.json`.

### 8. Tag filter picker (scales to hundreds of tags)

- Extract the tag list of the Tags page side panel into a compact `TagPicker` component: search box,
  collapsed groups (human tags by type; machine tags by run: service, task, model), paged loading, selected chips on top.
  It uses the existing `groupedEntities` / `entitiesOfType` / `machineTags` calls, scoped to the set's desk.
- [TagFilterDialog.vue](../../../MessyDesk-UI/src/features/services/crunchers/TagFilterDialog.vue) uses it instead of the flat
  `getSetEntities` dropdown, so it lists all the desk's tags (human and machine), not only those on the set's files.
  Keeps include / exclude / untagged modes and the and/or match.

### 9. ROI labels in the Tag Filter (separate section, indexed in Solr)

ROI data stays out of the tag system (no Entity/TagLink). The filter gets a second section, "Found in text
(ROI labels)", whose criteria are `{ service_id, task, label }` (plus `model` when known). This is
generic: any service whose output is a `ner.json` region container shows up, whatever its labels mean.

Backend (one Solr document per `ner.json` run; mention text stays in the file). Solr is assumed to be usually up.
- **Document:** `id = roi:<ner rid>`, `type = "roi_run"`, `owner`, `project`, `roi_run` (ner file rid),
  `roi_source` (the file the run read, its `DERIVED_FROM` target), `roi_service`, `roi_task`, `roi_model`, and a
  multivalued string `roi_key` with one value per distinct label, `service|task|model|label`. It must not use the
  `node` field: `updateTagsForFile` finds docs by `node` and would re-post these with `tag_*` fields.
- **Schema:** add the `roi_*` fields to [solr-init-v2.sh](../../tools/solr-init-v2.sh) (the script keeps the index;
  `SOLR_RESET=true` wipes it). All text queries already filter `type:"text"`, so these docs never show as search hits; check the
  facet/count queries in [solr.ts](../../src/platform/solr/solr.ts) too.
- **Write:** when a `ner.json` arrives ([results.ts](../../src/modules/results/results.ts), next to the
  `service_id` / `task` / `model` stamp) the backend posts the document to Solr directly (`NerService.indexRun`,
  `commitWithin`), like the existing deletes; no md-solr task is needed. A failed write is logged, not fatal.
  Only labels are sent, not mention texts.
- **Picker list:** facet on `roi_key` with `fq=owner`, `fq=type:roi_run`, desk `fq=project`, a `facet.contains` /
  prefix for the search box, `facet.limit` + `facet.offset` for paging. Counts are runs (files) per label. Replaces the
  disk scan of `labelGroups`, which stays only for mention drill-down.
- **Filter:** for the set's files, query `{!terms f=roi_source}rid1,rid2,...` (POST, chunked) with `fq=roi_key:(...)`,
  read back `roi_source`, then combine with the tag matches. If Solr is down or the request fails, the filter must
  fail with an error, never return an empty or partial set.
- **Delete:** with the run (the existing `ner.json` provenance deletion in [graph.ts](../../src/modules/graph/graph.ts)),
  with the source file (add `roi_source` to the delete in `dropFilesIndex`), and with the desk
  (`dropProjectIndex` already deletes by `owner` + `project`).
- **Reindex / backfill:** `reindexProject` drops the desk's docs, so it must also rebuild the ROI docs: one disk
  pass over the desk's `ner.json` files (`NerService.runs`). That is the only full scan left, and it doubles as the
  backfill for runs from before this change (the "Reindex desk" button), so no separate migration.
- **Filter request:** `tagFilterSet` accepts `selected_roi_labels: [{ service_id, task, model?, label }]` next to
  `selected_entity_rids`. Include (and/or), exclude and untagged modes combine tags and ROI labels in one match (and =
  all selected criteria, or = any). "Untagged" stays about `TagLink` only.
- Record the ROI criteria in the filter process `params` and `info` so the result set shows what it was made from.
- Not done now: indexing mention texts (search over them stays on `ner.json`), and image ROI data (same
  container shape, so the same document should work).

UI: `TagPicker` gets a collapsed "Found in text" group (by run, then label with counts, searchable, paged) and
the dialog sends both lists. Mention search inside a label is not part of the filter.

Tests: `roi_run` docs written on arrival and removed with the run, source file and desk; reindex rebuilds them; filter by an ROI label (include/exclude/and/or) and by tag plus ROI label;
runs of another desk or user are not matched.

### 10. UI docs and tests

- Update help content ([helpContent.js](../../../MessyDesk-UI/src/features/help/helpContent.js)) and the UI wiki
  (`domain-concepts.md`).
- Vitest tests for `useTags`, the admin dialogs and the picker in `test/features/`.

## Order of work

1. Schema + `DeskTag` + desk-scoped create/link/list (backend, with tests).
2. Admin endpoints (rename, usage, remove, delete everywhere, import).
3. UI desk scoping, then tag admin view.
4. `TagPicker` and the Tag Filter dialog (tags).
5. `roi_run` Solr documents (schema, write, delete, reindex) and the ROI section of the filter.
6. Docs.

## Risks / to verify while implementing

- Search index: rename and delete must reindex every affected file's `tag_*` fields; large tags need batching.
- ArcadeDB 25.3.1 index quirk noted in schema.ts (composite TagLink index returned too many rows): test the new
  composite `DeskTag` index the same way, fall back to two single-column indexes.
- Anything that moves or copies files between desks (check [files.ts](../../src/modules/files/files.ts)) must also
  keep the file's human tags inside the target desk's vocabulary.
- A user link to a machine entity with the same label is allowed and kept as today; the file then counts as user-tagged.
- Not done now (needed when desks get several users): desk-membership-based access instead of `owner = :user`,
  who may rename/remove a tag, and a `tag_tagged_by` search field if search should filter by tagger.
- Solr is a derived index: after a Solr wipe or schema re-init the ROI section of the filter is empty until "Reindex desk" is run.
