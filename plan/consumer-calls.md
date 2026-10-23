# MD-consumers → MessyDesk backend: HTTP API inventory

Snapshot: MD-consumers `5c690f4` (main, after `sqlite-queue` merge), MessyDesk `d4c6654`.
Scope: `/home/arihayri/Projects/MD-consumers/src/**` (all of it: `index.mjs`, `queueClient.mjs`, `server.mjs`, `funcs.mjs`, 13 adapters, 1 descriptor), plus `tests/`, `wiki/`, and `/home/arihayri/Projects/MD-hello-world`.

Some files the task named are gone:
- `index-db.mjs`, `index-multi.mjs`, `index-cold.mjs`, `all.mjs` were deleted in `68b8982`.
- The `imaginary` and `sharp-thumbnailer` adapters were deleted in `c352267`.
- The current tree has no thumbnailer, sharp, zip, pypdf or csv adapter. Those flows run through a generic adapter (`elg`/`elg_fs`) that a service picks in its own `/config` (see §4).

Every backend call uses `got` (v14), except where noted. Base URL: `MD_URL` (default `http://localhost:8200`). Auth is always the header `mail: <value>` (see the "mail" column).

`DEFAULT_USER` = `local.user@localhost`, hardcoded in `funcs.mjs:12`, `index.mjs:34`, `queueClient.mjs:3` and most adapters.

---

## 1. Endpoint inventory

### 1a. Queue (queueClient.mjs, used only by index.mjs main loop)

| METHOD | Path | Body | mail | Response read | Call sites |
|---|---|---|---|---|---|
| POST | `/api/queue/claim` | JSON `{topic: TOPIC, adapter_id}` | DEFAULT_USER | `res.job` (null ⇒ idle). Uses `job.id` and `job.payload`. `job.queue`, `job.attempts` and `job.max_attempts` are ignored | queueClient.mjs:14; called index.mjs:540 |
| POST | `/api/queue/{job.id}/heartbeat` | JSON `{adapter_id}` | DEFAULT_USER | nothing | queueClient.mjs:22; called index.mjs:565 (every 40 s) |
| POST | `/api/queue/{job.id}/complete` | JSON `{adapter_id}` | DEFAULT_USER | nothing | queueClient.mjs:29; called index.mjs:574 |
| POST | `/api/queue/{job.id}/fail` | JSON `{error: e.message \|\| String(e), adapter_id}` | DEFAULT_USER | nothing (backend returns `{ok, permanent, batch_aborted}`, all unread) | queueClient.mjs:36; called index.mjs:578 |

### 1b. Registration / lifecycle (index.mjs + funcs.mjs)

| METHOD | Path | Body | mail | Response read | Call sites |
|---|---|---|---|---|---|
| POST | `/api/services/register` | JSON `{source, service: <descriptor with id forced to TOPIC>}` | DEFAULT_USER | returned, not used | funcs.mjs:574 (`registerServiceDescriptor`), wrapped by `registerServiceDescriptorWithRetry` funcs.mjs:588. Called index.mjs:453 (startup: 5 attempts, 500 ms initial, ×2, max 10 s) and index.mjs:493 (30 s heartbeat: 3 attempts) |
| POST | `/api/services/{TOPIC}/help/ingest` | **no body**. Query `?help_url=<HELP_URL env \|\| descriptor.help_url>` only when one of them is set | DEFAULT_USER | `.json()` awaited, discarded. Errors only logged | index.mjs:240/247 (`triggerServiceHelpIngest`), called once at index.mjs:463 |
| POST | `/api/services/{TOPIC}/adapter/{adapter_id}` | JSON `{control_url}` (`http://localhost:<CONTROL_PORT\|random>`) | DEFAULT_USER | `.json()` discarded | index.mjs:469/472 (startup), index.mjs:501 (every 30 s heartbeat) |
| DELETE | `/api/services/{TOPIC}/adapter/{adapter_id}` | none | DEFAULT_USER | none | index.mjs:336 (shutdown, if registered), index.mjs:513 (after `HEARTBEAT_FAILURE_THRESHOLD`=2 consecutive heartbeat failures) |
| DELETE | `/api/services/{TOPIC}` | none | DEFAULT_USER | none | index.mjs:354 (shutdown, if `serviceRegisteredInBackend`) |
| POST | `/api/nomad/service/{NOMAD_INSTANCE_ID}` | JSON `{nomad_hcl: <file contents with job name/service name rewritten to NOMAD_INSTANCE_ID>}` when an HCL path is known, otherwise **no body** | DEFAULT_USER (backend requires admin) | returned, unused | funcs.mjs:82/91 (`createService`), called index.mjs:409 when no service URL is found |
| DELETE | `/api/nomad/service/{NOMAD_INSTANCE_ID}` | none | DEFAULT_USER (admin) | returned, unused | funcs.mjs:103/106 (`stopService`), called index.mjs:345 on shutdown if `serviceStartedByConsumer && NOMAD_MODE` |
| GET | `/api/services/{TOPIC}` | — | DEFAULT_USER | whole body, treated as descriptor (`id`, `tasks`). Any error ⇒ null | funcs.mjs:494 (`getBackendServiceDescriptor`). Third fallback in `resolveDescriptorSourceChain` funcs.mjs:631, reached only when `SERVICE_JSON_PATH` is set but runtime `/config` and local files miss |

