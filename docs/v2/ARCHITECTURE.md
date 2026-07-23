# Cartograph v2 architecture

Status: accepted direction, implementation in progress  
Baseline: Cartograph v1.1.33  
Last verified against upstream ParadeDB documentation: 2026-07-23

## Product contract

Cartograph v2 is a breaking engine replacement for coding agents. Its shipped
runtime is Rust, its only storage engine is PostgreSQL 18 or newer, and its
retrieval layer requires both ParadeDB `pg_search` and pgvector.

These are decisions, not experiments:

- SQLite support is deleted. There is no SQLite driver, compatibility mode,
  configuration branch, schema, test matrix, or fallback in v2.
- The CLI, MCP server, index scheduler, extractors, graph algorithms, search
  planner, database lifecycle, and diagnostics move to Rust.
- TypeScript v1.1.33 remains temporarily as a behavior oracle and migration
  source. It is not linked into or distributed with the final v2 runtime.
- PostgreSQL owns durable relational state. ParadeDB owns lexical ranking and
  Top-K execution. pgvector owns model-scoped vector nearest-neighbor search.
- Cartograph owns code extraction, graph constraints, task intent routing,
  deterministic rank fusion, evidence selection, and agent-facing response
  contracts.
- Local inference remains an optional OpenAI-compatible HTTP dependency. The
  deterministic lexical/graph path must remain useful without an LLM.

## Runtime topology

```text
coding agent
    |
    | MCP over stdio (JSON-RPC, bounded messages)
    v
Rust cartograph process
    +-- request router / cancellation / deadlines
    +-- graph + intent planner
    +-- bounded indexing supervisor
    +-- extraction workers
    +-- evidence packager
    +-- optional OpenAI-compatible HTTP clients
    |
    | PostgreSQL wire protocol, pooled and schema-scoped
    v
PostgreSQL 18+
    +-- relational graph and index generations
    +-- pg_search / ParadeDB BM25 and code tokenization
    +-- pgvector model-scoped vector indexes
    +-- advisory locks, COPY, JSONB, recursive CTEs
```

The default development deployment references the upstream multi-architecture
`paradedb/paradedb:0.23.5` image at OCI manifest digest
`sha256:c3efc689b6ebd2fb396d7f50d68735b2dcff3e03f3bf51a926258d942201da2d`.
Cartograph does not copy or redistribute that image. The digest resolves to the
verified linux/amd64 and linux/arm64 manifests and changes only through an
explicit supported-version update.

## Rust workspace boundaries

The final workspace is organized around stable boundaries, not a monolithic
binary:

| Crate | Responsibility | May depend on |
| --- | --- | --- |
| `cartograph-domain` | Branded IDs, source spans, nodes, edges, documents, task/evidence contracts | serde only |
| `cartograph-config` | Secret-safe config discovery, validation, migration diagnostics | domain |
| `cartograph-db` | PostgreSQL connection, migrations, COPY writers, transactions, advisory locks, capability doctor | config, domain |
| `cartograph-extract` | File classification, parsers, language/framework resolvers, normalized facts | domain |
| `cartograph-indexer` | Bounded pipeline, incremental generations, deterministic reducers, cancellation | domain, db, extract |
| `cartograph-graph` | Traversals, affected tests, roles, centrality, path algorithms | domain, db |
| `cartograph-search` | BM25, vector, graph-aware candidates, rank fusion, abstention | domain, db, graph |
| `cartograph-agent` | Coding-task routing, evidence budgets, trust/verification packets, learning | domain, graph, search |
| `cartograph-llm` | Optional OpenAI-compatible HTTP embedding/chat/rerank clients | config, domain |
| `cartograph-mcp` | JSON-RPC transport, schemas, tool profiles, deadlines, cancellation | public service surfaces only |
| `cartograph-cli` | User commands and process lifecycle | public service surfaces only |
| `cartograph-test-support` | Golden fixtures, ephemeral database helpers, deterministic clocks | test-only |

Cross-slice reach-through is forbidden. Each crate exposes a narrow public
surface and keeps SQL, transport, or parser internals private.

The first committed slice contains `cartograph-config`, `cartograph-db`, and
`cartograph-cli`. It proves that the Rust runtime can reject an unsupported
database before any schema mutation.

## Storage model

The initial schema design uses one configured Cartograph schema with explicit
project IDs. Per-project isolation is enforced in every primary/foreign key and
query; deployment-level schema selection remains configurable. A project can be
removed or rebuilt without affecting another project.

