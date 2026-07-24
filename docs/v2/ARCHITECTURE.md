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

The foundation began with `cartograph-config`, `cartograph-db`, and
`cartograph-cli`, proving that the Rust runtime can reject an unsupported
database before any schema mutation. The generation-safe storage slice adds
`cartograph-domain` without adding any non-Serde production dependency to that
crate. The first native language slice adds `cartograph-extract` behind that
domain boundary; its exact contracts and current limitations are recorded in
[`EXTRACTION.md`](EXTRACTION.md).

## Storage model

The initial schema design uses one configured Cartograph schema with explicit
project IDs. Per-project isolation is enforced in every primary/foreign key and
query; deployment-level schema selection remains configurable. A project can be
removed or rebuilt without affecting another project.

Core relations:

| Relation | Key data |
| --- | --- |
| `projects` | stable UUID, canonical root identity, repository fingerprint |
| `index_generations` | generation UUID, project, source revision, state, timestamps, worker settings, content digest and digest-contract version |
| `files` | project, normalized path, language, content hash, size, parse status, generation |
| `symbols` | stable symbol UUID, file/span, kind, qualified name, signature, structural digest |
| `edges` | project, source symbol, target symbol, typed edge, confidence, provenance, generation |
| `references` | project, source span, lexical owner, normalized name, optional resolved target, kind, confidence, resolution provenance |
| `search_documents` | unique bigint key, project/file/symbol, code fields, prose fields, indexed metadata |
| `project_operation_leases` | project/operation key, owner PID/process-start marker, generation, token, heartbeat, expiry |
| `embedding_models` | provider/model fingerprint, dimension, normalization, active/retired state |
| `document_embeddings` | document/model key, unconstrained vector value, source digest, generation |
| `task_traces` | redacted intent, candidate/rank provenance, selected evidence, outcome link |
| `agent_outcomes` | project-local success/failure signal, changed files/symbols/tests, expiry |

All structural writes are staged under a new index generation. A single
transaction atomically marks the generation current only after every required
stage succeeds. Readers always see one complete generation; cancellation or a
worker failure leaves the previous generation current.

The first generation-safe migration implements `projects`,
`index_generations`, `files`, `symbols`, `edges`, `references`, and
`search_documents`. It uses an append-only, checksummed migration ledger in the
configured schema, a transaction-scoped advisory migration lock, project-scoped
foreign keys, and a partial unique index that permits only one `current`
generation per project. Each generation reserves a monotonic project-local
sequence; publication refuses a ready token whose sequence is not newer than
the visible generation, so delayed workers cannot regress the project index.
Schema names are restricted to PostgreSQL's 63-byte ASCII identifier shape,
canonicalized, and still double-quoted wherever SQL must interpolate them.

The Rust write API returns opaque `StagedGeneration`, `ReadyGeneration`, and
`CurrentGeneration` tokens. The only way to obtain `ReadyGeneration` is to
first construct an opaque validated/deterministically reduced/digested fact
capability, then commit its complete file, symbol, edge, reference, and
search-document set in one transaction. The only way to obtain
`CurrentGeneration` is to consume that ready token in the atomic publication
transaction. Ready/current tokens carry the computed logical digest and its
validated contract version. Database constraints remain the second line of defense against
forged or stale process state. Failed operations return the consumed token,
and checked recovery can rehydrate durable `staging`/`ready` state plus its
digest/version pair after process loss or mark it terminally failed.

Migration 2 adds one observable lease row per project and mutating operation.
Each acquisition records a non-nil token, owner PID, boot/session-qualified
process-start marker, optional generation, and PostgreSQL-clock timestamps.
Acquisition uses a non-blocking transaction-scoped advisory lock plus a
conditional upsert: an unexpired row returns `Busy`, while an expired row is
atomically replaced with a new token. Heartbeat and release require the exact
unexpired token, so an old process cannot regain authority after takeover.
Durations are bounded to 1 second through 5 minutes and status exposes expired
rows for diagnosis without granting a mutation token. The append-only runner
applies migration 2 to an existing version-1 schema, rejects ledger gaps, and
still verifies every previously recorded name and checksum.

Migration 3 completes the structural `edge_kind` constraint for all native
relationships. Migration 4 retains unresolved-reference names, lexical owner,
and resolution provenance with an owner index. Migration 5 adds the persisted
logical-digest contract version: historical non-null digests are explicitly v1,
while newly prepared complete-reference generations are v2. The
version-1-to-current live upgrade fixture carries a populated ready generation,
symbol, and reference through versions 2 through 5, proves its digest remains
unchanged and marked v1, then verifies a second migration run is empty.

