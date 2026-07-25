# Adding a language

Cartograph v2 language support is native Rust. Do not add a TypeScript
extractor, WebAssembly grammar asset, external parser process, or parser-only
placeholder and call the language complete.

Use the maintained [extractor and resolver extension
guide](EXTENDING-EXTRACTORS-RESOLVERS.md). A production language slice must add
all of the following:

1. stable `SourceLanguage` identity and extension admission;
2. a pinned native tree-sitter grammar or bounded Rust structural scanner;
3. declarations, references, exact/coarse spans, and diagnostics;
4. deterministic module/name resolution with explicit ambiguity;
5. safe search documents and framework/cross-language edges where applicable;
6. cancellation and input/output/nesting limits;
7. v1-import and freshness admission updates;
8. deterministic 1/2/4/8/16-worker publication and live ParadeDB BM25 proof;
9. support-matrix and acknowledgement updates.

Unknown source remains unsupported until the complete contract passes. An
empty file node is valid only for the deliberately documented structural-file
modes; it is not a substitute for an extractor.

The current architecture and language inventory are documented in
[native extraction](v2/EXTRACTION.md) and the [support matrix](SUPPORT-MATRIX.md).
