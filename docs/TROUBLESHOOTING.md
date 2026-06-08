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

## Cartograph Is Not Initialized

Symptom:

```text
Cartograph not initialized in /path/to/project
```

Fix:

```sh
cartograph admin init -i /path/to/project
cartograph status --verbose /path/to/project
```

For PostgreSQL storage, pass the storage flags during `admin init` or `setup`
before the first index:

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
  source checkout or run `cartograph install --command "$(command -v cartograph)"`
  to write an absolute command path into supported MCP configs.
- The host is using HTTP/SSE MCP settings. Cartograph's server is stdio MCP.
- A long-running MCP session still has an old database handle after storage was
  migrated. Restart the host session.

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

`cartograph admin storage-migrate` expects a fresh or nonexistent PostgreSQL
schema. If the schema already contains Cartograph tables, migration stops.

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

## Database Lock Or Concurrent Process

Doctor reports sibling MCP/admin/hook processes when it can detect them. If an
admin/index command reports a database lock, stop or restart the sibling process
and retry:

```sh
cartograph doctor .
cartograph admin sync .
```

PostgreSQL reduces local SQLite writer-lock friction, but long-running admin
jobs can still compete at the application level.
