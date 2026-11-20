# Changelog

## [0.2.0] - 2026-11-20

First public release of the rewritten MessyDesk backend (TypeScript). It keeps the HTTP API,
events, queue messages, database schema and data layout of the old backend, so MessyDesk-UI and
MD-consumers work with it unchanged.

### Added
- Sets: merging, previews, ZIP export; tags and tag filters with counts.
- Search: full-text search (Solr) with fuzzy and partial/whole-word matching and OCR misspelling
  tolerance; interactive semantic search over vector and similarity (md-gensim) indexes.
- LLM services (OpenAI-compatible and Gemini) with prompts, fixed tasks and token limits per
  service group.
- HPC processing on CSC Roihu (Slurm + Allas), e.g. NAFREC handwritten text recognition.
- Demo projects, user API keys, manual PDF splitting.
- Local Docker Compose setup with the UI and base services (no Nomad needed).
- Default services include Indra-OCR and UVDoc.

### Changed
- Runs on ArcadeDB 26.9.1 (legacy 23.7.1 still supported via `LEGACY_ARCADEDB`).
- Performance: faster lineage and access queries, new indexes, background deletes and batch
  publishing.
