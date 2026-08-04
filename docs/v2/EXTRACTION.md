# Native extraction contract

Cartograph v2 extracts every v1.1.33 language mode in Rust. The extractor owns
bounded project discovery, exact source snapshots, grammar or custom structural
parsing, structural facts, deterministic resolution, and canonical generation
input. It does not depend on PostgreSQL, MCP, or an LLM.

## Supported language families

The authoritative, exhaustively tested manifest is
`cartograph_domain::SourceLanguage::ALL`: all 73 v1.1.33 modes and their 163
extensions, plus additive `.pyi`, native TOML, and 52 dedicated textual
game-scripting modes. The
implementation is divided into:

- JavaScript/TypeScript, Rust/Python/Go, query-tag, C-family, shell, managed,
  JVM-dynamic, and conservative grammar-backed structural walkers;
- parser-only structural file documents for CSS, embedded templates, JSDoc,
  JSON/Jupyter, and regex sources;
- bounded custom scanners for Aura, BG3 Anubis/resources/stats, Liquid, Osiris,
  properties, Svelte, TOML, VB6, Visualforce, Vue, MyBatis XML, and the
  [researched game-scripting inventory](GAME-SCRIPTING-LANGUAGES.md).

Unknown extensions are excluded by discovery and rejected when explicitly read.
They do not produce a misleading “successful empty graph.” The v1 PostgreSQL
importer applies the same language boundary.

## Source boundary

`SourceRoot` canonicalizes and validates a project directory. A source read:

1. accepts a validated project-relative `NormalizedPath`;
2. verifies the extension is supported;
3. resolves inside the canonical root;
4. requires a regular file;
5. streams bounded chunks while polling cancellation;
6. enforces per-file bytes before and during the read;
7. validates UTF-8 across chunk boundaries;
8. computes the exact BLAKE3 content digest;
9. produces an immutable `SourceSnapshot` with language, path-derived file ID,
   byte size, digest, and source.

Discovery follows Git-compatible ignore rules and has file/path/manifest byte
ceilings. Local Cartograph state, Git internals, build outputs, and ignored
paths do not enter the supported-source revision.

## Complete source revision

Freshness is the digest of an exact file count followed by normalized
path/content-digest pairs in deterministic order. The encoding lives in
`cartograph-domain::SourceManifestDigestBuilder` and is shared by agent status,
source context, indexing, and v1 import. An exact set mismatch fails closed.

Generation freshness additionally requires the current native generation-digest
contract. Contract V13 fences named TypeScript and JavaScript construction
targets; contract V12 fenced stable bounded Go and Python anonymous call-target
normalization; contract V11 fenced anonymous Rust call-target normalization;
contract V10 fenced call-target-precise
secret exposure and incomplete-implementation evidence; contract V9 fenced JSX executable-line
ownership, SQL/document/secret health precision, Python intrinsic and receiver
provenance, React lazy default consumers, and TypeScript `typeof` value
consumers; contract V8 fenced
context-classified URL and serial-loop evidence, facade roles, and semantic
clone compatibility; contract V7 added generation-scoped static numerical
sites; contract V6 fenced framework, resolver, test-ownership, and Rust Cargo
workspace crate/re-export semantics.
After an upgrade from an older contract, unchanged source remains stale until a
normal index publishes current-contract facts. This contract check stays
separate from the source-manifest digest so v1 import still compares exact
checkout bytes rather than a binary-specific identity.

## Parsing and facts

`NativeExtractor` chooses either the pinned tree-sitter grammar or the bounded
custom structural scanner from the snapshot's typed language. Grammar-backed
paths use bounded parse callbacks; every path polls cancellation and enforces
fact/string/modeled-output limits. Grammar-backed malformed syntax returns
recoverable diagnostics instead of panicking.

The walker emits:

- file and declaration identities;
- symbol kind/name/qualified name/visibility/export/async/static state;
- exact one-based line and byte spans;
- import bindings and module specifiers;
- typed references and containment;
- privacy-safe Rust numerical sites with exact span, operation, potential
  hazard, visible precision, deterministic confidence/provenance, and explicit
  unknowns;
- safe callable signatures and body-search text;
- parser diagnostics.

Immediately invoked Rust closures have no stable declaration target, so their
source bodies are never retained as named call references. Calls inside the
closure remain ordinary typed evidence.

