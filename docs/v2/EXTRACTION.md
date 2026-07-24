# Cartograph v2 native extraction

Status: TypeScript/JavaScript structural extraction, project-wide discovery,
bounded resolution, PostgreSQL persistence, and real-corpus scaling implemented;
module-aware resolution and body-bearing search documents remain pending.

This document fixes the boundary of `cartograph-extract` so later language and
framework work does not leak parser details into storage or parallel indexing.
The normative product direction remains `docs/v2/ARCHITECTURE.md`.

## Implemented boundary

`cartograph-extract` depends only on `cartograph-domain`, BLAKE3, Tree-sitter,
and error support. It does not depend on PostgreSQL, the index supervisor, MCP,
the v1 TypeScript runtime, or an LLM.

The first native grammar family owns these case-insensitive extensions:

| Language | Extensions | Grammar |
| --- | --- | --- |
| TypeScript | `.ts`, `.mts`, `.cts` | Tree-sitter TypeScript |
| TSX | `.tsx` | Tree-sitter TSX |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.xsjs`, `.xsjslib` | Tree-sitter JavaScript |
| JSX | `.jsx` | Tree-sitter JavaScript |

The workspace pins Tree-sitter 0.26.11, the JavaScript grammar 0.25.0, and the
TypeScript/TSX grammar 0.23.2. A version change is a behavior change and must
re-run the locked oracle and native corpus gates.

## Input and identity contract

`NormalizedPath` accepts only bounded project-relative paths, canonicalizes
slash direction plus redundant `.` components, and rejects parent traversal,
absolute paths, NULs, and Windows drive prefixes. `SourceRoot` canonicalizes
the project root and requested target, rejects targets outside that root and
non-regular files, checks metadata size, then reads in 64 KiB chunks while
polling cancellation and enforcing the byte ceiling again as the file grows.
Each chunk updates BLAKE3 and a streaming UTF-8 decoder, including split
multi-byte sequences, so there is no final full-source hash/validation pass.
Unsupported extensions and non-regular targets (including FIFOs) are rejected
before opening. Fallible buffer reservations return a credential-safe resource
error, and snapshot/root debug output omits source, project path, and root.

The root check is symlink-aware but does not claim an `openat2`-style race-free
filesystem capability boundary: the standard-library implementation
canonicalizes before opening. A future hostile/concurrently-mutated checkout
threat model must select and test a capability-based open primitive rather than
silently widening this claim.

Every snapshot stores the exact BLAKE3 digest of the original UTF-8 bytes.
Stable IDs use length-delimited, domain-separated BLAKE3 fields rendered as RFC
9562 UUIDv8 values:

- file ID: canonical project-relative path;
- symbol ID: canonical path, symbol kind, scope-qualified name, and the ordinal
  among equal declarations in that same scope.

Line number, byte span, comments, and formatting are deliberately absent from
symbol identity. Inserting a same-named method in another class therefore does
not change the existing method ID. True duplicate declarations in one scope
remain distinct through their deterministic source-order ordinal.

## Native facts

The TypeScript/JavaScript walker currently emits:

- interfaces, classes, functions, methods, arrow/function-expression bindings,
  variables, constants, type aliases, enums, enum members, imports, and React
  function/arrow components;
- local and scope-qualified names, exact declaration half-open byte spans,
  one-based lines, zero-based byte columns, signatures, adjacent JSDoc, export/default/async/
  static flags, and explicit visibility;
- lexical containment;
- module imports and named imported symbols;
- extends, implements, parameter/type, and return-type references;
- calls, construction, PascalCase JSX references, and non-call field access;
- bounded syntax diagnostics while retaining useful declarations from a
  recoverably damaged parse.

Each symbol also carries a concrete-syntax BLAKE3 digest that excludes comments
and formatting whitespace while retaining semantic tokens. This supports
incremental decisions without pretending that a reformatted file has a new
logical declaration.

References remain named source evidence through persistence. Every row keeps
its file, closest lexical owner, normalized reference name, kind, span,
resolution provenance, confidence, and optional exact target. Project-wide
resolution decides whether exact evidence creates an edge, but missing,
ambiguous, and qualified-member references remain explicit rows; they are not
discarded and are not guessed from a final member name.

## Cancellation, bounds, and parallel execution

Tree-sitter parsing uses `parse_with_options` and its progress callback to poll
the supervisor-owned cancellation probe. The Rust walker, structural digest,
diagnostic traversal, type traversal, and source reader also poll that same
probe. Parent cancellation, sibling failure, per-item timeout, and whole-stage
timeout therefore reach CPU work that cannot await Tokio directly.

Direct-child and depth-first AST traversal use allocation-free Tree-sitter
cursors. Structural hashing polls while counting children and every 64 KiB of a
large leaf; exact leaf bytes preserve semantic whitespace in templates and JSX
while comments remain excluded. Fact strings have an absolute 256 KiB ceiling.
Each file also has a source-derived fact-count limit and a modeled Rust-output
limit of `source_bytes * 8 + 256 KiB`, enforced before every fact and checked
again against final vector/string capacities. Exceeding any limit is a
structured `OutputLimit`, not unchecked heap growth.

`cartograph-indexer` wraps the native extractor in the shared `StageRunner`.
Each lazily admitted snapshot receives:

- a stable file key and contiguous sequence;
- an item deadline starting at that envelope's admission, including its
  bounded worker-queue wait, capped by the stage deadline;
- exact progress bytes equal to source bytes;
- a conservative in-flight accounting reservation of source bytes multiplied
  by 32 plus 1 MiB.

The worker uses `block_in_place`; no detached `spawn_blocking` task can outlive
the stage scope. Outputs may complete in any order but reduce in exact input
order and retain their reservation through a trusted fixed-state observer. The
adapter does not accumulate `ExtractedFile` values: each value is dropped before
its reservation is acknowledged. A complete length/tag-delimited digest over
every output field is identical at one and four workers, and a 256-file
regression proves the observer runs while declared bytes remain reserved and
peak reservation stays under the supervisor scope.

The 32x reservation is conservative accounting, not an OS allocator/RSS hard
limit for Tree-sitter's C heap. The current observer is deliberately limited to
fixed-size validation/digest state; it cannot serve as the production
resolve/COPY handoff. A real corpus RSS benchmark and, if required, process
isolation remain release gates.

The production continuation is now `build_native_generation`. It runs five
strictly ordered supervisor stages:

1. Discovery uses Rust's `ignore` walker with Git-compatible standard ignore
   files, includes hidden source files, never follows symlinks, hard-excludes
   `.git/` and `.cartograph/`, honors per-directory `.cartographignore`
   markers, sorts paths deterministically, and enforces file-count plus modeled
   path-manifest byte limits. An unreadable or non-UTF-8 entry fails closed
   instead of silently publishing a partial project.
2. Read/hash admits only discovered path/size records. Each worker reserves
   `source_bytes * 2 + 128 KiB`, streams bounded UTF-8 plus BLAKE3 under
   cancellation, and reduces to a compact path/language/file-ID/hash/size
   manifest. Source buffers are dropped at ordered reduction.
3. Parse/extract reopens each manifest path under the exact previously observed
   size, requires identical hash, language, and file identity, then runs native
   Tree-sitter under the existing 32x reservation. Concurrent source drift is a
   fatal parse-stage result, never a mixed-generation snapshot.
4. Ordered parse outputs are immediately moved into storage-independent
   `NativeFileFacts`. Before the parse reservation is acknowledged, a separate
   retained-generation budget accounts file/symbol/reference strings, vector
   capacities, every per-symbol path/language/ID clone, metadata allowance, and
   anticipated search documents. The pipeline never accumulates
   `SourceSnapshot` or raw `ExtractedFile` values for the corpus.
5. Resolve performs deterministic exact-name selection: one same-file target
   wins first, otherwise one unique project target wins. Qualified members such
   as `console.log` remain unresolved until receiver/container/import evidence
   exists. A cancellation-polled ordered map avoids a monolithic candidate
   sort. Reduce first performs a cancellation-polled, capacity-aware retained
   model inside the supervised blocking stage. It counts actual outer-vector and
   JSON-array capacities with type-correct raw/canonical roots, validates storage
   field caps and relations, deduplicates every table, canonicalizes JSON and
   ordering, and computes the complete logical digest under an explicit
   four-times working-set reservation. Measured input/output bytes travel in the
   validation report; Tokio workers do not rescan either payload.
   PostgreSQL receives only the opaque `CanonicalGenerationFacts` capability;
   the async prepare/COPY task cannot run a second synchronous reducer.

The retained generation is hard-capped but intentionally stays in memory until
the five COPY streams consume it. Resolve charges candidates, vector
capacities, and output clones before allocation against its three-times task
reservation. Canonical validation polls during memory modeling, every fact,
map-to-vector conversion, relation-map build, and relation check. It reports a
conservative cumulative high-water charge under its four-times task
reservation. This is bounded fail-closed ownership, not an unbounded observer
and not yet spill-to-disk or streaming database reduction.

Migration 3 expands PostgreSQL graph-edge validation so every current native
relationship kind (`type_of`, `returns`, `instantiates`, `overrides`,
`decorates`, `field_access`, `def_use`, and `exports`, in addition to the
original kinds) can persist as a first-class edge. The live supervisor fixture
now proves discovery through publication and a ParadeDB BM25 hit from the
native generation. Migration 4 adds bounded reference name, owner, and
resolution-provenance columns plus an owner index, so unresolved evidence
survives COPY and later resolver improvements. Migration 5 versions logical
digests without rewriting history: populated pre-v4 rows keep their original
digest with version 1, while new complete-reference facts use digest version 2.

## Oracle and ownership transition

`tests/fixtures/v1_1_33` freezes four v1.1.33 projections covering TypeScript,
JavaScript, TSX, and JSX. The Rust extractor must match those declaration,
containment, reference, span, signature, JSDoc, and modifier projections
exactly. A temporary v1 test parses the committed JSON with Zod, executes the
v1.1.33 extractor over all four sources, and compares that independent
projection before the Rust test consumes it; the oracle is not self-authored by
the Rust implementation. Separate Rust-owned invariants already go beyond it for
exact BLAKE3 hashing, UTF-8/size/path rejection, partial parse recovery,
cooperative cancellation, formatting-stable identity/digests, duplicate
ordinals, cross-scope identity stability, validated serialized spans/languages,
enum-member isolation from comments/initializer expressions, bare and nested
type-alias references, typed component references, semantic template/JSX
whitespace, bounded adversarial names, FIFO rejection, split UTF-8, and redacted
debug output. The owned pipeline additionally covers all supported test-path
extensions/directories, full-payload one-versus-four-worker digests, long-path
many-symbol accounting, spare-capacity admission, cancellation during retained
modeling/map conversion/relation-map construction, storage-cap rejection, false
qualified-member resolution, unresolved evidence round trips, and
credential-shaped non-callable plus scalar/destructured/arrow/method/component
default initializer exclusion from search. Component type
references are an explicit additive v2 improvement and are filtered only from
the v1-compatibility projection before equality.

The v1 oracle is not the permanent v2 product contract. Before broadening the
extractor, freeze a Rust-owned corpus and evaluate any intentional improvement
as an explicit golden-contract change. Production Rust must never call Bun or
TypeScript to extract a file.

## Deliberately not complete

The following work remains outside this slice:

1. Git tracked-file reconciliation for the unusual case where an already
   tracked source is later covered by an ignore rule; the first Rust walker
   applies ignore rules uniformly. Embedded-repository/submodule parity also
   needs a locked corpus.
2. Import/export alias modelling, module-path and qualified-member resolution,
   receiver/type evidence, lexical shadowing, overload policy, and richer
   confidence calibration beyond exact unique-name resolution.
3. Separate exact reference-target spans from v1-compatible expression/site
   spans; imports and constructions currently retain the v1.1.33 site range.
4. Richer TypeScript declarations such as interface method signatures,
   properties, fields, parameters, decorators, overrides, and explicit exports.
5. Search documents containing bounded implementation-body code. The first
   native payload indexes paths, symbol qualified names, safe callable
   declaration-only signatures, and JSDoc. Non-callable initializer RHS text is
   cleared before storage; callable signatures containing defaults or string
   literals fall back to the qualified name, and complete source bodies are not
   duplicated.
6. Spill/partitioned resolution and streaming database reduction if measured
   real projects exceed the configured retained-generation cap.
7. Framework resolvers and cross-language bridges, followed by the remaining
   language families in the v2 plan.
8. Per-worker parser reuse and additional large-corpus evidence to decide whether repeated
   component/digest/type traversals need fused language-specific walks.

The frozen [native corpus matrix](benchmarks/NATIVE-CORPUS-SCALING.md) now proves
identical digest/rows/edge kinds/BM25/lifecycle behavior at 1/2/4/8/16 workers
and records isolated process RSS. The next implementation slice is module/import
resolution and bounded symbol-body search documents, followed by measurement
and optimization of the dominant PostgreSQL/ParadeDB COPY/indexing floor.
