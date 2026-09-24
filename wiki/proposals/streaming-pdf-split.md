# Proposal: Streaming PDF Split for Memory Efficiency

**Status**: Draft  
**Date**: 2026-08-17  
**Depends on**: [pdf-auto-import](pdf-auto-import.md)

## Problem

The current `md-pypdf_fs` split implementation loads the entire PDF into memory via `PdfReader`. For a 500MB PDF, this means 500MB+ resident memory. With the 1GB upload limit, the splitter could theoretically need over 1GB RAM per concurrent job.

## Current Implementation

```python
reader = PdfReader(input_file)      # ← loads entire PDF structure into memory
page_count = len(reader.pages)

for i, page in enumerate(reader.pages, start=1):
    writer = PdfWriter()
    writer.add_page(page)
    # write single page to disk
```

`pypdf`'s `PdfReader` maps the full cross-reference table and page tree into Python objects on construction.

## Potential Approaches

### A. Chunked Processing with Page Ranges

Process N pages at a time, reopening the reader for each chunk. Trades CPU (re-parsing) for bounded memory.

```python
CHUNK_SIZE = 50
for start in range(0, page_count, CHUNK_SIZE):
    reader = PdfReader(input_file)
    for i in range(start, min(start + CHUNK_SIZE, page_count)):
        # extract page i
    del reader  # free memory
```

### B. Alternative Library (pikepdf / qpdf)

`pikepdf` (C++ qpdf binding) uses lazy page loading and streams pages without holding the entire structure in memory. Would require swapping the PDF backend.

### C. External Tool (pdftk / qpdf CLI)

Shell out to `qpdf --split-pages` which handles memory internally in C++. Proven for very large files but adds a system dependency.

### D. Streaming Callback

Instead of collecting all page paths and returning them in one response, stream results page-by-page back to the backend as each page is written. Requires changes to the adapter protocol.

## Constraints

- Must not change the external contract (service descriptor, task params, response format) in a breaking way.
- Current approach works fine for typical PDFs (< 100MB). This is a scaling concern for edge cases.
- The 1GB upload limit already caps input size.

## Recommendation

Evaluate option **B** (pikepdf) first — it's a drop-in library swap with lazy loading semantics. If that's insufficient, option **C** (qpdf CLI) is the most battle-tested for very large files.

## Notes

This proposal was deferred from the PDF auto-import design session. The current implementation is adequate for the expected workload. Revisit if users report memory issues with large PDFs.
