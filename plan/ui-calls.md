# MessyDesk-UI → backend API inventory

Repo: `/home/arihayri/Projects/MessyDesk-UI` (paths below are relative to `src/` unless they start with `e2e/`, `wiki/` etc.).

## How HTTP is done

- **Single HTTP module:** `api/client.js` builds a `web` object on top of axios. The area modules (`api/admin.js`, `api/entities.js`, `api/files.js`, `api/projects.js`, `api/search.js`, `api/services.js`, `api/session.js`) are one-line pass-throughs (`export const x = (...args) => web.x(...args)`). Only `api/session.js:15 getSsoUser()` adds logic (returns `response.data || {}` from `web.sso()`).
- `axios.defaults.baseURL = import.meta.env.VITE_API_PATH` (client.js:28). `.env.development` sets `VITE_API_PATH=""`, `VITE_PUBLIC_PATH=""`.
- Response interceptor (client.js:38-69): calls `onAuthError(status)` on 401/302; rejects with `{status, message: data.message || 'Server error occurred'}`; network → `{status:0}`.
- **No** `fetch(`, `XMLHttpRequest`, `WebSocket`, `sendBeacon` anywhere outside axios. The only non-axios network sources are: one `EventSource`, `<img>/<iframe>/<a href>` URLs built by helpers, `window.location.assign` for zip download, and a hardcoded Shibboleth logout link.
- RIDs: almost every method does `rid.replace('#','')` → URL segment `{rid}` = `12:34` (colon kept, unencoded). Exceptions noted in "Suspicious".
- vite dev proxy (`vite.config.js`): `/events`, `/api`, `/images`, `/icons` → `http://localhost:8200`; dev server port 3000.

Legend: **DEAD** = defined in `api/client.js` (and re-exported) but no call site in `src/`.

---

## Auth / me / users / permission requests

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api` | – | – | nothing (only success vs 401/302 matters) | def client.js:76 `ready`; app/App.vue:28 (on mount + every `visibilitychange`→visible) |
| GET | `/api/sso` | – | – | `.data.mail`, `.data.name` (full axios response returned by `web.sso`; `getSsoUser` unwraps `.data`) | def client.js:71, session.js:15; features/help/LoginPage.vue:32, features/home/HomePage.vue:39 |
| GET | `/api/me` | – | – | `access` (`=== 'admin'` → isAdmin), `id` (shown as user name/email), `settings` ({theme, cookie, motion}) | def client.js:354; stores/session.js:20 (called from app/AppHeader.vue:44, app/router.js:149 admin guard) |
| PUT | `/api/me/settings` | – | `{ <key>: <value> }` one of theme/cookie/motion | whole returned settings object (`theme`,`cookie`,`motion`), fed to `setSettings` | def client.js:359; stores/settings.js:86 |
| GET | `/api/users` | – | – | array of `{ '@rid', label, id (email), access, service_groups[], active }` | def client.js:265; features/admin/AdminPage.vue:71 |
| POST | `/api/users` | – | `{ label, id }` (id = email) | nothing (errors swallowed, see Suspicious) | def client.js:285; features/admin/AdminPage.vue:101 |
| PUT | `/api/users/{rid}/service-groups` | – | `{ service_groups: string[] }` | nothing | def client.js:295; features/admin/AdminPage.vue:207 |
| POST | `/api/permissions/request` | – | `{}` | nothing | def client.js:270; features/help/LoginPage.vue:21 |
| GET | `/api/permissions/request` | – | – | array of `{ '@rid', id (email), label }` (`.length` for badge) | def client.js:275; features/admin/AdminPage.vue:70, :115 |
| DELETE | `/api/permissions/request/{rid}` | – | – | nothing | def client.js:280; features/admin/AdminPage.vue:102, :114 |

## Service groups

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/service-groups` | – | – | array of `{ id, name, description, logo, logo_version }` | def client.js:302; features/admin/AdminPage.vue:72, :141, :165 |
| POST | `/api/service-groups` | – | `{ id, name, description }` | nothing | def client.js:307; features/admin/AdminPage.vue:139 |
| PUT | `/api/service-groups/{id}` (encodeURIComponent) | – | `{ name, description }` | nothing | def client.js:312; features/admin/AdminPage.vue:150 |
| DELETE | `/api/service-groups/{id}` | – | – | nothing | def client.js:317; features/admin/AdminPage.vue:164 |
| POST | `/api/service-groups/{id}/logo` | – | multipart `file` (explicit `Content-Type: multipart/form-data` header) | whole object `Object.assign`ed onto the group (expects updated `logo`, `logo_version`) | def client.js:322; features/admin/AdminPage.vue:153 |
| GET (img src) | `{VITE_API_PATH}/api/service-groups/{id}/logo?v={logo_version||0}` | `v` cache-buster | – | image | features/admin/ServiceGroupsTab.vue:22-27 (used :54) – only when `group.logo` truthy |

