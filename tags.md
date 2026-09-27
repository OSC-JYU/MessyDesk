# AutoTag system

Autotag system means that classification or NER data can be directly transformed to tags. 

If crucnher has param "autotag" this will happen as soon as json file arrives to MessyDesk.
But suitable json can be also transformed to tags also via Autotag cruncher afterwards.

## Idea

So we can have two type of tags in MessyDesk: user created and machine created. We can also attatch tags to file by hand or by machine.

### Machine created tag.
For example MD-Gliner has task "classify". If it had autotag setting on, it will create tags on fly and attach them to files.

If we use some NER model, then autotag would create tags with type "person", "location" etc.

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
- `graph.createImageROIs`/`getImageROIs`/`editImageROIs` become generic container CRUD (they already
  don't interpret ROI contents) — likely renamed (e.g. `graph.createRegions`) rather than duplicated,
  plus a new immutable-only creation path for `ner.json` (no edit/upsert endpoint, create-only).
  Route path is still open — see §7.

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
- Existing `HAS_ENTITY` edges in production data need a one-time migration into `TagLink` rows (or a
  read-time fallback during rollout — needs a decision, see §6).
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
- Indexing is triggered the same way existing text indexing is triggered: async, via the existing Solr
  adapter/consumer path (`MD-consumers/src/adapters/solr.mjs`) — no new queue, no SQLite involved
  (SQLite stays scoped to the job queue only).
- Reindexing on tag removal/edit follows the existing `solr.dropSetIndex`/`dropProjectIndex` pattern —
  needs an equivalent partial-update (add/remove just the tag fields on an existing doc) rather than a
  full delete+reindex, since the underlying file text doc already exists independently of tags.

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

## 6. Basic NER + Autotag workflow (MVP scope)

1. User runs an NER cruncher (e.g. MD-Gliner2 `extract_entities`) on a file or set.
2. Adapter converts the model's raw JSON into `ner.json` (§2), written the same way any cruncher output
   is written today, in its own output `Set`. No tags exist yet at this point.
3. If the task/service has `autotag` enabled, MessyDesk (on JSON arrival) creates/reuses one `Entity`
   per distinct label seen and writes one `TagLink` row per (file or region, label) — not per raw
   mention — with `created_by: 'machine'`, `service_id`, `task`, `confidence` (§3).
4. Tag data is indexed into Solr (§4).
5. User browses results: existing Tags UI/filter lists machine tags per service+task (already scoped by
   project/set from existing file data), can filter files by tag (§5), and can jump from a tag to the
   specific region(s) it came from via `TagLink.region_id` → `ner.json`.

## 7. Open questions

- Should `ner.json`/`roi.json` routes live under the existing `/api/images/{rid}/sets/{set_rid}/rois`
  path (renamed to be file-type-agnostic) or a new `/api/files/{rid}/sets/{set_rid}/regions` path?
  Renaming affects the existing image ROI frontend (`ImageROIDisplay.vue`) — needs a decision before
  touching routes.
- Migration strategy for existing `HAS_ENTITY` edges: one-time batch migration into `TagLink`, or dual
  read (check edges, fall back to `TagLink`) during a transition window?
- Exact Solr partial-update mechanism for tags (atomic update `add`/`remove` on multivalued fields vs.
  full reindex per file) — needs a quick look at the Solr schema/update API before committing.
- Autotag trigger point: on JSON arrival for every task that produces entities, or only for tasks/services
  explicitly flagged `autotag: true` in their `service.json`/params? (Original idea implies the latter —
  flagged per-cruncher-run.)
- Does `graph.createImageROIs` etc. get renamed/generalized now, or do we add parallel functions that
  share the same underlying helpers? Renaming is cleaner long-term but touches existing, working image-ROI
  call sites.

## 8. Phased implementation plan

1. Generalize ROI container storage/routes to support `ner.json` (immutable, create-only) alongside
   `roi.json` (mutable) and the new `type: "text"` region shape (§2), reusing existing image-ROI code
   paths where possible.
2. Introduce `TagLink` document type + rewritten `linkEntity`/`unLinkEntity`/`getTags`; migrate existing
   `HAS_ENTITY` edges (§3, §7).
3. Implement `/api/tags` GET/POST (pre-existing gap).
4. Wire MD-Gliner2 adapter to emit `ner.json`, add `autotag` handling on JSON arrival (§6).
5. Add Solr tag fields + indexing hook, sourced from `TagLink` (§4).
6. Rewrite `createTagFilterSet` against `TagLink`; update filter UI for region-aware results (§5).
7. Update Tags UI to browse machine tags per service/task and jump to source regions (§6).


