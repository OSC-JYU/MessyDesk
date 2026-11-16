# MessyDesk TODO plan

Done tickets excluded: #1, #3, #4, #5, #7, #8, #9, #11, #12, #22.
Code done, waiting for live verification: #10 (files), #14, #23, #24, #26, #28, #16, #17, #18a, #19, #30 (see notes on each ticket).
Ticket numbers follow the original list (there are two #18s: 18a = bug, 18b = feature).

## Bug fixes

### High priority

**#1 PDF added to sets (high)** THIS IS FIXED!



**#14 EXIF rotation on upload (high)** Zip-extracted images now rotated too (needs verifying with a real zip; mirrored orientations 2/4/5/7 not handled).  CHECK this! This works at least individual images.
- Apply EXIF orientation when an image is uploaded, including images extracted from a zip.
- Plan: add one normalisation step in the shared image ingest path (upload and zip extract both). It should rotate pixels according to the EXIF orientation and reset the orientation tag, so the thumbnail, preview and later processing all agree. Likely use MD-sharp or the sharp library directly. Keep the original file untouched if needed. Test with orientations 1-8, including zip extraction.

### Medium priority

**#18a Hide process button does not work (medium)** Fix in MessyDesk-UI useDeskGraph.js (needs browser verification).
- Should shortcut file/set nodes directly to each other without showing process nodes.
- Plan: reproduce in the UI graph view. Check the hide-process toggle state and the graph query/transform (MessyDesk-UI plus the API graph endpoint). Collapse file -> process -> file chains into direct edges, and expand them again when toggled off. Cover sets and multi-output processes.

### Normal / unspecified priority

**#8 MD-sharp extract is not offered for polygon data** I think that this is fixed!
- Users cannot extract images from ROIs.
- Plan: check the MD-sharp `service.json` accepted types and the UI task-offering logic. Add the polygon JSON type, and make sure the extract service handles polygons (use the bounding box or mask per polygon) in the consumer. Verify end to end with HTR segmentation output.

**#16 MD-text-base_fs clever text join is not clever** Fix done: new grouping mode `text_source` (grouping.ts, join_text in service.json), unit-tested; needs live check.
- It should walk up the lineage to the first non-split PDF or first text file (txt, md, html) and build the combined text from that.
- Plan: define a lineage-walk function, either in the API (provide the root source per file) or in the service. Resolve each set member to its source, de-duplicate, and keep the order. Document the rules in the service help. Test with sets containing split PDFs, OCR output and plain text.

**#17 Text thumbnails not shown after batch processing until refresh** Fix done (needs browser check): set events now carry `text_samples`, and the open set view refreshes.
- Plan: find how the UI refreshes after a process completes (websocket/event). Make sure the completion event for each output triggers a thumbnail/snippet reload. Probably the text snippet fetch happens before the content exists, or the event handler ignores batch outputs. Fix the event, or refetch on completion.

**#19 No feedback when adding text to an open set** Fix done (needs browser check): same mechanism as #17. Still no success/error notice.
- Text snippets are not shown, and there is no sign that the upload worked.
- Plan: after the add-text request completes, update the open set view (append the new node and show its snippet). Add success/error notices. Likely shares the root cause with #17.

**#30 PDF splitting applied to a set shows no progress bar** Fix done (needs live check): progress events sent at batch start and per finished file for batches up to 50 files.
- Plan: check what the backend sends while a split runs on a set (set process events with `file_count`/`file_total`, and the split-finish handling in results.ts), and how the UI set node renders progress for other set processes. Likely the split path does not emit set-level progress events or total counts. Emit them per split PDF and update the set process node in the UI. Verify with a set of several PDFs.

### Needs a decision

**#2 Solr search with a different option on the same set**
- Plan: decide whether to prevent it or allow it. Recommended: allow it, but make the new run replace the previous index for that set, with the options stored on the process. Alternatively, warn in the UI and block a second Solr process on the same set. Either way, define the behaviour and the index key. Then implement the check in the API where the process is created.

## Features

### Tags and metadata

**#10 Index file and node user descriptions** Fix done for files (needs live check): editing a description updates the search index; files without text get a description-only document (`process: description`). Set and process node descriptions are not indexed yet (the search UI cannot open them).
- Plan: add the description fields to the Solr/search document model, and reindex when a description changes. Include them in the search UI as searchable fields.

**#21 Tag filter for service-created tags (e.g. language)**
- Plan: make the tag filter use one unified tag list (the same as the tag manager view) with no human/machine distinction. Backend: ensure service tags are stored in the per-Desk tag model and returned by the tag list endpoint. UI: the filter picker uses that list.

**#24 Tag filter on a set of reference nodes** Fix done (needs live check): tags are not copied; the filter and the set's tag list follow the `ref` links to the real files (new files/references.ts).
- Plan: do not copy tags. Make the filter traverse reference nodes to the actual files and match tags there, then return the set's references that match. Update the query (graph traversal one hop through the reference edge), add tests for sets of references, and keep the result as a new set.

**#26 System tag "has ROI"** Fix done for image ROIs (needs live check): RoisService sets/removes the system tag on save, update and delete of a region set. Not handled: deleting a region-set node through the general node delete leaves the tag; text ROIs wait for #13.
- Plan: add a tag type `System`. When ROIs are added to an image or text, the API creates or links the tag "has ROI" on the parent file, and removes it when the last ROI is deleted. Hide or lock system tags against manual edit/delete in the tag manager.

**#28 System tag "edited"** Fix done (needs live check): `TagsService.setSystemTag` (type System, a machine tag of service "system"); set on quick-edit save, removed on revert. #26 can reuse it.
- Plan: when a quick-edit result is saved, the API adds the System tag "edited" to the new file. Reuse the system-tag mechanism from #26 (do #26 first).

**#23 Notes** Fix done (needs live check): task `create_note` in MD-text-base_fs (re-register the service); notes are marked `note`, and saving one sets/removes the system tag "Has note" on the parent file. Notes have their own display (NoteDisplay.vue): edited directly, autosave after 1.5 s, on next/previous and on leaving, a Saved indicator and a Save button; saved in place (no "edited" tag, no original copy). A side-by-side view comes with #25.
- Plan: add a "Notes" set type. Creating it makes an empty markdown file per file in the set, linked to its parent. The editor saves the text. On save, if the text is non-empty, add the "Has note" System tag to the parent file, and remove it when the text is empty. Reuse #26/#28 system-tag logic.

### Text and ROIs

**#13 Text ROIs (qualitative coding)**
- Plan, in phases:
  1. Data model: text ROI as offsets (start/end) on a text file, stored like the image ROIs. Support taggable ROIs, with a tag link per ROI.
  2. UI: select text in the text viewer to create a ROI, and show highlights with tags.
  3. API: CRUD for text ROIs and ROI tag links, and system tag "has ROI" (#26).
  4. Machine generation: let services (NER, e.g. MD-Gliner2) output ROI + tag links in a defined JSON format, and import it into the data model.
  Needs a design note first, since it is the largest ticket.

### Graph / UI

**#15 Pop out from set**
- Plan: add a "pop out" action that marks a set member as detached in the UI. It is drawn as a single file linked to the set, with its own processing, and set-processing ignores the detachment (the file is still treated as a member). Store as a flag on the membership edge, and add a "put back" action. Check that the graph layout handles it.

**#18b Hide process could render the cruncher node attached to the file/set**
- Plan: when processes are hidden, show the service/cruncher as a small badge or node attached to the output file/set. Builds on the #18a fix.

**#20 Cruncher card shows used parameters**
- Plan: save the actual parameters on the process node when it runs (including the prompt text as used, not a library reference). In the card, show a short, readable parameter list; keep the details view as the debug view.

**#6 File lineage shows Desk name at bottom**
- Plan: include the Desk (project) name in the lineage API response, and render it at the bottom of the lineage view. Mainly useful in the non-Desk (all files) view.

**#25 Side-by-side file view along lineage**
- Plan: build a full-screen view with 2+ panes selected from the file's lineage (e.g. image and OCR text). Minimal controls, with pane selection, synchronised navigation for multi-page files, and note editing (needs #23). Start with a two-pane layout.

### Sources / imports

**#27 DSpace import (DSpace 7 source node)**
- Plan:
  1. Source node type "DSpace": define the source (base URL, credentials).
  2. Query node(s) under the source, using the DSpace 7 REST discovery/search API. Results are saved as JSON files.
  3. Reuse the Bitstream loader cruncher for bundle selection, and add an abstract-extraction option.
  4. Metadata design note: decide how to carry the item metadata into processing (e.g. store as file metadata/tags, or pass to downstream services).

**#29 Nextcloud import (source node)**
- Plan: use the same source node framework as DSpace (#27). Support WebDAV with URL and credentials/app password, folder browse and select, and import files into a Desk or set. Do it after #27 so the source abstraction is shared.

## Suggested order
1. #1, #14 (high priority bugs)
2. #18a, #17, #19, #8, #16
3. #2 decision
4. System tag groundwork: #26, #28, #23, #21, #24, #10
5. #20, #6, #15, #18b
6. #25, #13, #27, #29
