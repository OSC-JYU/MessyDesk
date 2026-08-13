# Service Architecture

Core rule: a service must be independent from MessyDesk internals.

Services must not call MessyDesk API endpoints directly. Services do not need to know about queueing, process lifecycle endpoints, or graph update endpoints. All integration with MessyDesk backend happens through adapters in `MD-consumers`.

Services can be implemented in any language as long as they follow the request and response contracts.

## Architecture Layers

1. MessyDesk backend (`MessyDesk`)
- Owns process state, graph writes, file node creation, and set updates.
- Receives callbacks from adapters, not from services.

2. Adapter layer (`MD-consumers`)
- One adapter per API style (`elg`, `elg_fs`, `poppler`, etc.).
- Converts queue messages into service HTTP calls.
- Converts service responses into MessyDesk backend callbacks.
- Handles `/api/nomad/process/files/tmp`, `/done`, and error propagation.

3. Service runtime (this repo pattern)
- Performs only task logic (transform data from input to output).
- Reads input either from request body (HTTP mode) or disk path (disk mode).
- Returns outputs in a defined response format.

## Storage Modes

Use environment variable `STORAGE_MODE` (`http` or `disk`). `FILE_STORAGE_MODE` can be supported as backward-compatible alias.

- `http` mode:
	- Service receives uploaded content via multipart/form-data.
	- Service usually returns `response.type = "stored"` with downloadable `uri` values.

- `disk` mode:
	- Service reads source file from `message.file.path` under `MD_PATH`.
	- Service writes outputs to disk.
	- Service returns `response.type = "disk"` and `response.files[]`.
	- Adapter performs tmp callback to MessyDesk backend.

## Ownership Boundaries

Service responsibilities:
- Validate task params and input shape.
- Resolve and validate input paths safely in disk mode.
- Run transformation logic.
- Return response payload only.

Adapter responsibilities:
- Build service request payload from queue message.
- Call service `/process` endpoint.
- Stage/copy produced files when needed.
- Call MessyDesk `/api/nomad/process/files/tmp` and `/done`.
- Handle callback retries, logging, and error mapping.

MessyDesk backend responsibilities:
- Persist file nodes and process transitions.
- Link outputs to process/set/project context.

## Request Contract (Adapter -> Service)

Typical minimum fields in incoming message payload:

```json
{
	"task": { "id": "task_name", "params": {} },
	"file": {
		"@rid": "#..:..",
		"project_rid": "#..:..",
		"path": "data/<db>/.../source.ext",
		"label": "source.ext",
		"type": "text",
		"extension": "txt"
	},
	"process": { "@rid": "#..:.." },
	"output_set": "#..:..",
	"userId": "#..:.."
}
```

Notes:
- In `elg` and `elg_fs`, the JSON payload is sent as multipart field `message`.

## Response Contract (Service -> Adapter)

Preferred disk response:

```json
{
	"task": "task_name",
	"response": {
		"type": "disk",
		"files": [
			{
				"path": "/absolute/path/to/output.ext",
				"label": "output.ext",
				"type": "text",
				"extension": "txt"
			}
		]
	}
}
```

Legacy HTTP response (still supported in some adapters/services):

```json
{
	"response": {
		"type": "stored",
		"uri": ["/files/<id>/output.ext"]
	}
}
```

## End-to-End Disk Flow

1. Queue event arrives in `MD-consumers`.
2. Adapter sends message to service `/process`.
3. Service reads input from `message.file.path` and writes outputs to disk.
4. Service returns `response.type = "disk"` with file descriptors.
5. Adapter posts files to MessyDesk `/api/nomad/process/files/tmp`.
6. MessyDesk persists output file nodes and process progress.

## Tmp File Structure Contract

The callback endpoint `/api/nomad/process/files/tmp` accepts only files inside MessyDesk tmp root:

- Absolute root form: `<DATA_DIR>/tmp/...`
- Example (db-scoped): `.../MessyDesk/data/<db>/tmp/<filename>`

Important:
- `tmp_path` must be a filename (basename), not a full path.
- Backend resolves the filename under db tmp root derived from `message.file.path` (`data/<db>/tmp`).
- A path like `.../MD-consumers/data/tmp/...` is invalid.
- Services can write outputs to any valid location they own, but adapter-staged callback file must be inside backend tmp root.

Accepted `tmp_path` payload style:
- Filename only (for example: `zipfs_abc123_page_001.txt`).

Example callback payload:

```json
{
	"message": {
		"file": { "@rid": "#79:123", "project_rid": "#4:0", "label": "a.txt", "type": "text", "extension": "txt" },
		"process": { "@rid": "#109:3" },
		"output_set": "#130:4",
		"total_files": 5,
		"current_file": 4,
		"userId": "#49:0"
	},
	"tmp_path": "zipfs_xxx_a.txt"
}
```

Adapter staging requirement:
- Adapter must call `/api/nomad/process/files/tmp` once per output file.
- Adapter must not perform file existence checks, path rewriting, or file staging/copying.
- Adapter forwards service-provided file reference as filename-only `tmp_path`.

Service disk-output requirement:
- File-storage services must write output files into `data/<db>/tmp`.
- Service `response.files[].path` must be filename only (no directories, no absolute path).
- Keep `label`, `type`, and `extension` metadata in each response file item.

## Security and Path Safety

For disk mode, services must:
- Resolve paths under configured root (`MD_PATH`).
- Reject absolute paths when contract expects relative paths.
- Reject path traversal (`..`) escaping root.
- Validate file existence and return clear `4xx` errors.

## Error Handling Guidelines

- Use `400` for invalid request shape or invalid task params.
- Use `404` for missing source file or expected input resource.
- Use `500` for unexpected internal task failures.
- Preserve `HTTPException` status codes (do not wrap all errors into generic `500`).

## Multi-file and Set Processing

For `many-to-one` patterns:
- Service may append intermediate results using `output_uuid`, `current_file`, `total_files`.
- Service should return output file only when final file is processed.
- For non-final files, return empty file list in disk response.

## Checklist for New File-Storage Service

1. Add `STORAGE_MODE` handling (`disk` + optional `http`).
2. Implement safe MD path resolution via `MD_PATH`.
3. Return `response.type = "disk"` with `response.files[]`.
4. Do not call MessyDesk endpoints from service code.
5. Ensure service adapter is `elg_fs` in `services/<service>/service.json`.
6. Add tests for path safety, disk input loading, and output contract.

## Maintainer Notes

- Keep adapter/service responsibilities strict. If a service contains direct calls to `/api/nomad/process/files/*`, treat it as architecture drift.
- If disk-mode callbacks fail with `422`, first verify test message ids (`process.@rid`, `file.@rid`, `project_rid`, `output_set`) exist in current backend DB.
- If error is `Invalid tmp file path`, inspect callback `tmp_path` first. In almost all cases the adapter is staging outside `<DATA_DIR>/tmp` due to wrong `MD_PATH` or wrong db-root resolution.
- If error is `Tmp file not found`, verify the service wrote the file into `data/<db>/tmp` and returned the exact filename in `response.files[].path`.