Calls in the same files that do not go to the backend:
- `GET {NOMAD_URL}/service/{topic with _→-}` (funcs.mjs:40/44). Reads `[0].Address`, `[0].Port`.
- `GET {service}/config` (funcs.mjs:565, index.mjs:119).
- `GET {service}/health` (index.mjs:131).

### 1c. File download (adapters → backend)

| METHOD | Path | Body | mail | Response read | Call sites |
|---|---|---|---|---|---|
| GET | `/api/files/{rid without '#'}{source suffix}` | — | `user` arg, almost always `msg.userId` | binary stream saved to `./data/source/<uuid>` | funcs.mjs:121/125 (`getFile`). Callers: annif.mjs:43, elg.mjs:53, elg.mjs:60 (`msg.file.source['@rid']`), json-tagger.mjs:49 (`msg.target`), poppler.mjs:69, paddleocr.mjs:45, libretranslate.mjs:119, ollama.mjs:84, gemini-ai.mjs:47, azure-ai.mjs:134, dspace7.mjs:178 (uses **DEFAULT_USER**, suffix `''`) |
| GET | `/api/sets/{input_set without '#'}/files/zip` | — | `msg.userId` | binary stream saved as a zip | funcs.mjs:139/142 (`getFilesZip`). Caller elg.mjs:49 when `msg.input_set` is set. **Broken against the current backend**: that route now returns `202 {job_id, status_url, download_url}` JSON (files.mjs:1109), not a zip |

### 1d. Result callbacks (adapters → backend)

All multipart uploads are built with `form-data`:
- part `content`: a file stream, or a string or Buffer with a filename.
- part `message`: `JSON.stringify(msg)` with `contentType: application/json` and `filename: message.json`.

The header is always `mail: DEFAULT_USER`, except paddleocr, which sends no mail header.

