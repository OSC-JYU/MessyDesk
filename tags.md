# AutoTag system

**Policy (superseding the original idea below): NER never creates tags.** NER (and NER-like
structured-extraction) tasks only produce `ner.json`, which is indexed/browsed directly (§6 below,
`graph.getNerLabelGroups`/`getNerLabelFiles`/`getNerLabelMentions`) — no `Entity`/`TagLink` rows are
ever written for them, and `service.json` for such tasks must never set `"autotag": true`. Only
classification-style tasks (whole-document category, e.g. MD-Gliner2's `classify_text`) may still use
autotag to turn their labels into real, TagLink-backed tags. The rest of this doc, including the
earlier phases in §8, predates this correction and describes NER using autotag — that part is stale.

Autotag system means that classification data can be directly transformed to tags.

If crucnher has param "autotag" this will happen as soon as json file arrives to MessyDesk.
But suitable json can be also transformed to tags also via Autotag cruncher afterwards.

## Idea

So we can have two type of tags in MessyDesk: user created and machine created. We can also attatch tags to file by hand or by machine.

### Machine created tag.
For example MD-Gliner has task "classify". If it had autotag setting on, it will create tags on fly and attach them to files.

~~If we use some NER model, then autotag would create tags with type "person", "location" etc.~~ Superseded: see policy note above, NER never autotags.

### Machine tagging
The same Gliner can be also use existing tags (created by user) and just attach them to files.


We need to figure out structure. Tags create by machine must have some kind of created by attribute that tells service and task used (md-Gliner:classify for example). For NER objects tags must also have type.

Tags attached by machine must be linked witth edge that tells that linking was done by machine.

UI
User must see machine created tags per service and task. User must also be able to select project and set (this data comes from file data already)



## TECH
We can have hundreds of thousands files or even millions. We need to think about scalability.
Is file--edge->tag too heavy?

### JSON formats

We need a way to tell MessyDesk how to transfers certain json to tags. Diiferent models gives different outputs.

Gliner2 NER  example:
{
  "task": "extract_entities",
  "params": {
    "labels": "celestial body"
  },
  "result": {
    "entities": {
      "celestial body": [
        {
          "text": "Mars",
          "confidence": 0.9996895790100098,
          "start": 78,
          "end": 82
        },
        {
          "text": "Mars",
          "confidence": 0.999466598033905,
          "start": 0,
          "end": 4
        }
      ]
    }
  }
}

---

# Redesign Plan

Branch: `feature/tag-redesign`

## 1. Core idea

An entity/NER hit is not just a classification, it also carries a **text span** (region of interest).
MessyDesk already has this exact concept for images (`docs/help/9.ROIs.md` "Image ROIs"), and already
documents "Text ROIs" as a planned feature with near-identical wording to this plan. So: extend the
existing ROI mechanism to text, and build tags on top of ROIs instead of inventing a parallel system.

```
Model output (any shape) --[adapter]--> ner.json/roi.json (canonical shape) --[autotag]--> TagLink --[index]--> Solr
```

- **Adapters own the JSON-format problem.** Each MD-consumers adapter already knows its own service's
  API contract, so converting arbitrary model output (GLiNER2, other NER/classifiers, future object
  detection) into a canonical region-container shape is adapter work, not core MessyDesk work. Core
  never needs to understand per-model JSON.
- **Two region containers, not one**, split by mutability:
  - `ner.json` — machine-produced, **immutable**. A new processing run always creates a new `ner.json`
    (own `File` node, own `Set`); never edited in place.
  - `roi.json` — user-produced/edited, **mutable**. Upsert-per-(file, set), same as image ROIs today.
  Both are `File` graph nodes, `DERIVED_FROM` the source file, holding one opaque JSON blob — same
  storage pattern as existing image ROIs, so core storage/CRUD barely changes.
- **Tags are not edges.** Tag *vocabulary* (`Entity` vertices) stays as-is, but tag *assignment* (what
  is tagged with what) moves out of the graph entirely into a flat link table (§3). This is what
  actually resolves the "hundreds of thousands of links" scale concern — not Solr. Solr's job is
  full-text/faceted **search and browsing**, not being the fix for graph write volume.
- Raw NER hits inside `ner.json` are just data, not tag links — nothing is written to the link table
  until a tag is explicitly created (autotag: one per distinct label per run) or a user promotes/attaches
  one by hand.

## 2. Region schema (`ner.json` / `roi.json`)

Same shape for both containers — only mutability and the `type` values in use differ:

```json
{
  "rois": {
    "roi_<unique>": {
      "id": "roi_<unique>",
      "type": "text",
      "start": 78,
      "end": 82,
      "text": "Mars",
      "label": "celestial body",
      "confidence": 0.9996895790100098
    }
  }
}
```

- `start`/`end` need only be unique **within one container file** — trivially true for `ner.json` since
  each run gets its own file; disambiguate overlapping hits from the same run with a suffix
  (`roi_<start>_<end>_<n>`) rather than requiring cross-run uniqueness.
- `roi.json` may additionally carry a free-text `note` per region (user annotation), which gets indexed
  to Solr for search but has no bearing on tagging.
- Image ROIs keep their existing `type: "rect"` shape unchanged; `type: "text"` is additive.
- Decision: keep `graph.createImageROIs`/`getImageROIs`/`editImageROIs`/`deleteImageROIs` and their
  `/api/images/{rid}/sets/{set_rid}/rois` routes untouched (no frontend risk). `ner.json` gets its own
  parallel, create-only functions/routes instead of a rename: `graph.createNerRegions`/`getNerRegions`,
  `POST /api/files/{rid}/sets/{set_rid}/ner` and `GET /api/files/{rid}/ner` (lists every run, since
  `ner.json` has no upsert — unlike `roi.json`, a source file can have many `ner.json` runs over time).
  `service_id`/`task` are stored as fields on the `ner.json` File node itself (passed as query params on
  create) so a run's origin is visible without needing `TagLink` rows to exist yet.

## 3. `TagLink` — unified tag assignment

Replaces `HAS_ENTITY` edges as the assignment mechanism for **all** combinations (user/machine ×
file/region). Plain ArcadeDB document type, not a vertex/edge — no graph traversal needed since a tag
assignment is a flat fact, not a relationship to walk.

```
TagLink (document type)
- entity_rid      -- the Tag/Entity vertex (vocabulary stays as vertices, via graph.createTag)
- target_rid      -- file rid, OR ner.json/roi.json container rid
- region_id       -- nullable; region key inside the container, when tag is region-scoped
- created_by      -- 'user' | 'machine'
- service_id/task -- nullable, machine-created only (e.g. md-gliner2:extract_entities)
- confidence      -- nullable, carried through from model output when available
- created_at
```

Indexes on `(target_rid, region_id)` and on `entity_rid` cover both query directions ("tags on this
file/region" and "files with this tag"). No `target_type` field needed — the container's own `type`
(`ner.json` vs `roi.json`, or absent for plain files) already tells you mutability/origin.

Consequences:
- `graph.linkEntity`/`unLinkEntity`/`getTags` are rewritten against `TagLink` instead of `HAS_ENTITY`
  MATCH queries — plain indexed `WHERE`, not graph patterns.
- Deleting an `Entity` no longer cascades automatically (edges gave this for free) — needs an explicit
  `DELETE FROM TagLink WHERE entity_rid = ...` step.
- No migration of existing `HAS_ENTITY` edge data — old tags are not carried forward, no dual-read
  fallback needed.
- Per-mention linking (one `TagLink` per NER hit, not just per distinct label) is no longer
  architecturally risky if ever wanted later, since rows are cheap — it becomes a configuration choice
  for autotag granularity, not a hard constraint.

## 4. Solr indexing

- New Solr fields (multivalued) on the existing document schema: `tag_label`, `tag_rid`,
  `tag_created_by`, `tag_confidence` — populated per file (and per region, where applicable) alongside
  the existing `fulltext`/`label`/`project`/`owner` fields. Sourced from `TagLink` rows, not from graph
  edges.
- `roi.json` notes get indexed as their own searchable field (`region_note`) so annotations are
  full-text searchable like OCR text already is.
- Indexing is triggered via a dedicated `update_tags` task on the existing `md-solr` queue/consumer
  (`MD-consumers/src/adapters/solr.mjs`) — same queue as text indexing, not a new one, but its own task
  id so it can be dispatched independently of `index`/`delete`.
- Writes are a realtime-get + merge + full-document repost per existing Solr doc for the file, not an
  atomic partial update (`{"set": [...]}`): this Solr version silently rejects atomic `set` on
  multiValued fields ("multiple values encountered for non multiValued field set") even when the schema
  correctly reports `multiValued: true`. Atomic updates were the original design and turned out to have
  never worked in practice — see §8 step 5.
- Reindexing on tag removal/edit follows the existing `solr.dropSetIndex`/`dropProjectIndex` pattern for
  dropping the underlying text docs; the tag fields on the recreated docs are restored separately by
  re-running `graph.reindexFileTags` per file after a project reindex (see §8 step 5).

## 5. Filtering

- `graph.createTagFilterSet` currently does a graph `MATCH` over `HAS_ENTITY`. Rewritten to query
  `TagLink` directly (plain `WHERE entity_rid IN (...)`) for authoritative filtering, with Solr used for
  the interactive browse/search UI (facets, free-text + tag combined queries) rather than as the
  source of truth.
- Region-aware filtering: a match reports which region(s) matched (via `TagLink.region_id`), not just
  which file — new response shape needed for filter results and for browsing tags after an NER run.
- `/api/tags` GET/POST routes still need to be implemented (pre-existing gap, see
  `/memories/repo/tags-implementation-map.md`) — required regardless of this redesign, since the UI
  already expects them.

## 6. Basic NER workflow (current, no autotag)

1. User runs an NER cruncher (e.g. MD-Gliner2 `extract_entities`) on a file or set.
2. Adapter converts the model's raw JSON into `ner.json` (§2), written the same way any cruncher output
   is written today, in its own output `Set`. **No tags are ever created from this** — `ner.json` is the
   end state, not an intermediate step toward a `TagLink`.
3. User browses results directly off `ner.json`, no `Entity`/`TagLink` involved:
   `graph.getNerLabelGroups(userRID)` scans every `ner.json` run the user owns (via each run's
   `DERIVED_FROM` source file's project) and groups by `(service_id, task, label)` with counts —
   the NER equivalent of `graph.getMachineTags`, but with no link table to query.
   `graph.getNerLabelFiles(service_id, task, label, userRID)` resolves the source files behind one
   group by reading each matching run's JSON and following its `DERIVED_FROM` edge.
   `graph.getNerLabelMentions(service_id, task, label, userRID, options)` aggregates actual mention
   text/hits (paged, searchable) across those files, same shape as `graph.getMachineTagMentions`.
   Routes: `GET /api/tags/ner/labels`, `GET /api/tags/ner/labels/files`, `GET /api/tags/ner/labels/mentions`.
4. This is a direct-scan implementation (reads every owned `ner.json` per request) — acceptable at
   current scale, but not the long-term answer; the Solr indexing route (§4) is the intended eventual
   home for NER browsing/search, not built yet.

### Classification autotag workflow (still uses TagLink)

1. User runs a classification cruncher (e.g. MD-Gliner2 `classify_text`) with `autotag` enabled in
   `service.json`.
2. MessyDesk (on JSON arrival) creates/reuses one `Entity` per distinct label seen and writes one
   `TagLink` row per (file, label) — with `created_by: 'machine'`, `service_id`, `task`, `confidence` (§3).
3. Tag data is indexed into Solr (§4).
4. User browses results via `graph.getMachineTags`/`getMachineTagFiles`/`getMachineTagMentions`
   (`GET /api/tags/machine`...), which read `TagLink`, not `ner.json`.

## 7. Open questions

- Autotag trigger point: on JSON arrival for every task that produces entities, or only for tasks/services
  explicitly flagged `autotag: true` in their `service.json`/params? (Original idea implies the latter —
  flagged per-cruncher-run.)
- Does `graph.createImageROIs` etc. get renamed/generalized now, or do we add parallel functions that
  share the same underlying helpers? Renaming is cleaner long-term but touches existing, working image-ROI
  call sites.

## 8. Phased implementation plan

1. ~~Generalize ROI container storage/routes to support `ner.json`~~ **DONE**: parallel
   `graph.createNerRegions`/`getNerRegions` + `/api/files/{rid}/sets/{set_rid}/ner` (POST),
   `/api/files/{rid}/ner` (GET), reusing the image-ROI storage pattern. Adapter-side JSON shape
   (`type: "text"` regions, §2) and autotag wiring on arrival are still open (§4 below).
2. ~~Introduce `TagLink` document type + rewritten `linkEntity`/`unLinkEntity`/`getTags`~~ **DONE** on
   `feature/tag-link-model`. Old `HAS_ENTITY` edge data is not migrated — existing tags are considered
   stale/disposable, no fallback reads needed (§3, §7).
3. ~~Implement `/api/tags` GET/POST~~ **DONE** on `feature/tag-link-model`.
4. ~~Wire MD-Gliner2 adapter to emit `ner.json`, add `autotag` handling on JSON arrival~~ **DONE, then
   REVERTED for NER** (see policy note at top): `api.py`'s `extract_entities` still writes a
   `*.ner.json` (double-extension \u2192 generic file intake detects `type: "ner.json"` automatically).
   `service.json`'s `extract_entities` task no longer has `"autotag": true` \u2014 NER never creates
   `Entity`/`TagLink` rows. `graph.autotagNerFile` still exists and still fires from
   `processFilesController.mjs` when `message.task?.autotag` is set, but that is now exclusively a
   classification-task path (e.g. a future `classify_text` autotag setting), not an NER one.
5. ~~Add Solr tag fields + indexing hook, sourced from `TagLink`~~ **DONE**, then found broken, then
   fixed onto a queue-based design:
   - Original design (atomic partial update, called synchronously from `linkEntity`/`unLinkEntity`) had
     never actually worked: this Solr version rejects atomic `{"set": [...]}` updates on multiValued
     fields with a 400 error, and `solr.mjs`'s non-fatal catch-and-log error handling meant every prior
     call had silently failed with zero visible signal.
     [`tag_label`/`tag_rid`/`tag_created_by`/`tag_confidence` schema fields have since been corrected
     (`multiValued: true`) in the Solr core, but the atomic-update code path itself remains broken for
     this Solr version regardless of schema.]
   - Current design: `graph.reindexFileTags` rebuilds `tag_label`/`tag_rid`/`tag_created_by`/
     `tag_confidence` from current `TagLink` rows, then calls `graph.enqueueTagSync`, which publishes an
     `update_tags` message to the `md-solr` queue (falls back to the old direct `solr.updateTagsForFile`
     call only if the consumer hasn't registered the `update_tags` task). The consumer
     (`MD-consumers/src/adapters/solr.mjs`) looks up every existing Solr doc for the file by `node`
     (a file can have more than one doc, one per indexing process), and for each does a realtime-get +
     merge + full-document repost rather than an atomic update, leaving `fulltext`/`description`/etc.
     untouched.
   - `reindexFileTags` is called from `linkEntity`/`unLinkEntity` (file-level only, skipped when
     `region_id` is set), transitively from `autotagNerFile`'s per-label `linkEntity` calls, and now also
     from `POST /api/projects/{rid}/reindex-search` per file (that route drops and fully recreates every
     Solr doc for the project via `dropProjectIndex`, which wiped tag fields with no restoration step
     until this fix). Moving to the queue (rather than staying synchronous) was a deliberate choice: a
     single autotag run can touch thousands of files, and each Solr write now costs a realtime-get per
     existing doc, too slow to do inline in the request/file-processing path. `TagLink` remains the
     source of truth; Solr is eventually consistent, which is fine since the Tags UI reads `TagLink`
     directly, not Solr. Non-fatal on Solr errors. `region_note` full-text indexing for `roi.json`
     annotations is still open.
6. ~~Rewrite `createTagFilterSet` against `TagLink`~~ **DONE**. Region-aware *filtering* (matching by
   region rather than whole file) is not pursued for now: autotag stays file-level-only by design (one
   `TagLink` per file+label, `region_id` always null, see §4/§8 step 4), so there is no region-scoped
   `TagLink` data to filter on. Per-region detail is still fully available by reading `ner.json` on
   demand (see step 7) \u2014 just not as a `createTagFilterSet` input.
7. ~~Update Tags UI to browse machine tags per service/task and jump to source regions~~ **DONE, then
   REWORKED for NER** (see policy note at top and §6): `graph.getMachineTags`/`GET /api/tags/machine`
   still lists distinct (service_id, task, label) `TagLink` combos, but that is classification-only now.
   NER browsing lives in `EntitiesMain.vue` (`TagsMain.vue` is dead/unrouted) against
   `graph.getNerLabelGroups`/`getNerLabelFiles`/`getNerLabelMentions` (§6), which read `ner.json` runs
   directly \u2014 no `TagLink`, no per-file client-side filtering. Selecting a mention with multiple hits
   shows a prev/next browser and loads the actual source text inline with the matched span highlighted
   (offsets straight from `ner.json`'s `start`/`end`), instead of navigating away.
8. ~~Add a cruncher-side tag picker so a user can restrict a run to existing tags instead of typing free-form
   categories~~ **DONE**: `Entity` (type `Tag`) now has an optional `description` (`graph.createTag`/
   `getTags`/`GET,POST /api/tags` all pass it through). In `CruncherList.vue`, any task param with
   `params_help.<key>.display: "tagpicker"` renders `TagPickerField.vue`, which toggles between "List
   categories" (the original free-form comma-string textinput, unchanged) and "Pick tags" (multi-select
   over the user's existing tags, each showing its description, plus an inline "define a new tag"
   mini-form). In tag-pick mode the param value sent to the queue message is a JSON array of
   `{label, description}` (not a comma string). This is opted into **per task**, not per service: only
   `MD-Gliner2`'s `classify_text` task uses `service.json`'s `"display": "tagpicker"` on its `labels`
   param, because it assigns one whole-document category and existing tags map onto that cleanly.
   `extract_entities` (NER) deliberately keeps plain `"textinput"` \u2014 it extracts many individual
   per-mention spans per label rather than one whole-document label, so it cannot sensibly be restricted
   to/linked with a fixed existing-tag set the same way; `api.py`'s `parse_label_entries()` (which
   understands the `{label, description}` shape and forwards a `{label: description}` dict to GLiNER2
   for better zero-shot accuracy) is used only by `run_classify_text`, while `run_extract_entities` keeps
   using the original `parse_label_list()`. No new backend "restrict autotag to selected tags" logic was
   needed for the classify_text case: since GLiNER2 only ever returns entities for the labels it was
   given, and `graph.autotagNerFile` already reuses an existing `Tag` entity by exact
   `(type, label, owner)` match (`graph.checkEntity`) rather than always creating a new one,
   pre-creating/picking the tag is sufficient to guarantee the run only ever links back to that same tag.

