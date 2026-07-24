# Cartograph v2 native extraction

Status: TypeScript/JavaScript structural extraction plus bounded native Rust,
Python, and Go declaration/reference slices, project-wide discovery,
module-aware bounded resolution, safe implementation search text, PostgreSQL
persistence, and real-corpus scaling implemented.

This document fixes the boundary of `cartograph-extract` so later language and
framework work does not leak parser details into storage or parallel indexing.
The normative product direction remains `docs/v2/ARCHITECTURE.md`.

## Implemented boundary

`cartograph-extract` depends only on `cartograph-domain`, BLAKE3, Tree-sitter,
and error support. It does not depend on PostgreSQL, the index supervisor, MCP,
the v1 TypeScript runtime, or an LLM.

The native grammar families own these case-insensitive extensions:

| Language | Extensions | Grammar |
| --- | --- | --- |
| TypeScript | `.ts`, `.mts`, `.cts` | Tree-sitter TypeScript |
| TSX | `.tsx` | Tree-sitter TSX |
| JavaScript | `.js`, `.mjs`, `.cjs`, `.xsjs`, `.xsjslib` | Tree-sitter JavaScript |
| JSX | `.jsx` | Tree-sitter JavaScript |
| Rust | `.rs` | Tree-sitter Rust |
| Python | `.py`, `.pyi` | Tree-sitter Python |
| Go | `.go` | Tree-sitter Go |

The workspace pins Tree-sitter 0.26.11, the JavaScript grammar 0.25.0, and the
TypeScript/TSX grammar 0.23.2, Rust grammar 0.24.2, and Python and Go grammars
0.25.0. A version change is a behavior change and must re-run the locked oracle,
polyglot canary, and native corpus gates.

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
- module imports plus default, named/aliased, and namespace binding semantics;
- declaration-only function/method signatures and overload groups;
- extends, implements, parameter/type, and return-type references;
- calls, construction, PascalCase JSX references, and non-call field access;
- bounded syntax diagnostics while retaining useful declarations from a
  recoverably damaged parse.

The additional native language slices are deliberately narrower:

| Language | Implemented structural evidence | Resolution boundary |
| --- | --- | --- |
| Rust | inline modules, structs, enums/variants, traits, type aliases, constants/statics, functions, impl/trait methods, explicit visibility, same-file containment when the top-level owning type is already declared, calls, macro calls, field access, type/return references, and external `mod`/`use` evidence | ordinary lexical lookup and qualified calls through an exact top-level external `mod` binding in conventional `lib.rs`, `main.rs`, or `mod.rs` layouts resolve; bare cross-file names do not. Only unrestricted `pub` is public, `pub(crate)`/`pub(super)` are internal, and other restricted forms are not treated as exported. Imported nested/member/module symbols are not callable top-level bindings. Cargo/custom-root topology, `#[path]`, nested external modules, `use` trees/aliases, associated-type dispatch, and receiver typing remain explicit unresolved evidence |
| Python | classes, functions, class methods, inheritance, parameter/return annotations, calls, attribute access, imports, and top-level non-underscore export state | exact relative `from .module import name` bindings and package-relative module bindings such as `from . import helpers` resolve; absolute environment/package imports, `__all__`, namespace packages/`__init__.py`, assignments, decorator edges, and dynamic imports are not inferred |
| Go | package clauses, named structs/interfaces/type aliases, functions, receiver/interface methods, same-file receiver containment when the top-level type is already declared, calls, selectors, imports, and Go's uppercase export convention | lexical names and a unique exported name in another Go file resolve only when normalized directory and declared package both match; methods and other member kinds are excluded from bare fallback. Import paths are retained with aliases, but `go.mod` re-anchoring, embedded fields, and implicit interface implementation are not inferred |

Representative Rust, Python, and Go sources are locked in
`crates/cartograph-extract/tests/polyglot.rs`. The production pipeline test
`polyglot_and_module_forms_produce_resolved_nonempty_graphs` additionally
requires every fixture file to produce symbols and proves a Rust external-module
call, a Go same-directory/same-package call, Python named and namespace
relative-import calls, and an identifier-backed default export. Negative
canaries reject Rust nested/member/module targets through external `mod`, Go
module/method/foreign-directory/mismatched-package fallback, cross-language
stems, and dynamic CommonJS resolution. This is the silent-empty-graph canary
for every language claimed in the table.