| METHOD | Path | Body | Payload fields sent back | Response read | Call sites |
|---|---|---|---|---|---|
| POST | `/api/nomad/process/files` | multipart `content` (stream) + `message` | whole `msg` (mutated): `file.type`, `file.extension`, `file.label` (label+'.'+ext, or the service filename), `file_total`, `file_count`, `thumb_name` (set/deleted), `response.time`, plus everything in the original payload (`file['@rid']` is still the **source** rid, `process`, `output_set`, `set_process`, `current_file`, `total_files`, `userId`, `role`, `target`, `task`, `service`, …) | `response.ok` (logged only) | funcs.mjs:305 (`sendFile`), reached via `getFilesFromStore` funcs.mjs:202, from elg.mjs:89 and poppler.mjs:102 |
| POST | `/api/nomad/process/files` | multipart `content` (string from `JSON.stringify(content)`, filename=label, `application/json`) + `message` | same whole-msg pass-through; `file.type`, `file.extension`, `file.label` overwritten | `response.ok` | funcs.mjs:358 (`sendJSONFile`). Callers: annif.mjs:75 (content is the literal `'test'`, see §6), libretranslate.mjs:144, ollama.mjs:170, azure-ai.mjs:223, solr.mjs:290 (only when `output_file===true` on the last file) |
| POST | `/api/nomad/process/files` | multipart `content` (Buffer or string, filename=label, `text/plain`) + `message` | same | `response.ok` | funcs.mjs:406 (`sendTextFile`) and funcs.mjs:372 (`sendStringTextFile`). Callers: test.mjs:57, test.mjs:63, libretranslate.mjs:135, ollama.mjs:173, gemini-ai.mjs:149, azure-ai.mjs:228, dspace7.mjs:167 (passes `true` as 4th arg = string mode), dspace7.mjs:214 |
| POST | `/api/nomad/process/files` | multipart `content` (stream of OCR JSON) + `message`, sent with `got.stream.post` and **no mail header** | `msg` with `file` **replaced** by `{label:'ocr.json', type:'ocr.json', extension:'json'}` (source `@rid` dropped), `processed_files` incremented, `response.time` | none (stream drained) | paddleocr.mjs:106 |
| POST | `/api/nomad/process/files/metadata` | multipart, same helper (`sendJSONFile`/`sendTextFile`), `file.type='response'`, label `response.json` or `init.json` | whole msg. Backend needs `message.file.type=='response'`, `message.file.label`, `message.process.path` | `response.ok` | ollama.mjs:179, gemini-ai.mjs:156, azure-ai.mjs:237 (content `{metadata:{model,tokens:{in,out,total}}, raw}`); dspace7.mjs:131 (init task, content `{hierarchy, fields}` as a string) |
| POST | `/api/nomad/process/files/tmp` | **JSON** `{message: callbackMessage, tmp_path: basename(service file path or label)}` | `callbackMessage` is built from a **whitelist**: `file` = `{...msg.file, type, extension, label, source: msg.file, page_number?}`; `target` (`msg.target \|\| msg.file.project_rid`); `process`; `output_set`; `set_process`; `userId`; `total_files` and `current_file` (the parent batch counters when both >0, otherwise the per-response `files.length` and `i+1`); `file_total`; `file_count`; `batch_total_files` (only when parent counters exist); `service`; `task`; `role` (`msg.role \|\| (task.id==='thumbnail' ? 'thumbnail' : undefined)`); `response` (= service `response` + `time`) | `.json()` discarded. Failures counted and logged with the body | elg_fs.mjs:109/166 |
| POST | `/api/nomad/process/files/done` | JSON (raw string body with Content-Type, or `json:`) | elg_fs: whole `msg` with `file.metadata` merged from service `metadata` and `response` merged + `time`. solr: whole msg + `response.time` + `summary` on the last file. solr update_tags: msg + `response:{...,updated,response}`. json-tagger: msg + `response.time` | elg_fs logs the `.json()`. Others ignore it | elg_fs.mjs:268/269 (only when the service returned no files and `response.type!=='disk'`), solr.mjs:218 (task `update_tags`), solr.mjs:280 (tasks `index`/`delete`), json-tagger.mjs:82 |
| POST | `/api/nomad/process/files/error` | JSON `{error, message: data}` | `message` = the whole msg (or `{}` on parse failure). `error` = an Error object (serialises badly, see §6) or `error.message` string | none, errors swallowed | funcs.mjs:323 (`sendError`). Callers: test.mjs:31,74; annif.mjs:26,85; elg.mjs:32,98; elg_fs.mjs:222,287; json-tagger.mjs:32 (101 commented out); poppler.mjs:34,113; paddleocr.mjs:31,121; libretranslate.mjs:107,157; ollama.mjs:69,185; gemini-ai.mjs:30,166; dspace7.mjs:36,228; azure-ai.mjs:115,247; solr.mjs:163,300. **Every "invalid payload" call (the first one listed for each adapter) passes `url_md` (`.../api/nomad/process/files`) instead of `MD_URL`, so it posts to `/api/nomad/process/files/api/nomad/process/files/error` (404, swallowed)** |
| POST | `/api/entities/link/{msg.target without '#'}` | JSON array `[{type: msg.id+'-'+entity_group, label: word, color:'#ff8844', icon:'mdi-account'}]` (raw string body) | — | `statusCode` logged | json-tagger.mjs:76/78. Header `mail: msg.userId` (not DEFAULT_USER) |

### 1e. Defined but never called (dead)

- `GET /api/batches/{process_rid}`: elg_fs.mjs:20/23, `shouldContinueBatch`. Its only call is commented out at elg_fs.mjs:117-120. It reads `status||state`.
- `POST {md_url}/done`: funcs.mjs:449, `sendDone`. Imported by dspace7.mjs:16 but never called. The path is wrong anyway (there is no `/done` route).
- `objectToURLParams` (imported by poppler) and `getPlainText` (imported by paddleocr) are local helpers. Neither is called.

### 1f. Backend routes no consumer calls

- `/api/nomad/process/csv/append`: the handler is a stub that parses `request` + `content` parts and does nothing.
- `/api/queue/jobs/*`, `/api/batches/*/pause|resume|cancel`, `/api/queue/{topic}/status` and the other queue routes: UI or admin only.

### 1g. MD-hello-world
It makes no direct backend calls. It is a FastAPI service with:
- `GET /health`, `GET /config` (descriptor), `GET /help`.
- `POST /process`: multipart, reads only the `message` part and `message.task.id`. Returns `{response:{uri:"/files/<name>", message}, metadata:{task}}`.
- `GET /files/{name}`.

Its descriptor sets `"adapter": "elg"`, so the backend sees it only through `elg.mjs` + `getFilesFromStore` → `POST /api/nomad/process/files`.

---

