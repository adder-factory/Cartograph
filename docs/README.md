# Cartograph documentation

[Project overview](../README.md) · [Quick start](../README.md#quick-start) ·
[Language matrix](SUPPORT-MATRIX.md) · [Troubleshooting](TROUBLESHOOTING.md)

Use this page to find the shortest path to an answer. The root
[README](../README.md) explains the product and first successful setup; the
guides below own the detailed operational and implementation contracts.

## Find the right guide

| I want to… | Start here |
| --- | --- |
| Install Cartograph myself | [Quick start](../README.md#quick-start) |
| Ask a coding agent to install and verify it | [Agent-assisted installation](AGENT-INSTALL.md) |
| Look up a command or JSON behavior | [CLI reference](CLI-REFERENCE.md) |
| Connect or debug an MCP host | [MCP usage](MCP-USAGE.md) |
| Check language, extension, or framework support | [Language support matrix](SUPPORT-MATRIX.md) |
| Configure source policy, limits, retrieval, or models | [Configuration](CONFIGURATION.md) |
| Choose managed or external PostgreSQL | [Storage and operations](STORAGE-BACKENDS.md) |
| Diagnose Docker, database, indexing, semantic, or transport failures | [Troubleshooting](TROUBLESHOOTING.md) |
| Tune a large or memory-sensitive repository | [Performance tuning](PERF-TUNING.md) |
| Understand code-health findings | [Native code-health detectors](BIOMARKER-DETECTORS.md) |
| Add a language, grammar, resolver, or framework bridge | [Extending extraction and resolution](EXTENDING-EXTRACTORS-RESOLVERS.md) |
| Understand architecture and trust boundaries | [Cartograph v2 architecture](v2/ARCHITECTURE.md) |
| Inspect scaling and task-quality evidence | [Verification and benchmarks](v2/benchmarks/README.md) |

## Recommended reading paths

### First successful setup

1. Follow the [quick start](../README.md#quick-start).
2. Run `doctor`, publish the first index, and require fresh `status`.
3. Make one real deterministic or hybrid query.
4. Register the host through [MCP usage](MCP-USAGE.md), reopen it, and prove one
   live MCP status/query pair.

### Coding-agent integration

1. Copy the task from [Agent-assisted installation](AGENT-INSTALL.md).
2. Select the narrowest appropriate MCP profile in [MCP usage](MCP-USAGE.md#profiles).
3. Use the [CLI/MCP alignment](cli-mcp-alignment.md) when translating between
   operator commands and agent tools.
4. Follow the freshness → context → impact → review loop in the
   [agent workflow](../README.md#agent-workflow).

### Operations and large repositories

1. Choose database ownership in [Storage and operations](STORAGE-BACKENDS.md).
2. Review source admission and hard limits in [Configuration](CONFIGURATION.md).
3. Measure before changing workers or timeouts with
   [Performance tuning](PERF-TUNING.md).
4. Use [Troubleshooting](TROUBLESHOOTING.md) for typed failure states and safe
   recovery paths.

### Language and extractor development

1. Check the current product boundary in the [language support matrix](SUPPORT-MATRIX.md).
2. Review the measured [language-coverage report](LANGUAGE-COVERAGE-REPORT.md)
   and [grammar provenance](GRAMMAR-ASSETS.md).
3. Choose the smallest correct implementation mechanism in
   [Extending extraction and resolution](EXTENDING-EXTRACTORS-RESOLVERS.md).
4. Preserve the deterministic and privacy boundaries in the
   [native extraction contract](v2/EXTRACTION.md).

## Guide catalog

### Setup and daily use

- [Agent-assisted installation](AGENT-INSTALL.md) — end-to-end installation,
  upgrade, indexing, registration, and verification task.
- [CLI reference](CLI-REFERENCE.md) — complete top-level command inventory and
  stable automation behavior.
- [MCP usage](MCP-USAGE.md) — registration, profiles, protocol behavior, tool
  selection, transport proof, and reliable agent loops.
- [Configuration](CONFIGURATION.md) — project policy, database environment,
  optional model tiers, and bounded runtime settings.

### Languages and code intelligence

- [Language support matrix](SUPPORT-MATRIX.md) — languages, extensions,
  extractor depth, framework signals, and embedded DSLs.
- [Language-coverage report](LANGUAGE-COVERAGE-REPORT.md) — current validation
  and coverage evidence.
- [Grammar provenance](GRAMMAR-ASSETS.md) — pinned native grammar ownership and
  review boundary.
- [Game scripting coverage](v2/GAME-SCRIPTING-LANGUAGES.md) — researched and
  testable game/modding language boundary.
- [Adding a language](ADDING-A-LANGUAGE.md) — concise entry point for selecting
  an extension mechanism.
- [Extending extraction and resolution](EXTENDING-EXTRACTORS-RESOLVERS.md) —
  implementation checklist and required gates.
- [Code-health detectors](BIOMARKER-DETECTORS.md) — native finding contracts,
  evidence levels, privacy, and interpretation.

### Operations and reliability

- [Storage and operations](STORAGE-BACKENDS.md) — PostgreSQL ownership,
  capabilities, migration, backup, recovery, retention, and compaction.
- [Performance tuning](PERF-TUNING.md) — worker selection, storage strategy,
  measurement, and safe tuning boundaries.
- [Troubleshooting](TROUBLESHOOTING.md) — symptom-oriented diagnosis and
  bounded recovery.
- [Distribution and licensing](v2/LICENSING.md) — Cartograph/ParadeDB packaging
  and deployment boundary.

### Architecture and contribution

- [Cartograph v2 architecture](v2/ARCHITECTURE.md) — implemented crate,
  database, generation, retrieval, lease, MCP, and release architecture.
- [Native extraction contract](v2/EXTRACTION.md) — discovery, parsing, facts,
  resolution, publication, and test routing.
- [Standing architecture rules](ARCHITECTURE.md) — durable repository rules.
- [Architecture decision records](decisions/README.md) — decisions and their
  long-lived tradeoffs.
- [Graph export formats](GRAPH-EXPORT-FORMATS.md) — JSON, Cytoscape, DOT,
  Mermaid, and SCIP interchange.
- [CLI/MCP alignment](cli-mcp-alignment.md) — one-to-one and family mappings
  between public surfaces.

### Evidence and history

- [Verification and benchmarks](v2/benchmarks/README.md) — what each benchmark
  proves, its status, and how to reproduce it.
- [Versioned release notes](RELEASES.md) — implementation changes and upgrade
  boundaries for each stable release.
- [GitHub releases](https://github.com/adder-factory/cartograph/releases) —
  signed tags, native archives, checksums, and provenance.

## Documentation contract

- Installed command help is authoritative for exact flags, defaults, bounds,
  and confirmation phrases.
- Release-audited guides identify their version; historical benchmarks remain
  explicitly labeled and are not presented as current reruns.
- Destructive or replacement operations retain dry-run, backup, ownership, and
  exact-confirmation boundaries in both documentation and implementation.
- Database URLs, credentials, private paths, source literals, and internal
  recovery state do not belong in public examples or release artifacts.
- Documentation changes should pass the implementation-backed contract tests;
  every internal file and heading link must resolve before publication.
