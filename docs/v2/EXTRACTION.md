# Native extraction contract

Cartograph v2 extracts every v1.1.33 language mode in Rust. The extractor owns
bounded project discovery, exact source snapshots, grammar or custom structural
parsing, structural facts, deterministic resolution, and canonical generation
input. It does not depend on PostgreSQL, MCP, or an LLM.

## Supported language families

The authoritative, exhaustively tested manifest is
`cartograph_domain::SourceLanguage::ALL`: all 73 v1.1.33 modes and their 163
extensions, plus additive `.pyi` support and a native TOML mode. The
implementation is divided into:

- JavaScript/TypeScript, Rust/Python/Go, query-tag, C-family, shell, managed,
  JVM-dynamic, and conservative grammar-backed structural walkers;
- parser-only structural file documents for CSS, embedded templates, JSDoc,
  JSON/Jupyter, and regex sources;
- bounded custom scanners for Aura, BG3 Anubis/resources/stats, Liquid, Osiris,
  properties, Svelte, TOML, VB6, Visualforce, Vue, and MyBatis XML.

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
- safe callable signatures and body-search text;
- parser diagnostics.

Callable signatures are normalized to exclude literal-bearing bodies/values.
Search text is intentionally useful for code identifiers without becoming a
secret or source-literal dump.

## Resolution

Resolution runs after extraction. It prefers exact module/path and qualified
scope evidence and keeps ambiguous or dynamic cases unresolved.

Implemented language-level behavior includes:

- relative TypeScript/JavaScript module specifiers and common extension/index
  probing;
- import bindings, named/default/namespace shapes represented by typed facts;
- lexical/containment-aware local references;
- Rust/Python/Go and the remaining production families' declaration and
  call/member reference shapes;
- component/template, Salesforce markup, MyBatis, VB6, properties, Liquid, and
  BG3/Osiris domain semantics;
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
- files, symbols, typed edges, exact/coarse references;
- search documents for file/symbol code/name/natural text;
- deterministic row ordering and logical digest;
- literal row/count/byte admission reports.

Resolution output is reduced in stable order before PostgreSQL. Parallel worker
completion order cannot affect IDs, rows, digest, or BM25 document identity.

## Parallel pipeline

```text
discover
  -> bounded read/hash
  -> tree-sitter parse/extract
  -> module/reference resolve
  -> canonical reduce/digest
  -> PostgreSQL COPY/validate/publish
```

The supervisor and stage runner enforce:

- file-count- and source-byte-aware 1/2/4/8/16 worker selection with
  caller/hardware caps;
- bounded queues, tasks, per-item bytes, retained output, and total operation
  memory model;
- input sequence numbers and ordered reduction;
- item/stage/operation/COPY/heartbeat/cancellation deadlines;
- cancellation polling inside discovery, reads, parser callbacks, resolution,
  reduction, and database work;
- abort/reap/poison behavior when a worker panics, hangs, times out, or its
  caller future is dropped;
- exact lease ownership and rollback before publication.

The in-memory canonical generation is hard-capped. V2.0 does not claim an
unbounded corpus or spill-to-disk reducer; oversize input is rejected before
unsafe allocation or publication.

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