## 2. Queue-claim loop contract (index.mjs:523-585, queueClient.mjs)

- One job at a time per process. There is no concurrency.
- Claim body: `{topic: TOPIC, adapter_id: <uuid v4 generated at startup>}`. The backend (queue.mjs:546) claims from both `TOPIC` and `TOPIC_batch` and returns `{job: {id, queue, payload (parsed object), attempts, max_attempts}}` or `{job:null}`. The lease is `QUEUE_DB_LEASE_SECONDS` (default 120 s).
- Polling:
  - Idle (`job` null): sleep `backoff`, starting at `POLL_MIN_MS`=100 and doubling up to `POLL_MAX_MS`=2000. It resets to 100 after a job.
  - Claim throws with HTTP 404: sleep `POLL_MAX_MS` (the comment says "backend hasn't implemented it").
  - Any other claim error: log, then sleep `POLL_MAX_MS`.
- Payload handoff: `process_msg(service_url, { json: () => job.payload })`. This shim is left over from the NATS `msg.json()` API. `payload` is already an object.
- Job heartbeat: `setInterval` every 40 000 ms → `POST /api/queue/{id}/heartbeat {adapter_id}`. Failures are logged only. The first heartbeat fires at 40 s, inside the 120 s lease. The timer is cleared in `finally`.
- Completion:
  - If `process_msg` resolves: `POST /complete {adapter_id}`.
  - If it throws: `POST /fail {error: e.message, adapter_id}`.
  - Errors from complete or fail are logged only. Nothing is retried client-side.
  - Backend fail semantics: up to `max_attempts` (default 3), then exponential backoff retry, then permanent failure, plus a possible batch auto-abort.
- **Real contract**: 11 of 13 adapters catch everything internally, call `sendError(...)` and return normally, so the job is reported **complete** even when it failed. The backend learns about the failure only through `/api/nomad/process/files/error`, and the queue's retry logic never runs for these adapters. Only `test.mjs:75` and `elg.mjs:99` rethrow, so they hit both `/files/error` **and** `/fail`. Each retry can then produce another error node.
- Pause, resume and cancel:
  - The control server (server.mjs) exposes `POST /jobs/{id}/pause|resume|cancel` and `GET /health` on `CONTROL_PORT` (0 = random).
  - The control URL is registered as `http://localhost:<port>`, so it is unreachable from a backend in another container or host.
  - `batchRunner.isPaused/isCancelled/waitUntilResumedOrCancelled` are **never consulted** by the loop or by any adapter, so these endpoints only flip flags.
  - Pause and cancel in practice come from the backend refusing to hand out jobs of paused or cancelled batches at claim time (queue.mjs:570-590).

---

## 3. Service registration contract (startup order, index.mjs:372-521)

1. `createDataDir()`, then `adapter_id = uuidv4()`.
2. If `SERVICE_JSON_PATH` is set, the bootstrap descriptor is resolved: service `/config` → local file candidates → `GET /api/services/{TOPIC}` → `{id: TOPIC, tasks: {}}`. `id` is always forced to `TOPIC`.
3. Service URL:
   - `DEV_URL`, otherwise `getServiceURL`.
   - Nomad mode: catalog lookup of `NOMAD_INSTANCE_ID` with `_`→`-`.
   - Otherwise: `descriptor.dev_url || local_url || 'http://dummy.service.com'`.
   - If nothing is found: **`POST /api/nomad/service/{NOMAD_INSTANCE_ID}`** with `{nomad_hcl}` (or no body), then poll Nomad every 2 s.
4. Optional DEV_URL preflight (`/config` or `/health`).
5. Final descriptor: the runtime `/config` is polled for up to 15 s (or the explicit file is used). Then `adapter.enrichDescriptor(descriptor, serviceUrl)` runs if the adapter exports it; only `libretranslate` does, replacing `params_help.source/target.values`.
6. **`POST /api/services/register`** `{source, service}`, where `source` ∈ `runtime-config | explicit-descriptor | adapter-descriptor | backend-registry | topic-fallback`. The descriptor fields the consumer itself relies on are `id` (overwritten), `adapter`, `tasks`, `help_url`, `dev_url`, `local_url`. Everything else passes through to the backend unchanged.
7. **`POST /api/services/{TOPIC}/help/ingest[?help_url=…]`**, once at startup. Failures are non-fatal. The README says it falls back to `source_url`, but the code does not.
8. Control server start, then **`POST /api/services/{TOPIC}/adapter/{adapter_id}` `{control_url}`**. The backend then calls `queue.ensureProcessConsumersForService`.
9. Every 30 s:
   - Re-resolve the descriptor (no wait) → enrich → `POST /api/services/register` (3 attempts) → `POST /api/services/{TOPIC}/adapter/{adapter_id}` `{control_url}`.
   - On failure, `consecutiveHeartbeatFailures++`. At ≥2: **`DELETE /api/services/{TOPIC}/adapter/{adapter_id}`**, which hides the service. The next successful heartbeat re-adds it.
