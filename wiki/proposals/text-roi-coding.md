# Proposal: Text ROIs and coding (qualitative research)

**Status**: Proposal  
**Date**: 2026-11-16  
**Depends on**: [tags](tags.md) (desk-specific tags, tag admin), #26 system tags  
**Affects**: MessyDesk (backend), MessyDesk-UI, a future analysis service  
**TODO plan**: #13

## Goal

Give researchers a simple but effective way to **mark and code text**: select a passage to make a region, and
optionally give it one or more tags. Tagged passages are highlighted in the colour of their tag. Later,
analyse the coding with a separate service.

**Tagging is optional.** A region is useful on its own: the user may only mark passages (to quote, to return
to, to hand to a service, or to tag later). A region with no tags is a plain ROI; a region with tags is a
coded ROI.

The workflow is the same as for image ROIs: the user adds a ROI cruncher to a text or a set of texts, and
works in the resulting ROI set.

Non-goals for the first version: coding of images or audio, collaborative real-time editing, a full QDA
suite (memos, code hierarchies, case variables). They can come later and the model should not block them.

## What exists today

| Piece | Where | What we reuse |
|---|---|---|
| Image ROIs | `modules/rois/rois.ts`, UI `features/files/roi/` | One `roi.json` File node per (file, ROI set), derived from the file. Upsert on save. `has ROI` system tag. |
| ROI set | Desk node, `roiSourceNode()` in `nodeKinds.js` | A set node that opens the editor for the source file of the set. |
| Region tag link | `TagLink.region_id` (`TagsService.link`, `LinkMeta.region_id`) | A tag can already be linked to one region of a file. The image ROI label picker (`RoiLabelPicker.vue`) uses it. |
| Text spans | `ner.json`, written by MD-Gliner2 (`entities_to_regions`) | `{ rois: { id: { id, type: "text", start, end, text, label, confidence } } }`. Browsed by `NerService` (Faceted ROI-data), with no TagLink rows. |
| Tags | `TagsService`, `TagPicker.vue`, tag admin | Create, rename, usage, import to desk, delete. Entity types have a colour, individual tags do not. |
| Mention preview | `MentionPreview.vue` | Shows a span in context. |

So the new parts are: the text region format with offsets, a text coding editor, colours for tags, and merge.

## Data model

### Region format

Text regions use the same shape as `ner.json` regions, so machine and human regions can be shown and
processed by the same code:

```json
{
  "rois": {
    "r_8f3a": { "id": "r_8f3a", "type": "text", "start": 120, "end": 168, "text": "…the quoted passage…" }
  },
  "text_hash": "sha256 of the text the offsets refer to"
}
```

- Stored as a `roi.json` File node (type `roi.json`, as for images), one per (text, ROI set), derived from the
  text. Same upsert API behaviour.
- **Offsets are Unicode code points** (`start` inclusive, `end` exclusive), the same as Python services
  produce (Gliner). The browser works with UTF-16, so the UI converts with one helper. This must be written
  down in the format doc and tested with emoji and combining characters.
- `text` is stored with each region as a snippet. It makes exports readable and lets us re-anchor a region if
  the text changes.
- `text_hash` detects that a text was edited after coding (quick edit exists). A stale region set is shown
  with a warning and the regions are re-anchored by snippet where possible, otherwise marked "lost".
- Regions may overlap and nest. No limit on regions per text.

### Tags on regions

Use the existing `TagLink` with `target_rid` = the text file and `region_id` = the region id. A region can
have **zero, one or several** tags: a region exists without any link, so the region file is the source of
truth for which regions exist, and tag links only add to it (a region is never created or deleted as a side
effect of tagging, except that deleting a region removes its links). This keeps tags in one system: tag
admin, usage counts, desk import and search work as they do now, and file-level tags (`region_id IS NULL`)
are not touched.

Removing the last tag of a region leaves the region. Untagged regions count in the `has ROI` system tag, but
not in tag usage counts.

Needed changes:

- Make `TagLink` rows record the ROI set (`roi_set`), so two coders working on the same text in different ROI
  sets do not mix their codes (required, see Several coders). Region ids are only unique inside a ROI set.
