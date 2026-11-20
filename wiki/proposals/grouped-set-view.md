# Proposal: Grouped Set View (browse files by their original PDF)

**Status**: Implemented (2026-11-05)  
**Date**: 2026-11-05  
**Depends on**: [pdf-split-as-cruncher](pdf-split-as-cruncher.md)  
**Affects**: MessyDesk (backend), MessyDesk-UI

## Problem

Splitting PDFs gives sets of one-page files. A set made from 50 PDFs holds thousands of pages, and the same
happens for everything made from pages (texts from Poppler, page images). The set browser lists them as one flat,
label-ordered stream: `page_001.pdf` of every PDF side by side, with nothing that says which document a page
belongs to. The user wants to browse documents, not a pile of pages.

## Idea

Browsing only. Processing, lineage, tags and search do not change.

- Opening a set from the desk shows **one card per original PDF**. The card shows the first page of that PDF
  (the file with the lowest `page_number` in the group) and the number of pages.
- Clicking a card shows the files of that PDF. A breadcrumb shows where the user is: **Set › file.pdf**.
- This is the same for the pages (`pdf`), the texts, the rendered images and anything else made from the pages.
  A set of texts shows the first page's text as the cover of each PDF.
- It applies to the set browser opened from the desk only. Tag views, search results and the lineage panel
  stay flat.
- A user setting **Group PDF content** (default: on) controls it, and the set view has a toggle that overrides it
  for the set on screen.

## Decisions

| # | Decision |
|---|----------|
| 1 | Grouping is visual. No process, set or edge changes. A file keeps its place in the set, its lineage and its processing. |
| 2 | The group of a file is the **original PDF it comes from**. It is stored on the file (`origin_rid`, `origin_label`, see below), so the set browser does not walk the graph. |
| 3 | Default on (user setting `group_pdf`: `on` / `off`), plus a toggle in the set view. The toggle is per set view and is not saved. |
| 4 | A set that has only one group (for example one split PDF) shows its files directly: a cover that leads to every page adds a click for nothing. |
| 5 | A set that has both grouped files and other files (for example images from a ZIP next to pages) shows the group cards first, then the other files as normal cards. |
| 6 | Previous/next in the file viewer steps through the **whole set** in the grouped order, and the breadcrumb follows the shown file (it changes when the next file belongs to another PDF). |

## 1. Marking files with their original

Lineage already gives the original of a file (walk `DERIVED_FROM` up to the `original-pdf`), but doing that for
every file of a set on every page load is too slow. The original is therefore copied to the file when it is made,
the same way `page_number` and `root_source_rid` are.

New attributes of `File`:

| Attribute | Meaning |
|-----------|---------|
| `origin_rid` | rid of the `original-pdf` the file comes from |
| `origin_label` | label of that PDF, so a card has its title without another query (the node stays when the file is deleted, but the label is needed in the same query) |

Set in `NodesService.createProcessFile` and `createReferenceFile` from the input file of the job (`msg.file`):

1. Input type is `original-pdf` → `origin_rid` = the input, `origin_label` = its label (the split pages).
2. Otherwise the input has `origin_rid` → copied (texts and images of pages, and any later step).
3. Otherwise none. Files from a many-to-one run have no origin, unless the run was grouped per original
   (`root_source_rid` of the message): then the output gets that root as its origin
   (`file1.pdf.txt` belongs to `file1.pdf`).

`page_number` is copied the same way: `originOf` hands the page number of the input to everything made from a page, so
texts, images and embedded images keep their page without help from the adapters (the split and Poppler's text task also
report it themselves).

New index: `File.origin_rid` (NOTUNIQUE) in `src/platform/arcade/schema.ts`. Existing data is not filled in
(no backward compatibility): old sets show flat.

## 2. API

`GET /api/sets/{rid}/files` gets a `group` query param. Without it nothing changes.

| Request | Answer |
|---------|--------|
| `?group=origin&skip&limit` | One page of **entries**: the groups, then the files without an origin. A group entry is `{ kind: 'group', origin_rid, origin_label, count, cover: <the file with the lowest page_number, with thumbnail> }`. A file entry is the normal file. `entries_total` is the number of entries. |
| `?group=origin&origin={rid}&skip&limit` | The files of one group, ordered by `page_number`, then label. |

The answer says `grouped: false` (and lists the files flat, as without the param) when the set has no file with
an origin, or when all its files have the same origin (decision 4).

The group entries are made by one query per page request:

