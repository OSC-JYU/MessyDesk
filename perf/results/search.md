# S8: search index size and search speed (2026-10-05)

Scenario S8 of [plan/performance-testing.md](../../plan/performance-testing.md): Solr 9.7 as in
`docker-compose.yml` (default 512 MB heap, schema from `tools/solr-init-v2.sh`), filled with
OCR-like pages of generated text (`perf/s8-search.ts`: dictionary words with a Zipf distribution,
2 500 characters per page, 20 desks), and searched exactly as the backend does
(`SolrClient.search`: edismax over `fulltext_exact`, the n-gram `fulltext`, label and description,
with highlighting). Same laptop as before. Raw results: `s8-search.run2.json`, `s8-light.json`.

**Update:** Ari decided the three questions (highlighting, a lighter index, md-solr commits); see
"Decisions and follow-up" at the end. The size numbers below were re-measured after fixing the text
generator, whose first version used only ~3 000 different words.

## Index size

| Text | Pages | Index on disk | Index ÷ text | Per page |
|---|---|---|---|---|
| 11 MB | 4 500 | 85 MB | 7.9× | 19 KB |
| 201 MB | 84 000 | 1.52 GB | 7.6× | 19 KB |
| 1 000 MB | 419 000 | 7.1 GB | 7.1× | 17.7 KB |

The index is about **7 times the text**, mostly because `fulltext` is indexed as every 2–15
character n-gram (for substring search) and the text is stored twice (`fulltext` and its copy
`fulltext_exact`). Extrapolated at 17.7 KB per page:

| Amount | Text | Index |
|---|---|---|
| A 100 000-page desk | ~250 MB | **~1.8 GB** |
| 10 million pages (the database target) | ~25 GB | **~175 GB** |

Solr's memory stayed at 1.2 GB with the 1 GB-of-text index; disk is the limit at 10 million pages.

## Search speed

Median (p95) of 20 searches (common and rare words, prefixes, phrases), each twice:

| Text in index | All desks | One desk | 10 searches at once |
|---|---|---|---|
| 11 MB | 64 ms (244) | 6 ms (209) | 93 ms (423) |
| 201 MB | 156 ms (249) | 47 ms (241) | 290 ms (429) |
| 1 000 MB | 127 ms (262) | 115 ms (244) | 225 ms (444) |

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

md-solr posts each page with `commit=true`: **67–70 ms per page** at 1 GB, about 14
pages a second per consumer. A 100 000-page desk takes about 2 hours to index with one consumer;
10 million pages would take about 8 days. Bulk loading without per-page commits ran at 640 pages a
second.

## Decisions and follow-up

Ari: (1) highlight whole words first; (2) not at the cost of finding OCR misspellings, but two
indexing options, today's and a much lighter one, could be offered; (3) change md-solr.

**1. Highlighting (done, backend).** Whole-word snippets first; only hits without one (matched by a
word fragment) are highlighted on the n-gram field, in a second request for just those hits. The
backend's search with 500 hits on the 1 GB index: p50 316 → 157 ms, p95 636 → 455 ms, response
1.35 → 1.1 MB, and every hit still has a snippet.

**3. md-solr commits (done, MD-consumers branch `solr-commit-within`).** Pages and tag changes are
posted with `commitWithin=1000` (env `SOLR_COMMIT_WITHIN_MS`) instead of `commit=true`: 74 → 1.6 ms
per page on the 1 GB index, so a 100 000-page desk indexes in minutes instead of two hours. Search
sees a page up to a second later.

**2. Light index and OCR misspellings (measured, not built).** The same 200 MB of pages, with 3 % of
words misread the way OCR misreads them (m↔rn, l→1, e→c, o→0…), indexed both ways: "full" is
today's documents, "light" puts the text only in the whole-word field. 40 words, searched as the
backend searches:

| Way of searching | Index | Pages with the word found | Pages with only a misread form found | Other pages per search | p50 / p95 |
|---|---|---|---|---|---|
| Full index (today) | 1 446 MB | 100 % | **0.6 %** | 118 | 24 / 150 ms |
| Full index, fuzzy `word~1` | 1 446 MB | 99.9 % | 85.6 % | 1 889 | 173 / 629 ms |
| Light index | **188 MB** | 100 % | 0 % | 0 | 19 / 115 ms |
| Light index, fuzzy `word~1` | 188 MB | 100 % | **88.8 %** | 284 | 132 / 624 ms |
| Light index, fuzzy `word~2` | 188 MB | 100 % | 94.4 % | 1 203 | 2 990 / 6 472 ms |

What this shows:

- **Today's n-gram index does not find misspellings.** It finds word fragments (`tion`, `abandon`
  inside `abandoned`), but a whole word only matches pages where OCR got it right: 0.6 % of the
  misread-only pages. The query side is not split into n-grams, so `governments` never matches a
  page that says `govemments`.
- **Fuzzy search finds them**, on either index: 86–89 % of misread-only pages with `~1` (one edit),
  94 % with `~2` but far too slow (3–6 s). Fuzzy works best on the light index (fewer unrelated hits).
- **The light index is 7.7 times smaller** (188 MB vs 1 446 MB for 200 MB of text; at 10 million
  pages ~23 GB instead of ~175 GB). What it loses is fragment search inside words.

My recommendation:

1. Add **"include OCR misspellings"** to search (fuzzy `~1` on whole words), as an option in the
   search box. It needs no re-index and works on today's index; it is slower (~130–170 ms median, up
   to ~600 ms), so it should be a choice, not the default.
2. Offer **two index options** in md-solr's index task: **full** (today: fragment search, ~7× the
   text) and **light** (whole words only, ~1× the text). Both get fuzzy search for OCR errors. The
   search query already covers both fields, so both kinds of documents are found by the same search.
   Light could be the default for very large desks.

## Built (decision G6)

- **Search option "include OCR misspellings"** (`fuzzy: true` in `POST /api/search`, a checkbox on the
  UI's search page). The normal search runs as before, OR'ed with fuzzy terms on the whole-word
  field: each word of 4+ letters as `word~1` plus its common two-edit OCR confusions (m↔rn, d↔cl,
  w↔vv, h↔li), which `~1` cannot reach. Word-fragment matches and their snippets are kept.
- **md-solr index option** `index_mode`: `full` (default, today's) or `light` (whole words only).
  Re-indexing a desk keeps each run's mode.

Same 200 MB with 3 % OCR errors, the backend's own search (`SolrClient.search`), 1 000 hits:

| Index | Search | Misread-only pages found | Other pages per search | p50 / p95 |
|---|---|---|---|---|
| Full (1 400 MB) | normal | 0.6 % | 118 | 50 / 652 ms |
| Full | + OCR misspellings | 86.9 % | 369 | 157 / 675 ms |
| Light (190 MB) | normal | 0 % | 0 | 23 / 136 ms |
| Light | + OCR misspellings | **95.6 %** | 284 | 131 / 593 ms |

The OCR confusions raised the light index from 88.8 % (plain `~1`) to 95.6 %. On the full index
more unrelated pages match through word fragments, and with 1 000 hits some misread pages rank below
the cut.