A synthesized qualified or reference name that exceeds its canonical storage
bound is shortened rather than fatal: one ordinary construct — a long method
chain, or a re-export group naming a module's whole public surface — must never
cost the whole index. The shortened form keeps a prefix cut on a character
boundary, a `~` marker, and a digest of the exact original name, so it is
deterministic across re-extraction and keeps distinct originals distinct. The
file then carries a `canonical_name_truncated` diagnostic, so a shortened
identity is never mistaken for the complete one.

A bounded field with no safe shortening still fails canonical reduction, and the
failure now names the exact rejected storage field —
`canonical_field_rejected(<field>)` — without rendering the name, source,
project path, database URL, or driver text. Naming the field is what turns a
whole-corpus bisection into a single run.

The same stable-target rule applies to immediately invoked Go function
literals and Python lambdas. For an oversized Go call expression,
composite/nested/unary targets are omitted instead of retaining an unstable
source-sized name; an oversized selector retains only its bounded stable field
and remains dynamic-dispatch evidence.

Callable signatures are normalized to exclude literal-bearing bodies/values.
Search text is intentionally useful for code identifiers without becoming a
secret or source-literal dump.

The first numerical contract is `rust_ast_v1`. It detects arithmetic before a
widening cast, absolute-only tolerance comparisons, low-precision reductions,
domain-sensitive functions, NaN-sensitive ordering, and narrowing before
accumulation. These are bounded static heuristics. The persisted expression
identity is a source-version-fenced digest; source expressions and literal
values are not persisted. Runtime observations and formal proof are separate
future adapters and remain explicitly `not_configured` in current status/tool
responses.

Structural-health extraction also retains bounded context, not raw literals:
URL sites are separated into request destinations, endpoint configuration, and
presentation/validation/data abstentions; JavaScript awaited loops retain
loop-carried dependency, post-await exit, and explicit serial-intent
abstentions; returned-object facade factories retain their delegate count; and
clone profiles retain domain-separated identifier fingerprints only. These V8
facts let PostgreSQL findings explain why a site was actionable or abstained
without persisting a URL, identifier, or source expression.

## Resolution

Resolution runs after extraction. It prefers exact module/path and qualified
scope evidence and keeps ambiguous or dynamic cases unresolved.

Unresolved evidence remains typed by provenance. In particular, Rust macro
invocations that would require expansion, dynamic receiver/member access,
language intrinsics, and explicit non-local imports remain targetless rather
than being guessed as project declarations. Static embedded-SQL references
resolve to indexed SQL tables when available and otherwise retain typed
external-schema read/write/DDL provenance. Project-actionable unresolved
pressure is computed separately from those expected language boundaries.

Implemented language-level behavior includes:

- relative TypeScript/JavaScript module specifiers and common extension/index
  probing;
- import bindings, named/default/namespace shapes represented by typed facts;
- lexical/containment-aware local references;
- Rust/Python/Go and the remaining production families' declaration and
  call/member reference shapes;
- Cargo-workspace Rust crate roots, public inline-module paths, and named
  `pub use` facades, with package-scoped cross-crate resolution that preserves
  private-module and ambiguous-package boundaries;
- component/template, Salesforce markup, MyBatis, VB6, properties, Liquid, and
  BG3/Osiris domain semantics;
- bounded npm/Composer/Cargo package and workspace manifest facts, including
  dependency-section provenance, workspace membership/exclusions, and
  target-specific Cargo dependencies;
- Fastify object-form routes and NestJS HTTP, GraphQL, message-pattern, and
  WebSocket handler relationships after deterministic framework detection;
- edge kinds required by current graph retrieval, with confidence, provenance,
  and represented site count.

Language-mode admission is complete. Framework and cross-language resolver
parity remains a separate release gate; a language being native never implies
that every framework hook for that language is complete. Expansion follows the
[native extension guide](../EXTENDING-EXTRACTORS-RESOLVERS.md) and must add the
complete discovery/parser/resolution/search/import/freshness contract.

## Deterministic canonical generation

The indexer converts extracted files into canonical facts:

- project and generation identity;
- files, symbols, typed edges, exact/coarse references, static numerical sites;
- search documents for file/symbol code/name/natural text;
- deterministic row ordering and logical digest;
- literal row/count/byte admission reports.

