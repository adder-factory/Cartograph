# Architecture rules

[Documentation home](README.md) · [Project overview](../README.md) ·
[V2 architecture](v2/ARCHITECTURE.md) · [Decision records](decisions/README.md)

The current implementation architecture is maintained in
[Cartograph v2 architecture](v2/ARCHITECTURE.md). This file records the standing
repository rules for contributors.

- Rust owns every executable product path. Do not introduce a Bun, Node,
  TypeScript, Python, or shell runtime dependency.
- PostgreSQL 18 with ParadeDB `pg_search` and pgvector is the only storage
  contract. Do not add SQLite, built-in PostgreSQL FTS fallback, or a degraded
  pgvector-off mode.
- The browser visual-graph viewer is the only allowed v1 capability removal.
  Graph traversal, paths, impact, similarity, import/export, language and
  framework coverage, LLM tiers, configuration, install, and agent workflows
  remain parity gates.
- Preserve crate ownership. Transport code does not issue SQL; database code
  does not read arbitrary project files; extraction does not know PostgreSQL;
  optional LLM clients do not own structural truth.
- Validate every filesystem, Git, HTTP, database, CLI, MCP, and config boundary.
  Expected failures use typed/redacted outcomes and stable public codes.
- Keep work bounded: bytes, rows, recursion, tasks, workers, deadlines,
  cancellation, subprocess output, and serialized responses.
- Parallel work must reduce deterministically. Supported worker counts must
  produce identical logical facts, digests, and ordered retrieval evidence.
- A visible generation is immutable and atomic. Derived BM25/vector state is
  validated before publication and never substitutes for canonical rows.
- Credentials, source literals, SQL text, and absolute project paths do not
  enter public errors, debug output, archives, or persisted telemetry.
- Add focused regression tests for every corrected failure mode, then run the
  complete workspace and live database gates appropriate to the change.

Durable tradeoff records live under `docs/decisions/`. Update a decision and
the current v2 architecture together when its posture changes.
