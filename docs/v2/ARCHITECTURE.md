# Cartograph v2 architecture

Last implementation review: 2026-07-24

Cartograph v2 is a native Rust code-intelligence server for AI coding agents.
PostgreSQL 18 is its only durable store, ParadeDB `pg_search` provides
code-aware BM25, and pgvector provides model-scoped semantic retrieval. Exact,
lexical, graph, review, freshness, and affected-test workflows require no LLM.

## Hard boundaries

- No SQLite driver, file, fallback, compatibility mode, importer, optional
  feature, or test utility is shipped.
- No Bun/Node/TypeScript runtime is shipped. The v1.1.33 implementation is only
  a historical behavior/migration oracle and is removed from the v2 tree.
- The browser visual-graph viewer is the sole intentional v1 capability
  removal. The underlying typed graph, callers/callees, paths, impact,
  similarity, dependency/import queries, and machine-readable interchange stay
  release requirements; no other feature may be dropped to declare parity.
- Cartograph archives contain only the native executable and allowlisted MIT/
  third-party notices. PostgreSQL, ParadeDB, pgvector, and images remain
  separately installed software.
- Database URLs are environment/local-state secrets. Public errors, debug
  output, MCP responses, archives, and project records do not render them or
  absolute checkout paths.
- Generative output is optional and cannot replace structural truth. Embedding
  and reranker tiers use OpenAI-compatible HTTP; chat tiers support
  OpenAI-compatible HTTP, Anthropic Messages API, and the bounded local Claude
  bridge. Ask, generated summaries/roles, and LLM dead-code judging preserve
  evidence/model provenance and explicit failure/fallback states.

## Crate ownership

| Crate | Responsibility |
| --- | --- |
| `cartograph-domain` | Branded IDs, enums, source language/path/digest contracts, project identity, canonical manifest digest |
| `cartograph-config` | PostgreSQL-only secret settings and bounded pool/timeouts |
| `cartograph-extract` | Bounded discovery/read/hash, native tree-sitter parsing, declarations/references, deterministic resolution |
| `cartograph-db` | Capabilities, migrations, leases/fences, COPY, publication, retrieval, semantic storage, v1 import, retention, managed lifecycle |
| `cartograph-indexer` | Bounded parallel stages, deterministic reduction, supervisor/cancellation/reaping, corpus-aware workers |
| `cartograph-search` | Exact/BM25/hybrid evidence, typed intent, graph traversal, RRF, affected tests, trust/abstention |
| `cartograph-scip` | Bounded zero-runtime protobuf codec, exact typed-edge extension, deterministic export, per-file replacement overlay |
| `cartograph-llm` | Bounded redacted embedding/reranker/chat clients, provider config, model identity, and local backend supervision contracts |
| `cartograph-agent` | Project runtime, freshness, indexing, embedding sweeps, Git review, source excerpts, working-tree overlay |
| `cartograph-mcp` | Bounded stdio JSON-RPC/MCP protocol, profiles, cancellation, stable errors |
| `cartograph-cli` | Native command routing, database operations, MCP adapter, project-local agent installation |

Dependencies point inward through typed contracts. MCP/CLI do not issue SQL;
database code does not read arbitrary project files; extractors do not know
about PostgreSQL or transport.

## Database capability and schema

Before migration or normal work, Cartograph proves:

- PostgreSQL 18.4 or newer within major version 18;
- `pg_search` 0.25.0, expected preload state, the `paradedb` access method, and exact
  `pdb.source_code` token behavior;
- pgvector 0.8.4 or newer, with 0.8.5 recommended for external PostgreSQL;
- bounded DML/DDL capability in the selected safely quoted schema.

The append-only migration ledger currently owns twenty-three versions. Migration
23 adds virtual parse-cache payload accounting and table-local autovacuum policy
for high-churn generation, fact, and cache relations. Core relations:

| Relation | Purpose |
| --- | --- |
| `projects` | Privacy-preserving project root identity and current generation pointer |
| `index_generations` | Staging/ready/current/superseded/failed lifecycle, sequence, source/content digests |
| `files` | Generation-scoped normalized path, language, content hash, parse status |
| `symbols` | Generation-scoped declaration identity, kind, range, safe signature, visibility, export/default-export, async/static, and declaration-only semantics |
| `edges` | Typed symbol relationship, confidence, provenance, represented site count |
| `references` | Exact/coarse source evidence, owner/target, byte span, multiplicity |
| `search_documents` | Canonical durable code/name/natural-text documents and stable document identity |
| `generation_search_relations` | Verified catalog for immutable generation-local BM25 tables and indexes |
| `project_operation_leases` | Observable PostgreSQL-clock ownership and fencing |
| `embedding_models` | Model fingerprint, provider/name, dimension, lifecycle/readiness metadata |
| `document_embeddings` | Model- and generation-scoped vectors |
| `v1_import_runs/checkpoints` | Exact resumable v1.1.33 PostgreSQL cutover state |
| `coverage_sources/symbol_coverage` | Generation-fenced LCOV provenance and symbol coverage |
| `file_history/file_cochanges/symbol_issues` | Bounded Git churn, co-change, and issue-tagged symbol evidence |
| `agent_artifacts/mcp_sessions/mcp_tool_calls/mcp_macros` | Durable notes/summaries/roles, investigations, usage audit, and macros |
| `symbol_similarity_edges/symbol_similarity_builds` | Model-scoped materialized similarity with exact build provenance |
| `native_parse_cache` | PostgreSQL-backed deterministic parse-result cache |
| `summary_priority_queue` | Generation/evidence-fenced agent-demand summary priority |

Generation foreign keys cascade only through explicit generation deletion.
Ordinary indexes support identity/filter joins. BM25 ranking is intentionally
not global: each ready/current generation owns a derived physical
`search_g_<generation UUID>` table and matching `_bm25` index. The identifier is
derived only from a validated globally unique generation UUID (enforced by
migration 11), and the catalog binds it to the project, content digest, row
count, and relation-format version.

## Project identity and source freshness

The canonical checkout path is hashed under a domain separator. PostgreSQL
stores `project:<digest>`, never the path. Agent runtime and v1 importer call the
same domain helper, preventing invisible duplicate projects or path disclosure.

The complete supported-source revision is built from an exact count plus
ordered normalized path/content-digest pairs through one shared domain builder.
Indexer, status, source context, and importer use the same encoding. An imported
schema must contain exactly the checkout's supported path/content set; missing,
extra, or substituted paths fail before durable mutation.

`fresh=true` means the current generation recorded exactly that complete live
manifest under the native generation-digest contract emitted by the running
binary. A newer extractor, resolver, or test-ownership contract therefore marks
an unchanged checkout stale and makes an ordinary index publish a replacement;
it cannot reuse older graph semantics as a source-only no-op. Unknown or stale
state lowers confidence and is never treated as a clean result.

## Native extraction

Current production admission covers all 73 v1.1.33 language modes plus native
TOML: 61 pinned grammar-backed modes and 13 bounded Rust custom scanners. The
163-extension v1 manifest is exact; `.pyi` and `.toml` are additive
improvements. Every family has
literal-safety and cancellation tests, deterministic 1-vs-4 worker facts, and
live PostgreSQL/ParadeDB COPY, publication, and BM25 evidence. Unknown discovery
remains fail-closed. Framework and cross-language resolver parity is tracked as
a distinct release gate rather than being inferred from language admission.

For each admitted file:

```text
discover -> bounded read/hash -> tree-sitter parse -> typed facts
         -> deterministic module resolution -> canonical reduce/digest
```

Facts include deterministic IDs, exact paths/ranges, symbol/reference kinds,
literal-free callable signatures, confidence, provenance, diagnostics, and
multiplicity. Ambiguous references remain unresolved.

See [native extraction](EXTRACTION.md) and the
[extension guide](../EXTENDING-EXTRACTORS-RESOLVERS.md).

## Bounded parallel indexing

The supervisor selects a corpus-aware worker count from both supported-file
count and exact indexed source bytes, bounded by the caller, hardware, and the
measured 1/2/4/8/16 policy. Every stage has item/task/byte admission, ordered
envelopes, cooperative cancellation, stage/item/operation deadlines, and
retained-worker cleanup.

```text
discover -> read/hash -> parse/extract -> resolve -> optional SCIP overlay -> deterministic reduce
         -> COPY canonical staging rows -> relation/digest validation
         -> populate generation search table -> build/verify BM25
         -> scoped planner statistics -> ready
         -> validate exact relation again -> publish
```

