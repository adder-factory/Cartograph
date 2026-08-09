# PostgreSQL storage and operations

Cartograph v2 has one storage engine: PostgreSQL 18.4 or newer within major
version 18 with ParadeDB `pg_search` 0.25.1 and pgvector 0.8.4 or newer.
Pgvector 0.8.6 is recommended for external PostgreSQL; the managed upstream
ParadeDB 0.25.1 image bundles 0.8.4. SQLite is not a backend, fallback,
migration target, importer, feature, or test utility.

## Capability contract

`cartograph doctor` fails closed unless the selected database proves:

- PostgreSQL 18.4 or newer within major version 18;
- the expected `pg_search` version and preload state;
- the `paradedb` access method and `pdb.source_code` tokenizer behavior;
- pgvector 0.8.4 or newer;
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
upstream ParadeDB image. New and upgraded containers reserve 256 MiB of shared
memory and HNSW creation disables parallel maintenance workers so vector-index
construction stays bounded. It refuses a remote Docker context, foreign resources
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

Before replacing an older managed image, create and retain a verified backup,
then use the explicit upgrade capability:

```sh
cartograph db upgrade --project-path . \
  --confirm upgrade-managed-database
```

The upgrade starts the exact digest against the retained volume, updates
`pg_search` and pgvector transactionally before calling extension-defined
functions, and requires capability plus Cartograph migration proof before it
discards the old container. ParadeDB 0.25.1 retains the legacy `bm25` access
method, so existing derived indexes remain valid and queryable; Cartograph
creates replacement/new generation indexes with the current `paradedb` access
method and accepts both catalog names during this upgrade boundary.
It also replaces a same-image legacy container when its shared-memory allocation
is below the current HNSW requirement. `doctor` reports that condition before
embedding work reaches index creation.

Restore, upgrade, derived-index rebuild, and removal replace or delete state and
require the exact confirmation phrase shown by `cartograph db <command> --help`.
The lifecycle validates archive/resource identity before mutation and tests
rollback/recovery paths against the pinned service.

Windows release binaries use external PostgreSQL. Managed lifecycle remains
disabled there until private credential ACL behavior can be proved equivalent.

## External database

The database administrator installs PostgreSQL 18.4 or newer within major
version 18, `pg_search` 0.25.1, and pgvector 0.8.4 or newer (0.8.6
recommended), and creates the extensions. Supply secrets only through the
process environment:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
cartograph doctor /absolute/path/to/project
cartograph index /absolute/path/to/project
```

For an existing external database, quiesce Cartograph writers, retain a verified
database backup, install the new extension binaries, restart PostgreSQL, and
update both catalogs before running `cartograph doctor`:

```sql
ALTER EXTENSION pg_search UPDATE TO '0.25.1';
ALTER EXTENSION vector UPDATE TO '0.8.6';
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

Large native generations can use a staging-only PostgreSQL spill in the same
database/schema. The spill tables are children of one immutable generation and
are inaccessible to current-generation readers. Every mutation rechecks the
exact index lease and generation sequence. File-local extraction payloads are
streamed in bounded batches. Cacheable payloads are stored once in the
immutable parse cache and spill rows retain foreign-key-protected references;
an inline digest-checked payload is used only when cache publication is
unavailable. Resolver output is row-validated and COPY-published into typed raw
files/symbols/edges/references/numerical-sites/documents tables without a JSONB
fact-batch intermediary.

After resolution seals exact raw counts, Cartograph reduces 64 UUID partitions
per typed relation in four-partition transaction groups. Each transaction
detects identity conflicts, proves the group's file/symbol/span
cross-relations, aggregates edge multiplicity/confidence, inserts canonical
generation rows, removes those raw rows, and advances a durable cursor. The
document relation uses an indexed exact duplicate-identity probe, so large
text fields are compared only when two raw rows claim the same document ID.
This changes no conflict semantics and avoids materializing unique document
text into a `DISTINCT` aggregate. The
canonical V13 digest streams exact canonical row bytes from PostgreSQL in the
same table/key order as the memory reducer. The final ready transaction checks
the lease/state, the durable `canonicalized` phase that only validated groups
can reach, digest capability, and canonical counts, builds the generation
search relation, removes the spill run, and marks the generation ready.
Publication remains the later short current-pointer swap.