TypeScript/JavaScript module evidence now also covers explicit local export
lists, local export aliases, named re-exports, CommonJS namespace/member/
destructured `require`, and identifier-backed static `exports.name` /
`module.exports` object assignments. CommonJS inference requires the standard
`require`, `module`, and `exports` names to be unshadowed; any lexical binding
with the relevant name makes that file abstain from the corresponding
inference. Named re-exports create an exported alias
node plus an `exports` edge to the proven source declaration, so a consumer can
traverse the barrel without pretending the alias is the implementation.
`export *` retains module import evidence but does not propagate an unbounded
unknown export set. Unbound dynamic and side-effect-only `require` calls remain
as ordinary unresolved call evidence and cannot fall through to an unrelated
JavaScript-family project symbol; a genuine same-file lexical `require` can
still resolve. Computed export names, conditional mutation
of `module.exports`, and package `exports` maps remain unresolved rather than
guessed.

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

Callable and binding implementations also emit an identifier-only search
projection. It includes identifiers and selected control-flow keywords but
omits comments and every literal token. Each symbol is capped at 16 KiB; a
stable prefix plus rolling tail prevents a large repetitive middle from hiding
important code near the end, and a truncation bit is carried into search
document metadata. The original source body is never retained or copied to
PostgreSQL.

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
5. Resolve walks containment ancestry first, excluding class/interface members
   from bare lexical lookup while preserving explicit field-access resolution,
   applies overload policy, then uses exact relative module bindings. Default,
   named/aliased, and namespace imports require an exported target in one
   normalized, language-compatible module; supported module stems now include
   TypeScript/JavaScript, Rust, Python, and Go extensions. Cross-language stems
   remain unresolved until an explicit bridge exists. JavaScript-family
   directory resolution recognizes only `index` files; Rust recognizes only
   `mod.rs`, and a simultaneous `name.rs` plus `name/mod.rs` match is
   deliberately ambiguous. Python and Go do not inherit either directory
   convention. Unbound project fallback
   is restricted to the JavaScript family or a same-directory, same-package Go
   file. Rust and Python cross-file references require explicit binding
   evidence. Bare packages,
   missing/ambiguous modules, and ambiguous overloads remain explicit unresolved
   evidence. An ambiguous exact path or stem cannot fall through to a directory
   `index`. Named import declaration references use the exact binding span
   before lexical lookup; runtime aliases still permit inner lexical shadowing.
   Only one exported cross-file candidate may be used as a final fallback.
   Receiver/type-directed members are not inferred, and namespace imports
   supply the current exact module evidence. Cancellation-polled ordered
   maps avoid a monolithic candidate sort; every import-binding, containment-
   ancestry, and candidate scan observes cancellation internally. Reduce first performs a
   cancellation-polled, capacity-aware retained
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
whitespace, default/named/namespace import bindings, declaration-only overloads,
literal-safe prefix/tail-bounded implementation text, bounded adversarial names,
FIFO rejection, split UTF-8, and redacted debug output. The owned pipeline
additionally covers all supported test-path
extensions/directories, full-payload one-versus-four-worker digests, long-path
many-symbol accounting, spare-capacity admission, cancellation during retained
modeling/map conversion/relation-map construction, storage-cap rejection, false
qualified-member resolution, module aliases, lexical shadowing, overload
implementation selection, package-import abstention, ambiguous-stem
abstention before directory-index fallback, sibling-member exclusion from bare
calls, exact aliased-import declaration spans, in-reference candidate-scan
cancellation, project-bounded relative paths,
unresolved evidence round trips, and
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
2. Star re-export propagation, TypeScript `paths` aliases, package exports,
   dynamic/computed CommonJS, Python package-root policy, Cargo module/use-tree
   semantics, `go.mod` import re-anchoring, and receiver/type-directed
   qualified-member resolution. These need richer provenance/confidence rather
   than name-only fallback.
3. Separate exact reference-target spans from v1-compatible expression/site
   spans; imports and constructions currently retain the v1.1.33 site range.
4. Richer TypeScript declarations such as properties, fields, parameters,
   decorators, overrides, anonymous default exports, and namespace re-exports.
5. Retrieval evaluation for identifier/keyword body text, including field
   boosts and whether deterministic token deduplication improves BM25 without
   reintroducing literals or complete source bodies.
6. Spill/partitioned resolution and streaming database reduction if measured
   real projects exceed the configured retained-generation cap.
7. Framework resolvers, cross-language bridges, deeper Rust/Python/Go semantics,
   and the remaining language families in the v2 plan.
8. Per-worker parser reuse and additional large-corpus evidence to decide whether repeated
   component/digest/type traversals need fused language-specific walks.

The frozen [native corpus matrix](benchmarks/NATIVE-CORPUS-SCALING.md) now proves
identical digest/rows/edge kinds/BM25/lifecycle behavior at 1/2/4/8/16 workers
and records isolated process RSS. The next implementation slice is measurement
and optimization of the dominant PostgreSQL/ParadeDB COPY/indexing floor,
followed by the remaining resolver/export cases above.