10. SIGINT/SIGTERM, in this order:
    - `DELETE /api/services/{TOPIC}/adapter/{adapter_id}`.
    - `DELETE /api/nomad/service/{NOMAD_INSTANCE_ID}`, only if this consumer started it and is in Nomad mode.
    - **`DELETE /api/services/{TOPIC}`**, which removes the whole service registration even when other instances share `TOPIC` (see §6).
    - `process.exit(0)`.

---

## 4. Payload fields adapters READ (the backend must keep producing these)

Adapter dispatch: TOPIC → descriptor `.adapter` (or `ADAPTER` env) → `src/adapters/<name>.mjs`.

| Field | Read by (file:line) | How it's used |
|---|---|---|
| `file['@rid']` | test:41; annif:39,43; elg:42,53; elg_fs:110,129-135,198 (spread into callback); poppler:69; paddleocr:41,45; libretranslate:115,119; ollama:80,84; gemini-ai:43,47,78; dspace7:178; azure-ai:130,134; solr:179,204,214 | download via `GET /api/files/{rid}`; Solr doc `node` + id; existence guard |
| `file.type` | annif:53; ollama:89,91; gemini-ai:51,105; azure-ai:135,137; solr:194 | text vs image branching; Solr `type` |
| `file.extension` | annif:53; gemini-ai:51,56,105 | mime / text detection |
| `file.label` | test:61-62; annif:74; ollama:156; azure-ai:204; libretranslate:124; solr:188; funcs `sendFile` (label+'.'+ext) | output label |
| `file.original_filename` | libretranslate:124; ollama:154; azure-ai:202 | output label (preferred) |
| `file.path` | **solr:176**: must be relative to `MD_PATH` (absolute is rejected, as is a path escaping the root) | disk read for indexing |
| `file.description` | solr:195 | Solr `description` |
| `file.project_rid` | elg_fs:138 (fallback for `target`); solr:181 | |
| `file.source['@rid']` | elg:58-60 | second download → multipart part `source` to the service |
| `file.metadata` | elg_fs:257 (merged) | |
| `userId` | every `getFile` call (as the `mail` header); elg_fs:142; solr:189 (`owner`), solr:205 (delete query); json-tagger:49,71 | auth for file download; ownership |
| `task.id` | test:52,60; annif:48; elg_fs:152,196; poppler:44; libretranslate:122; dspace7:55,137,176; solr:175,203,213,255,274 | task dispatch |
| `task.params.*` | test `delay`; annif `prompts.content` (unused), `project_id`; poppler `page` (read, then **deleted** from msg before forwarding); ollama `prompts.content`, `temperature`, `output_type`, `json_schema`; gemini `prompts.content`; azure `prompts.content`, `output_type`, `json_schema`; libretranslate `source`, `target`; dspace7 `url`, `query`, `scope`, `sort`, `page`, `size`, `language_source`, `language` | |
| `task.model.id` | ollama:111 (fallback `OLLAMA_MODEL`/`llama3.1`); gemini-ai:122; azure-ai:144 (deployment) | |
| `task.model.version` | azure-ai:143 (apiVersion) | |
| `task` (as a **string** `'tag'`) and `id` (top level) | json-tagger:47,58 | legacy payload shape |
| `target` | json-tagger:49,76 (**file rid** to download and the entity-link target); elg_fs:138 (forwarded) | |
| `process` / `process['@rid']` | elg_fs:16,139,197; solr:180,272 | Solr id `<file>:<process>`; forwarded |
| `set_process` | elg_fs:16,141; solr:180,199-200,272 | forwarded; Solr field |
| `output_set` | elg_fs:140,199; solr:182 (fallback) | forwarded |
| `input_set` | elg:48-49 (switches to zip download); solr:182,273 | |
| `set_rid` | solr:182,273 | |
| `project_rid` | solr:181 | |
| `current_file`, `total_files` | elg_fs:111-113; solr:258,270-271,288 | batch counters; "last file" detection |
| `batch_total_files` | elg_fs:111 | preferred over `total_files` |
| `service` | elg_fs:150,195 | forwarded |
| `role` | elg_fs:152 (forwarded, defaulted to `'thumbnail'` when `task.id==='thumbnail'`); poppler:89 (**sets** `'thumbnail'`) | |
| `tag_fields.{tag_label,tag_rid,tag_created_by,tag_confidence}` | solr:215,139-142 | update_tags |
| `output_file` | solr:255-257 | emit `index.json` |
| `processed_files` | paddleocr:92-96 (incremented) | |
| `response` | elg:85, elg_fs:154,259, solr:219,263 (spread) | |
| `thumb_name` | funcs:223-227 (set from service output / deleted) | |

