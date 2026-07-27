# Native CLI reference

The installed executable is `cartograph`. Run `cartograph <command> --help` for
the exact bounds and confirmation phrases in the installed version.

## Coding commands

```text
cartograph index [PROJECT]
cartograph status [PROJECT]
cartograph find <QUERY> --by auto|name|path|reference|bm25|hybrid
cartograph context <TASK> [--exact-name NAME] [--exact-path PATH]
cartograph entry-points [--bucket routes|cli|cli-commands|mcp-tools|cli-files|public-exports]
  [--limit 20]
cartograph graph <SYMBOL_ID> --direction callers|callees|both|impact
cartograph graph <SYMBOL_ID> --direction path --to <TARGET_SYMBOL_ID>
  [--edge-kind calls|imports|references|implements|extends|tests|type-of|returns|instantiates|overrides|decorates|field-access|def-use|exports|contains]
cartograph graph <SYMBOL_ID> --direction similar
  [--k 5] [--min-score 0.3] [--same-language] [--model-id <UUID>]
cartograph affected <SYMBOL_ID>
cartograph show <SYMBOL_ID>
cartograph review --ref <GIT_REF>
cartograph doctor [PROJECT]
cartograph admin scip-export [--out index.scip] [--maximum-rows 5000000]
cartograph admin scip-import [--in index.scip] [--maximum-rows 10000000]
  [--maximum-source-bytes 268435456] [--workers 16]
```

Retrieval inputs and result counts are bounded. `context` selects a deterministic
typed task intent and can use exact anchors, ParadeDB BM25, a ready matching
semantic model, graph expansion, affected tests, and a separate stale
working-tree overlay. JSON is the stable automation format; text favors concise
operator output.

`scip-export` requires a fresh generation and writes atomically inside the
project. It emits standard SCIP plus a forward-compatible Cartograph extension
for every exact edge kind and represented site count. `scip-import` validates a
bounded project-local artifact, installs it at
`.cartograph/scip/overlay.scip`, and forces a new generation. Covered files use
SCIP facts; uncovered files retain native extraction. A failed publication
restores the prior overlay when the importer still owns the installed bytes.
The overlay digest participates in freshness, so changing it cannot leave an
apparently current generation.

`entry-points` reads typed structural facts rather than asking BM25 to infer an
API boundary. It returns stable pages for routes, CLI commands, exported MCP
tool definitions, conventional CLI source, and exported declarations with no
in-tree calls/references/type-use. Every page includes its exact pre-limit total
and truncation flag. V2 includes exported constants, types, enums, traits,
modules, components, and resources in the public surface in addition to v1's
function/class categories.

## MCP and agent configuration

```text
cartograph serve --mcp [--managed-database-port PORT] [--profile coding|core|full|read-only|review]
cartograph install --yes --target codex|claude|cursor --location local [--managed-database-port PORT]
cartograph uninstall --yes --target codex|claude|cursor --location local
```

Install/uninstall modifies only project-local agent configuration, preserves
unrelated entries, and pins the absolute native executable. For a non-default
managed port, the installer also pins the non-secret loopback port in the
portable server arguments. Restart the host after a configuration or binary
change.

## Database lifecycle

```text
cartograph db start
cartograph db stop
cartograph db status
cartograph db logs
cartograph db backup <OUTPUT>
cartograph db restore <ARCHIVE>
cartograph db upgrade
cartograph db derived-index
cartograph db remove
cartograph db import-v1
cartograph db prune
```

Managed lifecycle is supported on macOS/Linux with local Docker. Windows uses
external PostgreSQL. Restore, upgrade, derived-index rebuild, remove, v1 import,
and prune require explicit operation-specific confirmation. See
[PostgreSQL operations](STORAGE-BACKENDS.md).

## Database selection

External database settings are environment-only:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
```

The URL is secret and must not be committed or echoed. Without an external URL,
the project-local managed credential is resolved for a database started by
`cartograph db start`.

## Exit and error behavior

Invalid inputs, missing capabilities, stale/lost lease fences, unavailable
database/source/Git state, and operation failures return nonzero. Public errors
omit database URLs, query text, source literals, and absolute project paths.
Machine consumers should inspect JSON fields and stable MCP error codes rather
than parse human prose.
