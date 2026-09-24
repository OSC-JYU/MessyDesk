# Proposal: PDF Auto-Import via Split-on-Upload

**Status**: Draft  
**Date**: 2026-08-17  
**Service**: md-pypdf_fs (task: split)

## Motivation

Large PDF files cause memory issues in downstream services. Services expect single-page files. By splitting PDFs automatically on import, we normalize all PDF processing to single-page units and prevent memory-related failures.

## Core Principle

Every PDF must be split into single-page PDFs before downstream processing. Splitting is automatic on import. The original file is deleted after splitting (by default).

---

## 1. Gating: Splitter Must Be Active

| Layer | Behavior |
|-------|----------|
| **UI** | `Uploader.vue` checks `md-pypdf_fs` consumers > 0 from services store. If unavailable: disable PDF in accepted types or show disabled state with tooltip. |
| **Backend** | Upload handler returns **503 Service Unavailable** if `md-pypdf_fs` has no active adapter (heartbeat within ~60s). |

Adapter liveness is determined by the existing heartbeat mechanism (adapter registration every 30s).

---

## 2. Upload Flow (Single PDF to Project)

```
1. User uploads PDF
2. Upload handler:
   a. Detects type = 'pdf'
   b. Checks md-pypdf_fs adapter active → 503 if not
   c. Creates File node (no processable flag — node is transient)
   d. Saves PDF to disk
   e. Returns file node immediately (HTTP response)
   f. Sends SSE: { command: 'add', node }
   g. Calls afterFileCreated(node, { delete_original: true })
3. afterFileCreated:
   a. Creates Process node (role: 'import', status: 'running')
   b. Publishes split job to md-pypdf_fs queue
   c. Sends SSE update: node status = 'importing'
4. UI shows node with "Importing…" label
```

---

## 3. Split Completion (processFilesController)

```
1. Split results arrive (all pages, in order)
2. Creates output Set:
   - Single file upload: label = "{original_filename} — PDF pages"
   - Batch of PDFs: label = "PDF pages"
3. Creates page File nodes in Set:
   - metadata.page_number = N
   - metadata.source_filename = original filename
   - No processable flag (these ARE processable by all services)
4. Queues md-poppler thumbnail for page 1 only
   - Thumbnail job waits in SQLite queue if md-poppler unavailable
5. On batch complete:
   a. Applies page 1 thumbnail to: Set, original File node, page 1 node
   b. If delete_original: deletes PDF file from disk
   c. Sets _file_removed: true on original File node
   d. Marks Process node status = 'completed'
   e. SSE updates clear "Importing…" state
```

Thumbnails are created ONLY for the cover page (page 1). Pages 2–N get no thumbnails. Users can browse them as PDF files.

---

## 4. Failure Path

```
1. Split fails → Process node status = 'error' with error message
2. Original file kept on disk (not deleted)
3. UI shows error state on original node
4. "Retry import" button re-queues the split job
```

The queue's existing retry/max_attempts logic handles transient failures.

---

## 5. `processable: false` Semantics

| PDF origin | Flag | Services offered |
|------------|------|-----------------|
| Split page (from md-pypdf_fs) | *not set* | All matching services |
| Uploaded PDF (auto-split pending/done) | *not set* (transient, will be `_file_removed`) | N/A |
| ZIP-extracted PDF (splitter was down) | `processable: false` | Only md-pypdf_fs split |
| Service-produced PDF (non-splitter, non-zip) | `processable: false` | Only md-pypdf_fs split |

Rules:
- `processable === false` → `services.getServicesForNode()` returns only `md-pypdf_fs` split task
- Absence of `processable` field = processable (services that don't set it still work)
- ZIP service ignores the flag entirely
- User CAN manually trigger split on `processable: false` PDFs
- `processFilesController` sets the flag on PDF outputs from non-splitter/non-zip services

---

## 6. Guard: Importing Lock

- File node with `_status: 'importing'` rejects manual processing requests
- Backend returns error: "File is being imported"
- Prevents race conditions during the brief window before split completes

---

## 7. Graph Model

```
File (original, _file_removed: true, thumbnail: cover)
  → Process (role: 'import', status: 'completed')
    → Set (label: "{filename} — PDF pages", thumbnail: cover)
      → File page_001 (metadata.page_number: 1, thumbnail: cover)
      → File page_002 (metadata.page_number: 2, no thumbnail)
      → File page_003 (metadata.page_number: 3, no thumbnail)
      …
```

The Process node provides the link between original and output Set (no direct edge needed).

---

## 8. UI Behavior

| State | Display |
|-------|---------|
| Importing | Node with "Importing…" animated indicator (ProcessingNode, role: 'import') |
| Error | Red alert with error message + "Retry import" button |
| `_file_removed: true` | Greyed node, cover thumbnail visible, "Source PDF — file removed after import", download disabled, link to output Set |
| `processable: false` PDF | CruncherList shows only "Split PDF to pages" |

---

## 9. Upload Dialog

- Checkbox: `☑ Remove source PDF after import` (default: checked)
- Only visible when PDF files are selected
- Maps to query param `?delete_original=true|false`

---

## 10. Three Entry Points — Unified via `afterFileCreated`

| Entry | Call site | Notes |
|-------|-----------|-------|
| Single file upload | `files.mjs` upload handler | Gated by 503 |
| Upload to Set | `files.mjs` upload handler (same endpoint, set param) | Gated by 503 |
| ZIP extraction | `processFilesController` after materializing PDF output | If splitter down: store with `processable: false` |

All three call `afterFileCreated(node, options)` which:
1. Checks `node.type === 'pdf'`
2. Checks `services.hasActiveConsumer('md-pypdf_fs')`
3. If both true → creates Process node, publishes split job, sets status
4. If splitter unavailable (ZIP case) → sets `processable: false`, no auto-split

---

## 11. Multiple PDFs Uploaded Simultaneously

Each PDF → independent split job → independent Set → independent Process node.
5 PDFs uploaded at once = 5 Sets, 5 Process nodes, 5 split jobs.

---

## 12. Process Node Fields

```javascript
{
  role: 'import',        // distinguishes from user-triggered 'process'
  status: 'running',     // running | completed | error
  service: 'md-pypdf_fs',
  task: 'split',
  error: null            // error message on failure
}
```

UI uses `role: 'import'` to show "Importing…" instead of "Crunching…".

---

## Deferred

- **Mixed file types uploaded to existing Set** — see [mixed-set-pdf-upload](mixed-set-pdf-upload.md)
- **Streaming split for memory efficiency** — see [streaming-pdf-split](streaming-pdf-split.md)
