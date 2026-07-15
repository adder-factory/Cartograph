# Troubleshooting

Start with the diagnostic commands. They usually say which remediation to run:

```sh
cartograph status --verbose .
cartograph doctor .
cartograph mcp-budget
```

Use `cartograph doctor --fix .` when you want Cartograph to apply safe install
fixes such as creating `.cartograph/`, writing recommended config, or filling in
missing local model files. Doctor cannot start an LLM backend process for you.

## `bun install` Fails Extracting A Tarball

Cartograph installs from source, so a source install or `cartograph upgrade
--apply` runs `bun install`.

Symptom:

```text
error: Fail extracting tarball for "@biomejs/cli-linux-x64-musl"
```

This is a transient flake in Bun's installer — it sometimes fails extracting an
optional platform package even though the lockfile is valid (the failure is
near-instant and a clean retry succeeds). It is not a problem with Cartograph
or your environment.

Fix:

Clearing Bun's cache first forces a clean re-fetch:

```sh
bun pm cache rm
bun install
```

## Cartograph Is Not Initialized

Symptom:

```text
Cartograph not initialized in /path/to/project
```

Fix:

```sh
cartograph index /path/to/project
cartograph status --verbose /path/to/project
```

For PostgreSQL storage, pass the storage flags during `admin init` or
`llm install` before the first index:

```sh
cartograph admin init -i /path/to/project \
  --database-provider postgres \
  --database-url "$DATABASE_URL" \
  --database-schema cartograph \
  --database-pgvector auto
```

## MCP Server Does Not Connect

Run:

```sh
cartograph install
cartograph mcp-budget
cartograph serve --mcp --project-path /abs/path/to/project
```

Common causes:

- The host config points at a relative project path. Use an absolute
  `--project-path`.
- The `cartograph` binary is not on the host process PATH. Use `bun link` for a
  source checkout, or re-run `cartograph install` — it pins an absolute command
  path into supported MCP configs automatically when `cartograph` is not
  resolvable; `--command <path>` sets the path explicitly.
- The host is using HTTP/SSE MCP settings. Cartograph's server is stdio MCP.
- A long-running MCP session still has an old database handle after storage was
  migrated. Restart the host session.
- `serve --mcp` defaults to a shared per-project daemon (the stdio process proxies
  to it). Cartograph auto-retires unreachable daemon lock/socket state at startup,
  but if a handshake keeps failing, bypass it with `--no-daemon` to run a
  standalone in-process server. See [MCP usage](MCP-USAGE.md) for the daemon model.

## `cartograph: command not found` After A Release Or Update

`bun link` registers the global `cartograph` command as a symlink pointing at
the source checkout you linked from. That link inherits the lifetime of the
checkout: if you linked from a temporary release/update worktree and then removed
it, the command becomes a dangling symlink. Symptoms:

```sh
command -v cartograph      # no output
cartograph --version       # command not found
bun pm ls -g               # still lists @adder-factory/cartograph
test -e ~/.bun/bin/cartograph  # false — the target is gone
```

New `cartograph` CLI and `cartograph serve --mcp` processes cannot start, so a
new MCP client registers no Cartograph tools. An already-running daemon keeps
serving, which makes this easy to misread as a storage or MCP transport problem.

`cartograph doctor` (run from any stable checkout) reports this as a **Bun global
link** failure. To recover, re-point the global command at a stable location:

```sh
# From a permanent source checkout (not a disposable worktree):
bun link

# …or install the published tag instead of a linked checkout:
bun add -g git+https://github.com/adder-factory/cartograph.git#v<latest>
```

Never `bun link` the global CLI from a temporary release worktree. If a release
workflow linked from a worktree, re-link (or re-pin) before deleting it, and
verify `command -v cartograph` and `cartograph --version` still succeed.

## Gitignored Source Is Missing

Cartograph uses Git-visible files as the default source set. If valuable local
source is hidden by `.gitignore`, add a root `.ignore` override with a negated
pattern:

```gitignore
!customer/
!Pods/
```

Then run:

```sh
cartograph admin sync .
```

The override is local to Cartograph indexing. Explicit `exclude` config entries
and `.cartographignore` marker directories still win.

If Cartograph warns that `.ignore` or `.gitignore` is binary or invalid UTF-8,
restore or rewrite that file as plain UTF-8 text. Cartograph skips the corrupt
control file and continues indexing instead of applying unpredictable ignore
rules.

## PostgreSQL Cannot Connect

Run:

```sh
cartograph doctor /path/to/project
cartograph status /path/to/project --verbose
```

Check:

- `database.provider` is `postgres` in `.cartograph/config.json`, or
  `CARTOGRAPH_DATABASE_PROVIDER=postgres` is set.
- `database.url`, `CARTOGRAPH_DATABASE_URL`, or `DATABASE_URL` points at the
  right database.
- Hosted databases often need TLS. Prefer URL options such as
  `?sslmode=require`, `verify-ca`, or `verify-full`.
- Cartograph requires PostgreSQL 18 or newer. `cartograph doctor` reports the
  detected server version before it checks schema state.
- The configured role can create and write in the schema. Fresh-schema init and
  rebuild flows need DDL permissions.

For local testing:

```sh
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg18
```

## PostgreSQL Is Too Old

Doctor may report:

```text
Cartograph PostgreSQL storage requires PostgreSQL 18 or newer
```

