# Graph Data Model

MessyDesk uses ArcadeDB as a graph database, accessed via its HTTP API (no ORM). All data operations go through `src/graph.mjs` (~3400 lines), which is the authoritative source for the data model.

## Database Connection

**[verified]** from `src/env.mjs` and `src/db.mjs`:

```
URL: http://{DB_HOST}:{DB_PORT}/api/v1/command/{DB_NAME}
Default: http://127.0.0.1:2480/api/v1/command/messydesk
Auth: Basic (DB_USER:DB_PASSWORD)
```

Queries are sent as HTTP POST with JSON body containing the query language and statement. The `db.sql()` and `db.cypher()` functions in `src/db.mjs` handle this.

## Vertex Types

**[verified]** from `Graph.initDB()` in `graph.mjs`:

| Type | Key Attributes | Purpose |
|------|---------------|---------|
| `Project` | `label`, `created` | Top-level container for all user data |
| `User` | `id` (email), `label`, `access`, `active` | System user |
| `File` | `uuid`, `label`, `path`, `type`, `extension`, `metadata`, `project_rid`, `set`, `expand`, `_active` | Data node (document, image, JSON, etc.) |
| `Set` | `uuid`, `label`, `project_rid`, `path`, `filepath`, `count` | Collection of files |
| `Process` | `uuid`, `status`, `task`, `service_id`, `project_rid`, `set_process` | Processing job record |
| `SetProcess` | `uuid`, `status`, `total_files`, `batch_processed` | Batch processing parent |
| `Entity` | `label`, `type`, `owner` | Named entity or tag |
| `EntityType` | `label`, `color` | Classification for entities (Tag, Person, Location, etc.) |
| `TagLink` | `entity_rid`, `target_rid`, `region_id`, `owner`, `created_by`, `service_id`, `task`, `confidence`, `created` | Document type (not a graph edge) linking an Entity to a file; see Entity/Tag System below |
| `Source` | `label`, `status` | External data source (API, cloud storage) |
| `Prompt` | (varies) | AI prompt storage |
| `ErrorNode` | (varies) | Processing error record |
| `Request` | (varies) | API request record |
| `Person` | (varies) | Future use |

## Edge Types

**[verified]** from `Graph.initDB()`:

| Edge | From → To | Meaning |
|------|-----------|---------|
| `PROCESSED_BY` | File ← Process | A process operated on this file |
| `PRODUCED` | Process → File/Entity | A process created this output |
| `HAS_ITEM` | Set → File | Set membership |
| `BELONGS_TO` | File/Set → Project | Project membership |
| `HAS_SET` | Project → Set | Project owns set |
| `HAS_PROCESS` | Node → Process | Node has processing history |
| `DERIVED_FROM` | File → File | Lineage/derivation chain |
| `HAS_OWNER` | Project/Source → User | Ownership |
| `HAS_SOURCE` | File → Source | File came from external source |

## Indexes

**[verified]** from `Graph.initDB()`:

```sql
CREATE INDEX ON File (project_rid) NOTUNIQUE
CREATE INDEX ON File (set) NOTUNIQUE
CREATE INDEX ON Set (project_rid) NOTUNIQUE
CREATE INDEX ON Entity (owner) NOTUNIQUE
CREATE INDEX ON Project (label) NOTUNIQUE
CREATE INDEX ON TagLink (target_rid) NOTUNIQUE
CREATE INDEX ON TagLink (entity_rid) NOTUNIQUE
```

## Key Data Relationships

```
User
 ▲ HAS_OWNER
 │
Project ──HAS_SET──▶ Set ──HAS_ITEM──▶ File
 │                                      │ │
 │◀──BELONGS_TO─────────────────────────┘ │
 │                                        │
 │                    ┌──DERIVED_FROM──────┘
 │                    ▼
 │                  File (output)
 │                    ▲
 │                    │ PRODUCED
 │                    │
 └──HAS_PROCESS──▶ Process ──PROCESSED_BY──▶ File (input)
```

## Access Control Model

**[verified]** from `graph.mjs` `hasAccess()`:

```javascript
graph.hasAccess = async function (item_rid, user_rid) {
    const query = `TRAVERSE out() FROM ${item_rid}`
    var response = await db.sql(query)
    var user = response.result.filter(x => x['@rid'] == user_rid)
    return user.length > 0
}
```

Access is determined by **graph topology only**: starting from any node, traverse all outgoing edges. If the owning `User` vertex is reachable, access is granted. There is no ACL table, no role-based permissions matrix.

### Critical invariant