## Projects (desks)

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/projects` | – | – | array of projects: `'@rid'`, `label` (fallback `name`), `description`; size from first of `size_mb, sizeMB, sizeMb, total_size_mb, total_mb, size` (>1 MiB treated as bytes); item count from first of `node_count, nodes_count, item_count, file_count, count`; expiry from first of `expiration_date, expiry_date, expires_at, expires, expire_at, valid_until` | def client.js:379; features/home/useDesks.js:35; features/project/ProjectWorkspace.vue:24 (to find one desk's label/description); features/search/ProjectScope.vue:17 (`@rid`, `label`) |
| POST | `/api/projects` | – | `{ label, description:'', position:{x,y} }` (random 0-199) | `'@rid'` (if missing, reloads list and matches by `label`) | def client.js:139; features/home/useDesks.js:71 |
| GET | `/api/projects/{rid}` | – | – | graph: `nodes[]` each `{ data:{ id, type, _type, '@type', label|name, description, info, file_count, count, roi_count, paths[], text_samples[], image (relative URL, prefixed with VITE_API_PATH), service, model, metadata{size,width,height,count,page_count}, forward, process_rid, error, error_count, processed, params (JSON string; `.system_params.prompts.content` read), types[], status, location, role, extension, thumbnail_version }, position? }`; `edges[]` each `{ data:{ id, source, target } }` | def client.js:394; features/project/useDeskGraph.js:37 (→ graphModel.js:25-67) |
| PUT | `/api/projects/{rid}` | – | `{ key:'label', value }` or `{ key:'position', value:{x,y} }` | nothing | def client.js:765; features/home/useDesks.js:80 (rename); features/project/useDeskGraph.js:71 (drag-stop, **node.id of any node**, not only projects – see Suspicious) |
| DELETE | `/api/projects/{rid}` | – | – | nothing | def client.js:750; features/home/useDesks.js:91 |
| POST | `/api/projects/update-size` | – | none | nothing | def client.js:384; features/home/useDesks.js:51 |
| GET | `/api/projects/storage-summary` | – | – | `used_mb`, `quota_gb`, `used_percent` | def client.js:389; features/home/useDesks.js:37 (→ features/home/StorageCard.vue:10-32) |
| POST | `/api/projects/{rid}/reindex-search` | – | none | `source_sets_found`, `requeued_sets`, `requeued_files` | def client.js:399; features/home/useDesks.js:85 (→ features/home/ReindexDeskDialog.vue:47-48) |
| POST | `/api/projects/{rid}/sets` | – | `{ label, description }` | `'@rid'` (to focus new node) | def client.js:149; features/project/dialogs/CreateSetDialog.vue:24 |
| POST | `/api/projects/{rid}/sources` | – | `{ type ('nextcloud'|'dspace7'), label, url, description }` | `'@rid'` | def client.js:159; features/project/dialogs/CreateSourceDialog.vue:43 |
| POST | `/api/projects/{rid}/upload` | `no-thumbnails=true`, `delete_original=false` (never set by callers) | multipart `file` (+ `no_thumbnails` form field, never set) | nothing | def client.js:821 `uploadFile`; features/project/dialogs/UploadController.vue:66 |
| POST | `/api/projects/{rid}/upload/{set_rid}` | same as above | multipart, up to 20 `file` parts per request, 3 concurrent requests | `uploaded[]`, `failed[]` (each `{filename, error}`); if neither array present the whole body counts as one uploaded item | def client.js:844 `uploadFiles` (also `uploadFile` with set_rid, client.js:833 — never called with a set); features/project/dialogs/UploadController.vue:85 |

## Sets

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/sets/{rid}/files` | `skip`, `limit` (also supports `group_by_origin=true`, `source_rid` — never passed) | – | `files[]` (`'@rid'`, `rid`, `id`, `label`, `name`, `type`, `extension`, `entities[]`, `description`, `info`, `thumb`, `path`), `file_count` | def client.js:409; features/project/SetBrowser.vue:63 (PER_PAGE = 10), features/project/useOpenNode.js:57 (skip 0 limit 2), features/files/useFileViewer.js:96 (limit 1, prev/next) |
| POST | `/api/sets/{rid}/thumbnails` | `limit` (never passed) | none | `queued`, `total_files` | def client.js:622; features/project/panel/NodeTools.vue:63 |
| POST | `/api/sets/{rid}/files/zip/jobs` | – | none | `job_id` | def client.js:677; features/project/panel/NodeTools.vue:77 |
| GET | `/api/sets/{rid}/files/zip/jobs/{job_id}` | – | – | `status` (`'ready'` / `'failed'`), `download_url`, `message`; polled every `VITE_SET_ZIP_POLL_MS` (2000) up to `VITE_SET_ZIP_WAIT_MS` (20 min) | def client.js:683; features/project/panel/NodeTools.vue:82 |
| GET (navigation) | `{VITE_API_PATH}` + (`status.download_url` \|\| `/api/sets/{rid}/files/zip/jobs/{job_id}/download`) | – | – | file download via `window.location.assign` | def client.js:689 `getSetZipDownloadUrl`; features/project/panel/NodeTools.vue:85-86 |

