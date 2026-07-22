# Storage Backends

Cartograph supports both storage backends:

- **SQLite** is the default. It needs no service, stores the graph at
  `.cartograph/cartograph.db`, and is the fastest local single-writer path.
  Cartograph verifies the Bun SQLite runtime supports SQLite 3.37+,
  STRICT tables, FTS5, RTree, and JSON functions.
- **PostgreSQL 18+** is opt-in. Use it when you want external/shared storage,
  managed backups, operational DB controls, or native pgvector search.

## SQLite Default

```sh
cartograph index /path/to/project
cartograph status /path/to/project
```

No database config is required. SQLite uses FTS, RTree, JSON-backed variable
lists, and sqlite-vec when the optional sqlite-vec extension is available.
Doctor reports the SQLite version and feature check result.

Cartograph intentionally uses `bun:sqlite` for this backend rather than
Bun.SQL's SQLite adapter. The local graph API is synchronous and
statement-oriented, and `bench/sqlite-driver.mts` currently shows `bun:sqlite`
faster on Cartograph-shaped local workloads. Bun.SQL remains the right boundary
for PostgreSQL and future external SQL backends.

## PostgreSQL New Project

Start a PostgreSQL 18+ database first. For local development and pgvector
testing:

```sh
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg18
```

Initialize the project with PostgreSQL storage before the first index:

```sh
cartograph admin init -i /path/to/project \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-pgvector auto

cartograph doctor /path/to/project
```