The adapters themselves never read these fields:
- `external`, `root_source`/`root_source_rid`/`root_source_label`, `search_output`, `set_files`, `zip_output_name`, `db_name`, `pipeline`, `delete_original`, `set_node`, `output_rid`/`output_path`, `topic`, `queue_options`.

They still matter in two ways:
- (a) **The downstream services read them.** `elg` and `elg_fs` forward the entire payload as the multipart `message` part to `{service}/process`. For example, md-zip_fs needs `set_files`, `zip_output_name` and `db_name`, and pypdf/poppler need `task.params`.
- (b) **The backend reads some of them back** from the callback message. `processFilesController` reads `root_source*`, `pipeline`, `output_rid`, `output_path`, `role`, `process.kind`, `file.forward`, `file.page_number`, `thumb_name` and `behaviour`/`group_size`.
  - Adapters that post the whole `msg` (`sendFile`/`sendJSONFile`/`sendTextFile`, solr/json-tagger `/done`) round-trip them.
  - **`elg_fs`'s `/tmp` callback whitelist drops all of them** (and also `input_set`, `set_rid`, `project_rid`, `search_output`, `external`, `pipeline`, `root_source*`, `output_rid`/`output_path`, `topic`, `id`, `delete_original`).
  - So a rewrite must not assume those fields come back on `/api/nomad/process/files/tmp`. The `/tmp` callback carries only the fields listed in §1d.

Fields consumers **add** to callback messages:
- `file.type`, `file.extension`, `file.label`
- `file_total`, `file_count`
- `thumb_name`
- `response.time`, plus merged service `response`
- `role` (`'thumbnail'`)
- `file.source` and `file.page_number` (elg_fs)
- `file.metadata` (elg_fs `/done`)
- `summary` (solr, last file): `{indexed_files, total_files, process_rid, set_rid, task, service:'md-solr', updated_at}`
- `processed_files` (paddleocr)
- elg merges the service's `file_list.message` into msg (elg.mjs:86-88)

---

## 5. Special roles and flows

The backend produces these jobs. The consumer side is a generic adapter chosen by the service's own `/config` `adapter`. No adapter in this repo is specific to any of these flows.

