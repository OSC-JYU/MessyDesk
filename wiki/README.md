# MessyDesk Engineering Wiki

This wiki documents the architecture, design decisions, invariants, and non-obvious behavior of the MessyDesk platform. It is maintained for LLM and developer consumption. **Source code is the truth** — when this wiki contradicts source code, trust the code and update the wiki.

## How to use this wiki

- Start with [System Overview](architecture/system-overview.md) for a high-level understanding.
- Read [Graph Data Model](architecture/graph-data-model.md) before making any data-layer changes.
- Read [Process Lifecycle](architecture/process-lifecycle.md) before modifying processing pipelines.
- Read [Invariants & Non-Obvious Behavior](invariants.md) before any non-trivial change.

## Pages

### Architecture
- [System Overview](architecture/system-overview.md) — Components, repositories, and how they connect
- [Graph Data Model](architecture/graph-data-model.md) — ArcadeDB schema, vertices, edges, access control
- [Process Lifecycle](architecture/process-lifecycle.md) — File processing pipeline from UI trigger to result materialization
- [Service Architecture](architecture/services/service_architecture.md) — Service contracts and adapter layer
- [Consumers](architecture/services/consumers.md) — Consumer options and queue backends
- [Queue System](architecture/queue-system.md) — NATS JetStream and SQLite queue details
- [Search](architecture/search.md) — Solr integration and indexing

### Reference
- [Glossary](glossary.md) — Domain terms
- [Environment Variables](environment-variables.md) — All configuration across all repositories
- [API Surface](api-surface.md) — Backend HTTP endpoints
- [Service Descriptor Format](service-descriptor-format.md) — How to define a new service
- [Invariants & Non-Obvious Behavior](invariants.md) — Things that break if you don't know about them

### Verification status

Every claim in this wiki is tagged:
- **[verified]** — Confirmed by reading source code or tests
- **[inferred]** — Derived from code patterns but not directly tested
- **[assumed]** — Based on naming/documentation conventions, not verified
