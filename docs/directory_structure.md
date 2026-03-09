Directory structure TODO

MessyDesk uses graph database for documentating file processing and keeping record of origin of files.

Currently directory structure loosely replicates graph structure which is not ideal. We must implement new structure.
The idea is to make structure simpler but avoid huge directories. Important part of structure is that it must be possible to reconstruct database solely on directory data.

MessyDesk/data remains as data directory. Under that there is database specific directory, which allows experimenting with different databases in same data directory.

Under the database spesific directory there is projects directory. Project directories are simply projects RID without # and : replaced with underscore (like it is now)



New structure is following:

 /files
 /processes
 /sets

## Files

File has unique identifiers (UUIDv7).
Under `/files` there is sharding based on UUID value.
Example UUID: `0195f4e2-9a58-73df-a1bd-8e7a2c6f4d9b`



Stored like this (head-byte sharding, time-grouped for UUIDv7):

 files/
 └── 01/
   └── 95/
     └── f4/
       └── 0195f4e29a5873dfa1bd8e7a2c6f4d9b/

Actual file and its thumbnails are saved in that directory.


## Process
Process data is saved similarly in /processes


## Sets

/sets are saved differently. Sets are virtual folders that has references to files. Set folder includes JSON file with list of all files in it. 


## Implementation notes (2026-03)

Implemented in backend:

- New sharded helper paths in [src/media.mjs](../src/media.mjs)
  - `uuidShardPath(uuid)`
  - `shardPath(identifier)` (UUID primary, RID fallback)
  - `getFileDir()`, `getFilePath()`
  - `getProcessDir()`, `getProcessFilesDir()`
  - `getSetDir()`, `getSourceDir()`
- New root folder created at startup:
  - `/projects`
- For each project (`/projects/<project_rid>`), sharded folders are used:
  - `/files`
  - `/processes`
  - `/sets`
- New writes for `File` and `Process` nodes use sharded paths.
- New nodes get UUIDv7 at creation time.
- `Set` nodes get a dedicated path under `/sets` and write `set.json` manifest.


## Migration

Migration tool is provided as a separate script:

- [tools/migrate_sharded_layout.mjs](../tools/migrate_sharded_layout.mjs)

Usage:

1. Dry-run:
   - `node tools/migrate_sharded_layout.mjs --dry-run`
2. Apply migration:
   - `node tools/migrate_sharded_layout.mjs`

The script migrates:

- existing nodes to UUIDv7 when UUID is missing
- `File.path` to `/projects/<project_rid>/files/<uuid-shards>/<uuid>.<ext>`
- `Process.path` to `/projects/<project_rid>/processes/<uuid-shards>/<uuid>/files`
- `Set.path` to `/projects/<project_rid>/sets/<uuid-shards>/<uuid>` and writes `set.json`
- `Source.path` to `/projects/<project_rid>/sources/<uuid-shards>/<uuid>`