| Flow | Producer (backend) | Topic | Payload specifics | Consumer path | Callback |
|---|---|---|---|---|---|
| Image thumbnail on upload | routes/files.mjs:338 | `md-thumbnailer` (md-sharp run with `TOPIC=md-thumbnailer`) | `{topic:{id}, service:{id}, task:{id:'thumbnail', params:{width:800,type:'jpeg'}}, file, userId}`. **No `role`** | via `elg_fs`: callback `role` defaults to `'thumbnail'` because `task.id==='thumbnail'` (elg_fs:152). This default is load-bearing. Via `elg`: no role is added, so the output would be stored as a normal file | `/tmp` (elg_fs) or `/files` (elg) |
| Image thumbnail for outputs | processFilesController.mjs:556 | `md-thumbnailer` | adds `role:'thumbnail'`, `total_files`, `current_file`, `output_set`, `process`, `set_process` | same | same |
| Thumbnail refresh (version/revert) | routes/files.mjs:162 `queueThumbnailRefresh` | `md-thumbnailer` (image), `md-poppler` (pdf) | image: `role:'internal_versioning'`, `process:{kind:'internal_versioning'}`, `target`, top-level `id:'md-thumbnailer'`, **no `service`**. pdf: `role:'thumbnail'`, `process:{kind:'internal_versioning'}`, `task.params:{page:1,previewResolution:150,thumbnailResolution:80}` | `md-poppler` → poppler.mjs. Disk mode (`STORAGE_MODE=disk`): JSON `POST {svc}/process` with msg, then no backend callback at all (the service writes the files itself). Otherwise: multipart, `msg.role='thumbnail'` forced, `getFilesFromStore` → `/files`. Because `process` is an object without `@rid`, error routing on failure relies on role/kind | `/files` or none |
| Split-PDF page thumbnails | processFilesController.mjs:578 | `md-poppler_fs` | `role:'thumbnail'`, `task.params.task:'thumbnail'`, `process`, `output_set`, counters | adapter declared by the md-poppler_fs service (presumably `elg_fs`) | `/tmp` |
| EXIF rotate | routes/files.mjs:320 | `md-sharp` | `task:{id:'rotate', params:{rotate, stripmeta:'true'}}`, `role:'internal_versioning'`, `process:{kind:'internal_versioning'}` | md-sharp's adapter. `elg_fs` forwards `role` and `process`. `elg` round-trips the whole msg | backend checks `task.id==='rotate'` **and** role/kind (processFilesController.mjs:296-299), then republishes a thumbnail to md-thumbnailer with `role:'internal_versioning'` |
| Zip set export | routes/files.mjs:83-107 | `md-zip_fs` | `{service:{id:'md-zip_fs'}, task:{id:'zip',params:{compression:0}}, file:{'@rid':setRid,'@type':'Set',type:'set'}, set_rid, db_name, zip_output_name, set_files:[{@rid,path,label,original_filename}], userId: <user RID>}` | presumably `elg_fs`, with the service writing `zip_output_name` into the tmp dir | `/tmp` (tmp_path = file basename). The `set_rid`, `db_name` and `zip_output_name` fields are **not** echoed back by elg_fs. The backend's zip job tracks the output by name in its own job record |
| PDF split import | controllers/importPipeline.mjs:47-82 | `md-pypdf_fs` | `role:'import'`, `delete_original`, `output_set`, `set_node`, `process` | presumably `elg_fs` | `/tmp`. elg_fs **drops `role:'import'` unless `msg.role` is set**. It is set here, so it is forwarded. `delete_original`/`set_node` are dropped (the backend re-reads them from the Process node) |
| Solr indexing | backend solr.mjs → topic `md-solr` | `md-solr` | tasks `index` (needs `file.path` relative to `MD_PATH`, `file['@rid']`, `process`/`set_process`, `project_rid`, `set_rid`/`input_set`/`output_set`, `userId`, `current_file`/`total_files`, `output_file`), `delete` (`file['@rid']`, `userId`), `update_tags` (`file['@rid']`, `tag_fields`) | solr.mjs talks to Solr directly (`/solr/messydesk/{select,get,update?commit=true}`) | `/done` (+ an optional `index.json` via `/files`) |
| Service-group logo resize | routes/service-groups.mjs:106-123 | **not queued** | backend `fetch`es `md-sharp {url\|local_url}/process` directly with `task {id:'fit', params:{width:200,height:200,type:'png'}}`, reads `response.uri[0].uri` | consumers are not involved | — |
| CSV append | `/api/nomad/process/csv/append` (stub) | — | — | no consumer calls it | — |
| AI metadata | ollama / gemini / azure / dspace7 init | — | — | `/api/nomad/process/files/metadata` with `file.type='response'` | backend `Graph.writeUsage(usage, message)` |

Backend error-route special cases (nomad.mjs:91-124):
- A thumbnail failure is detected by `role` ∈ {thumbnail, thumbnails}, `task.id==='thumbnail'`, `topic.id` or `service.id==='md-thumbnailer'`.
- An internal-versioning failure is detected by `role` ∈ {internal_versioning, exif_rotate} or `process.kind`/`process`==='internal_versioning'.
- Both are swallowed: no error node is created.

---

## 6. NATS status

**Dead.**
- No NATS code is left in `src/`, and `package.json` has no `@nats-io/*` dependencies.
- The NATS consumers (`index-cold`, `index-multi`, `all.mjs`) and the NATS test publishers were deleted in `68b8982`.
- Leftovers:
  - The `{ json: () => job.payload }` shim (index.mjs:572) imitates the NATS message API.
  - gemini-ai.mjs:26-27 still does `JSON.parse(message.json())`, which **throws on the object payload**. That leaves `msg` undefined, so the adapter always fails, and its error goes to the wrong URL.
  - Stale wiki pages describe NATS behaviour: `wiki/non-obvious-behavior.md` §4, §11, §12 and `wiki/proposals/consumer-queue-overhaul.md`.

---

## 7. Suspicious / unclear