### BM25 document index

ParadeDB allows one BM25 index per table, so every field used for text matching,
filtering, sorting, or aggregation belongs in the `search_documents` covering
index. The first migration was validated against the pinned extension before
acceptance. Its index shape is:

```sql
CREATE INDEX search_documents_bm25_idx
ON cartograph.search_documents
USING bm25 (
  id,
  project_id,
  generation_id,
  document_id,
  file_id,
  symbol_id,
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

The first reusable M4 stage executor is now implemented in
`cartograph-indexer`. `SupervisorContext::stages()` produces a supervisor-bound
`StageRunner`; callers provide typed envelopes containing a contiguous
stage-local sequence, stable key, payload, reserved/progress byte counts, and
an absolute item deadline. A run also supplies explicit worker and queue caps,
a whole-stage deadline, a separate bounded cleanup grace, a parallel transform,
and one in-order reducer.

The executor admits at most `workers + queued_items` envelopes. Tasks waiting
for a worker permit are the explicit bounded queue and remain registered with
the supervisor's global task/byte scope. A completed out-of-order output keeps
its reservation until the deterministic reducer consumes it, so fast later
files cannot release memory capacity around a blocked earlier file. The input
iterator advances only while a bounded window slot exists; byte pressure can
retain one not-yet-admitted envelope while admitted tasks drain, never an
unbounded producer queue.

Each item deadline covers both queue wait and worker execution and is capped by
the stage deadline. The driver also checks the stage deadline around input,
reduction, and progress, and never reports success after it expires. Iterator
`next` and the per-item reducer are trusted bounded/nonblocking callbacks;
blocking I/O and expensive CPU work must run in the abortable worker future or
a separate supervised stage. Results may complete in any order, but reduction
and observable item/byte progress occur only in exact input-sequence order.
Non-contiguous input, invalid capacity, admission failure, worker failure,
deadline, panic/unexpected exit, reducer failure, progress failure, and parent
cancellation have stable structured outcomes without embedding project paths
or credentials. Failure/cancellation aborts work and reaps it within the
separate cleanup grace; incomplete reaping is a distinct fatal outcome. A
dropped execution future synchronously aborts its retained workers and poisons
the supervisor scope. Completed results are acknowledged only after ordered
reduction and progress, so discarding an incomplete stage cannot permit
publication. Handled parent cancellation remains a cancellation rather than a
worker failure.

Each run can attach a `StageMetrics` observer. Its internally consistent
snapshot distinguishes admitted envelopes, successfully reduced envelopes,
current retained items/bytes, and exact high-water marks. Admission and release
accounting follows the same reservation lifetime as the supervisor task scope,
including out-of-order outputs and every failure/cancellation path. A poisoned
or inconsistent observer is a structured fatal stage error; an already
registered task is still aborted and reaped before that error returns.

CPU stages receive a cloneable `StageCancellation` probe combining parent
cancellation, sibling/stage failure, and the item's effective deadline. Native
Tree-sitter parsing polls it from the parser progress callback; source reading,
AST walking, diagnostic collection, and structural hashing poll it between
bounded units of work. A stage signals cooperative cancellation before it
aborts and reaps tasks, so safe native work can unwind promptly while the task
scope still fails closed if work does not cooperate.

The first real parse/extract adapter now lazily admits validated TypeScript,
TSX, JavaScript, and JSX snapshots through this executor. File and symbol IDs,
exact content hashes, syntax-stable structural digests, declarations,
containment, and unresolved references are deterministic; a complete canonical
digest of every output field is identical at one and four workers. The adapter
uses a trusted fixed-state validation observer and drops each output before its
in-flight reservation is released, so it does not hide a corpus-sized result
vector.

The first end-to-end native fact builder now runs discovery, read/hash,
parse/extract, exact project resolution, and canonical reduction as five
strictly ordered supervisor stages. Discovery is Git-ignore-aware,
`.cartographignore`-aware, deterministic, symlink-nonfollowing, and bounded by
file count plus retained path bytes. Read/hash owns source buffers only inside
admitted workers and reduces them to a compact manifest. Parse reopens each file
under its exact manifest size and rejects hash/language/identity drift before
Tree-sitter runs. Ordered extraction output is converted into separately
budgeted project facts before the parse reservation is acknowledged; neither
snapshots nor raw extracted files are retained for the corpus.

The initial resolver chooses only unambiguous exact evidence: a unique
same-file target or a unique project target. Qualified members remain
unresolved until receiver/type/import evidence exists, so `console.log` cannot
silently bind to an unrelated local `log`. Every reference row retains its
name, lexical owner, span, confidence, and resolution provenance. The canonical
payload contains file and symbol rows, containment plus every current
structural edge kind, resolved/unresolved references, and initial BM25
documents built from paths, names, safe callable declaration signatures, and JSDoc.
Non-callable initializer values and callable signatures containing default or
literal expressions are removed before persistence. A live test
executes this path through supervised five-table COPY, publication, and
ParadeDB search.

This is a bounded in-memory generation, not streaming resolution: a separate
hard cap accounts retained project facts and anticipated documents. Resolve
charges candidate/index/output allocation against a three-times envelope;
canonical validation iteratively and cooperatively measures actual outer-vector
and JSON-array capacities, then polls each fact, map conversion, and relation
build under a four-times working-set envelope. Input/output byte measurements
are carried in the stage report so Tokio workers never rescan the corpus.
Exceeding either fails the generation. A measured
real-corpus gate must decide whether v2 needs
partitioned/spilled resolution or streaming database reduction. Tree-sitter's
C allocator is still not constrained by Rust accounting, so process RSS remains
a release measurement. Git tracked files newly covered by ignore rules,
module/import aliases, symbol-body search text, and embedded-repository parity
also remain explicit follow-ups.

`GenerationContents` can independently attach `PrepareGenerationMetrics`. That
observer measures only the five-table PostgreSQL COPY stream, including bounded
row encoding, and deliberately excludes validation, fencing, ready/publication
transitions, and verification queries. Benchmark code therefore does not
mislabel the broader prepare transaction as COPY time.

Workers emit normalized facts keyed by stable path/span/symbol identities. A
single deterministic reducer sorts and deduplicates facts before computing the
generation digest. Running with 1, 2, 4, 8, or 16 workers over the same snapshot
must produce the same logical database digest and retrieval fixture results.

The first committed [1/2/4/8/16-worker baseline](benchmarks/INDEX-SCALING.md)
proves that invariant through real COPY, publication, and ParadeDB BM25 on 30
runs. On the measured 14-logical-CPU arm64 host, supervised Parse-plus-Reduce
throughput rose from 1,696 to 6,754 items/s while end-to-end median time fell
from 240.11 ms to 116.38 ms. COPY p50 remained near 57-67 ms and became the
dominant floor. The
reported stage and reservation high-water include both supervised Parse and
one-item canonical Reduce; its explicit 256 MiB ceiling is the peak reservation
at every worker count. Until the
real extractor corpus supersedes this synthetic baseline, parse/extract uses an
initial cap of `min(available_parallelism, 16)`, one queued envelope per worker,
and the independent supervisor byte budget as the final admission authority.
COPY remains one retained database task.

PostgreSQL `COPY` is used for bulk staging. Parallel workers never issue
independent destructive maintenance. Advisory locks are scoped by project and
operation, carry observable owner metadata, and have supervisor-enforced
deadlines.

The first COPY implementation accepts an opaque `CanonicalGenerationFacts`
capability, never unordered raw facts. A supervised blocking reduce stage first
validates database bounds, normalized project paths, finite confidence values,
branded relationships, and document-to-symbol/file consistency. Its
cancellation-polled deterministic reducer orders by stable logical keys,
removes canonically equivalent facts, rejects conflicting identities, and
encodes JSON metadata with recursively sorted object keys. The async database
prepare task therefore reaches its first PostgreSQL await without performing a
synchronous cloning reduction on a Tokio worker.

The reducer computes a domain-separated v2 BLAKE3 logical-generation digest from typed,
length-delimited canonical fields. The digest deliberately excludes project
ID, generation UUID/sequence, worker count, PostgreSQL identity keys, and input
order; those are execution/deployment details rather than source facts. It
includes normalized source/file hashes, structural spans and digests, graph and
complete reference owner/name/confidence/provenance evidence, search text, and
canonical metadata. PostgreSQL stores version 2 beside new digests and preserves
version 1 beside historical rows rather than reinterpreting or recomputing them.

Persistence then streams PostgreSQL text COPY in bounded chunks, with explicit
escaping for tabs, newlines, carriage returns, backslashes, control bytes, and
the `\N` null marker. Tables load in foreign-key order: files, symbols, edges,
references, then the ParadeDB-indexed search documents. Every COPY completion
count must equal the reduced row count. All five loads and the transition to
`ready` share one transaction; a late COPY/trigger failure rolls back earlier
tables and returns the original staging token.

The database lease substrate is implemented for `index`, `sync`, `hook`,
`migration`, and derived-index `rebuild` operations. Its database-wide advisory
key includes the configured schema, project, and operation. It uses
PostgreSQL's clock for expiry and heartbeat rather than process wall time,
returns immediately on contention, and permits deterministic stale-owner
takeover.

The first M4 supervisor foundation now owns lease acquisition, renewal,
reconciliation, cancellation, terminal generation transitions, and exact
release. The persistence layer still deliberately does not infer process
liveness from PID reuse alone.

## Process supervision

V1.1.33 exposed a concrete failure mode during release work: a hook worker
could outlive useful progress for many minutes while holding the project lock.
V2 cannot inherit that process model.

The Rust `cartograph-indexer` foundation provides:

- parent-to-child cancellation propagation;
- abort escalation after a bounded grace period, followed by an awaited join;
- child and PostgreSQL-task reaping on every normal, error, timeout, explicit
  cancellation, caller-abort, and caller-future-drop path;
- stage heartbeat and progress timestamps;
- lock owner PID/process-start identity plus operation and generation;
- lease renewal and safe stale-owner recovery;
- a maximum runtime for hook-triggered work;
- status output that distinguishes queued, active, cancelling, and wedged work.

The public `run` future immediately transfers the operation to one owned Tokio
task. Its guard retains the exact spawning runtime handle, so dropping a
previously-polled future from a non-runtime thread still schedules bounded
cleanup on the correct runtime. Cancellation is linearized with publication:
once publication begins, a late cancellation cannot turn a committed
generation into a reported cancellation; before that gate, cancellation closes
the worker and prepare scopes, reaps all retained tasks, fails the owned
generation, and releases the exact lease.

Worker admission has both task and byte caps and no hidden queue. Every worker
result must be joined and observed before publication. Prepare/COPY authority
is a distinct capability from terminal publication/cleanup authority, and the
pipeline context never exposes the lease fence. The one prepare operation is a
retained task with its own server-side COPY deadline, independent of the short
heartbeat request deadline.

Durable PostgreSQL operations run in retained tasks with server-bounded
transactions and explicit rollback. After the operation then generation
advisory locks are acquired, prepare performs a non-row-locking exact-token,
generation, and database-clock expiry check before entering COPY. It repeats a
row-locking fence check immediately before the ready transition. Acquisition,
publication, cleanup, and uncertain timeouts reconcile durable state before
retrying or reporting an ambiguous outcome.

The current live pinned-ParadeDB suite has 23 supervisor cases. It covers
success, heartbeats, progress stalls, whole-operation deadlines, lost leases,
takeover, bounded acquisition/publication/cleanup reconciliation, dropped child
failures, long COPY payloads, blocked COPY/publication/cleanup, simultaneous
heartbeat and COPY uncertainty, caller task abort, and dropping a polled public
future outside the runtime. The added stage integration case forces reverse
parallel completion, proves exact ordered reduction/progress, then reaches
supervised COPY and publication on PostgreSQL/ParadeDB. Lock-injection cases
prove zero active schema work, free operation/generation advisories, correct
generation state, and exact lease disposition before the external blocker is
released.

The remaining M4 fault matrix must exercise each real discover/read/parse/
resolve/merge/BM25/vector stage after those stages exist; the supervisor
substrate itself is implemented rather than deferred.

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

Successful managed start also applies the append-only Cartograph schema ledger
inside that readiness deadline, using the same validated configured schema as
external connections. Its report identifies that schema and distinguishes
newly applied migration versions from an idempotent reuse; a migration failure
is part of startup failure rather than a partially reported success.

This is not the complete lifecycle yet. Removal, backup/restore,
extension/image upgrade, supervisor integration for lease renewal, and Podman
support remain work. Credential creation currently fails closed on non-Unix
hosts until a tested Windows ACL implementation can prove equivalent privacy;
v2 must not silently write a less-protected secret file.

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

V2 has no SQLite runtime and no SQLite importer. No v2 binary, migration tool,
test utility, or optional feature may link a SQLite driver or read a SQLite
database. Supported cutover paths are deliberately narrower:

- Import directly from a v1.1.33 PostgreSQL schema.
- Rebuild v2 PostgreSQL state from the source checkout when no v1 PostgreSQL
  state exists.
- A user who needs to preserve a v1 SQLite index must use v1.1.33 to migrate it
  to PostgreSQL before starting the v2 cutover; v2 never opens the old file.
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
   library, and no v2 runtime, importer, optional feature, or test helper can
   select or open SQLite.
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
