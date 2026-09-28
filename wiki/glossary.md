
# Glossary

| Term | Definition |
|------|-----------|
| **Project** | Top-level container for user data. Owns sets, files, and processes via graph edges. Each project has exactly one owner (User). |
| **Set** | Collection of files within a project. Stored on disk with a `set.json` manifest. Files belong to at most one set. |
| **File** | A data node in the graph representing a document, image, JSON, or other content. Has `type`, `extension`, `path` on disk. |
| **Process** | A processing job record. Created when a user triggers a service task on a file. Tracks status (`queued` → `running` → `done`/`error`). |
| **SetProcess** | Parent node for batch processing. Aggregates multiple Process nodes when processing a set of files. |
| **Service** | An external tool that processes files (e.g., OCR, NER, image resize). Runs as an independent HTTP server. Described by a `service.json` descriptor. |
| **ServiceGroup** | Admin-managed graph vertex (`id`, `name`, `description`, `logo`) formalizing the `service_groups` string values used in `service.json` and on `User.service_groups`. `id` is the canonical value referenced elsewhere (e.g. `"IMAGE"`). Managed from the Admin page (admin-only); see [service-descriptor-format.md](service-descriptor-format.md#service-groups). |
| **Cruncher** | UI term for services. Named after the cookie icon (crunch). How services are presented to the user. |
| **Consumer / Adapter** | Integration layer (MD-consumers repository) that connects services to the MessyDesk backend. Translates queue messages into service HTTP calls and routes results back. One consumer process per service. |
| **Task** | A specific operation within a service (e.g., "resize" within the md-sharp service). Defined in the service descriptor. |
| **Behaviour** | Task processing mode: `one-to-one` (1 file → 1 output), `one-to-many` (1 file → N outputs), `many-to-one` (N files → 1 output). |
| **Message** | JSON payload that the backend sends to a service via the consumer. Contains file metadata, task parameters, process context, and user identity. |
| **Queue** | Per-service list of processing requests. Implemented as a SQLite database (`data/{db_name}/queue.sqlite`) with WAL mode. Jobs have status (`queued`, `running`, `done`, `failed`, `cancelled`), lease-based claiming, and retry logic. |
| **ROI** | Region of Interest. Area of an image (rectangle, circle, polygon) defined with percentage-based coordinates. Stored as `roi.json` file nodes. |
| **Autotag** | Mechanism that makes MessyDesk create/link `Entity`/`TagLink` rows for a task's output as soon as it arrives, so the user can browse (and Set-filter by) the result as real tags. Either a fixed `service.json` flag (`"autotag": true`, whole-document classification tasks), or, for a Faceted ROI-data task that declares a user-facing `autotag` checkbox param, a per-run opt-in (e.g. MD-lingua's `detect_language`, on by default). Strictly separated from user-created tagging via `TagLink.created_by`: `'machine'` vs `'user'`. See [graph-data-model.md](architecture/graph-data-model.md). |
| **Faceted ROI-data** | Hidden service behaviour (not a declared `service.json` param — implied by a task's output file type, `ner.json`) that makes MessyDesk index a task's per-span JSON output (`rois`) directly for browsing in the Tags view, grouped by `(service_id, task, label)`, without creating any `Entity`/`TagLink`. Currently implemented as `graph.getNerLabelGroups`/`getNerLabelFiles`/`getNerLabelMentions`. MD-Gliner2's `extract_entities` and MD-lingua's `detect_language` are both cases of this — despite the `ner.json`/"NER" naming, the mechanism is generic span/region browsing, not specific to named-entity recognition. See [graph-data-model.md](architecture/graph-data-model.md). |
| **Entity** | Named entity or tag. Created manually, or by a classification service's Autotag (never by Faceted ROI-data — see Tag). Types: Tag, Person, Location, Theme, Quality, Date, Organisation. |
| **Tag** | An entity of type "Tag". Main manual organisation tool for files, also used by Autotag. Optionally has a `description`, used by the cruncher tag-picker (see [processing-crunchers.md](../../MessyDesk-UI/wiki/processing-crunchers.md) in MessyDesk-UI) to improve zero-shot model accuracy. Faceted ROI-data tasks never create Tags — see Faceted ROI-data. |
| **TagLink** | Document type (not a graph edge) linking an Entity to a file (optionally a region). Carries `created_by`/`service_id`/`task`/`confidence` to distinguish manual tags from Autotag ones. Faceted ROI-data is never linked this way. See [graph-data-model.md](architecture/graph-data-model.md). |
| **NER label group** | A `(service_id, task, label)` combination found by scanning a user's `ner.json` runs directly (`graph.getNerLabelGroups`) — the browse-time result of Faceted ROI-data, and the equivalent of a machine tag but with no `Entity`/`TagLink` created. See [graph-data-model.md](architecture/graph-data-model.md). |
| **Source** | External data source (API, cloud storage). When created, triggers an `init` task to establish connection. |
| **RID** | Record ID in ArcadeDB, format `#cluster:position` (e.g., `#12:50`). Used as the primary identifier for graph vertices and edges. |
| **Descriptor** | `service.json` file describing a service's capabilities, supported types, tasks, and parameters. |
| **Nomad** | HashiCorp Nomad. Optional service orchestrator for production deployments. |
| **DERIVED_FROM** | Graph edge linking output files to their source files. Carries process context (process_rid, task, cruncher) as edge attributes. |
| **Import** | Automatic processing that occurs when a PDF file is uploaded. The file is split into single-page PDFs via `md-pypdf_fs`. The Process node has `role: 'import'`. Original file is deleted by default. |
| **processable** | Boolean field on File nodes. When `false`, only the PDF split service is offered. Absence of the field means the file is processable by all matching services. Set on non-splitter/non-zip PDF outputs. |
| **_file_removed** | Boolean field on File nodes. When `true`, the file data has been deleted from disk but the graph node is preserved as provenance (e.g., original PDF after import split). |