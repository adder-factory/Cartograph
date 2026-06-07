# Storage Backends

Cartograph supports both storage backends:

- **SQLite** is the default. It needs no service, stores the graph at
  `.cartograph/cartograph.db`, and is the fastest local single-writer path.
- **PostgreSQL** is opt-in. Use it when you want external/shared storage,
  managed backups, operational DB controls, or native pgvector search.

## SQLite Default

```sh
cartograph admin init -i /path/to/project
cartograph status /path/to/project
```

No database config is required. SQLite uses FTS, RTree, and sqlite-vec when
the optional sqlite-vec extension is available.

## PostgreSQL New Project

Start a PostgreSQL database first. For local development and pgvector testing:

```sh
docker run --rm -d --name cartograph-postgres \
  -e POSTGRES_USER=cartograph \
  -e POSTGRES_PASSWORD=cartograph \
  -e POSTGRES_DB=cartograph \
  -p 5432:5432 \
  pgvector/pgvector:pg16
```

Initialize the project with PostgreSQL storage before the first index:

```sh
cartograph admin init -i /path/to/project \
  --database-provider postgres \
  --database-url postgres://cartograph:cartograph@localhost:5432/cartograph \
  --database-schema cartograph \
  --database-pgvector auto

cartograph doctor /path/to/project
```

The one-shot setup command accepts the same storage flags:

```sh
cartograph setup /path/to/project \
  --database-provider postgres \
  --database-url "$DATABASE_URL" \
  --database-schema cartograph \
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

## Migrate Existing SQLite Project

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

## Doctor And Status

```sh
cartograph doctor /path/to/project
cartograph status /path/to/project --verbose
```

Doctor verifies PostgreSQL connectivity, schema version, DML writes, DDL
privileges for init/rebuild workflows, and pgvector availability when enabled.
Status reports the active backend; PostgreSQL storage uses native GIN indexes
and pgvector when available instead of SQLite-only sqlite-vec/RTree paths.

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

PostgreSQL support currently bootstraps fresh schemas. It does not run
SQLite's forward migration chain in PostgreSQL; use a new schema for upgrades
that need a rebuild.

## Benchmarks

Run the local storage benchmark with:

```sh
CARTOGRAPH_BENCH_POSTGRES_URL=postgres://user:pass@localhost:5432/cartograph \
  bun bench/storage-backends.mts
```

See `bench/README.md` and the README storage section for the current local
SQLite vs PostgreSQL comparison.