The project settings `generationStorage`, `maxSpillBytes`, and `maxSpillRows`
control selection and logical quotas. Defaults are `auto`, 128 GiB, and one
billion rows; hard maxima are 1 TiB and ten billion rows. Logical bytes exclude
PostgreSQL/WAL/index/temporary-space amplification. An abandoned generation is
removed through the ordinary generation cascade/retention path; never delete
individual spill relations manually.

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
`CARTOGRAPH_DATABASE_SCHEMA`. `--project-path` identifies the initialized v2
destination; `--source-checkout` may point at a detached byte-exact historical
tree so current dirty work never needs to be rewound. Preflight that exact
checkout first:

```sh
cartograph db import-v1 \
  --project-path /absolute/path/to/current-project \
  --source-checkout /absolute/path/to/exact-v1-checkout \
  --source-schema cartograph_v1 \
  --dry-run \
  --format json
```

The preflight validates schema history, bounded rows/bytes/JSON, supported
languages, repository/source identity, current checkout bytes, relations,
coordinates, body/content hashes, and canonical output without writing the
destination. It independently discovers the exact v1.1.33-compatible checkout
path/content set, excluding only additive v2 `.pyi` and TOML modes, and rejects
any missing, extra, or substituted v1 file before mutation. It reports that raw
verified manifest as the imported generation revision. The default aggregate source/metadata ceiling is 512 MiB; bounded
advanced ceilings are available as `--maximum-rows` and
`--maximum-source-bytes`.

After a clean report:

```sh
cartograph db import-v1 \
  --project-path /absolute/path/to/current-project \
  --source-checkout /absolute/path/to/exact-v1-checkout \
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

Additive v2 file types or source-policy inputs can make the imported v1
generation correctly report stale. Run a normal v2 index before the final
status/retrieval verification in that case.

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
superseded generations. The same exact migration lease also runs parse-cache
retention: the running extractor contract is always protected, at most one
recent older contract is retained, and independent defaults cap the project at
20,000 rows, 2 GiB of logical payload, and 10,000 deletions per pass. Cache hits
touch `last_used_at` at most hourly rather than writing on every hit.

This keeps routine watcher churn bounded. Explicit pruning remains separate
from import, backup, physical compaction, and derived-index recovery and is
available for larger audited batches after a verified backup:

Automatic post-index cleanup delegates thresholded dead-row reclamation to the
table-specific autovacuum policy instead of synchronously vacuuming every
retention relation on the watcher hot path. Explicit `db prune` retains the
thresholded, table-scoped synchronous maintenance result for operator-audited
batches; neither path performs `VACUUM FULL` or database-wide `ANALYZE`.

```sh
cartograph db prune \
  --project-path /absolute/path/to/checkout \
  --keep-superseded 2 \
  --maximum-deletions 100 \
  --confirm prune-old-generations \
  --format json