## Files / documents

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/documents/{rid}` | – | – | file node: `'@rid'`, `'@type'`, `type`, `extension`, `label`, `path`, `description`, `metadata{size,width,height,lines,characters}`, `entities[]` (`rid` or `'@rid'`, `label`, `color`, `icon`) or `tags[]`, `edited`, `ref`/`ref_rid` (reference node), `info` | def client.js:581 `getDocInfo` (console.logs!); features/project/useOpenNode.js:24; features/files/useFileViewer.js:35; features/files/useQuickEdit.js:47; features/search/useFileOpener.js:15; features/files/tools/FileTagsTool.vue:21; features/files/displays/LineSegmentsDisplay.vue:33 (`path`); features/files/displays/SimilarityDisplay.vue:65 (`label`) |
| GET | `/api/files/{rid}` (JSON/text) | – | – | raw file content; axios may return a parsed object *or* a string — consumers handle both (`asText`, `JSON.parse` if string) | def client.js:588 `getNodeFile`; features/files/useFileContent.js:17 (used by OcrDisplay:13, JsonDisplay:8, HumanJsonDisplay:11, TextDisplay:16, HocrDisplay:15); features/tags/MentionPreview.vue:25 (text, sliced by `hit.start/end`); features/files/displays/SimilarityDisplay.vue:63, :105 (`doc_map`, `text_file`, ...); features/files/displays/LineSegmentsDisplay.vue:65 (`image_shape`, `source_path`, `image_path`, `source.path`, `source_rid`, `source['@rid']` …) |
| GET | `/api/files/{rid}` (blob) | – | – | Blob | def client.js:593 `getNodeFileBlob`; features/files/useQuickEdit.js:72 |
| GET (img/iframe/a) | `{VITE_API_PATH}/api/files/{rid}` | – | – | browser loads original file | features/files/fileUrls.js:6-8 `fileUrl`; used in features/project/panel/NodeTools.vue:103 ("Open file" href), features/files/tools/FileToolsPanel.vue:64 (href), features/files/displays/PdfDisplay.vue:6 (iframe src), features/files/displays/ImageDisplay.vue:88 (`img.src` for crop), features/files/displays/HocrDisplay.vue:25 & HumanJsonDisplay.vue:47 (source image src) |
| POST | `/api/files/{rid}/version` | – | either multipart `{ file (Blob, filename), operation ('crop'|'rotate'), params (JSON string {degrees, crop}) }` or JSON `{ content: string }` | nothing | def client.js:598; features/files/useQuickEdit.js:74 (image, multipart); features/files/displays/TextDisplay.vue:34 (`{content}`) |
| POST | `/api/files/{rid}/revert` | – | none | nothing | def client.js:612; features/files/useQuickEdit.js:132; features/files/displays/TextDisplay.vue:39 |
| POST | `/api/files/{rid}/thumbnail` | – | none | nothing | def client.js:617; features/files/useQuickEdit.js:80, :90, :133; features/project/panel/NodeTools.vue:56 |
| GET | `/api/files/{rid}/ancestors` | – | – | array of `{ type, path }` (finds `type==='image'`) | def client.js:636; features/files/displays/OcrDisplay.vue:23; features/files/displays/LineSegmentsDisplay.vue:36 |
| GET (img src) | `{VITE_API_PATH}/api/thumbnails/{path}[?v={version}]` | `v` cache-buster | – | image | features/files/fileUrls.js:12-17 `previewUrl`; used in features/files/displays/ImageDisplay.vue:27, features/files/displays/OcrDisplay.vue:47, features/files/displays/LineSegmentsDisplay.vue:95, features/files/LineagePanel.vue:84 |
| GET (img src) | `{VITE_API_PATH}/api/thumbnails/{dir of path}` (no filename!) | – | – | image | features/files/fileUrls.js:19-22 `folderPreviewUrl`; features/files/roi/RoiEditor.vue:213 |
| GET (img src) | `{VITE_API_PATH}/api/thumbnails/{dir of path}/thumbnail.jpg` | – | – | image | features/search/results.js:42-48 `thumbnailUrl` (search hits :79 and tagged files :97) |
| GET (img src) | `item.thumb` used **as-is** (no base prefix), normalised to end in `/thumbnail.jpg` | – | – | image | features/search/results.js:94-96 (tagged files / set browser) |
| GET (img src) | `VITE_API_PATH + node.data.image` (backend-supplied relative URL) + `?v=thumbnail_version` | `v` | – | image | features/project/graphModel.js:43; features/project/nodes/ImageNode.vue:14, PdfNode.vue:14 (`versioned()` in nodes/thumbnails.js), features/project/panel/NodePanel.vue:87. SetNode.vue:29-37 renders `data.paths[]` directly as `src` (sentinel `'__pdf_icon__'`). |

## Graph (vertices/edges/traverse)

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/graph/traverse/{rid}/out` | – | – | array (lineage path) of nodes `{ '@rid', '@type' ('File','Set','User','Process',…), type, label, extension, path }` | def client.js:631 `getNodePath`; features/files/LineagePanel.vue:33; features/project/useOpenNode.js:54; features/files/useFileViewer.js:65; features/files/sourceImage.js:7 (used by HocrDisplay.vue:24, HumanJsonDisplay.vue:46) |
| GET | `/api/graph/vertices/{rid}/init` | – | – | `hierarchy[]` (`{id,name,collections[{id,name}]}`), `fields[]` (`{id,name}`) — DSpace source init | def client.js:770 `getSourceInit`; features/services/crunchers/DspaceQueryForm.vue:41 |
| POST | `/api/graph/vertices/{rid}` | – | `{ key, value }` (keys used: `label`, `description`) | nothing | def client.js:760 `setNodeAttribute`; features/project/panel/NodePanel.vue:27 (label / description); features/files/tools/DescriptionField.vue:34 (description) |
| DELETE | `/api/graph/vertices/{rid}` | – | – | nothing | def client.js:745 `deleteNode`; features/project/dialogs/DeleteNodeDialog.vue:27 (rid = `node.data.process_rid || node.id`) |
| POST | `/api/graph/query` | – | `{ query, current, cluster }` | – | def client.js:129 **DEAD** |
| POST | `/api/graph/query/me` | – | `{ rel_types[], node_types[], return }` | – | def client.js:646 **DEAD** |
| GET | `/api/graph/vertices/{rid}` | – | – | – | def client.js:641 `getSchemaAndData` **DEAD** |
| POST | `/api/graph/vertices` | – | arbitrary | – | def client.js:740 `createNode` **DEAD** |
| POST | `/api/graph/edges/{rid}` | – | arbitrary | – | def client.js:755 `setRelationAttribute` **DEAD** |
| GET | `/api/graph/stats` | – | – | – | def client.js:570 `getStats` **DEAD** |
| POST | `/api/graph/vertices/{rid}/rois` | – | `{ rois, width, height }` | – | def client.js:775 `createROIs` **DEAD** |