Use a PostgreSQL 18+ server, or keep the default SQLite backend. For local
pgvector testing, use `pgvector/pgvector:pg18`.

## pgvector Is Missing

If `database.pgvector` is `auto`, Cartograph tries to create/use the extension
and falls back when it is unavailable. If `database.pgvector` is `require`,
doctor fails until native pgvector is available.

Fix options:

- Use a PostgreSQL image or hosted database with pgvector installed.
- Grant the role permission to create the `vector` extension, or have an admin
  run `CREATE EXTENSION IF NOT EXISTS vector;`.
- Set `database.pgvector` to `off` when native vector mirrors are not wanted.

Canonical embeddings are still stored without pgvector. The pgvector tables are
native PostgreSQL mirrors used to speed vector search.

## SQLite Vector Search Is Slow

Status may report:

```text
sqlite-vec did not load
```

Cartograph still works, but vector search falls back to a slower in-memory
path. Reinstall dependencies and re-run status:

```sh
bun install
cartograph status --verbose .
```

The sqlite-vec package ships prebuilts for common macOS, Linux, and Windows
architectures.

## LLM Or Embedding Endpoint Is Offline

Core graph commands do not require an LLM, but summaries, embeddings,
semantic search, `ask`, and rerank do.

Run:

```sh
cartograph llm setup
cartograph doctor .
cartograph backend start .
cartograph llm smoke .
```

If doctor says the embedding endpoint is not responding, either start the
configured backend or point `.cartograph/config.json` at a detected
OpenAI-compatible backend such as Ollama, llama-cpp, Apple MLX, LM Studio,
vLLM, LocalAI, or a cloud provider.

A running `cartograph serve --mcp` re-reads `.cartograph/config.json` when it
changes on disk, so applying a preset or repointing a provider takes effect on
the next MCP LLM call — no server restart required.

## Indexing Looks Stale

Run:

```sh
cartograph status --verbose .
cartograph admin sync .
```

If an agent has stale MCP results after recent edits, ask it to pass
`liveSource: true` to source-bearing reads or restart the MCP session after a
large reindex or storage migration.

## Missing Symbols Or Edges

Check:

- The file extension is listed in [Support Matrix](SUPPORT-MATRIX.md).
- The file is not excluded by `.cartograph/config.json` include/exclude globs.
- The file is below `maxFileSize` (5 MiB by default, configurable up to 10 MiB).
- The relevant framework resolver is detected by package files or source
  anchors.
- Generated files may be excluded by default; remove or narrow the exclude rule
  if those files are important graph inputs.

Run a targeted lookup:

```sh
cartograph find "SymbolName" --by name --mode fuzzy
cartograph files --format summary
cartograph at-range path/to/file.ts 10 30
```

## Storage Migration Problems

When migrating to PostgreSQL, `cartograph admin storage-migrate` expects a
fresh or nonexistent PostgreSQL schema. If the schema already contains
Cartograph tables, migration stops.

Use `--force` only when you intend Cartograph to drop and recreate the target
schema:

```sh
cartograph admin storage-migrate /path/to/project \
  --database-url "$DATABASE_URL" \
  --database-schema cartograph \
  --database-pgvector auto \
  --force
```

Restart any MCP server attached to the old SQLite database after migration.

When migrating back to SQLite, use `--database-provider sqlite`. Cartograph
writes a temporary SQLite database first, validates it, then swaps it into
place. If the command fails before the swap, the existing PostgreSQL config and
sentinel remain active.

## Database Lock Or Concurrent Process

Doctor reports sibling MCP/admin/hook processes when it can detect them.

Since v1.1.17 `cartograph serve --mcp` defaults to a shared per-project daemon —
**one writer per project** — so multiple agents pointed at the same project share
a single index writer instead of re-indexing concurrently and clobbering each
other. Writer-lock contention is therefore mostly a concern when you opt out of
that model with `--no-daemon` (a standalone in-process server, one per process),
or when you run a long CLI `admin` job alongside a live server. See
[MCP usage](MCP-USAGE.md) for the daemon model.

Long LLM enrichment passes — `admin summarize`, `admin embed`, and `admin
classify` — are resilient to a concurrent writer (for example a `serve --mcp`
auto-sync watcher committing mid-pass). Each write takes the SQLite write lock
up front, retries a transient `database is locked` with backoff, and isolates a
still-contended item by deferring it to the next pass instead of aborting the
whole run.

A full `cartograph admin index` (or `admin sync`) writes far more and can still
lose to a busy sibling. If one reports a database lock, let the daemon settle (or
stop/restart the contending standalone server or admin job) and retry:

```sh
cartograph doctor .
cartograph admin sync .
```

PostgreSQL reduces local SQLite writer-lock friction, but long-running admin
jobs can still compete at the application level.

## Standalone Binary Warns About AVX Under Rosetta Or Emulation

The prebuilt x64 binaries are built against Bun's baseline (pre-AVX2) runtime
so they run on older x64 CPUs, in VMs, and under Apple's Rosetta. On hosts
without AVX, Bun still prints a startup notice:

```
warn: CPU lacks AVX support, strange crashes may occur. ...
```

For the baseline builds Cartograph ships, the notice is cosmetic — no AVX
instructions are used and the binary is fully functional. On native x64
hardware with AVX the notice does not appear.
