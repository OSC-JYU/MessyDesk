# Proposal: PDF Split as a Normal Cruncher

**Status**: Implemented (2026-11-05). No backward compatibility was kept: existing PDF nodes are not migrated.  
**Date**: 2026-11-05  
**Supersedes**: `pdf-auto-import` (removed)  
**Affects**: MessyDesk (backend), MessyDesk-UI, MD-pypdf_fs, MD-poppler

## Motivation

Auto-splitting on upload (the "import" flow) makes upload depend on a running splitter (503 gate), needs
special states (`_status: importing`, `processable: false`, `role: 'import'`) and gives the user no control
over the split. Splitting becomes an ordinary, user-triggered cruncher task. Uploading a PDF only stores it.

## Decisions

| # | Decision |
|---|----------|
| 1 | Upload never splits and never needs the splitter. The 503 gate and the upload-dialog "remove source" checkbox are removed. |
| 2 | New file type **`original-pdf`** for an un-split PDF. Type `pdf` means "a page PDF made by the splitter". |
| 3 | `md-pypdf_fs` split is the only cruncher offered for `original-pdf` (by `supported_types`, not by a special rule). |
| 4 | Split task params: `pages` (range, default = all pages) and `delete_original` (default on). |
| 5 | Poppler works on `pdf` (split pages) only, and takes a page range that is matched against the pages' original page numbers. |
| 6 | `delete_original` always follows the toggle, also with a range. The UI warns when a range and delete are both set. |

## 1. File types: `original-pdf` vs `pdf`

Why a new type and not a flag: service matching is already driven by `supported_types`. With two types the
rules live in the descriptors, and `processable`, `_status: importing` and the matching special case in
`servicesForNode()` can all be deleted. A later service that needs the whole document (e.g. a PDF/A
converter, a form reader, a PDF text-layer OCR that wants the full file) declares `original-pdf` and gets the
file without any backend change.

| Type | Produced by | Offered services |
|------|-------------|------------------|
| `original-pdf` | upload, ZIP extraction, any service that outputs a PDF (type detection in `files/metadata.ts` returns it for every `.pdf` / `application/pdf`) | services that list `original-pdf` (today only `md-pypdf_fs`) |
| `pdf` | `md-pypdf_fs` split only | services that list `pdf` (Poppler, future page-level services) |

How `pdf` is assigned: type detection never returns `pdf`. When `ResultsService` materializes an output of
`md-pypdf_fs` / task `split` (the existing `isSplitPdfOutput` check) it sets `type: 'pdf'` on the new node.
The viewer, download and `Content-Disposition` treat `original-pdf` and `pdf` the same; only `pdf` pages get thumbnails
(a shared helper `isPdfType(type)` replaces the `type === 'pdf'` checks).

Descriptor changes:

```json
// MD-pypdf_fs/service.json
"supported_types": ["original-pdf"],
// MD-poppler/service.json (unchanged)
"supported_types": ["pdf"],
```

A single-page PDF is still `original-pdf` (the backend does not read the file to decide). Splitting it gives
one page.

### Existing data

Not migrated, by decision. Old `processable` / `_status` fields are no longer read; old PDFs stay `pdf`, so they must be uploaded or split again.

## 2. Upload and ZIP

- `FilesService.upload`: remove the `hasActiveConsumer(PDF_SPLITTER)` check and the `afterFileCreated` call; remove `?delete_original=`.
- `ZIP` output: PDFs are stored as `original-pdf`; no `afterFileCreated`, no `processable` flag.
- `ResultsService`: remove the "other service's PDF gets `processable: false`" branch.
- Delete `ImportPipeline.afterFileCreated` and the `role: 'import'` path. `ImportPipeline.complete` becomes the generic
  split-completion hook (see 4).
- Upload dialog (UI): remove the splitter-running warning and the checkbox. `UploadController.vue`, `client.js` (`deleteOriginal` options).
- An original PDF gets no thumbnail (Poppler cannot run on it, and it may be huge). The UI draws its own node (`OriginalPdfNode.vue`: PDF icon, "Original PDF", split is the only cruncher); sets show a PDF icon for it.

## 3. Split task (`md-pypdf_fs`)

```json
"tasks": {
  "split": {
    "name": "Split PDF to pages",
    "description": "Splits a PDF into one-page PDF files. All pages by default; give a range to split only some.",
    "output_set": "PDF pages",
    "behaviour": "one-to-many",
    "params_help": {
      "pages": { "name": "Pages", "default": "", "format": "page_range" },
      "delete_original": { "name": "Delete the original PDF after splitting", "default": true, "display": "checkbox", "warning": "Pages outside the range are lost for good.", "warning_if_set": "pages" }
    }
  }
}
```