## ROIs

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/images/{rid}/sets/{set_rid}/rois` | – | – | accepts array of shapes, `{ rois:{id:shape} , '@rid'|rid|roi_rid }`, or bare map `{id:shape}`; ROI-file rid from `'@rid'` / `rid` / `roi_rid`; shape fields `type ('rect'|'circle'|polygon), left, top, width, height, cx, cy, r, points[{xPct,yPct}], id, '@rid', label`; 404/error = "no regions" | def client.js:789; features/files/roi/useRois.js:23; features/project/SetBrowser.vue:52 (**once per file shown** to compute "Has regions" badge) |
| POST | `/api/images/{rid}/sets/{set_rid}/rois` | – | `{ rois: { <id>: {...shape, id, '@rid': id} } }` | full axios response returned: `result.data['@rid']` (fallback `result['@rid']`) | def client.js:781; features/files/roi/useRois.js:51 |
| PUT | `/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}` | – | `{ rois: {...map} }` | nothing | def client.js:796; features/files/roi/useRois.js:49 |
| DELETE | `/api/images/{rid}/sets/{set_rid}/rois/{roi_rid}` | – | – | nothing (used when last shape is removed) | def client.js:804; features/files/roi/useRois.js:46 |

## Services (registry / control)

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/services` | – | – | **object keyed by service id**: `{ <id>: { id?, name, description, consumers[] (length = workers), active, nomad (bool), nomad_hcl, location ('external'…), local_url, kind, registration{source,last_seen}, supported_types[], supported_formats[], source_url } }` | def client.js:172; features/home/ActiveCrunchersCard.vue:25; features/services/ServicesPage.vue:45 (polled every 5 s); features/services/ServiceControlPage.vue:33; features/admin/AdminPage.vue:73; features/project/dialogs/UploadController.vue:32 (`['md-pypdf_fs'].consumers.length`) |
| GET | `/api/services/files/{rid}` | `filter` (`''` or `'ROI'`, appended unencoded as `?filter=`) | – | `for_format[]`: `{ id, name, description, category, access ('proprietary'…), status ('experimental'), location, source_url, models{<id>:{name,output,description,supported_types[]}}, external_tasks, supported_formats[], params_help, tasks{<key>:{ name, description, info, content, params_help{<p>:{name,help,display,values,default,multi,component}}, supported_formats[], output_type, json_schema, system_params }} }`; `filters[]`: `{ id, name, description, category }`. Service `thumbnailer` and category `system` hidden client-side. | def client.js:331; features/services/crunchers/CruncherPicker.vue:61 |
| POST | `/api/services/install` | – | `{ kind ('nomad'|'external'|'local'), id, name?, description?, service? (raw JSON string), nomad_hcl?, url? (external), dev_url? (local) }` | nothing | def client.js:210; features/services/ServiceControlPage.vue:72 (payload from InstallServiceDialog.vue:34-44) |
| DELETE | `/api/services/{id}` | – | – | `status` (`'not_found'` special-cased) | def client.js:215; features/services/ServiceControlPage.vue:85 |
| POST | `/api/services/reload` | – | `{}` | nothing | def client.js:220; features/services/ServiceControlPage.vue:69 |
| POST | `/api/nomad/service/{id}` | – | `{ nomad_hcl }` or `{}` | nothing | def client.js:199; features/services/ServiceControlPage.vue:60 |
| DELETE | `/api/nomad/service/{id}` | – | – | nothing | def client.js:205; features/services/ServiceControlPage.vue:66 |
| GET | `/api/services/{id}/init` | – | – | – | def client.js:344 `getInitData` **DEAD** (re-exported from session.js) |

