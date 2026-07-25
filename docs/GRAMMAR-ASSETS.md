# Native grammar provenance

Cartograph v2 links pinned Rust tree-sitter grammar crates. It does not ship or
load the v1 WebAssembly grammar directory.

The authoritative release inventory is:

- exact crate versions and checksums: `Cargo.lock`;
- direct grammar pins: workspace dependencies in `Cargo.toml`;
- language-to-grammar/custom-scanner registration:
  `crates/cartograph-extract/src/language.rs`, `grammars.rs`, and related native
  modules;
- third-party licensing and upstream attribution: `ACKNOWLEDGEMENTS.md` and
  `deny.toml`.

Adding or upgrading a grammar requires more than a successful parser load:

1. pin an exact compatible crate version;
2. verify its license and update acknowledgements/deny policy when needed;
3. inspect its real node vocabulary and update native extraction;
4. test declarations, references, malformed syntax, cancellation, bounds, and
   literal safety;
5. prove deterministic output under every supported worker count;
6. publish the language corpus to live PostgreSQL/ParadeDB and verify BM25;
7. run `cargo deny --all-features check` and the complete release gates.

See [the native extension guide](EXTENDING-EXTRACTORS-RESOLVERS.md) for the
full admission contract.