Planned core relations:

| Relation | Key data |
| --- | --- |
| `projects` | stable UUID, canonical root identity, repository fingerprint |
| `index_generations` | generation UUID, project, source revision, state, timestamps, worker settings, content digest |
| `files` | project, normalized path, language, content hash, size, parse status, generation |
| `symbols` | stable symbol UUID, file/span, kind, qualified name, signature, structural digest |
| `edges` | project, source symbol, target symbol, typed edge, confidence, provenance, generation |
| `references` | project, source span, resolved target, reference kind, confidence |
| `search_documents` | unique bigint key, project/file/symbol, code fields, prose fields, indexed metadata |
| `embedding_models` | provider/model fingerprint, dimension, normalization, active/retired state |
| `document_embeddings` | document/model key, unconstrained vector value, source digest, generation |
| `task_traces` | redacted intent, candidate/rank provenance, selected evidence, outcome link |
| `agent_outcomes` | project-local success/failure signal, changed files/symbols/tests, expiry |

All structural writes are staged under a new index generation. A single
transaction atomically marks the generation current only after every required
stage succeeds. Readers always see one complete generation; cancellation or a
worker failure leaves the previous generation current.

### BM25 document index

ParadeDB allows one BM25 index per table, so every field used for text matching,
filtering, sorting, or aggregation belongs in the `search_documents` covering
index. The migration will be validated against the pinned extension before it
is accepted. Its intended shape is:

```sql
CREATE INDEX search_documents_bm25_idx
ON cartograph.search_documents
USING bm25 (
  id,
  project_id,
  path,
  language,
  document_kind,
  (qualified_name::pdb.source_code),
  (code::pdb.source_code),
  natural_text,
  metadata
)
WITH (key_field = 'id');
```

`qualified_name` and `code` use `pdb.source_code`, which splits snake_case and
camelCase. Natural-language summaries and docs use the default/unicode search
path. Exact path/language/kind fields also get ordinary PostgreSQL indexes where
that is cheaper than the covering BM25 scan.

The query planner applies explicit boosts rather than hiding weights in
application constants. Initial defaults favor exact qualified-name and path
matches, followed by code, documentation, and generated summaries. Every result
returns component scores and a reason code.

### Vector model isolation

Different embedding models can emit different dimensions. V2 therefore does
not hard-code one global `vector(n)` column. It stores model metadata separately
and creates a model-scoped partial expression index after validating the model's
dimension, conceptually:

```sql
CREATE INDEX document_embeddings_model_<fingerprint>_hnsw
ON cartograph.document_embeddings
USING hnsw ((embedding::vector(<validated_dimension>)) vector_cosine_ops)
WHERE model_id = '<validated-model-id>';
```

The application validates `vector_dims(embedding)` before insertion and the
database adds a defensive trigger. A model change creates new rows and a new
partial index; the old model is retired only after reference and readiness
audits pass.

## Retrieval plan for coding agents

Every task is classified into a typed intent before retrieval. Examples include
symbol lookup, implementation tracing, change planning, test selection, error
diagnosis, architecture survey, and documentation lookup. Intent controls field
boosts, graph constraints, evidence budgets, and abstention thresholds.

Candidate generation runs concurrently under a shared deadline:

1. ParadeDB BM25 Top-K over code-aware fields, with project/language/path filters.
2. pgvector Top-K for the configured embedding model when semantic readiness is
   verified live.
3. Exact symbol/path/reference lookup.
4. Graph expansion from high-confidence seeds: callers, callees, imports,
   references, tests, co-change, and recent local outcomes.
5. Working-tree overlay for changed or untracked files not represented by the
   current durable generation.

The deterministic reducer normalizes component ranks and fuses them with
reciprocal-rank fusion (RRF). It then applies graph proximity, freshness, trust,
and outcome priors. Raw BM25 and cosine values are retained for diagnostics but
are not mixed directly because their scales are unrelated.

Every agent response includes compact evidence provenance:

- why each file/symbol was selected;
- exact source generation and whether live overlay was used;
- component ranks/scores and graph relationship;
- confidence and explicit abstention reason;
- affected tests and verification commands when the task implies a change.

No-LLM mode uses BM25, exact lookup, graph expansion, and deterministic
packaging. Hybrid mode adds embeddings only after a real probe proves matching
model fingerprint, dimension, row coverage, and query success.

## Parallel indexing and determinism

Parallelism is bounded at every stage; there is no unbounded task spawn or
channel. The pipeline is:

