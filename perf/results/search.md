# S8: search index size and search speed (2026-10-05)

Scenario S8 of [plan/performance-testing.md](../../plan/performance-testing.md): Solr 9.7 as in
`docker-compose.yml` (default 512 MB heap, schema from `tools/solr-init-v2.sh`), filled with
OCR-like pages of generated text (`perf/s8-search.ts`: dictionary words with a Zipf distribution,
2 500 characters per page, 20 desks), and searched exactly as the backend does
(`SolrClient.search`: edismax over `fulltext_exact`, the n-gram `fulltext`, label and description,
with highlighting). Same laptop as before. Raw results: `s8-search.run.json`.

## Index size

| Text | Pages | Index on disk | Index ÷ text | Per page |
|---|---|---|---|---|
| 11 MB | 4 500 | 74 MB | 6.9× | 17 KB |
| 50 MB | 21 000 | 345 MB | 6.9× | 17 KB |
| 201 MB | 84 000 | 1.26 GB | 6.3× | 16 KB |
| 1 000 MB | 419 000 | 6.3 GB | 6.3× | 16 KB |

The index is about **6.3 times the text**, mostly because `fulltext` is indexed as every 2–15
character n-gram (for substring search) and the text is stored twice (`fulltext` and its copy
`fulltext_exact`). Extrapolated at 16 KB per page:

| Amount | Text | Index |
|---|---|---|
| A 100 000-page desk | ~250 MB | **~1.6 GB** |
| 10 million pages (the database target) | ~25 GB | **~160 GB** |

Solr's memory stayed at 1.2 GB with the 1 GB-of-text index; disk is the limit at 10 million pages.

## Search speed

Median (p95) of 20 searches (common and rare words, prefixes, phrases), each twice:

| Text in index | All desks | One desk | 10 searches at once |
|---|---|---|---|
| 11 MB | 142 ms (273) | 8 ms (255) | 182 ms (463) |
| 201 MB | 160 ms (305) | 123 ms (297) | 280 ms (442) |
| 1 000 MB | 163 ms (330) | 160 ms (307) | 267 ms (528) |

Search time hardly grows with the index: it is spent **highlighting**. On the 1 GB index:

| Variant | p50 | p95 | Response |
|---|---|---|---|
| Backend default, 250 hits | 157 ms | 329 ms | 688 KB |
| As the UI's search page asks, 500 hits | 306 ms | 621 ms | 1.4 MB |
| 500 hits, highlighting only `fulltext_exact` | 68 ms | 246 ms | 591 KB |
| 500 hits, unified highlighter | 318 ms | 621 ms | 1.4 MB |
| 500 hits, no highlighting | 19 ms | 53 ms | 86 KB |
| 50 hits | 33 ms | 60 ms | 138 KB |

Highlighting the n-gram field costs most of it. The UI shows the `fulltext_exact` snippet first and
falls back to `fulltext`; the `fulltext` highlight is only needed for substring and prefix matches
(`tion`, `abandon*`), which have no whole-word snippet.

## Indexing speed

md-solr posts each page with `commit=true`: **70 ms per page** (p95 112 ms) at 1 GB, about 14
pages a second per consumer. A 100 000-page desk takes about 2 hours to index with one consumer;
10 million pages would take about 8 days. Bulk loading without per-page commits ran at 640 pages a
second.

## For Ari

1. **Highlight only `fulltext_exact`** (and fall back to `fulltext` only when that is empty)? Search
   on the UI's search page would go from ~300 ms to ~70 ms and half the response size; substring and
   prefix hits would show no snippet unless the fallback is done.
2. **Index size**: storing the text once (not storing the n-gram copy) and a smaller n-gram range
   (e.g. 3–10) would shrink the index; both need a re-index. Worth measuring?
3. **md-solr commits per page**: committing every second or so (Solr `commitWithin`) instead of per
   page would make indexing many times faster. That is a change in MD-consumers, outside this rewrite.