Resolution output has one stable logical reduction contract and two physical
paths. The memory path reduces in Rust before bounded COPY. The PostgreSQL path
lazily forms parse work as it enters the bounded scheduler, admitting at most
64 files and 64 MiB of combined source per item. A single larger source remains
indivisible, and queued work receives its deadline only when admitted. The path
references immutable cached payloads when possible, validates file-local
output, and COPY-publishes typed
unordered facts behind the exact staging/lease fence. It reduces 64
deterministic UUID partitions for each of the six canonical relations in
four-partition transaction groups. Each group proves conflicts and
cross-relations before atomically replacing raw evidence with canonical rows.
Parallel worker completion order cannot affect IDs, rows, digest, or BM25
document identity. Extracted batch identity and file/byte windows use logical
payload digests rather than inline-versus-cache storage, so either
representation replays idempotently; different bytes for an existing sequence
fail closed.

One spill parse item reuses one `NativeExtractor` per encountered language,
matching the extractor's reusable-parser contract while keeping the item and
payload bounds unchanged. Hot AST cancellation polls read monotonic watch
versions atomically and retain exact parent/stage/deadline behavior.

## Parallel pipeline

```text
discover
  -> bounded read/hash
  -> bounded tree-sitter parse/extract batches -> cache-backed spill
  -> compact resolution preparation -> parallel per-file resolve -> typed COPY
  -> memory canonical reduce, or PostgreSQL partitioned reduce
  -> exact streamed digest / publish
```

The supervisor and stage runner enforce:

- file-count- and source-byte-aware 1/2/4/8/16 worker selection with
  caller/hardware caps;
- bounded queues, tasks, per-item bytes, retained output, and total operation
  memory model;
- distinct per-file extraction limits: completed retained output is capped at
  32 times source bytes plus a fixed allowance, while transient parser/fact
  construction is reserved at 64 times source bytes plus its fixed allowance;
- input sequence numbers and ordered reduction;
- item/stage/operation/COPY/heartbeat/cancellation deadlines;
- cancellation polling inside discovery, reads, parser callbacks, resolution,
  reduction, and database work;
- abort/reap/poison behavior when a worker panics, hangs, times out, or its
  caller future is dropped;
- exact lease ownership and rollback before publication.

`generationStorage: "auto"` keeps small projects on the memory path and selects
PostgreSQL for a large file count, indexed-source size, or conservative
source-to-generation expansion estimate. PostgreSQL spill removes the complete
extraction/resolver/canonical payload from Rust memory and applies independent
logical byte/row quotas. Parsing, fact publication, canonical reduction, and
digesting all make durable bounded progress rather than retaining a generation
payload. Resolve also advances supervision only after exact pages, committed
fact/score batches, and completed deterministic derived work, so one large
outer work item cannot hide healthy progress. The project-wide resolution
lookup, clone profile, and centrality graph remain explicitly bounded compact
native structures because exact cross-file resolution needs the full
declaration domain; an extreme graph can still be rejected before unsafe
allocation or publication. Persistent SCIP replacement overlays remain on the
memory path until their per-file replacement contract has an equivalent
streamed implementation.

## Search document boundary

Each published file/symbol can produce a stable search document containing:

- normalized path, language, document kind;
- qualified name;
- safe code/identifier text;
- natural documentation text;
- file/symbol/generation/project identity.

ParadeDB indexes qualified name and code with `pdb.source_code`; natural text
uses its text tokenizer. A language slice is not complete until a live
PostgreSQL corpus test proves the expected current-generation BM25 hit.

## Test routing

Test path detection is language-aware and platform-independent. It recognizes
common `test`, `tests`, and `__tests__` directory segments plus language-owned
filename conventions (for example `.test/.spec`, Python `test_`, and Go
`_test`). Affected-test selection still requires graph evidence; a test-looking
path alone is not proof of impact.

## Locked verification

Unit/golden tests cover path admission, UTF-8 chunk boundaries, size/cancellation,
grammar mismatch, malformed syntax, IDs, spans, declarations, references,
resolution ambiguity, search documents, test routing, and digest stability.

The Rust-owned live corpus then proves discovery through PostgreSQL publication
and ParadeDB search at 1, 2, 4, 8, and 16 workers. Every run must retain:

- identical logical digest;
- literal file/symbol/edge/reference/document rows;
- identical edge-kind and diagnostic sets;
- identical ordered BM25 IDs;
- completed task/publication state;
- released leases and zero staged residue;
- bounded task/RSS measurements.

Committed reports:

- [synthetic COPY/index scaling](benchmarks/INDEX-SCALING.md)
- [native corpus scaling](benchmarks/NATIVE-CORPUS-SCALING.md)
- [patch-task evaluation](benchmarks/PATCH-TASK-EVALUATION.md)