```text
discover -> read/hash -> parse/extract -> resolve -> reduce -> COPY stage
         -> relational merge -> BM25 maintenance -> vector work -> publish generation
```

Each stage has:

- a configured concurrency cap and bounded queue;
- a cancellation token inherited from the supervisor;
- per-item and whole-stage deadlines;
- memory/byte budgets, not just item counts;
- structured progress counters and the identity of the current owner;
- retry rules limited to explicitly transient failures;
- deterministic output ordering before persistence.

Workers emit normalized facts keyed by stable path/span/symbol identities. A
single deterministic reducer sorts and deduplicates facts before computing the
generation digest. Running with 1, 2, 4, 8, or 16 workers over the same snapshot
must produce the same logical database digest and retrieval fixture results.

PostgreSQL `COPY` is used for bulk staging. Parallel workers never issue
independent destructive maintenance. Advisory locks are scoped by project and
operation, carry observable owner metadata, and have supervisor-enforced
deadlines.

## Process supervision requirement

V1.1.33 exposed a concrete failure mode during release work: a hook worker
could outlive useful progress for many minutes while holding the project lock.
V2 cannot inherit that process model.

The Rust supervisor must provide:

- parent-to-child cancellation propagation;
- kill escalation after a bounded grace period;
- child reaping on every exit path;
- stage heartbeat and progress timestamps;
- lock owner PID/process-start identity plus operation and generation;
- lease renewal and safe stale-owner recovery;
- a maximum runtime for hook-triggered work;
- status output that distinguishes queued, active, cancelling, and wedged work.

A failure-injection integration test must kill each pipeline stage and prove no
orphan process, live lock, or partial generation remains.

## Database lifecycle

Zero-setup SQLite is replaced by a first-class managed PostgreSQL experience:

- `cartograph db start` starts the pinned PostgreSQL 18 + ParadeDB + pgvector
  image, creates a persistent volume, generates private credentials, waits for
  health, creates extensions/schema, and runs the capability doctor.
- `cartograph db stop`, `status`, and `logs` are idempotent and explain whether
  the instance is managed by Cartograph or external.
- `cartograph db backup` produces and verifies a logical backup of relational
  source-of-truth data. Derived BM25/vector indexes are marked rebuildable.
- `cartograph db upgrade` backs up, pulls a pinned supported version, restarts,
  runs `ALTER EXTENSION`, verifies versions, and rebuilds derived indexes when
  required.
- External PostgreSQL is supported only when the doctor proves every hard
  capability. Cartograph never silently falls back to another backend.

The checked-in Compose file is a development harness only. The production CLI
lifecycle will use the Docker/Podman command API directly so users do not need a
Compose plugin.

The M1 preview now implements the Docker CLI path in Rust for
`cartograph-v2 db start|status|logs|stop`. It derives project-private resource
names from a BLAKE3 hash of the canonical root, labels and verifies container
and volume ownership, refuses foreign name collisions, generates a private
password-only file, publishes only to loopback, waits under a deadline, creates
both required extensions, and runs the live capability doctor. The password is
copied into the stopped container and referenced by `POSTGRES_PASSWORD_FILE`;
it is never stored directly in container environment metadata. The lifecycle
pins a Docker endpoint after proving it local, serializes same-project mutations
with an OS file lock, distinguishes paused/restarting states, and surfaces any
rollback failure. Start and stop remain idempotent.

Owned container labels are necessary but not sufficient: every existing
container must mount the exact project-owned named volume read/write at
`/var/lib/postgresql`, and the volume labels are revalidated before reuse. An
orphaned initialized volume without its original password file fails closed;
Cartograph never generates a replacement password for old PGDATA.

On Unix, secret state uses a mode-0700 directory and mode-0600 bounded regular
files opened with no-follow/nonblocking semantics. Group/world-writable
ancestors, state symlinks, and macOS extended ACLs are rejected. Cold image
pulls have a separate longer bound; the readiness deadline covers TCP health,
extension creation, driver connection, and every capability query.

This is not the complete lifecycle yet. Removal, backup/restore, extension/image
upgrade, lease/owner metadata, and Podman support remain M1 work. Credential
creation currently fails closed on non-Unix hosts until a tested Windows ACL
implementation can prove equivalent privacy; v2 must not silently write a
less-protected secret file.

## ParadeDB durability and licensing boundary