```sql
SELECT origin_rid, origin_label, count(*) AS count, min(page_number) AS first_page
FROM File WHERE set = :set AND origin_rid IS NOT NULL
GROUP BY origin_rid, origin_label ORDER BY origin_label SKIP :skip LIMIT :limit
```

plus one `ORDER BY page_number LIMIT 1` query per group on the page for the cover (10 groups per page, so 10
small indexed queries). The count query for the entry total is the same `GROUP BY` without paging.

**Order for stepping.** The viewer steps with `getSetFiles(set, skip, 1, { group: 'origin', order: 'flat' })`. The server uses one
order for the whole set, for every set-browsing context (grouped or not, so a position means the same in both): groups by `origin_label` (then `origin_rid`), pages by `page_number` inside a group, files
without an origin last. `?group=origin&order=flat` returns the files in that order, so `skip` is a position in the
whole set. The breadcrumb in the viewer is taken from `origin_rid` / `origin_label` of the shown file, and its path steps
(Set › file.pdf › file) go back to the set or the PDF (`?openSet=…&openOrigin=…`).

Cover thumbnails: the cover file is a normal file, so the thumbnail logic of the set view applies unchanged
(a PDF page without a thumbnail gets the PDF icon, a text file its text sample, an image its image).

## 3. User setting

`group_pdf` in `src/modules/users/settings.ts`: values `on`, `off`, default `on`. It is in `ALLOWED`, in
`DEFAULT_SETTINGS`, and in the Settings page (`SettingsPage.vue`) as a switch **Group PDF content**: "In a set made
from PDFs, show one card per PDF with its first page. Click it to see the pages."

## 4. UI

- `SetBrowser.vue`
  - Loads `getSetFiles(set, skip, limit, { group: 'origin', origin })` when grouping is on (setting on and the set
    view's toggle not switched off).
  - View state: `{ origin: null }` (top level) or `{ origin: {rid, label} }` (inside a PDF). The breadcrumb
    **Set name › file.pdf** replaces the title of `ResultsGrid`; clicking the set name goes back to the top level.
    The page number of the top level is kept when going back.
  - A group card is a `ResultCard` with the cover's thumbnail, the PDF's label, and a chip "N pages" / "N files".
    A click on a group card enters the group; a click on a file card opens it in the viewer as now.
  - A toggle button in the actions slot (**Group by PDF** / **Show all files**).
- `useOpenNode.js` / `GraphCanvas.vue`: the set browser remembers the position (`pageMemory`) per set and level.
- File viewer (`BrowseBar.vue`, `useFileViewer.js`, `browseQuery.js`): the set context carries `grouped`; stepping
  asks for the flat grouped order; the bar shows **Set › file.pdf** where it now shows the set chip; when stepping
  crosses to another PDF the breadcrumb changes with it. the steps of the path return to the set or the group that was open.
- Not changed: search results, the tag views (`ResultsGrid` from `features/search`), the lineage panel.

## 5. Not in this proposal

- Grouping inside the graph (a desk node per PDF). The desk keeps one set node.
- Several levels (for example page → embedded images). One level: the original PDF.
- A per-PDF page range or selection in the grouped view.
- Grouping of sets whose files come from other containers (ZIP). Only PDFs have an origin.

## 6. Implementation order

1. `origin_rid` / `origin_label` in `nodes.ts`, the schema index, tests (split pages get the original; a text from a page
   inherits it; a grouped many-to-one output gets its root).
2. `setFiles` group query and order (`files.ts`, `routes.ts`) with tests.
3. User setting (`settings.ts`, `SettingsPage.vue`).
4. `SetBrowser.vue` group level and breadcrumb; viewer stepping and breadcrumb.
5. Wiki: `api-surface.md` (the `group` params), `graph-data-model.md` (the new File attributes), `invariants.md`
   (grouping is visual only), UI wiki; user help (`docs/help/5.pdf-handling.md`, `8.sets.md`).

## 7. Risks

- **Stale origin**: an `origin_label` is a copy. Renaming the original PDF's label does not update its pages' cards
  until a rename also updates `origin_label` (one `UPDATE File SET origin_label WHERE origin_rid`). Do that in the rename
  path.
- **Large sets**: the `GROUP BY` runs on every page load of the top level. Fine for thousands of pages with the index;
  if sets of hundreds of thousands appear, keep a count on the original node.
- **Range splits**: the cover is the lowest page of the group, which may be page 7 when only 7-9 were split. The card
  says so ("pages 7-9" from `first_page` and `count` is not enough when pages are missing; show "3 pages").
- **Old data** has no origin and shows flat.