Workers complete out of order; the reducer commits in input order. Canonical
facts and five PostgreSQL COPY streams are bounded and checked. A failed search
table or index build rolls back with the staging transaction and therefore
cannot reach `ready`. Publication is atomic: it first requires the exact
generation relation and catalog to remain valid, then one transaction swaps the
current pointer and supersedes the prior current generation.

After an actual COPY, preparation runs column-targeted `ANALYZE` only on the
five copied relations before the generation can become ready. The relations
are visited in one deterministic order, and a contended statistics lock waits
under the connection/prepare statement deadline instead of being silently
skipped; timeout or query failure rolls the generation preparation back. This
prevents immediate status/issue-history reads from racing PostgreSQL's first
autoanalyze while avoiding the v1 failure mode of database-wide maintenance on
an unchanged/no-op index.

The public future owns the operation even when a caller cancels/drops it.
Supervisor tests cover queued/running cancellation, timeouts, slow/hung/panicked
work, database faults, lease uncertainty/takeover, caller-future drop, child/task
reaping, rollback, and publication cleanup. The committed worker matrices must
retain identical digest, rows, edge kinds, diagnostics, and ordered BM25 IDs.

## SCIP interchange without a visual viewer

Export reads one repeatable-read current-generation snapshot and then requires
the live project bytes to match every stored file hash before writing an atomic
project-local artifact. Standard SCIP definitions, relationships, occurrences,
UTF-8 byte ranges, documentation, and readable stable symbols are emitted. A
protobuf-compatible private field on `SymbolInformation` additionally carries
every Cartograph edge kind and exact site count; foreign SCIP consumers ignore
the field, while Cartograph round-trips calls, imports, tests, containment,
type/use, framework, and cross-language edges without degrading them to generic
references.

Import is a persistent overlay, not a direct database mutation. The validated
artifact is atomically installed at `.cartograph/scip/overlay.scip`; its digest
is part of source freshness. During every subsequent index, matching documents
replace native non-file facts for those files, native IDs are reused only on an
unambiguous kind/name match, uncovered files remain native, unresolved foreign
targets stay explicit, centrality is recomputed, and canonical validation runs
before COPY. Import forces publication and restores the previous artifact when
publication fails and no competing writer replaced the requested bytes.

## Leases and fencing

Write-bearing operations acquire a project/operation lease with:

- PostgreSQL-clock acquisition, heartbeat, and expiry;
- owner/process marker, operation, optional generation, and monotonic fence;
- transaction/advisory locks for publication, import, retention, and derived
  index replacement;
- exact fence checks immediately before commit.

An expired/replaced lease fails the operation and rolls back. Cleanup/release
errors cannot mask the primary lost-fence error.

## BM25 and exact retrieval

The covering search document includes project/generation/file/symbol identity,
path, language, document kind, qualified name, code, and natural text.
Qualified name and code use `pdb.source_code`, which separates snake_case and
camelCase. Natural documentation uses text tokenization.

Each bounded read starts a repeatable-read transaction, validates the caller's
expected generation against `projects.current_generation_id`, requires its
verified catalog/table/index, and queries only that physical generation table.
Other projects and ready/superseded generations therefore cannot change BM25
scores or ordering. A pointer change yields `CurrentGenerationChanged` rather
than mixed evidence. Stable tie-breaking uses the document key. Every hit
returns native score plus ordered field-component provenance. Typed task intent
selects explicit qualified-name/code/natural-text boosts; user text remains a
bound parameter, never interpolated SQL.

Migration/startup reconciliation checks current and ready generation relations
with unhealthy relations ordered first. It repairs at most 64 per invocation
from canonical `search_documents`, fails closed when further repair is needed,
and removes at most 64 strictly parsed unowned `search_g_...` tables. Every
build/drop holds a generation-specific transactional advisory lock. Retention
drops the physical table before deleting that terminal generation's canonical
cascades; row, relation-byte, DDL-count, and generation-count budgets bound one
cleanup transaction.

Exact current-generation name, path, reference, symbol-ID, and graph queries are
separate bounded paths. Reference evidence retains exact versus coarse precision
and represented site counts.