No `--database-schema` needed: see
[Per-project separation](#per-project-separation-on-a-shared-instance).
Pass it only when you want a specific name.

If you are also bootstrapping local LLM model files, `llm install` accepts the
same storage flags:

```sh
cartograph llm install /path/to/project \
  --database-provider postgres \
  --database-url "$DATABASE_URL" \
  --database-pgvector auto
```

## Config File

The same settings can be committed to `.cartograph/config.json` except for
secrets, which usually belong in environment variables:

```json
{
  "database": {
    "provider": "postgres",
    "url": "postgres://user:pass@localhost:5432/cartograph",
    "schema": "cartograph",
    "pgvector": "auto",
    "queryTimeoutMs": 120000,
    "connectionTimeoutSeconds": 30,
    "maxConnections": 1
  }
}
```

Environment fallbacks:

```sh
CARTOGRAPH_DATABASE_PROVIDER=postgres
CARTOGRAPH_DATABASE_URL=postgres://user:pass@host:5432/cartograph
CARTOGRAPH_DATABASE_SCHEMA=cartograph
CARTOGRAPH_DATABASE_PGVECTOR=auto
CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS=120000
CARTOGRAPH_DATABASE_CONNECTION_TIMEOUT_SECONDS=30
CARTOGRAPH_DATABASE_MAX_CONNECTIONS=1
CARTOGRAPH_DATABASE_SSL=true
```

`DATABASE_URL` is also accepted when `CARTOGRAPH_DATABASE_URL` is unset.

## Per-Project Separation On A Shared Instance

With SQLite every project is separate for free — the database file
lives inside the project. One shared PostgreSQL server needs the same
guarantee, and Cartograph manufactures it (one schema = one project =
one graph = one viewer):

- **Auto-derived schemas.** When `database.schema` is not configured,
  every connection derives `cartograph_<name>_<hash8>` from the
  project's absolute path instead of landing in `public`. Two projects
  pointed at the same server get disjoint schemas with zero
  configuration; the schema is created on first connect. The first
  config-driven open pins the derived name into
  `.cartograph/config.json` so renaming the project directory later
  cannot re-derive a different name and "lose" the index. `doctor`,
  `status`, and `storage-migrate` all report the effective schema.

- **Ownership guard.** The first open of a schema stamps the project
  root into its metadata; every later open verifies it. If two
  projects are misconfigured onto one schema (for example both
  copy-pasted `--database-schema cartograph`), the second project's
  first open fails with both paths and the fix — instead of silently
  interleaving two file trees into one graph.

  If you intentionally **moved or renamed** a project, re-bind once:

  ```sh
  CARTOGRAPH_DATABASE_REBIND_PROJECT_ROOT=1 cartograph status /new/path
  ```

**Upgrading from a pre-1.0.3 implicit-`public` setup:** earlier builds
landed in `public` when no schema was configured. After this change an
unconfigured project derives its own schema and will report the
(empty) derived schema as behind/fresh — set
`database.schema: "public"` in `.cartograph/config.json` (or
`CARTOGRAPH_DATABASE_SCHEMA=public`) to reconnect to existing data;
the error message says exactly this when it detects the situation.

## pgvector Modes

`database.pgvector` defaults to `auto`.

| Mode | Behavior |
|---|---|
| `auto` | Try `CREATE EXTENSION IF NOT EXISTS vector`; use native pgvector mirrors when available, otherwise fall back. |
| `off` | Do not use pgvector, even if the extension exists. |
| `require` | Fail initialization/doctor if pgvector is unavailable. |

Canonical embeddings remain in Cartograph's regular BYTEA storage. pgvector
tables are native mirrors used for PostgreSQL vector search and can be rebuilt
from the canonical rows.

## Migrate Existing Projects

Use `storage-migrate` when a project already has a SQLite-backed graph and you
want PostgreSQL without reindexing:

```sh
cartograph admin storage-migrate /path/to/project \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto
```

The target schema must be fresh or nonexistent. Pass `--force` only when you
intend Cartograph to drop and recreate that schema. The SQLite database is kept
as a timestamped `.sqlite-backup.*` next to `.cartograph/cartograph.db`, and a
small sentinel file remains so older tooling does not treat the project as
uninitialized.

Restart any MCP server that was attached to the old SQLite database after the
migration finishes.

To move a PostgreSQL-backed project back to the default local SQLite database,
target SQLite explicitly:

```sh
cartograph admin storage-migrate /path/to/project \
  --database-provider sqlite
```

Cartograph copies the current PostgreSQL rows into a fresh SQLite database,
validates the row counts and SQLite foreign keys, swaps the new database into
`.cartograph/cartograph.db`, removes the `database` block from
`.cartograph/config.json`, and keeps timestamped backups of the old PostgreSQL
sentinel and config file next to the project database.

Restart any MCP server that was attached to the old PostgreSQL database after
the migration finishes.

## Doctor And Status

```sh
cartograph doctor /path/to/project
cartograph status /path/to/project --verbose
```

Doctor verifies PostgreSQL 18+, connectivity, schema version, DML writes, DDL
privileges for init/rebuild workflows, and pgvector availability when enabled.
Status reports the active backend; PostgreSQL storage uses native GIN indexes
and pgvector when available instead of SQLite-only sqlite-vec/RTree paths.
After a write-bearing index or sync, maintenance runs PostgreSQL `ANALYZE
(SKIP_LOCKED)` only on relations in the active project schema so the PG18
planner can use fresh statistics without touching other Cartograph projects in
the shared database. `SKIP_LOCKED` avoids waiting when the initial relation lock
is already held and reduces conflict risk, but PostgreSQL may still wait later
on indexes or partitions. No-change PostgreSQL syncs skip manual analysis;
PostgreSQL autovacuum remains responsible for routine tuple cleanup.

`cartograph admin prune-store` is separate, operator-triggered logical cleanup:
it evicts cold, unreferenced summary and embedding cache rows after the chosen
retention window. Cartograph does not schedule it automatically, and it does
not replace PostgreSQL vacuum/reindex maintenance when an installation already
has physically bloated tables or HNSW indexes.

## Production Notes

Create the database and role outside Cartograph, then grant ownership or
equivalent privileges on the project schema:

```sql
CREATE SCHEMA cartograph AUTHORIZATION cartograph;
GRANT USAGE, CREATE ON SCHEMA cartograph TO cartograph;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA cartograph TO cartograph;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA cartograph TO cartograph;
ALTER DEFAULT PRIVILEGES IN SCHEMA cartograph
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO cartograph;
ALTER DEFAULT PRIVILEGES IN SCHEMA cartograph
  GRANT USAGE, SELECT ON SEQUENCES TO cartograph;
```

For hosted PostgreSQL, prefer URL certificate policy such as
`?sslmode=require`, `verify-ca`, or `verify-full`. The
`database.ssl` / `CARTOGRAPH_DATABASE_SSL=true` setting only forces TLS on/off.

PostgreSQL support requires PostgreSQL 18 or newer and currently bootstraps
fresh schemas. It does not run
SQLite's forward migration chain in PostgreSQL; use a new schema for upgrades
that need a rebuild.

## Benchmarks

Run the local storage benchmark with:

```sh
CARTOGRAPH_BENCH_POSTGRES_URL=postgres://user:pass@localhost:5432/cartograph \
  bun bench/storage-backends.mts
```

Reference run from 2026-06-07, Bun 1.3.14, `darwin arm64`, three fresh runs
per backend:

| Backend | Init median | Write median | Read median | Total median | DB size |
|---|---:|---:|---:|---:|---:|
| SQLite | 7 ms | 70 ms | 35 ms | 112 ms | 2.12 MB |
| PostgreSQL | 102 ms | 241 ms | 470 ms | 795 ms | 7.46 MB |

Workload: 200 files, 1,600 nodes, 3,200 candidate edges, 40 read iterations.
Treat this as a machine- and workload-specific reference point. SQLite remains
the fastest local single-writer default in this workload; PostgreSQL is the
choice for shared/external storage, database operations, hosted backups, and
native pgvector search.

See `bench/README.md` for benchmark knobs and caveats.