```

One invocation deletes at most the requested batch of stale unleased staging,
stale unleased ready, failed, and old superseded generations. Staging must be at
least ten minutes old and ready work at least 24 hours old by default. It always
preserves the current generation, recent or leased staging/ready work,
staging/ready/failed generations referenced by non-complete v1 import runs, and
the newest configured superseded histories. The import-run exception preserves
the exact state needed for concurrent-publication recovery.
The transaction also enforces independent canonical/cascade-row,
generation-relation-byte, and DDL-relation caps. Defaults admit at most five
million cascade rows, 8 GiB of generation search relations, and 64 relation
drops; hard bounds are 100 million rows, 64 GiB, and 64 drops. For every
selected terminal generation it accounts work first, drops the physical search
table (including its BM25 index), deletes canonical rows by cascade, and reports
the exact admitted rows, relations, and bytes. Before selection it walks the
PostgreSQL cascade catalog across every schema and verifies the namespace plus
relation identity of every known direct and indirect generation-owned table;
same-schema or cross-schema drift fails closed instead of weakening the row cap.
The transaction shares the schema-migration advisory lock, holds relation locks
that conflict with foreign-key DDL through accounting and deletion, and rechecks
the catalog immediately before `DELETE`. Child evidence tables such as coverage,
issue history, similarity, and summary-priority state are included in both
accounting and maintenance. It also acquires publication/retention locks and
rechecks the exact live migration lease after deletion before commit.
At 100,000 or more admitted cascade rows, a post-commit maintenance pass vacuums
and analyzes only the named high-churn tables with `SKIP_LOCKED`, forced index
cleanup, truncation disabled, and the same bounded deadline. A maintenance
failure is reported as deferred and cannot roll back already committed
retention.

Status and doctor expose generation-state counts plus a conservative retained
byte lower bound (source bytes plus physical generation search tables/indexes).
That lower bound deliberately excludes shared fact-table heaps and B-trees,
embeddings, and reusable dead space. Routine `status` also includes compact
whole-database and schema heap/index/TOAST totals; use `db usage` for the full
relation/cache/generation report.
Inspect the report and request another explicit batch if automatic cleanup does
not drain an existing backlog.

## Storage measurement and online compaction

Use the read-only report before deciding that the database is bloated:

```sh
cartograph db usage --project-path . --limit 64 --format json
```

Both `db usage` and the default `db compact` plan verify the exact current
migration ledger without creating or upgrading the selected schema.

It separates whole-database bytes from this schema's heap, B-tree/all-index,
TOAST, generation-search, and parse-cache allocations. Parse-cache evidence
separates uncompressed logical payload, live compressed payload for the selected
project and whole schema, total relation allocation, and the remaining physical
overhead. A bounded `parse_cache_physical_amplification` warning identifies a
large high-water relation without claiming that every overhead byte is safely
reclaimable. It also reports bounded
largest-table/index rows, estimated live/dead tuples, autovacuum evidence,
stale ready generations, invalid concurrent-index artifacts with exact total
and truncation evidence, and duplicate generation-content potential. Duplicate
ranking consistently considers only ready, current, and superseded generations;
failed/staging work cannot distort the estimate. Duplicate content is
assessment-only: mutation
stays disabled until a normalized content-addressed fact schema can preserve
immutable generation identity, project isolation, cascades, and freshness.

Migration 23 applies table-specific autovacuum/analyze thresholds to the
highest-churn generation and cache relations. It adds `payload_bytes` as a
PostgreSQL 18 virtual generated column, so byte accounting occupies no per-row
storage.

Ordinary `VACUUM` makes deleted space reusable inside PostgreSQL but usually
does not return it to the filesystem. This is especially visible for a
high-churn parse-cache TOAST relation: zero dead tuples can coexist with a large
reusable high-water file. Cartograph therefore offers a dry-run
online B-tree plan for recoverable index bloat:

```sh
cartograph db compact --project-path . --format json

cartograph db compact --project-path . \
  --apply \
  --confirm compact-online-indexes \
  --format json
```

Apply rebuilds one eligible B-tree at a time with `REINDEX INDEX CONCURRENTLY`
outside a transaction, under a schema advisory lock and per-index deadline. It
is bounded by index count and candidate bytes, is resumable after a partial
failure, and never auto-drops `_ccnew`, `_ccold`, invalid, BM25, or exclusion-
constraint artifacts. Managed mode measures free bytes from the validated
project-owned data volume and rejects `--available-headroom-bytes`; external
PostgreSQL requires that operator-supplied value. The required minimum is twice the largest
candidate plus 64 MiB because concurrent rebuilds temporarily need both index
copies and working space. The advisory lock and session timeout live on a
dedicated close-on-drop connection so cancellation cannot contaminate the pool
or strand a session lock.

`VACUUM FULL` is intentionally not automated: it takes an exclusive table lock
and needs extra disk for a rewritten copy. If heap/TOAST—not B-tree indexes—is
the remaining problem, schedule that separately only after a verified backup,
free-space check, and maintenance window.

## Distribution boundary

Native Cartograph archives contain no PostgreSQL, ParadeDB, pgvector, image,
extension binary, SQL dump, or database credential. The managed command pulls
the separately distributed upstream image. See [licensing](v2/LICENSING.md) for
the local Community and hosted/shared deployment boundary.
