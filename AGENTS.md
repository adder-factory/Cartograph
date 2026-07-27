# AGENTS.md — install and use Cartograph v2 from an AI coding agent

Cartograph is this workspace's native code-intelligence MCP server. These
instructions are deliberately mechanical: execute a step, verify its result,
then continue.

> Working on the Cartograph repository itself? Read `AGENTS.local.md` before
> changing code. It contains the private development conventions, architecture
> gates, Sonar workflow, reviewer step, and release procedure. A fresh public
> clone does not contain that git-ignored file.

## Existing project rule

If `.cartograph/` or a project-local Cartograph MCP registration exists, use
Cartograph for relationship-aware exploration:

- `cartograph context` for broad coding-task evidence;
- `cartograph find` for exact name/path/reference or BM25 lookup;
- `cartograph graph` for callers, callees, and reverse impact;
- `cartograph affected` for test selection;
- `cartograph review` for compare-to-ref and dirty-worktree evidence;
- `cartograph status` before relying on the index.

If the index is stale, run `cartograph index <project>` or call the MCP
`cartograph_admin` index action. Do not present stale evidence as current.

If the project has no Cartograph setup, ask:

> I notice this project does not have Cartograph initialized. Would you like me
> to start its PostgreSQL/ParadeDB database, index it, and add project-local MCP
> configuration?

## Architecture and hard requirements

Cartograph v2 is:

- a native Rust executable;
- PostgreSQL 18 only;
- code-aware BM25 through ParadeDB `pg_search` 0.23.5;
- pgvector-required;
- useful without an LLM through exact, lexical, graph, review, and test-impact
  retrieval.

There is no SQLite runtime, importer, optional feature, or fallback. Never
recommend SQLite for v2 and never attempt to open an old SQLite graph.

## Step 0 — install the binary

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

The installer verifies the selected native archive against the release
`SHA256SUMS`. If installation from source is required:

```sh
git clone https://github.com/adder-factory/cartograph.git
cd cartograph
cargo build --locked --release -p cartograph-cli
```

The pinned Rust toolchain is loaded from `rust-toolchain.toml`.

## Step 1 — choose database ownership

### Managed local database (macOS/Linux)

Use this when the user has a local Docker daemon and wants the normal local
developer experience:

```sh
cd /absolute/path/to/project
cartograph db start --project-path .
cartograph doctor .
```

`db start` must report a private credential, a project-owned container/volume,
the migrated schema version, and passing hard checks for PostgreSQL 18,
`pg_search`, pgvector, preload, BM25, and code tokenization.

Cartograph pins a local Docker endpoint and binds PostgreSQL to loopback. It
refuses foreign resources with colliding names. Do not weaken those checks.

### External PostgreSQL (all supported platforms)

The database administrator must install PostgreSQL 18, `pg_search` 0.23.5, and
pgvector, then create both extensions. Supply the URL through the environment:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph'
cartograph doctor /absolute/path/to/project
```

Never write the database URL into committed project files or echo it in chat.
Cartograph intentionally redacts it from errors.

Windows release binaries support external PostgreSQL. The managed lifecycle is
not enabled there until credential ACL handling can prove equivalent privacy.

## Step 2 — index and verify

```sh
cartograph index /absolute/path/to/project
cartograph status /absolute/path/to/project
cartograph context 'explain the primary request flow' \
  --project-path /absolute/path/to/project
```

A valid first index publishes one complete generation. Running the same index
again should report an unchanged/no-op generation. If source changes,
`cartograph status` must say stale until a new complete generation publishes.

Do not call a setup ready solely because files or a container exist. Require:

1. `cartograph doctor` succeeds;
2. `cartograph index` succeeds;
3. `cartograph status` reports a fresh current generation;
4. one real `find` or `context` query returns generation-scoped evidence.

## Step 3 — install MCP configuration

Cartograph writes only project-local configuration and pins the absolute native
executable:

```sh
# OpenAI Codex: .codex/config.toml
cartograph install --yes --target codex --location local \
  --project-path /absolute/path/to/project

# Claude Code: .mcp.json
cartograph install --yes --target claude --location local \
  --project-path /absolute/path/to/project

# Cursor: .cursor/mcp.json
cartograph install --yes --target cursor --location local \
  --project-path /absolute/path/to/project
