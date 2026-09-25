# Proposal: Mixed File Types Uploaded to Existing Set

**Status**: Draft  
**Date**: 2026-08-17  
**Depends on**: [pdf-auto-import](pdf-auto-import.md)

## Problem

When a user adds files to an existing Set (or extracts a ZIP containing mixed types), the Set may receive both PDFs and non-PDF files (images, text, etc.). The PDF auto-import proposal defines that PDFs must be split, but the behavior when mixing PDFs with other files in a Set upload is unspecified.

## Open Questions

1. **Where do split pages go?**
   - Into the target Set directly (alongside other files)?
   - Into a sub-Set within the target Set (nested)?
   - Into a separate new Set (independent of the target)?

2. **Set label implications** — if split pages join the target Set, the Set already has a user-defined label. No label override should happen.

3. **Original PDF node placement** — the original (with `_file_removed: true`) belongs to the target Set or stays at project level?

4. **Ordering** — if split pages join the target Set, how do they interleave with existing files? Appended at the end?

5. **Progress feedback** — does the Set show a combined "importing" state, or is it per-file?

## Constraints

- Must not break the core auto-import flow defined in [pdf-auto-import](pdf-auto-import.md).
- Must handle the case where splitter becomes unavailable mid-batch.
- The `afterFileCreated` function is already the single entry point — the decision is about Set membership of outputs.

## Notes

This proposal was deferred from the PDF auto-import design session to avoid coupling the core split-on-upload mechanism with Set membership semantics.
