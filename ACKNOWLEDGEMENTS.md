# Acknowledgements

Cartograph stands on other people's open-source work. Cartograph itself is
released under the MIT License; every dependency and external service retains
its own license and terms.

## Origin project

Cartograph began as a fork of
[codegraph](https://github.com/colbymchenry/codegraph) by Colby Mchenry, used
under the MIT License (Copyright (c) 2026 Colby Mchenry). Version 2 is a native
Rust/PostgreSQL architecture and no longer ships the original TypeScript/Bun
runtime, but the project's product direction and many code-intelligence
concepts grew from that foundation.

## Rust runtime libraries

The native executable uses these principal projects:

| Project | License | Use |
| --- | --- | --- |
| [Rust](https://www.rust-lang.org/) | Apache-2.0 / MIT | Language, standard library, and toolchain |
| [Tokio](https://tokio.rs/) | MIT | Bounded asynchronous runtime, process supervision, deadlines, and cancellation |
| [SQLx](https://github.com/launchbadge/sqlx) | Apache-2.0 / MIT | PostgreSQL protocol, pools, transactions, COPY, and typed row decoding |
| [Serde](https://serde.rs/) / [serde_json](https://github.com/serde-rs/json) | Apache-2.0 / MIT | Validated JSON protocol and persistence boundaries |
| [clap](https://github.com/clap-rs/clap) | Apache-2.0 / MIT | Native CLI parsing and help |
| [Tree-sitter](https://tree-sitter.github.io/tree-sitter/) | MIT | Incremental concrete syntax parsing |
| [BLAKE3](https://github.com/BLAKE3-team/BLAKE3) | Apache-2.0 / CC0-1.0 | Stable identities, source revisions, and logical generation digests |
| [rustls](https://github.com/rustls/rustls) / [ring](https://github.com/briansmith/ring) | Apache-2.0 / ISC / MIT | TLS used by PostgreSQL connections |
| [ignore](https://github.com/BurntSushi/ripgrep/tree/master/crates/ignore) | MIT / Unlicense | Git-compatible bounded source discovery |
| [notify](https://github.com/notify-rs/notify) | CC0-1.0 | Native recursive filesystem watching with a bounded polling fallback |
| [secrecy](https://github.com/iqlusioninc/crates/tree/main/secrecy) | Apache-2.0 / MIT | Secret-bearing database URL wrappers |
| [toml_edit](https://github.com/toml-rs/toml) | Apache-2.0 / MIT | Format-preserving Codex MCP configuration updates |
| [tempfile](https://github.com/Stebalien/tempfile) | Apache-2.0 / MIT | Private temporary files and atomic configuration persistence |
| [thiserror](https://github.com/dtolnay/thiserror) | Apache-2.0 / MIT | Structured, redacted error contracts |

The release gate runs `cargo deny` against the locked dependency graph for
advisories, licenses, banned SQLite crates, duplicate exceptions, and source
provenance. `Cargo.lock` is the authoritative version inventory for a release.

## Native Tree-sitter grammars

Cartograph links the Rust grammar crates listed below. It does not bundle the
old v1 WebAssembly grammar collection.

| Grammar family | Upstream | License |
| --- | --- | --- |
| TypeScript and TSX | [tree-sitter/tree-sitter-typescript](https://github.com/tree-sitter/tree-sitter-typescript) | MIT |
| JavaScript and JSX | [tree-sitter/tree-sitter-javascript](https://github.com/tree-sitter/tree-sitter-javascript) | MIT |
| Rust | [tree-sitter/tree-sitter-rust](https://github.com/tree-sitter/tree-sitter-rust) | MIT |
| Python | [tree-sitter/tree-sitter-python](https://github.com/tree-sitter/tree-sitter-python) | MIT |
| Go | [tree-sitter/tree-sitter-go](https://github.com/tree-sitter/tree-sitter-go) | MIT |

Max Brunsfeld and Tree-sitter contributors created and maintain the parsing
runtime; the grammar repositories are maintained by their respective
communities.

## External database services

Cartograph requires separately installed services and extensions:

- [PostgreSQL](https://www.postgresql.org/) — PostgreSQL License;
- [ParadeDB / `pg_search`](https://github.com/paradedb/paradedb) — AGPL-3.0
  or commercial terms published by ParadeDB;
- [pgvector](https://github.com/pgvector/pgvector) — PostgreSQL License.

These projects are not copied into or redistributed with Cartograph's native
release archives. `cartograph db start` instructs the user's local Docker daemon
to pull an upstream, digest-pinned ParadeDB image as a separate service. See
[`docs/v2/LICENSING.md`](docs/v2/LICENSING.md) for the enforced distribution and
supported-use boundary.

## Build and quality tools

Cartograph's development and release gates also use:

- [Clippy](https://github.com/rust-lang/rust-clippy) and rustfmt from the pinned
  Rust toolchain;
- [cargo-deny](https://github.com/EmbarkStudios/cargo-deny), Apache-2.0 / MIT;
- [cargo-llvm-cov](https://github.com/taiki-e/cargo-llvm-cov), Apache-2.0 / MIT;
- [SonarQube](https://www.sonarsource.com/products/sonarqube/) for independent
  static analysis and coverage gates;
- GitHub Actions maintained by GitHub and their named upstream authors, pinned
  by commit in `.github/workflows/`.

If a project or author is missing or miscredited, please open an issue or pull
request so the acknowledgement can be corrected.