## Semantic and hybrid retrieval

Embeddings are optional; pgvector capability is mandatory so the storage shape
is predictable. A model registration fixes provider, name/fingerprint,
dimension, and normalization. Vectors are isolated by model and generation,
with a dimension-validated model-scoped HNSW expression index.

Before semantic Top-K, Cartograph proves the model is active, fingerprint and
dimension match, current-generation document coverage is complete, HNSW exists,
and a query probe succeeds. Readiness is one of `ready`, `not_configured`,
`not_indexed`, `stale`, or `unavailable` at the agent boundary.

For automatic/hybrid mode, BM25 and eligible semantic requests run concurrently
under shared cancellation/deadlines. Reciprocal-rank fusion combines ranks—not
raw BM25/cosine scales—and retains channel rank/score provenance. If semantic
evidence is not ready or empty, the packet labels the exact lexical fallback.

## Intent, graph policy, and evidence packets

Natural-language context is classified without an LLM into:

- symbol lookup;
- implementation trace;
- change planning;
- test selection;
- error diagnosis;
- architecture survey;
- documentation lookup.

Priority-ordered bounded term tables make classification deterministic. Intent
selects candidate/exact/evidence/affected-test limits and graph behavior:
symbol/docs avoid irrelevant expansion, implementation/architecture follow
outgoing calls, and change/test/error requests follow reverse impact with
affected-test selection.

Packet assembly adds exact anchors, BM25/semantic candidates, then bounded graph
evidence. It deduplicates and orders evidence by reason/path/line/identity. A
separate typed, bounded `editCandidates` set promotes explicit anchors first;
without one, it promotes only files tied for the strongest distinct code-aware
task-term concentration across qualified names and paths. The broad evidence is
retained for impact and uncertainty instead of being discarded by that primary
edit-site decision.

Packets return generation, intent, freshness, confidence, abstention, channel
provenance, primary edit candidates, affected tests, and truncation. No query or
full source body is persisted as telemetry.

## Working-tree overlay and review

When durable source is stale, CLI/MCP context can inspect changed/untracked
supported files relative to `HEAD`. Git execution is shell-free,
noninteractive, output/deadline bounded, and reaped. The native source reader
then applies per-file/aggregate bytes, cancellation, supported-language, root,
UTF-8, and result bounds.

Matching live items carry path, Git change kind, exact content digest,
line-bounded UTF-8 excerpt, matched terms, and truncation. Overlay states are
`not_checked`, `clean`, `no_matches`, `used`, or `unavailable`. Overlay facts
remain separate from immutable graph evidence and do not upgrade stale
confidence.

`review --ref` separately resolves an immutable base commit and combines
committed/staged/unstaged/untracked paths with current-generation exact file,
reverse-impact, and affected-test evidence. It reports dirty state, freshness,
abstention, and per-stage truncation.

## MCP and CLI boundary

The MCP crate serves newline-delimited JSON-RPC over stdio with deterministic
tool schemas/profiles, bounded input/output/concurrency, hard request deadlines,
cancellation and worker reaping, redacted internal failures, and stable error
codes. Product handlers call the agent/search services; transport never reaches
through to SQL or filesystem internals.

The CLI exposes the same typed services plus managed database and project-local
MCP installation. Background admin work has explicit job IDs/status/cancel; it
is not an unbounded detached process.

## Managed PostgreSQL

On macOS/Linux, `db start` owns a pinned upstream ParadeDB container and private
volume/credential, binds only loopback, validates exact labels/mounts/identity,
and proves all capabilities. Status/logs/stop/backup are explicit. Restore,
upgrade, derived-index rebuild, remove, import, and prune require exact
operation-specific confirmation and have rollback/recovery tests.

Windows supports external PostgreSQL; managed lifecycle is withheld until
credential ACL behavior can prove equivalent privacy.

## V1 import and retention

V2 imports only from a v1.1.33 PostgreSQL schema in the same database as a
distinct v2 destination. That destination may already have a current
generation; import publishes a new immutable one. Operators quiesce project
index/sync/hook/rebuild writers to avoid wasted work. Dry-run validates source
schema/history, bounded streaming legacy JSON, supported language/path/content identity, rows,
coordinates, hashes, relations, canonical facts, and memory/output admission.
Mutation uses exact leases, staged/ready/BM25/complete checkpoints, rollback, and
same-input resume. It never reads SQLite.