- Counting and listing functions that now assume `region_id IS NULL` (file-level tags) must be checked, so
  region links do not show up as file tags by accident (`tags.ts` lines using `region_id IS NULL`).
- `created_by` stays `user` for human coding and `machine` for imported spans, with `confidence`.

### Tag colours

Tags need a colour so that highlights are easy to tell apart.

- Add a `color` attribute to the tag entity (today only entity types have one).
- A new tag gets the next colour from a fixed palette of distinct, accessible colours, chosen so that
  neighbouring tags in the palette are easy to separate. The user can change it in the tag admin and in the
  picker.
- The colour belongs to the tag, so it is the same in every desk that imports the tag.
- Text colour on the highlight is picked for contrast. Highlights use a background tint plus an underline in
  the full colour, so that overlapping regions can still be read. Colour must not be the only cue: the tag
  name is shown on hover and in the side list.
- Existing tags without a colour get one derived from a hash of the label until the admin sets one.

### ROI set and cruncher

- A **text ROI** cruncher (like the image ROI one) can be added to a text or to a set of texts. It creates an
  ROI set node. The set is the unit of coding: one coding pass, one coder, one codebook round.
- Opening the ROI set opens the first text in coding mode, and the user steps through the set (next/previous,
  and "next text without regions", or "next text with untagged regions").
- Several ROI sets on the same texts are allowed. This is what makes comparing coders or rounds possible
  later.