## Queue / batches / jobs

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| POST | `/api/queue/{service}/files/{rid}` | – | process: `{ service, id (task key), params{}, model?, name?, description?, system_params?{output_type,json_schema,…}, info? }` (built in crunchers.js:127-140) | nothing (full response returned) | def client.js:657 (console.logs url); features/services/crunchers/CruncherPicker.vue:74→:81 |
| POST | `/api/queue/{service}/files/{rid}/roi` | – | same process object | nothing | def client.js:664; CruncherPicker.vue:73→:81 (when filter==='ROI') |
| POST | `/api/queue/{service}/sets/{rid}` | – | same process object | nothing | def client.js:671; CruncherPicker.vue:72→:81 (node type `set`/`*-set`) |
| POST | `/api/queue/{service}/sources/{rid}` | – | same process object; DSpace query sends `{ service:'md-dspace7', id:'make_query', params:{ query, scope, sort, page, size } }` | nothing | def client.js:693; CruncherPicker.vue:71→:81, and :110 (DSpace query) |
| GET | `/api/queue/jobs/active` | – | – | array of jobs: `rid`, `set_process`, `service_id`, `queue` (`*_batch`), `queued_files`, `running_files`, `total_files`, `processed_files`, `failed_files`, `status`, `eta_sec`… (whole object stored in batchStore) | def client.js:184 **and again** :729 (duplicate; latter wins); features/services/ServicesPage.vue:45, :68; stores/batchStore.js:142 (hydrate on SSE open) |
| POST | `/api/queue/jobs/{rid}/dismiss` | – | none | nothing (errors ignored) | def client.js:734; stores/batchStore.js:132 |
| GET | `/api/queue/{topic}/flush` | – | – | nothing | def client.js:189 `flushQueue` (GET with side effects); features/services/ServicesPage.vue:219 |
| GET | `/api/batches/{rid}` | – | – | whole object shown as JSON; `status` **or** `state` read | def client.js:705; features/project/panel/ProcessDetailsDialog.vue:28 |
| POST | `/api/batches/{rid}/pause` | – | none | nothing | def client.js:711; stores/batchStore.js:117 (JobsPanel.vue:78) |
| POST | `/api/batches/{rid}/resume` | – | none | nothing | def client.js:717; features/project/panel/ProcessDetailsDialog.vue:40; stores/batchStore.js:122 |
| POST | `/api/batches/{rid}/cancel` | – | none | nothing | def client.js:723 `cancelBatch` → stores/batchStore.js:127; **also** def client.js:194 `cancelJob` (encodeURIComponent, no '#' strip) → features/services/ServicesPage.vue:218 (QueueDialog) |
| GET | `/api/queue/{service}/status` | – | – | – | def client.js:119 `getQueue` and :179 `getQueueStatus` — both **DEAD** |
| GET | `/api/queue/drain/{rid}` | – | – | – | def client.js:699 `cancelProcess` **DEAD** |

## Filters

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| POST | `/api/filters/{filter_id}/files/{rid}` | – | `{}` for generic filters; for `mdf-set-filter`: `{ selection_mode ('include'|'exclude'|'untagged'), selected_entity_rids: ['#..'], match ('or'|'and'), set_label? }` | nothing | def client.js:338; features/services/crunchers/CruncherPicker.vue:98; features/services/crunchers/TagFilterDialog.vue:81 (`{rid}` here is a **set** rid) |

## Prompts

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/prompts` | – | – | array `{ '@rid', name, type ('image'|'text'), description, content, output_type ('text'|'json'), json_schema, owner ('public'…) }` | def client.js:225; features/services/PromptsPage.vue:31 |
| POST | `/api/prompts` | – | full prompt draft (`structuredClone` of existing incl. `@rid`/`owner`, or new `{type,name,description,content,output_type,json_schema}`) – same endpoint for create and update | nothing | def client.js:114; features/services/PromptsPage.vue:49 |

## Tags / entities / NER

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/entities` | `project_rid` (1 desk) or `project_rids` (comma list), via `projectParams` | – | array of types `{ type, icon, items[{ '@rid', label, color, icon, created_by ('machine' filtered out) }] }` | def client.js:426; features/tags/useTags.js:43; features/files/tools/FileTagsTool.vue:28 |
| GET | `/api/entities/types` | – | – | array `{ type, label }` (select item-value/title) | def client.js:431; features/tags/AddTagDialog.vue:16 |
| POST | `/api/entities` | – | `{ type, label }` | nothing | def client.js:473; features/tags/AddTagDialog.vue:30 |
| GET | `/api/entities/sets/{rid}` | – | – | array `{ '@rid' or rid, label, type, count }` | def client.js:436; features/services/crunchers/TagFilterDialog.vue:35 |
| GET | `/api/entities/items` | `entities` (comma list of rids w/o '#'), `project_rid` / `project_rids`; **on error retried without project filter** | – | array of files (`'@rid'`/`rid`/`id`, `label`, `name`, `type`, `extension`, `entities`, `description`, `info`, `thumb`, `path`) | def client.js:441; features/tags/useTags.js:64 |
| POST | `/api/entities/{eid}/vertex/{vid}` | – | none | nothing | def client.js:478; features/files/tools/FileTagsTool.vue:67 |
| DELETE | `/api/entities/{eid}/vertex/{vid}` | – | – | nothing | def client.js:485; features/files/tools/FileTagsTool.vue:44 |
| GET | `/api/tags` | – | – | `{ result: [{ rid, label, description }] }` (note `rid`, not `@rid`, and wrapped in `result`) | def client.js:492; features/services/crunchers/TagPickerField.vue:22 |
| POST | `/api/tags` | – | `{ label, description }` | nothing (list reloaded and matched by label) | def client.js:497; features/services/crunchers/TagPickerField.vue:52 |
| GET | `/api/tags/machine` | – | – | array `{ entity_rid, label, count, service_id, task }` (grouped by service_id:task) | def client.js:502; features/tags/useTags.js:52 (not project-scoped) |
| GET | `/api/tags/ner/labels` | `search`, `project_rid`/`project_rids`, `file_rids` (comma list) | – | array `{ service_id, task, label, count }` | def client.js:534; features/tags/useTags.js:48 |
| GET | `/api/tags/ner/labels/mentions` | `service_id`, `task`, `label`, `search`, `page`, `pageSize`, `project_rid(s)`, `file_rids` | – | `{ mentions[{ text, count, hits[{ file_rid, file_label, start, end }] }], total, page }` | def client.js:554; features/tags/NerLabel.vue:33 (hits → MentionPreview.vue:25-44) |
| GET | `/api/tags/machine/{eid}/files` | `service_id`, `task` | – | – | def client.js:507 **DEAD** |
| GET | `/api/tags/machine/{eid}/mentions` | `service_id, task, search, page, pageSize` | – | – | def client.js:514 **DEAD** |
| GET | `/api/tags/ner/labels/files` | `service_id, task, label, project_rid(s), file_rids` | – | – | def client.js:541 **DEAD** |
| GET | `/api/files/{rid}/ner` | – | – | – | def client.js:527 `getNerRegions` **DEAD** |
| GET | `/api/entities/types/{type}` | – | – | – | def client.js:468 `getEntitiesByType` **DEAD** |

