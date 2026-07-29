# Agent-assisted installation

Give the following task to a coding agent from the repository Cartograph should
index:

```text
Install Cartograph v2 for this repository and register its native MCP server.

1. If `cartograph --version` is unavailable, use the checksum-verifying native
   installer from the Cartograph release. Do not install Bun or an npm package.
2. On macOS/Linux with a local Docker daemon, run:
   cartograph db start --project-path .
   cartograph doctor .
   Otherwise configure an external PostgreSQL 18 database with pg_search and
   pgvector through CARTOGRAPH_DATABASE_URL, then run doctor.
3. Run `cartograph index .` followed by `cartograph status .` and one real
   `cartograph context` query.
4. Run `cartograph install --yes --target <current-host> --location local
   --project-path .`.
5. Report the exact files changed, database ownership, doctor result, current
   generation/freshness, real retrieval result, and whether the host must be
   restarted.

Do not print or commit database/API credentials. Do not claim MCP health from
CLI success alone; restart the host and make a live MCP call when possible.
```

## Install the native executable

macOS/Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/adder-factory/cartograph/main/install.sh | sh
cartograph --version
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/adder-factory/cartograph/main/install.ps1 | iex
cartograph --version
```

The installers select one of the five release platforms and verify the archive
against the release `SHA256SUMS`. Building from source requires only the pinned
Rust toolchain:

```sh
git clone https://github.com/adder-factory/cartograph.git /tmp/cartograph
cd /tmp/cartograph
cargo build --locked --release -p cartograph-cli
install -m 0755 target/release/cartograph "$HOME/.local/bin/cartograph"
```

Cartograph v2 has no TypeScript/Bun or SQLite runtime.

## Database bootstrap

The normal local macOS/Linux path is:

```sh
cartograph db start --project-path .
cartograph doctor .
cartograph index .
cartograph status .
cartograph context 'explain the primary request flow' --project-path .
```

The managed lifecycle creates project-owned, loopback-only Docker resources
using the pinned upstream ParadeDB image. PostgreSQL 18.4 or newer within major
version 18, `pg_search` 0.25.0, pgvector 0.8.4 or newer, preload, ParadeDB
index access, BM25, and source-code tokenization are hard checks.

For external PostgreSQL, create both extensions and pass secrets through the
process environment:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
cartograph doctor .
cartograph index .
```

Never write the URL into a committed config. See
[PostgreSQL storage and operations](STORAGE-BACKENDS.md).

## Register an agent host

The installer supports 19 host targets and preserves unrelated configuration.
Common examples:

```sh
cartograph install --yes --target codex --location local --project-path .
cartograph install --yes --target claude --location local --project-path .
cartograph install --yes --target cursor --location local --project-path .
```

It pins the absolute native executable, writes project-local MCP configuration,
and can install managed Git hooks. If the managed database uses a non-default
port, add `--managed-database-port <PORT>`; the generated server arguments pin
that non-secret loopback port for every host format. Use `--no-hooks` to omit
hook changes. Run `cartograph install-hooks --remove` to remove only
Cartograph-owned blocks.

Restart the host after registration or binary replacement. A shell `status`
call validates the CLI/database path; it does not prove that an already-running
MCP process was replaced.

## Optional LLM capabilities

Exact lookup, ParadeDB BM25, graph traversal, affected tests, review, structural
summaries, roles, and code-health analysis work without an LLM. Embeddings,
reranking, generated summaries/classifications, `ask`, and local chat are
optional tiers.

```sh
cartograph llm setup
cartograph backend start .       # only for configured local llama-server tiers
cartograph llm smoke .
cartograph doctor .
```

Supported chat providers are OpenAI-compatible HTTP, Anthropic Messages API,
and the bounded local Claude CLI bridge. Embedding and reranker tiers use
OpenAI-compatible HTTP. Credentials should be resolved from environment
variables, not stored inline.

The browser visual-graph viewer is the only v1 capability not present in v2.
Typed graph data, paths, impact, similarity, JSON/DOT/Mermaid/Cytoscape export,
and SCIP interchange remain available to agents and tools.