**Every queryable node must have an outgoing path (through edges) that reaches a User vertex via HAS_OWNER.** If this chain is broken (e.g., orphaned nodes, manually deleted edges), the node becomes invisible to all users. **[verified]**

### User lookup

Users are identified by email address in the `id` field. `Graph.myId(mail)` queries `SELECT FROM User WHERE id = {mail}`. **[verified]**

## File Node Lifecycle

### Creation (`createOriginalFileNode`)

**[verified]** from `graph.mjs` line ~1548:

1. Generate UUIDv7 (first 6 bytes = timestamp)
2. Compute path: `data/{db_name}/{year}/{month}/{day}/{uuid}/{filename}`
3. Create `File` vertex with: uuid, label, original_filename, path, type, extension, metadata (`{size: 0}`), project_rid, `expand: false`, `_active: true`
4. Link to Project via `BELONGS_TO` edge
5. If `set_rid` provided: set `set` attribute, increment Set.count, sync set manifest

### Set membership

The `set` attribute on a File vertex stores the Set RID. **[inferred]** Once assigned, files are not moved between sets via normal operations.

### Metadata extraction

`media.uploadFile()` extracts after file write:
- Image dimensions (via `image-size` library)
- Text content samples
- PDF page counts

**[verified]** from `media.mjs`.

## Set Model

**[verified]** from `graph.mjs`:

- Sets are created via `Graph.createSet(project_rid, data, user_rid)`
- Directory created on disk: `data/{project}/set-{uuid}/`
- Manifest file `set.json` written with item list
- `syncSetManifest(set_rid)` keeps manifest in sync with graph
- `updateFileCount(set_rid)` maintains a denormalized `count` attribute

## Entity/Tag System

**[verified]** from `graph.mjs`:

7 default entity types created per-user on first use:

| Type | Color |
|------|-------|
| Tag | blue |
| Person | green |
| Location | green |
| Theme | purple |
| Quality | orange |
| Date | cyan |
| Organisation | blue |

Entities are linked to files via `TagLink` (a document type, not a graph edge — see `graph.mjs` `linkEntity`/
`unLinkEntity`; this replaced the earlier `HAS_ENTITY` edge model). One `TagLink` row per (entity, file) pair,
plus optionally per `region_id` for a specific ROI/region within that file. Fields distinguish manual tags
from machine-generated ones:

- `created_by`: `'user'` (created manually) or `'machine'` (created by autotag, classification tasks only —
  see below)
- `service_id` / `task`: which processing service+task produced the tag (null for manual tags)
- `confidence`: max confidence seen across the run, for machine tags
- `region_id`: currently always null in practice — autotagging is file-level only by design

The `Entity` vertex itself also carries a `created_by` (`'user'`/`'machine'`), separate from `TagLink`'s own
field of the same name — this is what lets `graph.pruneOrphanMachineTag` tell an autotag-created tag apart
from a user-made tag that happens to have zero links, and safely delete only the former.

There are two distinct, mutually exclusive mechanisms for making a service task's output browsable in
the Tags view. Both start from a task's output JSON; which one applies is a **policy decision made per
task**, not a runtime choice:

- **Autotag** — a declared `service.json` task parameter (`"autotag": true`). Causes MessyDesk to
  create/link real `Entity`/`TagLink` rows for the task's output labels as soon as the file arrives, so
  the user browses genuine, TagLink-backed tags. Strictly separated from user-created tagging via
  `created_by` (`'machine'` vs `'user'`) on both `Entity` and `TagLink` — see below.
- **Faceted ROI-data** — a *hidden* behaviour, not a declared `service.json` param: any task whose
  output file has `type: "ner.json"` (a per-span/per-region JSON container, see `graph.getNerRegions`)
  is automatically indexed for browsing in the Tags view, grouped by `(service_id, task, label)`, with
  **no** `Entity`/`TagLink` ever created. Despite the `ner.json` type name and the `getNerLabelGroups`
  function names (historical, from when this only served NER), the mechanism is generic span/region
  browsing — MD-lingua's `detect_language` (per-segment language detection, not named-entity
  recognition) is a Faceted ROI-data case, exactly like MD-Gliner2's `extract_entities`.