- Range grammar: comma list of `N`, `N-M`, `N-` (to last page), `-M` (from first). 1-based, inclusive.
  Empty or blank = all. Pages beyond the last page are ignored; a range that matches no page fails the job with a clear error ("The PDF has N pages; range matches none").
- `api.py`: parse `task.params.pages` in one function (`parse_page_range(text, page_count)`), validate before reading pages,
  loop only over selected pages. File names keep original numbering (`page_003.pdf`), so `page_number` is the number in the parent PDF.
  `failed_pages` and `page_count` stay in the response; add `selected_pages`.
- The range text is also validated in the backend before queueing (same grammar, shared in `src/shared/page-range.ts`) so a typo gives 400 instead of a failed job.
- `delete_original` is a normal task param. `ResultsService.finishSplit` reads it from `message.task.params.delete_original` (default `true`)
  after the last page of an input PDF arrived, removes the file from disk and sets `_file_removed: true` on the original node. Failure keeps the original.

Every output file of the split carries `page_number` (`api.py` answers it; the elg adapter passes it on).

Flow: user picks the split task on an `original-pdf` node (or a Set of them) → normal `queueFile`/`queueSet` →
Process node with `role: 'process'` → output Set "PDF pages" with `pdf` nodes → completion hook deletes the original if asked.
No "Importing…" state; the normal "Crunching…" state shows. A Set of PDFs gives one output Set per PDF (as the existing one-to-many does).
The deleted-original rule and the failed-page report (`reportFailedPages`) keep working but are attached to the ordinary process node.

## 4. Poppler: page range

Poppler tasks run on one-page `pdf` nodes, so the range is a filter on which pages of a Set take part:

- New task param `pages` (same grammar as split; `format: "page_range"`, `filter: "set_pages"`) on `pdf2text`, `pdf2images`, `pdfimages`, `pdfinfo`.
  Empty = all pages of the Set.
- Applied in the backend (`processing.queueSet`), before batching: a page is kept when its `page_number` matches the range.
  Pages without `page_number` are kept only when the range is empty. If the Set holds pages of several PDFs the range is applied to each PDF
  (page numbers are per original PDF). If nothing remains → 400 "No page of the set is in the range".
- Batch totals (`group_size`, progress) are computed after filtering.
- The filter is generic in the processing layer: any param with `"filter": "set_pages"` is applied (also on resume);
  Poppler is the first user. The param is removed from the task sent to the cruncher (Poppler never sees it).
- The UI shows the range only when the task is run on a set (`filter: set_pages` params are hidden for a single page).
- Poppler never sees `original-pdf`: matching offers it only `pdf`. The old Poppler description "Imported PDFs are split into pages by PyPDF" becomes "Run on the pages of a split PDF".

## 5. Where it is implemented

| Area | File |
|------|------|
| Types, `isPdfType` | `src/shared/service-ids.ts`, `src/modules/files/metadata.ts` |
| Upload (no gate) | `src/modules/files/files.ts`, `routes.ts` |
| Type assignment, `finishSplit` | `src/modules/results/results.ts` |
| Matching (no special case) | `src/modules/services/matching.ts` |
| Range grammar, validation, set filter | `src/shared/page-range.ts`, `src/modules/processing/processing.ts` |
| Splitter range, `page_number` | `MD-pypdf_fs/api.py`, `service.json` |
| Poppler range param | `MD-poppler/service.json` |
| UI: upload, `original-pdf` nodes, param warning, hidden set range | `MessyDesk-UI` (`UploadController.vue`, `PdfNode.vue`, `ParamField.vue`, `CruncherTask.vue`) |
| User help | `docs/help/5.pdf-handling.md` |

Removed: `src/modules/import/` (`afterFileCreated`, `role: 'import'`), `processable`, `_status: importing`, the cover-thumbnail mirror from page 1 to the original.

## 6. Risks

- **Data loss**: range split with delete (decision 6). Mitigation is the UI warning only.
- **Root-source grouping** (`grouping.ts`) walks DERIVED_FROM to the topmost PDF; it accepts both `pdf` and `original-pdf` as the boundary.
- **Range on Sets from several PDFs** works per PDF, but a Set that mixes pages from different PDFs shows one range field; per-PDF ranges are not supported.
- **Re-splitting**: splitting an original again (original kept) creates a second output Set; no de-duplication.
- **Streaming split** (memory) is independent; see [streaming-pdf-split](streaming-pdf-split.md).