## Search

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| POST | `/api/search` | – | `{ query, rows (≤1000; UI sends 500), project_rid? | project_rids[]? }`; **on any error with a project filter, re-POSTs `{query}` only** and sets `_project_filter_ignored` | Solr-shaped: `response.docs[]` (`id`, `node`, `label`, `path`, `type`, `entities`, `description`, `score`), `highlighting[<doc.id>].fulltext_exact[] / fulltext[]` | def client.js:86; features/search/SearchPage.vue:41 |
| GET | `/api/search/info` | – | – | `project_counts[]` `{ project_rid, docs }` | def client.js:404; features/home/useDesks.js:36 |

## Help

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/help` or `/api/help/{slug}` (slug lowercased, `[a-z0-9-]+`) | – | – | HTML text (`responseType:'text'`); parsed: `nav.help-nav a` (href, text, `.active`), `article.content` \|\| `main` \|\| body, `<title>` minus `"MessyDesk Help - "`; 404 → "not found" | def client.js:230; features/help/HelpPage.vue:43 (parse in features/help/helpContent.js:28-46) |
| GET | `/api/services/{id}/help` | – | – | HTML text, same parsing | def client.js:242; features/help/HelpPage.vue:39 |
| GET | `/api/services/{id}/help/assets/{path...}` (each segment encoded) | – | – | HTML text (fetched as text, then parsed as a help page) | def client.js:250; features/help/HelpPage.vue:39 |
| GET (img src inside help HTML) | `/api/help/images/{path}` and `/api/services/{path}` rewritten to `{VITE_API_PATH}/api/...` | – | – | images/assets | features/help/helpContent.js:13-26 |

## Misc (all DEAD unless noted)

| METHOD | path | query | body | response fields read | call sites |
|---|---|---|---|---|---|
| GET | `/api/errors/{rid}` (rid **not** '#'-stripped) | – | – | – | def client.js:81 `getError` **DEAD** |
| POST | `/api/query` | – | `{ query }` | – | def client.js:124 `rawQuery` **DEAD** |
| GET | `/api/schemas` | – | – | `.result` | def client.js:364 **DEAD** |
| GET | `/api/queries` | – | – | `.result` | def client.js:369 **DEAD** |
| GET | `/api/groups` | – | – | – | def client.js:374 **DEAD** |
| GET | `/api/files/{dir}` | – | – | – | def client.js:421 `getFiles` **DEAD** |
| POST | `/api/{dir}/import?filename={filename}[&mode={mode}]` (unencoded) | `filename`, `mode` | none | – | def client.js:575 `importFile` **DEAD** |
| GET | arbitrary `process_path` | – | – | – | def client.js:349 `getProcessParams` **DEAD** |
| POST | `/api/layouts` | – | `{ data: positions, target: node }` | – | def client.js:811 `saveLayout` **DEAD**; `getLayoutByTarget` (client.js:817) is a stub returning `{}` without a request |
| GET (link) | `/Shibboleth.sso/Logout` (absolute, not via VITE_API_PATH/PUBLIC_PATH) | – | – | – | app/AppHeader.vue:91 (live) |
| — | `GET /api/me` mocked, `GET /api/projects/1:0` mocked, `/events` aborted | | | | e2e/live-updates.pw.js:14-26; e2e/smoke.pw.js:136 mocks `/api` → 401 |

---

## SSE

**Creation:** `services/events.js:13-14` — `new EventSource(`${import.meta.env.VITE_API_PATH}/events`)`. Path is `/events` (**not** under `/api`; vite proxies it separately with `Accept: text/event-stream`, `Accept-Encoding: identity`). Opened once from `app/App.vue:47` on mount, closed on unmount (:53).

- `onopen` (events.js:16-24): clears reconnect timer and calls `batchStore.hydrate()` → `GET /api/queue/jobs/active` (stores/batchStore.js:140-153; jobs keyed by `job.set_process || job.rid`).
- `onerror` (events.js:35-41): closes and reconnects after 5000 ms (manual reconnect; native auto-reconnect disabled by `close()`).
- `onmessage` only (events.js:26-33): unnamed `message` events; `JSON.parse(event.data)`, parse errors ignored. **Named SSE events (`event: xyz`) would be ignored.** No `lastEventId` use.
- `routeEvent` (events.js:59-81): drops messages without `data.command`. Batch/process commands go to `batchStore.handleEvent`; **every** message with a `command` is re-dispatched as `window` `CustomEvent('md-sse', {detail: data})` (consumed only by features/project/useDeskGraph.js:164).
- No filtering by user/project in the UI: the open desk applies any `add`/`update` it receives (see Suspicious).

### Commands handled

| command | handler (file:line) | fields read |
|---|---|---|
| `batch_started` | events.js:64 → stores/batchStore.js:40-49 | job key `set_process` \|\| `process['@rid']`; `service_id`, `total_files` |
| `batch_progress` | events.js:65 → batchStore.js:64-73 | key as above; `processed_files`, `total_files`, `failed_files`, `avg_sec_per_file`, `eta_sec` |
| `batch_paused` | events.js:66 → batchStore.js:75-77 | key only |
| `batch_resumed` | events.js:67 → batchStore.js:79-81 | key only |
| `batch_completed` | events.js:68 → batchStore.js:83-94 | key; `total_time_sec` \|\| `batch.total_time_sec`; `batch.processed_files`, `batch.total_files`; job removed after 10 s |
| `batch_cancelled` | events.js:69 → batchStore.js:96-99 | key; removed after 5 s |
| `batch_error` | events.js:70 → batchStore.js:108-110 | key; `failed_files` (else increments by 1) |
| `batch_failed` | events.js:71 → batchStore.js:101-106 | key; `error_message` |
| `process_update` | events.js:72 → batchStore.js:51-62 **and** useDeskGraph.js:116-120 | batchStore (only if `batch` present): `batch.status` ('paused','cancelled','cancelling','done','failed'), `process.status`, `batch.processed_files` ?? `current_file`, `batch.total_files` ?? `total_files`, `batch.failed_files`, `batch.avg_sec_per_file`, `batch.eta_sec`. Graph: `process['@rid']` + process fields, `set['@rid']` + set fields (merged through UPDATE_FIELDS) |
| `process_finished` | events.js:73 → batchStore.js:83-94 **and** useDeskGraph.js:117-120 | same as `batch_completed` for batchStore; graph same as `process_update` |
| `add` | useDeskGraph.js:109-111 → addFromEvent :92-105, graphModel.js:129-157 | `set` (if truthy → ignored: file uploaded into a set), `node` (`'@rid'` \|\| `rid` \|\| `id`, `'@type'` → lowercased type, `'@type'==='SetProcess'`, any other node fields spread into data), `type` (node component; `'process'` sets status running/waiting), `image`, `input` (edge source rid), `output` (`'@rid'`, `type` \|\| `'@type'` ('search' → search-set), `image`, other fields), `process` (`'@rid'` + update fields) |
| `add_and_finish` | useDeskGraph.js:110 | identical to `add` |
| `update` | useDeskGraph.js:113-114 → updateNode :79-90 | `target` (node rid), `node` object; only whitelisted fields merged (graphModel.js:89-104): `image, thumb, thumbnail_version, status, label, description, info, file_count, count, roi_count, duration, metadata, paths, edited`. If any of `thumbnail_version/thumb/image/paths` present → thumbnail refresh (`thumbnail_version` defaults to `Date.now()`) and open SetBrowser refresh (GraphCanvas.vue:26) |

Any other command is only re-dispatched as `md-sse` and ignored.

---

## Suspicious / unclear

**Odd paths / methods**
- `/events` lives outside `/api` (events.js:13). If `VITE_API_PATH` is undefined the URL becomes `"undefined/events"` (no `|| ''` fallback there, unlike every other URL builder).
- GET with side effects: `GET /api/queue/{topic}/flush` (client.js:189, live) and `GET /api/queue/drain/{rid}` (client.js:699, dead).
- `POST /api/graph/vertices/{rid}` is used to *update* attributes (`{key,value}`), while projects use `PUT /api/projects/{rid}` with the same `{key,value}` body.
- `useDeskGraph.js:71` saves drag positions with `setProjectAttribute(node.id, {key:'position'})` → `PUT /api/projects/{node rid}` for **every** node type (files, sets, processes), not projects. Errors are swallowed (`.catch(() => {})`), so if the backend rejects non-project rids this silently does nothing. Positions are also never read back (layout is always dagre; `getLayoutByTarget` is a stub).
- `folderPreviewUrl` (fileUrls.js:19-22) requests `/api/thumbnails/{dir}` with no filename, while `results.js:42-48` requests `/api/thumbnails/{dir}/thumbnail.jpg` and `previewUrl` requests `/api/thumbnails/{path}`: three conventions for the same thumbnail route.
- `taggedFileToResult` (results.js:94-96) uses `item.thumb` without the `VITE_API_PATH` prefix (breaks if API is not same-origin), while graph `data.image` and zip `download_url` get the prefix.
- `getServiceHelpAsset` fetches assets with `responseType:'text'` and runs them through the HTML help parser (HelpPage.vue:39/52) — only works if "assets" are HTML pages.
- Help HTML references `/api/help/styles/help.css` (seen in tests) which helpContent intentionally drops.
- `ProjectWorkspace.vue:24` downloads the full project list to get one desk's label instead of using `GET /api/projects/{rid}`.
- vite proxy rules for `/images` and `/icons` have no corresponding usage in `src/` (likely leftovers).
- Hardcoded Shibboleth logout `/Shibboleth.sso/Logout` (AppHeader.vue:91) ignores `VITE_PUBLIC_PATH`; App.vue:18 redirects with relative `'login'`.

**Dead calls** (defined/re-exported, never called): `getError`, `rawQuery`, `getGraph`, `getMyGraph`, `getSchemaAndData`, `createNode`, `setRelationAttribute`, `getStats`, `createROIs`, `getSchemas`, `getQueries`, `getGroups`, `getFiles`, `importFile`, `getProcessParams`, `getInitData`, `getQueue`, `getQueueStatus`, `cancelProcess`, `saveLayout`, `getLayoutByTarget` (stub), `getEntitiesByType`, `getMachineTagFiles`, `getMachineTagMentions`, `getNerLabelFiles`, `getNerRegions`. Unused options: `getSetFiles` `groupByOrigin`/`sourceRid`; `createSetThumbnails` `limit`; `uploadFile(s)` `noThumbnails`/`deleteOriginal`/`chunkSize`/`concurrency` (defaults used). Note `wiki/api-layer.md` still documents several of these as live and misses others (e.g. `/api/tags/ner/*`, `/api/me/settings`, `/api/nomad/*`, service groups).

**Duplicates**
- `web.getActiveJobs` defined twice (client.js:184 and :729) — second silently overrides.
- `cancelJob` (client.js:194) and `cancelBatch` (client.js:723) hit the same `POST /api/batches/{rid}/cancel`; `cancelJob` uses `encodeURIComponent(rid)` without stripping `#`, so a `#12:3` rid becomes `%2312%3A3` (vs `12:3` everywhere else). `getQueue`/`getQueueStatus` also duplicate each other (both dead).

**Headers**
- No custom auth/user headers (no `mail` header, no tokens) anywhere in the UI; auth is cookie/SSO-proxy based. The only explicit header is `Content-Type: multipart/form-data` on the service-group logo upload (client.js:326); other uploads let axios set it.

**Response-shape workarounds**
- Batch status: `ProcessDetailsDialog.vue:14` reads `batch.status || batch.state`.
- Process/batch progress: `batch.processed_files ?? event.current_file`, `batch.total_files ?? event.total_files`, `total_time_sec || batch.total_time_sec` (batchStore.js:55-56, 87).
- Job identity: SSE key = `set_process || process['@rid']`; hydrate key = `job.set_process || job.rid` but the stored object is the raw job, and JobsPanel actions use `job.rid` — a hydrated job lacking `rid` would call `/api/batches/undefined/...`.
- `queue` name parsing: `job.service_id || job.queue.replace(/_batch$/,'')` (serviceStatus.js:46).
- Services registry is an object keyed by id (not an array); `toServiceList` uses `service.id || key`.
- Project records: size/count/expiry each tried under 5-6 field names; size >1 MiB assumed bytes (home/desks.js:25-54). Project label `label || name`.
- Graph nodes: `label || name`, `type` vs `_type` vs `@type`; `type:'search'` + `_type:'set'` → search-set; add-event node id `'@rid' || rid || id`; output type `type || '@type'`.
- Entities on a file: `entities` or `tags`; entity id `rid` or `'@rid'` (FileTagsTool.vue:15) but unlink uses `entity.rid` only (:44).
- `/api/tags` returns `{result:[{rid,…}]}` while `/api/entities` items use `'@rid'` and are bare arrays.
- ROI payloads: GET accepted as array, `{rois:{…}}`, or bare map; ROI-file rid from `@rid|rid|roi_rid`; POST result read from `result.data['@rid'] || result['@rid']`; SetBrowser's `hasRegions` ignores keys `@rid/rid/roi_rid`.
- File content from `GET /api/files/{rid}` may arrive as string or parsed JSON; consumers handle both.
- Line-segment JSON: `source_path || image_path || source.path`, `source_rid || source['@rid']` (lineSegments.js:22-23).
- Search and `/api/entities/items`: **any** error with a project filter triggers a retry without it and a "filter ignored" banner — this masks real server errors.
- `createUser` (client.js:285-293) catches errors and returns `error.response.data`, but the interceptor already replaced the error with `{status,message}` (no `.response`), so it *returns* that object instead of throwing → AdminPage.vue:101 treats a failed user creation as success and then deletes the permission request (:102).
- 302 handling relies on axios seeing a 302, but browsers follow redirects transparently in XHR, so this branch probably only fires with opaque cross-origin redirects (unclear).
- `saveImageROIs`, `createFileProcess` etc. return the full axios response while most methods return `.data` (inconsistent).

**Hardcoded ids / ports / URLs / N+1**
- Service ids hardcoded in UI logic: `md-pypdf_fs` (UploadController.vue:32, PDF upload gate), `md-dspace7` + task `make_query` (CruncherPicker.vue:110), filter `mdf-set-filter` (CruncherPicker.vue:91), `thumbnailer` hidden (crunchers.js:43), category `system` hidden.
- Ports/hosts: only in vite.config.js (`localhost:8200`, dev port 3000); `InstallServiceDialog.vue:141` placeholder `http://localhost:9012`; example URLs `nextcloud.jyu.fi`, `demo.dspace.org` in CreateSourceDialog.vue:17,22 (placeholders only).
- Env knobs: `VITE_API_PATH`, `VITE_PUBLIC_PATH`, `VITE_SET_ZIP_WAIT_MS`, `VITE_SET_ZIP_POLL_MS`, `VITE_FALLBACK_LOCALE`.
- N+1: SetBrowser.vue:52 calls `GET /api/images/{file}/sets/{roiSet}/rois` once per file on each page (cached per session in a Map). Services page polls `/api/services` + `/api/queue/jobs/active` every 5 s.
- `getDocInfo` and `createFileProcess`/`createROIProcess` leave `console.log` calls in (client.js:583-584, 659, 666).
- `getServicesForFile` appends `?filter=` unencoded; `importFile` builds query unencoded (dead).