```

The installer preserves unrelated MCP entries and refuses a symlink/non-file or
oversized configuration. Restart the agent host after the write.

Manual MCP specification:

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

Use stdio transport. Profiles are `coding`, `core`, `full`, `read-only`, and
`review`.

## Step 4 — use Cartograph while coding

Route questions by evidence type:

| Need | Command/tool |
| --- | --- |
| Broad task context | `cartograph context` / `cartograph_context` |
| Exact declaration/path/reference | `cartograph find` / `cartograph_find` |
| Lexical code relevance | `find --by bm25` |
| Call or dependency shape | `cartograph graph` / `cartograph_graph` |
| Tests likely affected | `cartograph affected` / `cartograph_affected` |
| Review current changes | `cartograph review --ref main` / `cartograph_review` |
| Freshness and counts | `cartograph status` / `cartograph_status` |
| Explicit refresh | `cartograph index` / `cartograph_admin` |

Cartograph evidence narrows inspection; it does not replace reading the exact
changed source or running the project test suite. Preserve confidence,
freshness, truncation, and abstention fields in agent reasoning.

## Managed database operations

Read-only/idempotent:

```sh
cartograph db status --project-path .
cartograph db logs --project-path . --tail 200
cartograph db derived-index --project-path .
cartograph db stop --project-path .
```

Backup:

```sh
cartograph db backup ./cartograph.backup --project-path .
```

Restore, upgrade, derived-index rebuild, and remove are destructive or
replacement operations. They require the exact confirmation phrase documented
by `cartograph db <command> --help`. Do not infer authorization for them from a
read-only diagnostic request.

## V1 migration

V2 imports only from a v1.1.33 PostgreSQL schema. The importer is resumable,
validates stable identities/counts/relations, and rebuilds BM25. It does not
import or inspect SQLite.

The v1 source and v2 destination must be distinct schemas in the same database.
Set `CARTOGRAPH_DATABASE_SCHEMA` to the v2 destination, preserve a database
backup, quiesce index/sync/hook/rebuild writers for the project, and preflight
the exact source checkout before authorizing mutation. The destination may
already have a current generation; import publishes a new immutable one:

```sh
cartograph db import-v1 \
  --project-path /absolute/path/to/checkout \
  --source-schema cartograph_v1 \
  --dry-run \
  --format json

cartograph db import-v1 \
  --project-path /absolute/path/to/checkout \
  --source-schema cartograph_v1 \
  --confirm import-v1-postgres \
  --format json
```

An interrupted exact run resumes when the same command is repeated. Never
change schemas or checkout bytes to force a checkpoint forward. Keep the v1
schema and backup until `status`, one real `context` query, and derived-index
health all pass. Imported reference site counts preserve v1 multiplicity; spans
remain explicitly coarse where v1 cannot prove an exact token. SCIP placeholder
hashes cannot prove historical bytes that v1 did not retain.

`ConcurrentPublication` means another writer published first. The importer
atomically fails/releases its stale generation; with writers quiesced, repeat
the identical confirmed command so it can reset the failed run and reserve a
newer generation.

If a user needs data that exists only in a v1 SQLite index, give two choices:

1. rebuild v2 from the source checkout; or
2. use the v1.1.33 binary to migrate SQLite to PostgreSQL first, then run the v2
   PostgreSQL importer.

Do not install SQLite tooling into v2 to shorten this workflow.

Every successful index/no-op reconciliation attempts a small automatic bounded
cleanup: it keeps the two newest superseded generations, terminalizes failed
pre-lease work, and can collect staging rows only after they have been unleased
for at least ten minutes. Import-referenced staging/failed generations and all
ready/current work remain protected. After backup and import verification, an
explicit larger bounded batch is:

```sh
cartograph db prune \
  --project-path /absolute/path/to/checkout \
  --keep-superseded 2 \
  --maximum-deletions 100 \
  --confirm prune-old-generations \
  --format json
```

This preserves the current generation, recent or leased staging work, all ready
work, incomplete import recovery state, and the two newest superseded
generations. Inspect each report before requesting another batch.

## Common failures

### Managed database says Docker is unavailable

Start a local Docker daemon or use external PostgreSQL. Cartograph intentionally
rejects remote Docker contexts for managed secrets/resources.

### PostgreSQL is too old

Cartograph requires PostgreSQL 18. Upgrade the external service or use the
pinned managed image.

### `pg_search`, pgvector, preload, BM25, or tokenizer check fails

Treat this as blocking. Install/enable the exact capabilities and rerun
`cartograph doctor`; never silently reduce the engine to plain PostgreSQL FTS.

### Managed port 55432 is occupied

Choose another loopback port consistently:

```sh
cartograph db start --project-path . --port 55433
export CARTOGRAPH_MANAGED_DATABASE_PORT=55433
cartograph install --yes --target <host> --location local \
  --project-path . --managed-database-port 55433
```

The environment variable selects the port for direct CLI commands. The
installer pins the same non-secret port in the MCP server arguments, so the
agent host does not need host-specific environment configuration.

### Project has no index

Run `cartograph index <project>`. An MCP configuration alone does not create a
generation.

### Index is stale

Run a bounded index/sync, then re-run the query. Do not call stale evidence
current.

### ParadeDB Community index is unusable after a crash

The local Community BM25 index is derived data. Inspect health, then use the
confirmed `db derived-index --rebuild` path. Relational source-of-truth rows and
backups remain separate.

### Agent cannot start the MCP server after upgrade

Run `cartograph --version` and `cartograph doctor <project>` in the same shell,
then re-run `cartograph install --yes --target <host>` to repin the absolute
executable. Restart the host.

## Development and release gates

For repository work, the minimum Rust gates are:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked --workspace
cargo deny --all-features check
```

The live workflow additionally proves PostgreSQL/ParadeDB capabilities,
migrations, deterministic COPY/publication, leases, fault handling,
1/2/4/8/16-worker output identity, retrieval, migration, database maintenance,
and cleanup. Its exact-SHA green `main` run emits a GitHub-attested gate
manifest; the tag workflow verifies that evidence rather than rerunning the
live suite. Stable releases still require independent review, Sonar/static
analysis, five native archive smokes, checksums, provenance, a signed tag, and
a tag SHA equal to the published `main` head.
