# PostgreSQL storage and operations

Cartograph v2 has one storage engine: PostgreSQL 18 with ParadeDB `pg_search`
0.23.5 and pgvector. SQLite is not a backend, fallback, migration target,
importer, feature, or test utility.

## Capability contract

`cartograph doctor` fails closed unless the selected database proves:

- PostgreSQL major version 18 or newer;
- the expected `pg_search` version and preload state;
- the BM25 access method and `pdb.source_code` tokenizer behavior;
- pgvector availability;
- the complete append-only Cartograph migration ledger;
- bounded read/write/DDL capability in the selected schema.

Cartograph never silently degrades to PostgreSQL built-in FTS or a local file.

## Managed local database

On macOS/Linux with a local Docker daemon:

```sh
cartograph db start --project-path .
cartograph db status --project-path .
cartograph doctor .
```

The native lifecycle creates a project-owned container and volume, generates a
private local credential, binds PostgreSQL to loopback, and pulls the pinned
upstream ParadeDB image. It refuses a remote Docker context, foreign resources
with colliding names, wrong labels/mounts, a public bind, and an unproved
database capability.

Common read/idempotent operations:

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

Restore, upgrade, derived-index rebuild, and removal replace or delete state and
require the exact confirmation phrase shown by `cartograph db <command> --help`.
The lifecycle validates archive/resource identity before mutation and tests
rollback/recovery paths against the pinned service.

Windows release binaries use external PostgreSQL. Managed lifecycle remains
disabled there until private credential ACL behavior can be proved equivalent.

## External database

The database administrator installs PostgreSQL 18, `pg_search` 0.23.5, and
pgvector and creates the extensions. Supply secrets only through the process
environment:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
cartograph doctor /absolute/path/to/project
cartograph index /absolute/path/to/project
```

Optional bounded pool controls:

```sh
export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
```

Do not commit or print a database URL. Public errors and debug output are
required to omit credentials, query text, and absolute project paths.

## Generation model

Indexing stages a complete immutable generation, validates files/symbols/edges/
references/search documents, and then builds derived search state from those
canonical rows. For BM25, it populates an immutable physical
`search_g_<generation UUID>` table, creates that table's `_bm25` index, verifies
source/relation/distinct row counts plus catalog health, and records the project,
generation, content digest, count, and format version in
`generation_search_relations`. Migration 11 enforces generation UUIDs as
globally unique because the trusted physical identifier is generation-derived.
Only then can the generation become `ready`.
The publication transaction requires that exact relation again before it swaps
the project's current pointer. Any table/index build failure rolls back with the
staging transaction and can never publish a partial generation.

Writers use project/operation advisory locks, explicit leases, PostgreSQL-clock
heartbeats, exact fencing tokens, bounded statement deadlines, and rollback on
lost/expired ownership. Re-indexing an identical supported-source manifest is a
no-op unless `--force` is explicit.

## Derived BM25 and vector state

Relational graph/search-document rows are source-of-truth data. ParadeDB BM25
and model-scoped HNSW indexes are rebuildable derived state. BM25 is generation
local rather than one global corpus, so documents in another project or a
ready/superseded generation cannot perturb current-generation scores or order.
A bounded read validates one expected current generation in a repeatable-read
transaction and queries only its verified physical relation. Inspect aggregate
derived-index health with:

```sh
cartograph db derived-index --project-path .
```

Use the exact confirmed rebuild form printed by command help when recovery is
required. Never describe the Community BM25 index as WAL-crash-durable or use a
rebuild to conceal loss of relational source rows.

Migration and startup reconciliation prioritize unhealthy current/ready
relations, repair at most 64 per invocation from canonical `search_documents`,
and fail closed if another bounded pass is required. It also removes at most 64
orphan tables whose names strictly decode as generation relation identifiers.
Builds, repairs, and retention drops share a generation-specific transactional
advisory lock. Healthy catalog/table/index tuples are left unchanged.

## Import from v1.1.33 PostgreSQL

V2 never opens SQLite. If the only v1 graph is SQLite, either rebuild from the
checkout or first use the v1.1.33 binary to migrate it to PostgreSQL.

The v1 source and v2 destination must be different schemas in the same database.
The destination may already contain a current generation; import publishes a
new immutable generation. Back up the database, quiesce project
index/sync/hook/rebuild writers, and select the v2 destination through
`CARTOGRAPH_DATABASE_SCHEMA`. Preflight the exact checkout first:

```sh
cartograph db import-v1 \
  --project-path /absolute/path/to/checkout \
  --source-schema cartograph_v1 \
  --dry-run \
  --format json
