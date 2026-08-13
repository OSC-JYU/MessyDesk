
# Glossary

| Term | Definition |
|------|-----------|
| **Project** | Top-level container for user data. Owns sets, files, and processes via graph edges. Each project has exactly one owner (User). |
| **Set** | Collection of files within a project. Stored on disk with a `set.json` manifest. Files belong to at most one set. |
| **File** | A data node in the graph representing a document, image, JSON, or other content. Has `type`, `extension`, `path` on disk. |
| **Process** | A processing job record. Created when a user triggers a service task on a file. Tracks status (`queued` → `running` → `done`/`error`). |
| **SetProcess** | Parent node for batch processing. Aggregates multiple Process nodes when processing a set of files. |
| **Service** | An external tool that processes files (e.g., OCR, NER, image resize). Runs as an independent HTTP server. Described by a `service.json` descriptor. |
| **Cruncher** | UI term for services. Named after the cookie icon (crunch). How services are presented to the user. |
| **Consumer / Adapter** | Integration layer (MD-consumers repository) that connects services to the MessyDesk backend. Translates queue messages into service HTTP calls and routes results back. One consumer process per service. |
| **Task** | A specific operation within a service (e.g., "resize" within the Imaginary service). Defined in the service descriptor. |
| **Behaviour** | Task processing mode: `one-to-one` (1 file → 1 output), `one-to-many` (1 file → N outputs), `many-to-one` (N files → 1 output). |
| **Message** | JSON payload that the backend sends to a service via the consumer. Contains file metadata, task parameters, process context, and user identity. |
| **Queue** | Per-service list of processing requests. Implemented as a SQLite database (`data/{db_name}/queue.sqlite`) with WAL mode. Jobs have status (`queued`, `running`, `done`, `failed`, `cancelled`), lease-based claiming, and retry logic. |
| **ROI** | Region of Interest. Area of an image (rectangle, circle, polygon) defined with percentage-based coordinates. Stored as `roi.json` file nodes. |
| **Entity** | Named entity or tag. Can be created manually or by services (NER). Types: Tag, Person, Location, Theme, Quality, Date, Organisation. |
| **Tag** | An entity of type "Tag". Main manual organisation tool for files. |
| **Source** | External data source (API, cloud storage). When created, triggers an `init` task to establish connection. |
| **RID** | Record ID in ArcadeDB, format `#cluster:position` (e.g., `#12:50`). Used as the primary identifier for graph vertices and edges. |
| **Descriptor** | `service.json` file describing a service's capabilities, supported types, tasks, and parameters. |
| **Nomad** | HashiCorp Nomad. Optional service orchestrator for production deployments. |
| **DERIVED_FROM** | Graph edge linking output files to their source files. Carries process context (process_rid, task, cruncher) as edge attributes. |