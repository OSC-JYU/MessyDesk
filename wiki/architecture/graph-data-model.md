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
| `HAS_ENTITY` | File → Entity | Entity association |
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

Entities are linked to files via `HAS_ENTITY` edges. Tag filtering creates new Sets containing matching files.

## DERIVED_FROM Edge Enrichment

**[verified]** from `connectDerivedFrom()` in `graph.mjs`:

The `DERIVED_FROM` edge carries metadata attributes:

```javascript
{
    process_rid: "#12:50",     // Process node that created this derivation
    process_id: "uuid-...",    // Process UUID
    cruncher: "Imaginary",     // Service display name
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
