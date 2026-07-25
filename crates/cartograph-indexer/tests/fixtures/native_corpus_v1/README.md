# Frozen native TypeScript corpus

These files are immutable source fixtures captured from Cartograph v1.1.33 for
the native 1/2/4/8/16-worker ingestion and determinism benchmark. They are test
data only: Cartograph v2 does not execute, compile, package, or depend on this
TypeScript code.

The benchmark locks the length-delimited corpus fingerprint before running, so
editing any fixture requires an explicit corpus-version review and refreshed
determinism evidence. Keeping the fixtures in the Rust crate prevents the v2
test suite from depending on the retired Bun/TypeScript runtime tree.