```

The preflight validates schema history, bounded rows/bytes/JSON, supported
languages, repository/source identity, current checkout bytes, relations,
coordinates, body/content hashes, and canonical output without writing the
destination. The default aggregate source/metadata ceiling is 512 MiB; bounded
advanced ceilings are available as `--maximum-rows` and
`--maximum-source-bytes`.

After a clean report:

```sh
cartograph db import-v1 \
  --project-path /absolute/path/to/checkout \
  --source-schema cartograph_v1 \
  --confirm import-v1-postgres \
  --format json
```

The importer persists monotonic `staged`, `ready`, `bm25_rebuilt`, and
`complete` checkpoints. Repeat the identical command after a reported
interruption; changed source identity or inconsistent checkpoint state fails
closed. Reference/edge multiplicity is preserved. Exact spans remain exact only
when v1 plus current source proves the token; otherwise the span is marked
coarse. A SCIP placeholder hash proves its path-derived placeholder identity,
not historical bytes v1 never stored.

`ConcurrentPublication` is retryable only after writers are quiesced. The
failed attempt atomically releases its stale generation; repeat the identical
confirmed command to reset that durable run and reserve a newer generation.

Before retiring v1, keep the source schema and backup and verify:

```sh
cartograph status /absolute/path/to/checkout
cartograph context 'trace the primary request flow' --project-path /absolute/path/to/checkout
cartograph db derived-index --project-path /absolute/path/to/checkout
```

## Bounded retention

Successful index and no-op reconciliation requests perform an automatic cleanup
with a 32-generation transaction cap while preserving the two newest
superseded generations. This keeps routine watcher churn bounded. Explicit
pruning remains separate from import, backup, `VACUUM`, and derived-index
recovery and is available for larger audited batches after a verified backup:

```sh
cartograph db prune \
  --project-path /absolute/path/to/checkout \
  --keep-superseded 2 \
  --maximum-deletions 100 \
  --confirm prune-old-generations \
  --format json
```

One invocation deletes at most the requested batch of stale unleased staging,
failed, and old superseded generations. Staging must be at least ten minutes old
by default. It always preserves the current generation, recent or leased
staging, all ready work, staging/failed generations referenced by non-complete
v1 import runs, and the newest configured superseded histories. The import-run
exception preserves the exact state needed for concurrent-publication recovery.
The transaction also enforces independent canonical/cascade-row,
generation-relation-byte, and DDL-relation caps. Defaults admit at most five
million cascade rows, 8 GiB of generation search relations, and 64 relation
drops; hard bounds are 100 million rows, 64 GiB, and 64 drops. For every
selected terminal generation it accounts work first, drops the physical search
table (including its BM25 index), deletes canonical rows by cascade, and reports
the exact admitted rows, relations, and bytes. It acquires publication/retention
locks and rechecks the exact live migration lease after deletion before commit.
Status and doctor expose generation-state counts plus a conservative retained
byte estimate (source bytes plus physical generation search tables/indexes).
Inspect the report and request another explicit batch if automatic cleanup does
not drain an existing backlog.

## Distribution boundary

Native Cartograph archives contain no PostgreSQL, ParadeDB, pgvector, image,
extension binary, SQL dump, or database credential. The managed command pulls
the separately distributed upstream image. See [licensing](v2/LICENSING.md) for
the local Community and hosted/shared deployment boundary.
