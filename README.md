# Cartograph

Cartograph is a native code-intelligence server for AI coding agents. It turns a
checkout into a searchable, generation-safe code graph and exposes compact
evidence through a CLI and the Model Context Protocol (MCP).

Version 2 is a Rust and PostgreSQL architecture:

- Rust owns discovery, parsing, resolution, bounded parallel indexing,
  retrieval, CLI, and MCP.
- PostgreSQL 18 is the only storage backend.
- ParadeDB `pg_search` provides code-aware BM25 retrieval.
- pgvector is a required database capability for the model-scoped semantic
  retrieval path.
- Exact lookup, BM25, graph traversal, affected-test selection, review packets,
  and freshness checks work without an LLM.

Cartograph v2 has no SQLite runtime, compatibility mode, optional feature, or
fallback. A database that fails a hard capability check is rejected instead of
silently switching engines.

## Why coding agents use it

Raw text search is useful, but it does not explain how a declaration is reached,
what a change can affect, or which tests are structurally connected. Cartograph
packages that evidence with stable provenance:

- exact symbol, path, and reference lookup;
- code-aware BM25 over names, implementation identifiers, and documentation;
- callers, callees, imports, references, and reverse impact;
- affected-test selection;
- working-tree versus Git-ref review packets;
- generation ID, freshness, confidence, truncation, and explicit abstention;
- bounded MCP payloads with stable error codes, deadlines, and cancellation.

The result is designed to help an agent decide what to inspect and verify while
keeping the source checkout—not a model response—the source of truth.

## Requirements

- macOS, Linux, or Windows x64 for the Cartograph executable;
- PostgreSQL 18 with `pg_search` 0.23.5 and pgvector;
- Docker on macOS/Linux for the managed database experience, or a compatible
  external PostgreSQL deployment on any supported platform;
- Git for `cartograph review` and compare-to-ref evidence.

The managed database pulls the pinned upstream ParadeDB image. Cartograph does
not bundle or redistribute PostgreSQL, ParadeDB, pgvector, or a container image.

## Install

macOS and Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh
```

PowerShell:

```powershell
irm https://raw.githubusercontent.com/adder-factory/cartograph/main/install.ps1 | iex
```

The installers download the native archive for the host, verify it against the
release `SHA256SUMS`, and place `cartograph` on the user PATH.

Build from source:

```sh
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
cargo build --locked --release -p cartograph-cli
install -m 0755 target/release/cartograph "$HOME/.local/bin/cartograph"
```

The repository pins its Rust toolchain in `rust-toolchain.toml`.

## Quick start with the managed database

On macOS or Linux with a local Docker daemon:

```sh
cd /path/to/project
cartograph db start --project-path .
cartograph doctor .
cartograph index .
cartograph status .
```

`db start` creates only project-owned resources, binds PostgreSQL to loopback,
stores a private generated credential, applies append-only migrations, and
proves PostgreSQL, ParadeDB, pgvector, preload, BM25, and tokenizer capability.

The lifecycle is explicit:

```sh
cartograph db status --project-path .
cartograph db logs --project-path . --tail 200
cartograph db backup ./cartograph.backup --project-path .
cartograph db derived-index --project-path .
cartograph db stop --project-path .
```

Restore, upgrade, derived-index rebuild, and removal require the exact
confirmation phrase printed by command help. These operations are bound to the
canonical project identity and refuse foreign containers or volumes.

## Use an external database

Create `pg_search` and `vector` in a PostgreSQL 18 database, then export a URL:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph'

cartograph doctor /path/to/project
cartograph index /path/to/project
```

Optional bounded pool settings:

```sh
export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
```

Database URLs are treated as secrets and are redacted from errors and debug
output. Do not commit them to a project configuration file.

## Connect an AI coding agent

Cartograph writes only project-local MCP configuration and pins the absolute
native executable path:

```sh
# OpenAI Codex
cartograph install --yes --target codex --location local --project-path .

# Claude Code
cartograph install --yes --target claude --location local --project-path .

# Cursor
cartograph install --yes --target cursor --location local --project-path .
```

Restart the agent host after installation. The MCP process resolves the same
project-owned managed credential automatically, or inherits
`CARTOGRAPH_DATABASE_URL` for an external deployment.

Manual MCP server specification:

```json
{
  "command": "/absolute/path/to/cartograph",
  "args": [
    "serve",
    "--mcp",
    "--project-path",
    "/absolute/path/to/project"
  ]
}
```

The available MCP profiles are `core`, `read-only`, and `review`. Tool listings
are deterministic and hidden tools cannot be called through a narrower profile.

## Agent workflow

A reliable coding loop is:

```sh
cartograph status .
cartograph context 'fix authentication token validation' --project-path .
cartograph review --ref main --project-path .
cartograph affected <symbol-uuid> --project-path .
```

