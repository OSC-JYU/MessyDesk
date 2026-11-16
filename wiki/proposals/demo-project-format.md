# Demo bundle format

One zip file holds a whole desk, so a demo can move between MessyDesk instances. Importing it never runs a service: the nodes, edges and files are copied. Code: `src/modules/demos/` (`bundle.ts` is the format, `exporter.ts` writes it).

## Layout

```
manifest.json
graph.json
cover.png            (optional, any image type)
files/<path>         the desk's directory, e.g. files/files/ab/cd/ef/<uuid>/<uuid>.png
```

`files/` holds the project directory as it is on disk (`files/`, `processes/`, `sets/`, `sources/`), so the first path part after the prefix is the project subdirectory.

## manifest.json

| Field | Meaning |
|---|---|
| `format` | Format version, now `1`. An importer refuses a higher version. |
| `title`, `description` | Language code to text, e.g. `{"en": "…", "fi": "…"}`. |
| `created`, `source` | ISO time and the name of the instance that exported it. |
| `project` | Id of the Project node in `graph.json`. |
| `files` | Number of entries under `files/` (a sanity check). |

## graph.json

`{ nodes, edges, documents }`:

- `nodes`: `{ id, type, props }` for the Project and every File, Set, Process, SetProcess, Source and ROI of the desk, plus the Entity nodes its tags use. `id` is the node's `uuid` (`n<number>` when it has none or shares one).
- `edges`: `{ type, from, to, props }` between those nodes (BELONGS_TO, DERIVED_FROM with its process properties). Edges to Users (HAS_OWNER) are not exported.
- `documents`: TagLink and DeskTag rows of the desk.

RIDs and absolute paths never appear. Any string value (also inside lists and objects) is encoded as:

| Value | Meaning |
|---|---|
| `@ref:<id>` | The RID of the node with that id. |
| `@project/<path>` | A path inside the project directory (`@project/` is the directory). |
| `@@text` | The literal string `@text`. |

Dropped properties: the database's own (`@rid`, `@type`, …), `_deleting`, and the user-naming `owner`, `added_by` and `tagged_by`. The importer sets the owner to the importing user.

## Covers

A desk's cover (`cover_upload` file name, `cover_file` RID) travels with the desk: `cover.<ext>` is in the project directory and `cover_file` is a `@ref:`. A demo made from a desk takes the desk's cover image (the upload, or the thumbnail of the cover file or first image) as its own `cover.<ext>` in the zip, and the desk's description is the suggested description in the admin form.

## Import rules (`reader.ts`, `importer.ts`)

- The reader refuses a newer `format`, unsafe entry names (`isSafeBundlePath`), too many entries, and too many bytes (counted while unpacking, not from the zip header). `set.json` files are not unpacked: they are written again from the new nodes.
- Nodes are created first. Values that hold `@…` strings are set after all nodes exist, once each `id` has a RID (`Decoder`). Then edges and documents are created.
- Every node gets a new `uuid`; the uuid parts of paths (shard directories and file names) are renamed to match when files are moved into the new desk's directory.
- Entities are matched by owner, type and label instead of duplicated. TagLink and DeskTag rows get the importing user as `owner`.
- The desk is named after the demo; a taken name gets " (2)", " (3)". It records `demo_source`.
- A failed import deletes what it created.