A concurrent publisher cannot corrupt or strand an import: the stale
generation is failed/released atomically, the caller receives
`ConcurrentPublication`, and an identical retry can reset the failed durable
run and allocate a newer sequence after writers are quiesced.

Legacy multiplicity is retained. A span is exact only when the stored/current
source proves the full token; otherwise it is explicitly coarse. SCIP
placeholder hashes cannot prove historical bytes v1 never stored.

Every successful index or no-op reconciliation attempts bounded generation and
parse-cache retention after publication/no-op detection. The current extractor
contract is always cache-protected; one recent older contract plus independent
row/logical-byte/deletion caps prevent unbounded parser-version accumulation.
Pre-supervisor failures terminalize
their exact staging generation under the same project advisory lock used by
lease acquisition. A later batch can collect staging only when it is old,
unleased, and not referenced by an incomplete import. Ready work becomes
eligible only after a longer age floor when it is unleased, non-current, and
outside import recovery. `db prune` uses the same bounded engine for larger
explicit batches of stale staging/ready, failed, and old superseded generations,
always preserving current, recent/leased work, import recovery state, and
configured recent histories. Retention locks
publication, rechecks its exact migration lease before commit, drops selected
derived BM25 relations transactionally, and reports admitted cascade rows,
relation count, and physical relation bytes. Status and doctor expose all
generation-state counts and a conservative retained-byte estimate.

`db usage` reads a repeatable, bounded storage snapshot with schema heap/index/
TOAST, cache, generation, dead-row, autovacuum, invalid-index, and deduplication
evidence. Content-addressed fact sharing is deliberately assessment-only until
a schema migration can preserve immutable generation identity and cascades.
`db compact` dry-runs by default and can rebuild eligible B-trees one at a time
with PostgreSQL's concurrent reindex path after explicit confirmation and
headroom proof. Heap-rewriting `VACUUM FULL` remains outside automation.

## Security, durability, and licensing

- Inputs, rows, bytes, tasks, output, deadlines, and retries have hard caps.
- Dynamic identifiers are parsed/quoted; user query text is always bound.
- Secret/query/path text is omitted from public errors and debug output.
- Source reads stay within a canonical project root and reject unsupported/
  oversized/non-UTF-8 data.
- Release archives are allowlisted and scanned for local paths/database bits.
- Community ParadeDB BM25 is treated as rebuildable local derived state, not
  crash-durable replicated production state.
- Shared/hosted/paid use requires a separate durability and AGPL/commercial
  licensing decision. Cartograph does not bundle the extension/image.

See [the distribution policy](LICENSING.md).

## Release evidence

Stable release requires format, strict Clippy, workspace tests, cargo-deny,
SQLite-free dependency/source proofs, live PostgreSQL/ParadeDB capability and
fault suites, semantic/import/retention/agent evaluations, deterministic worker
matrices, Rust LCOV plus Sonar quality gate, structural floor, independent
review, native archive privacy/smoke audits, five-platform CI builds, checksums,
provenance, signed tag, and exact tag/main/release SHA identity.

The complete remote gate runs once for the exact published `main` SHA. Its
quality, Windows, Linux-baseline, and sharded live PostgreSQL jobs produce a
GitHub-attested SHA-bound manifest. A tag-triggered release must verify that
manifest's repository, workflow, source digest, `refs/heads/main` source ref,
GitHub-hosted runner provenance, and required-job set before any platform build.
The tag workflow then performs only release-specific five-platform build,
archive, checksum, provenance, and publication work; it never substitutes the
attestation for the local Sonar or independent-review requirements.

Primary upstream references:

- [ParadeDB repository and license](https://github.com/paradedb/paradedb)
- [Create a BM25 index](https://docs.paradedb.com/documentation/indexing/create-index)
- [Code tokenizer](https://docs.paradedb.com/documentation/tokenizers/source-code)
- [Relevance boosts](https://docs.paradedb.com/documentation/sorting/boost)
- [BM25 scoring](https://docs.paradedb.com/documentation/sorting/score)
- [pgvector HNSW](https://github.com/pgvector/pgvector#hnsw)