If status is stale, run `cartograph index .` or let the agent call the bounded
`cartograph_admin` index action. Re-indexing an unchanged checkout is a no-op;
changed source publishes a complete new generation atomically.

Core MCP tools:

| Tool | Purpose |
| --- | --- |
| `cartograph_status` | Current generation counts and live-source freshness |
| `cartograph_find` | Exact name/path/reference or BM25 evidence |
| `cartograph_context` | Compact task-specific evidence packet |
| `cartograph_graph` | Callers, callees, or reverse impact |
| `cartograph_affected` | Bounded affected-test selection |
| `cartograph_review` | Git-ref and dirty-worktree review packet |
| `cartograph_admin` | Explicit index/sync operation |

## CLI

```text
cartograph index [PROJECT]
cartograph status [PROJECT]
cartograph find <QUERY> --by name|path|reference|bm25
cartograph context <TASK> [--exact-name NAME] [--exact-path PATH]
cartograph graph <SYMBOL_ID> --direction callers|callees|impact
cartograph affected <SYMBOL_ID>
cartograph review --ref <GIT_REF>
cartograph serve --mcp [--profile core|read-only|review]
cartograph doctor [PROJECT]
cartograph db <COMMAND>
cartograph install --yes --target codex|claude|cursor
cartograph uninstall --yes --target codex|claude|cursor
```

Every retrieval command supports bounded inputs and JSON output where noted in
`--help`. Text mode favors concise human diagnostics; JSON is the stable
automation surface.

## Native language coverage

The stable v2 extractor implements TypeScript, TSX, JavaScript, JSX, Rust,
Python, and Go as native Rust grammar families. Unsupported extensions do not
produce a misleading empty graph: discovery excludes them, while explicitly
requested unsupported files fail with a structured diagnostic.

Coverage is intentionally stated by implemented grammar family rather than by
the much broader v1 list. New languages must add declarations, references,
resolution behavior, bounded failure handling, and end-to-end graph tests before
they are advertised.

See [native extraction](docs/v2/EXTRACTION.md) and the
[extractor/resolver extension guide](docs/EXTENDING-EXTRACTORS-RESOLVERS.md).

## Migration from v1.1.33

V2 can import directly from a v1.1.33 PostgreSQL schema with resumable
checkpoints, structural validation, and a required derived-index rebuild. It
never reads a SQLite file.

If the only v1 index is SQLite, either rebuild v2 from source or use v1.1.33 to
migrate that data to PostgreSQL before running the v2 importer. Keep the v1.1.33
binary/tag available until validation succeeds.

Use `cartograph db --help` for the exact import command and confirmation
requirements in the installed release.

## Parallelism and safety

Indexing uses bounded worker counts selected from 1, 2, 4, 8, or 16 according
to corpus size and hardware. Workers may parse concurrently, but a deterministic
reducer produces the same logical digest and ordered retrieval evidence at every
supported worker count.

The indexer also enforces:

- task and byte admission limits with no hidden unbounded queue;
- cancellation polling in discovery, reading, parsing, resolution, validation,
  and database work;
- lease fencing and PostgreSQL-clock heartbeats;
- reaping on success, failure, timeout, cancellation, and caller drop;
- staged COPY, relation validation, and atomic generation publication;
- explicit freshness and abstention instead of guessed evidence.

Committed benchmark metadata and raw reports are under
[`docs/v2/benchmarks`](docs/v2/benchmarks/).

## ParadeDB boundary

The Community ParadeDB image is supported for a local developer/agent database
whose BM25 index is rebuildable derived state. Shared, hosted, replicated, or
paying production use requires a separate durability and licensing decision.

Cartograph release archives contain only the MIT-licensed native Cartograph
binary and project notices. See [the v2 distribution policy](docs/v2/LICENSING.md)
for the enforced archive boundary and upstream links.

## Development

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace
cargo deny --all-features check
```

Live PostgreSQL/ParadeDB gates are defined in
[`v2-rust.yml`](.github/workflows/v2-rust.yml). They cover capability checks,
migrations, COPY/digest invariants, leases, supervisor fault injection,
1/2/4/8/16-worker determinism, retrieval, migration, backup/restore, upgrade,
rollback, and derived-index recovery.

Release tags build and smoke native archives for macOS arm64/x64, Linux
arm64/x64, and Windows x64, create `SHA256SUMS`, and attach build provenance.
The release workflow refuses a tag that does not point at the published `main`
head.

## License

Cartograph is licensed under the [MIT License](LICENSE). Third-party components
retain their own licenses; see [ACKNOWLEDGEMENTS.md](ACKNOWLEDGEMENTS.md) and the
ParadeDB boundary above.
