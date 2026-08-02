# Extending native extraction and resolution

Cartograph v2 extracts code in Rust and publishes typed, generation-scoped facts
to PostgreSQL. This guide covers the registration points and failure modes for
adding a language, resolver, framework fact, or cross-language bridge.

Do not call the v1 TypeScript runtime, load its WASM grammars, introduce SQLite,
or shell out to a parser to make an extension appear complete. Unsupported
source must remain explicit until the complete native contract is implemented.

## Choose the smallest correct mechanism

| Graph gap | Mechanism |
| --- | --- |
| Syntax/declarations/references from a new grammar | Native language slice |
| Another extension using identical syntax/semantics | Existing language slice plus extension mapping |
| Import/package/receiver resolution inside one language | Deterministic language resolver |
| Literal route, command, resource, or component declaration | Framework fact extraction after explicit detection |
| Reference in one language to a declaration in another | Cross-language bridge over typed facts |
| Convention relating two already extracted nodes | Deterministic generation build step |
| Static numerical operation, precision, or hazard evidence | Numerical site extractor with an explicit analyzer contract |

A framework resolver should not become a second parser. A cross-language bridge
should not fabricate declarations. A derived edge should not be added after
publication, because that would make the visible generation differ from its
digest.

## Native language checklist

### 1. Stable language identity

Add the language to `cartograph-domain::SourceLanguage` with a stable serialized
and database value. Update the domain round-trip tests. These values are part of
generation facts and migration compatibility; renaming one is a schema change.

### 2. Discovery and snapshot admission

Update `crates/cartograph-extract/src/snapshot.rs`:

- map canonical extensions to the language;
- route language-specific test filenames;
- cover case normalization and compound extensions;
- prove unsupported extensions still fail explicitly.

`SourceRoot` performs project-root validation and bounded chunked reads.
`SourceSnapshot` owns UTF-8, language, size, path, file identity, and exact
content digest. New code must consume that boundary rather than reading an
arbitrary path directly.

### 3. Grammar registration

Pin the tree-sitter crate in the workspace and select its grammar in
`crates/cartograph-extract/src/native.rs`. Create a fresh parser per bounded
operation or use the established worker-local pattern; never share mutable
tree-sitter state across concurrent workers.

Add tests for:

- grammar/language mismatch;
- malformed but recoverable syntax;
- cancellation;
- maximum input and output bounds;
- zero-symbol files that are legitimately empty versus unsupported files.

### 4. Declarations and references

Extend the walker dispatch in `walk.rs` and focused modules under `walk/`.
Produce typed facts with:

- deterministic symbol/reference IDs;
- one-based lines and exact byte ranges;
- explicit symbol/reference kinds and visibility;
- safe literal-free callable signatures;
- explicit confidence, provenance, and site multiplicity;
- recoverable diagnostics instead of panics.

Do not resolve during syntax walking. Retain enough unambiguous typed evidence
for the resolver; leave dynamic or ambiguous references unresolved.

Numerical evidence additionally requires a stable site ID, exact owner/file
span, bounded machine-token categories, a privacy-safe expression digest,
confidence independent from evidence level, explicit unknowns, and an analyzer
contract included in freshness. Never persist the source expression or literal,
and never label static syntax as observed or formally proven behavior.

### 5. Resolution

Resolution must be deterministic and module-aware. Prefer exact module/path and
qualified-name evidence before any name-only fallback. If more than one target
remains plausible, retain unresolved evidence instead of choosing by worker or
database order.

Every new resolution rule needs fixtures for:

- the exact success path;
- same-name private declarations in different modules;
- ambiguous candidates;
- missing modules;
- import aliases/re-exports relevant to the language;
- identical output under reversed input order and every supported worker count.

### 6. Search documents

Ensure canonical generation building emits safe search documents for new files
and symbols. Code/name fields are tokenized by ParadeDB's `pdb.source_code`;
natural documentation uses the text field. A new language is not end-to-end
complete until a live PostgreSQL publication returns its expected BM25 hit.

### 7. Import and freshness boundary

The v1 PostgreSQL importer may admit only languages the v2 runtime can index and
include in its complete source revision. Update importer preflight and live
cutover tests when expanding support. Otherwise an imported generation could
appear fresh while unsupported files change or disappear on the next index.

## Framework facts and bridges

Framework extraction runs only after an explicit, deterministic detection
signal. It must have hard file/node/byte limits and emit ordinary typed facts so
the same canonical reducer, digest, COPY, validation, and publication rules
apply.

A cross-language bridge consumes existing facts from both languages. It must:

- state the exact convention it recognizes;
- scope candidates by module/package/framework identity;
- preserve ambiguity;
- cap fan-out;
- attach confidence and provenance;
- prove that input order and worker count cannot change the result.

Do not add a mutable post-publication hook. Derived relationships belong in the
staged generation before validation and atomic publication.

## Silent-failure traps

- Extension mapped but grammar selection missing: discovery succeeds and parse
  fails for every file.
- Grammar selected but walker dispatch missing: files look successfully empty.
- Declarations added without search documents: exact graph exists but BM25
  cannot find it.
- Resolver uses global name-only matching: private same-name symbols acquire
  false edges.
- Unsupported language admitted by v1 import: status can misreport freshness
  and reindex drops data.
- Per-worker map iteration reaches the digest: output changes with scheduling.
- Literal-bearing signatures enter search: secrets or source literals can leak
  into evidence.
- New edge kind omitted from bulk relation validation: invalid staged rows may
  reach publication or valid rows may fail late.

## Required gates

At minimum:

```sh
cargo fmt --all --check
cargo clippy --locked --workspace --all-targets --all-features -- -D warnings
cargo test --locked -p cartograph-domain -p cartograph-extract -p cartograph-indexer
```

Then run the live native-corpus supervisor and 1/2/4/8/16-worker benchmark from
`.github/workflows/v2-rust.yml`. The locked corpus must retain identical logical
digest, row counts, edge kinds, diagnostics, ordered BM25 IDs, terminal task
state, and cleanup. Finish with the full workspace, PostgreSQL/ParadeDB, Sonar,
structural, archive, and independent-review gates.

See [native extraction](v2/EXTRACTION.md) and
[v2 architecture](v2/ARCHITECTURE.md) for the current implemented boundary.