As of the verification date, ParadeDB warns that its Community BM25 index lacks
WAL-backed crash durability and physical replication. Cartograph treats the
BM25 index and embeddings as rebuildable derived data. Relational graph state,
source fingerprints, generation metadata, and task/outcome data remain ordinary
PostgreSQL source of truth and are backed up.

The Community tradeoff is acceptable for the local developer deployment only
if an automated crash-recovery test proves detection and one-command reindexing.
Shared/hosted deployments must either use a ParadeDB edition with the required
durability guarantees or explicitly accept reindex downtime. The product must
never describe Community BM25 as crash-durable.

`pg_search`/ParadeDB Community is AGPL-3.0 with a commercial option. Before a
public v2 binary/image or hosted service ships, legal/release review must record:

- whether Cartograph merely connects to a user-installed extension or
  distributes an AGPL-covered combined artifact;
- source-offer and notice obligations for any redistributed image;
- network-use obligations for a hosted Cartograph service;
- whether a commercial ParadeDB license is required for the chosen offering.

No code should try to route around these obligations.

## Migration and cutover

V2 has no SQLite runtime, but migration tooling may read old state once and
write v2 PostgreSQL. That importer is a quarantined command/tool, not a storage
backend:

- The preferred path imports directly from a v1.1.33 PostgreSQL schema.
- An optional one-shot legacy SQLite importer may be shipped separately if user
  data needs it. It cannot be linked into the v2 server or selected at runtime.
- Structural state is validated with counts, stable identities, referential
  invariants, and sampled content hashes.
- Embeddings migrate only when model fingerprint and dimension match; otherwise
  they are regenerated.
- BM25 indexes are always rebuilt by v2.
- Migration is resumable and records its source fingerprint and checkpoint.

The TypeScript runtime can be deleted only after:

1. Golden MCP schemas and representative tool outputs are compatible or have an
   explicitly approved v2 breaking-contract entry.
2. The patch-task evaluation meets or beats the v1.1.33 baseline for hit@5,
   MRR, edit precision, test recall, abstention, and token budget.
3. All supported extraction fixtures and graph invariants pass in Rust.
4. PostgreSQL migration, backup/restore, crash recovery, and extension upgrade
   tests pass on amd64 and arm64.
5. Determinism and scaling gates pass at 1/2/4/8/16 workers.
6. No production Rust dependency graph contains a SQLite crate or native
   library, and repository search finds no selectable SQLite path outside the
   quarantined importer/history.
7. A signed v2 release is built from `main` with provenance and smoke-tested
   native artifacts.

## Objective gates

Every v2 change must pass the relevant subset; release candidates pass all:

- `cargo fmt --all --check`
- `cargo clippy --workspace --all-targets --all-features -- -D warnings`
- `cargo test --workspace`
- dependency/license/advisory audit
- PostgreSQL 18 + pinned ParadeDB integration suite
- migration and backup/restore suite
- MCP JSON-schema and golden-protocol suite
- patch-task retrieval evaluation against the locked v1.1.33 corpus
- 1/2/4/8/16-worker determinism and throughput benchmark
- cancellation, timeout, crash, lock, and child-reaping fault injection
- memory/backpressure budget on a large multi-language fixture
- independent reviewer and Sonar/static-analysis gates

Performance claims require committed benchmark metadata: hardware, database and
extension versions, corpus fingerprint, worker count, warm/cold state, and the
raw report. No benchmark baseline may silently accept a changed corpus.

## Upstream references

- [ParadeDB architecture](https://docs.paradedb.com/welcome/architecture)
- [Install the self-hosted extension](https://docs.paradedb.com/deploy/self-hosted/extension)
- [Run the ParadeDB image](https://docs.paradedb.com/documentation/getting-started/install)
- [Create a BM25 index](https://docs.paradedb.com/documentation/indexing/create-index)
- [`source_code` tokenizer](https://docs.paradedb.com/documentation/tokenizers/available-tokenizers/source-code)
- [BM25 scoring](https://docs.paradedb.com/documentation/sorting/score)
- [Relevance boosts](https://docs.paradedb.com/documentation/sorting/boost)
- [Index-build parallelism](https://docs.paradedb.com/documentation/performance-tuning/create-index)
- [Write-throughput tuning](https://docs.paradedb.com/documentation/performance-tuning/writes)
- [Deployment and Community durability warning](https://docs.paradedb.com/deploy/overview)
- [Upgrade procedure](https://docs.paradedb.com/deploy/upgrading)
- [ParadeDB repository and license](https://github.com/paradedb/paradedb)