1. **Wrong error URL on parse failure**: every adapter calls `sendError({}, …, url_md)` with `url_md = …/api/nomad/process/files`. `sendError` appends `/api/nomad/process/files/error`, so these posts 404 silently. Several adapters also don't `return` after a parse failure, so the code falls into the try block and fails again with `msg` undefined.
2. **Error objects serialise to `{}`**: `sendError(msg, error, …)` passes the Error instance in `json`, and the `message` property is non-enumerable. Only some adapters (annif, gemini, libretranslate) pass `error.message`. The backend stores whatever arrives in error nodes.
3. **Failures reported as complete**: most adapters swallow errors (sendError + return), so the queue gets `/complete`. The queue retry/max_attempts/auto-abort logic therefore never sees most real failures. `test` and `elg` rethrow, so they hit both channels, and each retry creates another error node.
4. **Two parallel completion channels**: the queue `complete`/`fail` (job level) and `/api/nomad/process/files[/tmp|/done|/error]` (domain level) carry overlapping information. Batch counters (`current_file`/`total_files`) are advanced by the domain callbacks, not by the queue.
5. **`getFilesZip` is incompatible**: `GET /api/sets/{rid}/files/zip` is now async (202 JSON + poll + download). `elg` with `input_set` would send a JSON blob to the service as "content".
6. **Callback field whitelist in elg_fs vs full pass-through elsewhere**: the same backend handler (`processFilesCore`) receives very different message shapes depending on the adapter. Root-source, pipeline, search_output, output_rid/output_path, set_rid, project_rid, external and delete_original are lost on `/tmp`.
7. **`file['@rid']` in output messages is the *source* rid**, while `file.type/label/extension` describe the *output*. paddleocr instead replaces `file` entirely (no @rid). elg_fs keeps the source rid and also adds `file.source` = the source file.
8. **paddleocr uploads without a `mail` header**: this only works when the backend runs with `MODE=development`. Every other callback sends `DEFAULT_USER`.
9. **`mail: msg.userId` for downloads and entity linking**: backend producers sometimes set `userId` to a **user RID** (zip job `request.auth.credentials.user.rid`, files.mjs `userRid`, graph.mjs `me_rid`) and sometimes, apparently, an email. The `mail` header auth (`Graph.myId(mail)`) must accept both. dspace7 uses DEFAULT_USER for download instead.
10. **Thumbnail role inference**: the upload-time md-thumbnailer job has no `role`. Only elg_fs's `task.id==='thumbnail'` fallback makes it a thumbnail; poppler forces `role='thumbnail'`. Other topics, inconsistently: `topic:{id}` vs top-level `id` vs `service:{id}` (queueThumbnailRefresh has no `service`), and `process` is sometimes `{kind:'internal_versioning'}` with no `@rid`.
11. **Synonym fields**:
    - Backend `/tmp` accepts `tmp_file|tmp_path|content_file|content_path|file_path|path` on payload or message. Consumers send only `tmp_path` (top level).
    - Counters `total_files` vs `batch_total_files` vs `file_total`, and `current_file` vs `file_count`.
    - Set refs `set_rid` vs `input_set` vs `output_set`.
    - Solr falls back across `process['@rid']` vs `set_process` and `project_rid` vs `file.project_rid`.
    - `role` vs `process.kind`.
12. **json-tagger uses a legacy payload shape**: `msg.task` as the string `'tag'`, `msg.id` as the service id, `msg.target` as the file rid. The current backend never produces it, so it is effectively dead.
13. **annif** never uploads the Annif result: it sends `content:'test'` as `annif.json`, and `annif_result` is unused. Its `fetch` sends JSON with no content-type header.
14. **dspace7** imports `cld`, which is not in `package.json`, so the adapter fails to load. `sendTextFile(…, url_md, true)` uses the 4th param as "string mode". The init task sends JSON as text to `/metadata`. The DSpace query string is not URL-encoded.
15. **Shutdown deletes the whole service** (`DELETE /api/services/{TOPIC}`) even when several instances share a TOPIC (which the code explicitly supports via `NOMAD_INSTANCE_ID`). The other instances re-register on their next 30 s heartbeat. This route needs admin access, which works only because DEFAULT_USER is admin or in dev mode.
16. **Heartbeat = full re-register every 30 s** (descriptor + adapter POST), in addition to the per-job heartbeat every 40 s. Adapter liveness is inferred from register calls, and there is no dedicated adapter heartbeat endpoint.
17. **Control server is effectively a no-op** (§2), and its `control_url` uses `localhost`.
18. **`createService`/`stopService` error handling**: `throw('msg', e.response.body)` uses the comma operator, so it throws only the body, and it throws a TypeError when there is no response.
19. **Claim 404 special case** ("backend hasn't implemented it") is a leftover from the migration.
20. **poppler mutates `task.params`** (deletes `page`) before forwarding, and the deleted param is then missing from the echoed message. In disk thumbnail mode it makes no backend callback at all; the md-poppler service must write files and update the DB itself, or the backend must infer completion.
21. **Solr** works around Solr atomic-update limits (full get+merge+repost, solr.mjs:114-149). It requires shared-disk access (`MD_PATH`) to MessyDesk data instead of `GET /api/files`.
22. **Docs drift**:
    - The README mentions `STRICT_TOPIC_ID` and a `source_url` help fallback; neither exists.
    - The MessyDesk wiki says TOPIC is optional, but index.mjs:93 throws without it.
    - `wiki/message-protocol.md` cites the deleted `tests/publish_thumbnailer.mjs`.