- A text that has regions gets the `has ROI` system tag (#26, extend `RoisService.syncRoiTag` to text).

### Machine regions

A `ner.json` run can be turned into a coding set: "Import as coding" creates an ROI set with the spans of the
run as regions and a tag per label (created in the desk if missing, `created_by: machine`, with confidence).
The user then accepts, removes or retags them. This connects #13 to MD-Gliner2 and any later service that
writes the same region format. Services keep writing `ner.json`; core never needs model-specific formats.

## API

New routes, parallel to the image ones. Image routes stay as they are.

| Method | Path | Notes |
|---|---|---|
| GET | `/api/texts/{rid}/sets/{set}/rois` | Regions with their tags and a `stale` flag. |
| POST | `/api/texts/{rid}/sets/{set}/rois` | Upsert regions; checks offsets against the text length. |
| PUT / DELETE | `/api/texts/{rid}/sets/{set}/rois/{roi}` | Update or remove one region file. |
| POST / DELETE | `/api/texts/{rid}/sets/{set}/regions/{region}/tags/{tag}` | Link or unlink a tag. |
| GET | `/api/sets/{set}/coding` | Per-text coverage: counts of regions, tagged regions and untagged regions, for navigation and progress. |
| GET | `/api/projects/{rid}/coding/export` | Coded segments of a desk (or one ROI set) as JSON or CSV, see Analysis. |
| POST | `/api/tags/{rid}/merge` | Merge tags, see below. |
| POST | `/api/tags/import-spans` | Turn a `ner.json` run into a coding set. |

Writes check ownership like image ROIs (`AccessService.findOwned`). Deleting a text, ROI set or region removes
its region links (`removeLinksOf` already exists for nodes; regions need the same). Document in
`wiki/api-surface.md` when implemented.

## UI

### Coding mode

- In the text viewer, selecting text in a ROI set creates a region right away (it is saved, shown as an
  untagged highlight). A small floating picker next to the selection offers tagging, but it can be ignored or
  dismissed: nothing forces a tag. The picker shows the recently used tags first, a search box, and "create
  tag". Enter or a click applies the tag to the region.
- Keys 1-9 apply the first nine tags of the codebook of the set to the selection, so coding does not need the
  mouse. A key for "mark without tag" is not needed, since selecting already marks.
- Highlights are drawn in the tag colour. A region with several tags shows stacked underlines. An untagged
  region uses a neutral highlight (grey or a dashed underline), so it is easy to tell from tagged ones and to
  find again. Clicking a highlight opens the region: add or change tags, delete, adjust the boundaries.
- A side list shows the regions of the text in reading order, with the tag chips (or "no tags"), and a legend
  with counts per tag and for untagged regions. It can be filtered to untagged regions. Clicking an item
  scrolls to the region.
- Long texts: rendering must handle thousands of regions. Use non-overlapping segments computed from the
  region boundaries and render by chunk, not one element per region.
- The same viewer, read-only, shows the highlights outside coding mode (viewing a text that has regions), with
  a toggle to hide them.

### Browsing

See the open question below. At minimum: a "Coded segments" tab in the tags view that lists passages of a tag
with context (`MentionPreview`), and a count of coded passages on text cards.

## Merging tags

Merging is needed in coding, because tags are made on the fly and a codebook is cleaned up afterwards.

- Admin action: choose two or more tags, choose the target (an existing one or a new name), confirm.
- Effect: all `TagLink` rows of the source tags (file-level and region-level) move to the target. A file or
  region that already has the target keeps one link. The source tags are removed from the desk. Search tags are
  reindexed (`reindexFileTags`) for the affected files.
- It is a risky operation (see [tags](tags.md): delete and rename warn). The dialog shows how many files and
  regions are affected, and the result is not undoable in the first version. A later option is to keep an audit
  record of the merge (source ids, target id, link ids) so it can be reverted.
- Only tags of the same desk, or tags shared by all the desks involved. Merging a shared tag changes every desk
  that uses it, so the dialog lists those desks.
- Machine tags can be merged into human tags; the target decides `created_by` of the result per link (links keep
  their own `created_by`).

## Several coders (taggers)

Qualitative projects usually have more than one coder. The idea: the desk owner creates **one ROI set per
coder**, and each coder can open only their own set and code in it. The ROI set is already the unit that keeps
codes apart (see `roi_set` on the tag links), so it is also the unit of access. The coders' work can then be
compared (inter-coder agreement) by the analysis service.

This depends on **multi-user desks**, which do not exist yet and need their own plan (a TODO ticket; this
section only states what coding needs from it).

### What exists

Access is owner-only and decided in one place, `AccessService.findOwned`: a node is the user's when walking
its outgoing `DERIVED_FROM` / `BELONGS_TO` edges reaches a Project that `HAS_OWNER` the user. There is no
sharing, no roles and no per-node grant. Every module calls this service, and 404 (not 403) is returned for
other users' nodes.

### What coding needs from multi-user

1. **Desk members with a role.** A new edge from the Project to a User, next to `HAS_OWNER`, for example
   `HAS_MEMBER` with a `role`. Roles needed for coding:
   - `owner`: everything, as now. Creates ROI sets, assigns coders, sees all sets.
   - `coder`: restricted to the ROI sets assigned to them (below). Cannot see other coders' sets, run
     crunchers, upload, delete or change the desk.
   - Later: `viewer` (read-only on the whole desk) and `editor` (full access without ownership).
2. **Assignment of an ROI set to a coder.** A grant on the ROI set node, for example an `ASSIGNED_TO` edge
   from the ROI set to the User. A coder can read and write the regions and region tags of that set only.
3. **A coder's reach is small and explicit.** From the grant the coder may read: the ROI set, the texts the set
   covers (read-only, the text content itself), the tags of the desk (to pick from), and write: regions and
   region tag links in that set. Nothing else on the desk is visible. In particular the coder does not see
   the other ROI sets of the same texts, the lineage of the texts, other files, search, or the Desk graph. This
   keeps independent coding independent.
4. **Tags.** A coder may use the desk's tags. Whether a coder may create new tags is a setting of the ROI set:
   *closed codebook* (only the owner's tags, the default for agreement studies) or *open* (the coder can add
   tags, which are marked as created by that coder and can be merged or removed by the owner afterwards).
5. **Identity on the data.** Every region and every region tag link records the user who made it
   (`tagged_by`, which exists on `TagLink`, and `created_by` on the region). In the owner's views a coder's work
   is shown by coder name or colour of the set, never mixed with other sets.
6. **Owner tools.** Create an ROI set for each coder in one step ("Create coding sets for ..."), with the
   same texts, optionally a random sample or a share of the texts per coder, and an overlap (the same texts
   to two coders) for agreement checks. The owner sees progress per coder (texts coded of total, from
   `GET /api/sets/{set}/coding`), can lock a set when the coder is done (read-only), and can copy one coder's
   set as the base of an adjudicated "final" set.

### Access model change (sketch)

`findOwned` stays for owners. Add a second check, used by the coding routes and the file content routes the
coder needs, which resolves a user's **grants**: the ROI sets assigned to them and, through the set, the
texts they may read. The reachability walk must not be extended to give coders the whole desk. The cleanest
way is a separate `canCode(user, roiSet)` and `canReadForCoding(user, text, roiSet)` that require the grant,
and keep all the existing routes owner-only. Routes the coder needs:

- list my coding sets and open one (a coder's home page, instead of the Desk graph),
- the text content of a text in my set,
- the tags of the desk (read), and tag creation in an open set,
- the region and region-tag routes above, checked against the set.

Everything else answers 404 for a coder, as for strangers today.

### Sharing desks (out of scope here)

Inviting users (by account, since login is through the existing auth), accepting an invite, removing a
member, and what a member who is not a coder may do (the `viewer`/`editor` roles) belong to the multi-user
plan. Coding only fixes the requirements above so that the two plans fit: roles on the Project, a grant on a
single node, and the user recorded on data.

### Consequences for other parts of this plan

- `roi_set` on `TagLink` is **required**, not optional, for text coding.
- Tag usage counts, the tag view and the export (see Analysis) take an optional `roi_set` / `coder` filter,
  so the owner sees one coder or all of them, and a coder only ever gets their own set.
- Solr: region tags of different sets must not be merged in one field in a way that leaks a coder's tags to
  another coder. Coders get no search at all in the first version.
- Deleting a coder from the desk keeps their work (the set stays, owned by the desk); only the grant is
  removed.

## Open questions

### Do we need a separate view for coding, or can we use the existing tagging interface?

Recommendation: **a coding mode inside the file viewer**, not a separate page, and not only the existing
tagging interface. File tagging is about whole files and a list of chips; coding is about selecting inside the
text and needs the text to be the main thing on the screen with a minimal toolbar. The image ROI editor is
already a mode of the viewer (`fileBrowse` store, ROI set being edited), so text coding follows the same
pattern: open the ROI set, the viewer switches to coding mode. The tag picker, creation and colour dialogs are
reused from `features/tags/`. A separate page would duplicate the viewer and the set navigation.

What can be a separate page later is the **codebook** (all tags of the desk with colour, description,
count and merge), which is the tag admin with a few additions.

### Should we be able to merge tags?

Recommendation: **yes**, as described above, built on the tag admin. It is also useful for machine tags (many
NER labels that mean the same thing). Open sub-question: do we also need splitting a tag by moving some
regions to a new tag? Not in the first version; it can be done by retagging in the coded segments list.

### Do we need changes to browsing texts with tags?

Yes, small ones:

- **Granularity.** Today a tag filter returns files. For coding the interesting result is the passage. The tag
  view needs a segments mode: list of passages for a tag (with some context, file name and position), click to
  open the text scrolled to the region. `NerService` already does this for machine spans; the same list code is
  reused for coded regions.
- **Filters.** The tag filter should say "file has tag" versus "has a coded passage with tag". Both can be
  used in filters and sets (a filter may then produce a set of the texts or the passages).
- **Solr.** Files with coded regions should have the region tags in the index, in a separate field from file
  tags, so search can combine text search and codes. Check the size: a text with thousands of regions must not
  make one huge document.
- **Untagged regions.** They have no tag to browse by, so the tag view cannot list them. They are reached
  through the ROI set (side list, "next text with untagged regions") and are included in the export.
- **Cards.** Text cards show the number of coded passages and a few tag colour dots.

### What kind of analysis could we offer, and what is needed?

Analysis is a **separate service** (a MessyDesk cruncher), applied to texts with ROIs (tagged or not), like any other
service. What it needs from core is a stable, documented input:

- **Export format** (JSON, one object per coded segment): `file`, `file_label`, `set`, `coder`, `start`, `end`,
  `text`, `tags` (id, label; an empty list for an untagged region), `created_by`, `confidence`, and the parent document metadata (for example the
  original PDF and page). A CSV variant of the same. This is also the hand-over format for tools outside
  MessyDesk. REFI-QDA (the exchange format of NVivo, ATLAS.ti and MAXQDA) is worth checking as an export target.
- **Input to the cruncher**: a set of texts plus an ROI set, or the whole desk, resolved by core to the export
  above. The service never reads the graph itself.

Analyses that fit this and are useful in qualitative research:

1. Code frequencies per tag, per text and per group of texts (for example per original PDF or per set).
2. Co-occurrence and overlap of codes (in the same text, in the same paragraph, on the same passage).
3. Code-by-document matrix, as a table that can be downloaded.
4. Retrieval of all passages of a code or of a combination, with context, as a document (for writing).
5. Inter-coder agreement between two ROI sets on the same texts (percent agreement, Cohen's kappa, and
   Krippendorff's alpha on character or segment level). This is the reason to keep ROI sets separate per coder.
6. LLM-assisted steps, as separate crunchers that write a new ROI set: suggest codes for uncoded text, or
   summarise all passages of a code. These need the user's own API key rules already in place.

Output of an analysis is a normal file (CSV, JSON, markdown, chart image) in a new set, so it needs no
special UI in the first version.

Decision needed: which of these 1-6 are the first ones. Suggested first: 1, 3 and 4 (cheap and immediately
useful), then 5.

## Phases

1. **Format and storage.** Text region format and offset rules, `text.roi` upsert/read/delete, text ROI
   cruncher and ROI set node, `has ROI` for texts, offset tests (emoji, CRLF, combining characters), stale
   detection. No UI beyond a read-only highlight.
2. **Tags on regions.** `TagLink` with `region_id` and `roi_set` for texts, tag `color` with palette and admin
   editing, checks of the queries that assume `region_id IS NULL`, API for region tags.
3. **Coding UI.** Selection, floating picker, highlights, side list, legend, key shortcuts, set navigation.
4. **Browsing.** Coded segments in the tag view, filter semantics, cards, Solr fields.
5. **Merge.** Tag merge in the tag admin, with the warnings above.
6. **Machine import.** `ner.json` to coding set.
7. **Multi-user desks** (own plan, prerequisite for coders): roles on the Project, grants on a node, the
   coder's restricted routes and home page. Then: owner tools to create a coding set per coder, progress, lock.
8. **Export and analysis.** Export endpoint and format doc, then the first analysis service (new repository
   `MD-coding-analysis`, following the service conversion guide).

Phases 1-3 are the useful minimum for one coder; 4 and 5 make it usable for real projects, and 7 makes it
usable for a team.

## Risks

- **Offsets and encodings.** The largest source of bugs. One definition (code points), one helper on each
  side, tested.
- **Edited texts.** Offsets break silently without `text_hash`. Do not allow a text with regions to be edited
  without a warning.
- **Query assumptions.** Many tag queries treat `region_id IS NULL` as "file tag". Region links change counts
  and listings if this is missed. Cover with tests before the UI uses it.
- **Performance.** Thousands of regions in one text, and tags with thousands of regions in one desk. Segment
  rendering, paged segment lists, and bounded Solr documents.
- **Shared tags and colours.** A colour change on a shared tag changes it in other desks. Accept it (one tag,
  one colour) and say so in the admin.
- **Access leaks.** Giving a coder access through the existing reachability walk would expose the whole desk.
  Grants must be explicit per ROI set, with tests that a coder gets 404 for everything else, including other
  coders' sets, and that their set cannot be reached through the lineage or the tag views.

## Tests

- Unit: offset conversion, region validation against text length, stale detection, palette assignment, merge
  link rewriting (dedupe, file-level and region-level), untagged regions (created, kept when the last tag is
  removed, counted in `has ROI` but not in tag usage).
- Contract: text ROI CRUD, region tags, delete cascades, `has ROI` system tag, ownership checks, and for
  coders: access only to the assigned set, 404 elsewhere, closed vs open codebook, locked set is read-only.
- UI: highlight segmentation with overlaps and nesting, picker flow, keyboard shortcuts, read-only mode.