**Faceted ROI-data never creates tags.** `ner.json` output (per-mention/per-span spans with
`label`/`text`/`start`/`end`/`confidence`) is indexed/browsed directly — a `service.json` task that
produces `ner.json` (any span-shaped "extract structured data" task) must never set `"autotag": true`.
`graph.getNerLabelGroups`/`getNerLabelFiles`/`getNerLabelMentions` (`/api/tags/ner/labels*`) scan a
user's `ner.json` runs directly — grouped by `(service_id, task, label)`, with files resolved via each
run's `DERIVED_FROM` edge — giving the same browse/drill-down/mention-search UX as Autotag-created
machine tags below, without a link table. MD-lingua's `detect_language` reuses this exact path: it
writes a double-extension `*.ner.json` output file (same region container shape) rather than a separate
type, so no core changes were needed to browse it.

Autotag (whole-document classification tasks, with `service.json`'s `"autotag": true`): when a
matching output file arrives, `graph.autotagFile` creates/reuses one `Entity` per distinct label found
and one `TagLink` per (source file, label). The `Entity.type` used is configurable per task via
`graph.autotagFile`'s `entityType` param (defaults to `'Tag'`; nothing currently overrides it).
`graph.getMachineTags`/`graph.getMachineTagFiles` (`/api/tags/machine*`) let the UI browse these
machine tags grouped by service/task and drill into tagged files. **Policy**: whole-document
classification tasks (e.g. a hypothetical `classify_text`) set `"autotag": true` unconditionally in
`service.json` (fixed per task). Span-based "extract structured data" tasks producing `ner.json`
(MD-Gliner2's `extract_entities`, MD-lingua's `detect_language`) are Faceted ROI-data by default and
must never set that static flag — but such a task **may** additionally declare a user-facing
`autotag` checkbox param (`service.json`'s `params_help.autotag`) to let the user opt in per run:
`graph.createQueueMessages` then sets `msg.task.autotag` from the submitted param value instead of a
fixed flag (only `Set` tag-filters need real `TagLink` rows — the `ner.json` output is always produced
and browsable regardless of this toggle). MD-lingua's `detect_language` does this, defaulting the
param to on, so filtering Sets by detected language works out of the box while per-segment detail
still comes from Faceted ROI-data.

When a machine-created tag's last `TagLink` is removed (manual unlink, or file/Set deletion cascading through
`deleteNode`), `graph.pruneOrphanMachineTag` deletes the now-unused `Entity` too — generic across any autotag
entity type. User-created tags are never pruned this way, even if unused.


Tags may optionally carry a `description` (`graph.createTag(label, userRID, description)`). This is used by the
cruncher tag-picker UI (`TagPickerField.vue` in MessyDesk-UI): a user can restrict a task to a fixed set of
existing tags instead of typing free-form categories, and if those tags have descriptions, some services (e.g.
MD-Gliner2's zero-shot extraction) use the description text to improve model accuracy. No special "restrict to
these tags" backend logic exists for this — `autotagFile` already reuses an existing entity by exact
`(type, label, owner)` match, so a pre-existing tag is simply found and reused rather than duplicated.

Tag filtering (`graph.createTagFilterSet`) queries `TagLink` and creates new Sets containing matching files.
Solr `tag_label`/`tag_rid`/`tag_created_by`/`tag_confidence` fields are kept in sync with `TagLink` via
`graph.reindexFileTags` (see `solr.updateTagsForFile`).

## DERIVED_FROM Edge Enrichment

**[verified]** from `connectDerivedFrom()` in `graph.mjs`:

The `DERIVED_FROM` edge carries metadata attributes:

```javascript
{
    process_rid: "#12:50",     // Process node that created this derivation
    process_id: "uuid-...",    // Process UUID
    cruncher: "md-sharp",      // Service display name
    task: "resize"             // Task ID
}
```

**Design decision**: Process context is stored on the edge rather than requiring traversal through Process nodes. This enables efficient lineage queries without creating excessive edge patterns.

## Cascade Delete

**[verified]** from `deleteNode()` in `graph.mjs`:

Breadth-first traversal discovering:
1. Descendant files (via DERIVED_FROM incoming edges)
2. Process-linked files (via process_rid attribute on DERIVED_FROM edges)
3. Set members (if node is a Set: all files where `set = current_rid`)
4. SetProcess children (processes where `set_process = current_rid`)

For each node: Solr index entry deleted, filesystem path deleted (sorted by path length descending to clean directories bottom-up).

**Not deleted**: Upstream source files (parents in DERIVED_FROM chain) and parent SetProcess nodes.

## Query Patterns

The codebase uses two query languages:

- **SQL**: `SELECT FROM File WHERE project_rid = ...` — used for most data access
- **Cypher**: `MATCH (pr:Project)-[:HAS_OWNER]->(u:User) ...` — used for relationship traversals

**[inferred]** Some functions contain fallback queries (Cypher after SQL) suggesting schema evolution or compatibility concerns.
