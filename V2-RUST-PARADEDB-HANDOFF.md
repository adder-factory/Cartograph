# Cartograph v2 Rust/PostgreSQL/ParadeDB handoff

This is the durable continuation point for the v2 rewrite. Read
`docs/v2/ARCHITECTURE.md` completely before changing the implementation.

## User decisions that must not be reopened

- Ship v1.1.33 as the final v1 checkpoint, then build v2 from that exact tag.
- Remove SQLite. Do not preserve a SQLite runtime, fallback, config branch, or
  dual-backend abstraction.
- Require PostgreSQL 18+, ParadeDB `pg_search`, and pgvector.
- Write as much of the shipped product in Rust as possible. The final v2 CLI,
  MCP server, indexer, extraction pipeline, graph/search engine, database
  lifecycle, and diagnostics are Rust.
- Make ingestion highly parallel but bounded, cancellable, deterministic, and
  observable.
- Optimize first for usefulness to AI coding agents: intent-aware retrieval,
  graph constraints, compact evidence, affected tests, trust, and abstention.
- Use TypeScript v1.1.33 only as a temporary behavior oracle and migration
  source. Do not embed Bun/TypeScript as the v2 runtime.
- Release work must come from `main`; v2 work continues on a feature branch
  until the objective gates justify merging.

## Release baseline

- v1.1.33 release commit: `041e1859a25e27e867277a2b813ff0786ac2d0eb`
- Signed annotated tag: `v1.1.33`
- [Published release](https://github.com/adder-factory/cartograph/releases/tag/v1.1.33)
- Tag target and package version were verified before push; GitHub reports the
  SSH tag signature as valid and the tag resolves to `041e1859`.
- The tag-triggered [release workflow](https://github.com/adder-factory/cartograph/actions/runs/29978568421)
  completed successfully.
- Before the version-only commit, the exact code passed 7,139 tests with zero
  failures, 29 PostgreSQL integration tests, forced biomarkers at 0/0/0, the
  Sonar quality gate, retrieval baseline checks, and independent review.
- After the version bump, typecheck, architecture/format checks, version smoke,
  standalone build/smoke, and tracked/staged privacy inspection passed.
- All five native build/smoke jobs and the publish/provenance job passed. The
  immutable assets are Darwin arm64/x64, Linux arm64/x64, Windows x64, and
  `SHA256SUMS`. The five published asset digests exactly match the checksum
  file. Curated notes passed the privacy scan and are published on the release.

## Live runtime state at handoff creation

- The global `cartograph` command is installed from the signed
  `github:adder-factory/cartograph#v1.1.33` tag, is no longer linked to the v2
  working checkout, and reports 1.1.33. This keeps continued branch work from
  changing the machine-wide v1 tool underneath other projects.
- The old v1.1.32 shared daemon and a stuck hook worker were terminated cleanly.
- This already-open Codex session's MCP transport closed with the daemon and did
  not hot-register a replacement. Continue through the 1.1.33 CLI in this
  session. A fresh agent session should load Cartograph MCP 1.1.33 normally.
- A fresh standalone MCP initialize handshake was executed from the pinned
  global command and returned `serverInfo.version: "1.1.33"`. The server itself
  is healthy; only dynamic re-registration in the already-open host is absent.
- Do not delete a daemon lock while its recorded owner is alive. V1 exposed a
  repeatable long-lived hook-worker problem; the v2 supervisor requirements in
  the architecture doc are mandatory.
- At the time checked, the GitHub repository had no open issues.

## Git state

- Base: `v1.1.33` / `041e1859`
- Working branch: `feat/v2-rust-paradedb`
- Rust capability foundation: `fd0d663`
- Hardened ParadeDB development harness: `9d9119e`
- The architecture and this handoff are checkpointed immediately after those
  commits on the same branch.
- Rust/ParadeDB CI workflow: `e3158cb`; [run 29979753392](https://github.com/adder-factory/cartograph/actions/runs/29979753392)
  passed both the quality/no-SQLite job and the digest-pinned live database job.
- Managed lifecycle: `aa5b8f3`; [run 29983784952](https://github.com/adder-factory/cartograph/actions/runs/29983784952)
  passed format, clippy, unit, no-SQLite, live capability, and the full real
  Docker lifecycle fault suite on GitHub's amd64 runner.
- Generation-safe schema and first BM25 path: `8b60c79`; [run 29988967003](https://github.com/adder-factory/cartograph/actions/runs/29988967003)
  passed format, clippy, unit, no-SQLite, capability doctor, live migration and
  BM25 publication/recovery tests, and the full managed lifecycle suite on
  GitHub's amd64 runner.
- Do not amend the v1.1.33 tag or release. Fix v2 work with new commits.

The branch and origin are checkpointed through the generation-safe schema/BM25
slice. Continue with project operation leases, COPY loaders, and deterministic
generation digests; do not reopen the PostgreSQL-only or Rust-first decisions.

## Initial Rust slice

Implemented or in progress:

- Root Cargo workspace pinned to Rust 1.96.1 and v2.0.0-alpha.1.
- `cartograph-config`: secret-wrapped database URL, PostgreSQL-only URL
  validation, bounded pool/timeouts, errors that do not echo credentials.
- `cartograph-db`: Postgres-only driver dependency and read-only capability
  report for PostgreSQL 18, `pg_search`, pgvector, preload state, BM25 access
  method, and live `pdb.source_code` behavior.
- `cartograph-cli`: `cartograph-v2 doctor --format text|json` with nonzero exit
  status when a hard capability is absent.
- `deploy/paradedb`: pinned upstream ParadeDB 0.23.5 development service,
  persistent volume, health check, and idempotent extension initialization.
- Unit tests proving SQLite rejection, credential redaction, bounds checking,
  complete diagnostics when extensions are absent, PostgreSQL 17 rejection,
  and source-code tokenizer incompatibility rejection.
- The live arm64 development service reports PostgreSQL 18.4, `pg_search`
  0.23.5, pgvector 0.8.1, `pg_search` preload, BM25 access method, and the
  expected `{cartograph,search,snake,case,42}` tokenizer output. Both doctor
  formats return `ready: true`.

The Cargo dependency graph deliberately uses `sqlx-core` + `sqlx-postgres`
directly with exact versions. Do not replace them with default `sqlx` features:
the initial meta-crate resolution placed SQLite packages in `Cargo.lock` even
though they were not compiled. `cargo tree` and `Cargo.lock` must remain free of
`sqlx-sqlite` and `libsqlite3-sys`.

## Reproduce the current slice

```sh
cargo fmt --all --check
cargo clippy --workspace --all-targets --all-features -- -D warnings
cargo test --workspace
cargo tree --locked --workspace --all-features -e normal | rg 'sqlite|libsqlite'  # expect no output
rg '^name = "(sqlx-sqlite|libsqlite3-sys|rusqlite)"$' Cargo.lock  # expect no output

export CARTOGRAPH_POSTGRES_PASSWORD="$(openssl rand -hex 24)"
docker-compose -f deploy/paradedb/docker-compose.yml up -d
docker-compose -f deploy/paradedb/docker-compose.yml ps

export CARTOGRAPH_DATABASE_URL="postgresql://cartograph:${CARTOGRAPH_POSTGRES_PASSWORD}@127.0.0.1:55432/cartograph"
cargo run -p cartograph-cli -- doctor
cargo run -p cartograph-cli -- doctor --format json
export CARTOGRAPH_TEST_DATABASE_URL="$CARTOGRAPH_DATABASE_URL"
cargo test -p cartograph-db --test live_capabilities -- --ignored --nocapture
```

If the local machine has `docker compose`, it is equivalent. This machine has
the standalone `docker-compose` binary, not the Docker Compose CLI plugin.
The v2 harness defaults to host port 55432 so it can run beside the v1
PostgreSQL test/index instance on 5433. It binds only to `127.0.0.1` and refuses
to start without an explicit password. Compose scopes the container and volume
to its project. Set a unique `COMPOSE_PROJECT_NAME` and host port when running
multiple worktrees simultaneously.

Stop the development database without deleting its volume:

```sh
docker-compose -f deploy/paradedb/docker-compose.yml stop
```

Never run `down -v` unless intentionally destroying the v2 development data.

## M1 managed lifecycle slice

M1 adds the first user-facing Rust lifecycle:

```sh
cargo run -p cartograph-cli -- db status --format json
cargo run -p cartograph-cli -- db start --wait-seconds 90
cargo run -p cartograph-cli -- db logs --tail 50
cargo run -p cartograph-cli -- db stop
```

Implemented invariants:

- deterministic per-project container and volume names reveal no project path;
- both resources carry and verify managed/project ownership labels;
- existing containers must mount the exact owned named volume read/write at
  `/var/lib/postgresql`, and existing volume labels are revalidated;
- foreign same-name containers/volumes are refused without mutating the foreign
  Docker resource;
- a per-project OS file lock serializes lifecycle mutations across agents and
  processes;
- a 256-bit random credential is written atomically and reused;
- the password file is a bounded regular file opened no-follow/nonblocking,
  mode 0600 inside a mode-0700 state directory; writable ancestors, symlinks,
  and macOS extended ACLs are rejected;
- non-Unix creation fails closed pending tested Windows ACL support;
- Docker receives the password through `container cp`; container metadata has
  only `POSTGRES_PASSWORD_FILE=/tmp/cartograph-postgres-password`, not the
  password value or a secret-bearing env-file argument;
- non-UTF-8 Unix project paths are preserved as OS strings through `docker cp`;
- an existing volume without its original password file is refused instead of
  generating a password that cannot unlock the initialized PostgreSQL data;
- the active Docker endpoint is proven local once and pinned with explicit
  `--host` arguments for every later command, preventing context-switch races;
- ports are checked before creation/restart and published only on loopback;
- cold digest pulls have a separate 15-minute bound, ordinary Docker commands
  have a 30-second bound, and the requested readiness deadline covers TCP
  health, extension setup, connection, and capability queries;
- normal stop has a 45-second command budget around Docker's 30-second
  PostgreSQL grace period;
- health probes TCP explicitly so PostgreSQL's temporary initialization socket
  cannot produce a false healthy result;
- a start-created/restarted/unpaused container is restored to a safe prior
  state if readiness fails, and rollback failure is surfaced;
- paused and restart-looping containers have explicit status/stop behavior;
- successful start creates `pg_search`/`vector` and runs all six live doctor
  checks;
- status is read-only, logs are bounded, and start/stop are idempotent.

Local live evidence passed for create, healthy status, second start reuse,
bounded non-empty logs, password-free container metadata, mode 0600/0700,
same-project lock refusal, stop, stopped status, foreign container/volume
refusal, paused resume/stop, restart-loop stop, occupied-port classification
with no residual container, wrong/missing data mount refusal, orphaned-volume
credential refusal, zero-deadline rollback, and test cleanup. The
ignored Docker lifecycle tests complete in about ten seconds with the image
already pulled.

The final independent review verdict is `APPROVE` with no findings. The local
proof stack also passed 7,139 v1 TypeScript tests, the forced Cartograph
biomarker floor at 0 error / 0 warning / 0 info, coverage generation, and the
Sonar quality gate.

## Generation-safe schema and first BM25 slice

Implemented in Rust:

- `cartograph-domain` brands project, file, symbol, generation, document, model,
  and task UUIDs; deserialization validates and canonicalizes them, and nil IDs
  are rejected. The crate also owns stable generation/document/edge enums and
  BLAKE3 content-digest text.
- `CARTOGRAPH_DATABASE_SCHEMA` selects a conservative, canonicalized
  PostgreSQL schema identifier. Dynamic SQL accepts only that validated value
  and still quotes it explicitly.
- An append-only `schema_migrations` ledger records immutable version, name,
  and BLAKE3 checksum under a transaction-scoped advisory lock. Re-running is
  idempotent; checksum drift and newer schema versions fail closed.
- Migration 1 creates generation-safe projects, generations, files, symbols,
  edges, references, and search documents with project/generation composite
  foreign keys. A partial unique index enforces one current generation per
  project.
- The single `search_documents` BM25 covering index includes its unique bigint
  key, project/generation/document filters, path/language/kind, JSONB metadata,
  and code-aware casts for qualified names and code.
- Opaque `StagedGeneration`, `ReadyGeneration`, and `CurrentGeneration` tokens
  encode legal publication flow. Document insertion and readiness are one
  transaction; publication serializes per project, supersedes the old current
  row, changes the new row, and swaps the project pointer atomically. A
  monotonic project-local sequence rejects delayed older publishers.
- Prepare/publish failures return their consumed tokens. Checked recovery can
  reconstruct durable staging/ready state after a process restart and can mark
  abandoned work terminally failed without changing the visible generation.
- Current-generation BM25 search joins through the durable project pointer,
  binds all user text, orders by ParadeDB score and bigint key, and returns
  branded document/generation provenance.
- Managed `db start` now applies this migration after capability proof using
  the validated configured schema, then reports its name and whether a version
  was applied or reused.

Live tests against the pinned ParadeDB 0.23.5 image prove migration
idempotency, camelCase/snake_case code search, invisibility of ready/staging
generations, failed-batch rollback, atomic replacement, superseded/current
states, reverse-order stale-publication refusal, token retry/recovery/failure
marking, and checksum-tamper refusal. The full managed Docker lifecycle test
also passes with first-start migration and idempotent reuse of a non-default
schema.

Independent review initially found and then verified fixes for stale
reverse-order publication, consumed error tokens with no recovery path, and
managed startup ignoring the configured schema. The final verdict is `APPROVE`
with no findings. Final local evidence includes Rust format/clippy/unit, live
capability/generation/managed-Docker tests, v1 TypeScript gates, actionlint,
no-SQLite dependency checks, a forced 0/0/0 biomarker floor, fresh coverage and
Sonar quality gate, and a Cartograph diff analysis with zero introduced
findings.

## Execution plan

### M0 — final v1 release and v2 foundation

Exit criteria:

- v1.1.33 GitHub release is published from its signed tag with five native
  archives, `SHA256SUMS`, attestations, sanitized notes, and correct target SHA.
- A fresh MCP session reports/behaves as v1.1.33.
- Rust format, clippy, unit tests, no-SQLite dependency check, and live ParadeDB
  doctor all pass.
- Architecture and this handoff are committed.

### M1 — managed database lifecycle and migrations

Build in Rust:

1. `cartograph db start|stop|status|logs` without requiring Compose.
2. Private credential generation and mode-0600 local state.
3. Health wait with deadline, actionable image/runtime errors, idempotency.
4. Extension creation and strict version/capability checks.
5. Migration ledger and initial relational schema under a configurable,
   safely-quoted Cartograph schema.
6. `db backup|restore|upgrade` with verified output and extension version checks.
7. Integration tests on amd64 and arm64.

Red tests first: missing Docker, occupied port, unhealthy container, PG17,
missing preload, missing extensions, wrong source-code token stream, restart,
repeated start, cancellation, and secret leakage in logs/errors.

### M2 — domain contracts and generation-safe storage

Create `cartograph-domain` before schema implementation. Brand project, file,
symbol, generation, document, model, and task IDs. Use enums for lifecycle
states and edge/document kinds. Make incomplete generations impossible to
publish through the type/API design.

Implement:

- core relations from the architecture doc;
- project-scoped foreign keys and ordinary indexes;
- staged generation writes and atomic current-generation swap;
- advisory lock ownership metadata and stale-owner rules;
- COPY-based bulk loaders;
- deterministic database digest for cross-worker verification.

### M3 — Rust extraction parity

Port by language families rather than file-for-file translation:

1. Shared discovery/ignore/path normalization and content hashing.
2. Tree-sitter runtime and grammar asset loading.
3. TypeScript/JavaScript first because they exercise the richest v1 fixtures.
4. Python, Rust, Go, Java/Kotlin, C/C++, C#, then remaining supported modes.
5. Framework resolvers and cross-language bridges only after structural facts
   are stable.

Each port uses v1.1.33 fixture output as an oracle, then adopts a Rust-owned
golden contract. Do not call TypeScript from production Rust.

### M4 — bounded parallel indexer

Implement the staged pipeline and supervisor from the architecture doc. Commit
benchmarks for 1/2/4/8/16 workers. The logical digest and retrieval baseline
must be identical for every worker count.

Required fault injection:

- cancel/kill during read, parse, resolve, COPY, merge, BM25 build, and vector
  stages;
- slow/hung worker;
- database disconnect/restart;
- out-of-memory/backpressure simulation;
- parent exit and child reaping;
- competing hook and interactive sync.

### M5 — BM25, vector, graph, and hybrid retrieval

Implement schema and queries in measured increments:

1. Covering BM25 index with `pdb.source_code` on code/name fields.
2. Exact name/path/reference lookup and field boosts.
3. Graph traversal and affected-test queries.
4. Model-scoped pgvector storage/index management.
5. Concurrent candidate generation and deterministic RRF.
6. Working-tree overlay and freshness/trust flags.
7. Intent-specific evidence budgets and abstention.

Every result exposes provenance and component ranks. Evaluate deterministic,
BM25-only, vector-only, and hybrid modes separately; a missing semantic backend
must produce an explicit skip/readiness result, never silently relabel lexical
search as hybrid.

### M6 — Rust MCP/CLI and agent ergonomics

Freeze public JSON schemas before handlers. Port the smallest useful coding
profile first:

- status/doctor;
- context for a coding task;
- symbol/file lookup;
- graph callers/callees/impact;
- affected tests;
- review/compare-to-ref verification packet;
- admin sync/index.

Add request deadlines, cancellation, bounded response bytes/tokens, low-token
mode, profile gating, redaction, and stable error codes. Golden-test MCP
initialize/tools-list payloads and representative tool responses against the
approved v2 contracts.

### M7 — migration, evaluation, and cutover

Implement a v1.1.33 PostgreSQL importer first. Add a quarantined one-shot legacy
SQLite importer only if real user data requires it; never expose SQLite as v2
storage.

Lock the patch-task corpus fingerprint and compare v1.1.33 vs v2 on hit@5, MRR,
edit precision, test recall, abstention, token budget, and latency. Run migration,
backup/restore, crash recovery, extension upgrade, determinism, and native
packaging gates.

Only then:

- rename the preview binary from `cartograph-v2` to `cartograph`;
- remove Bun/TypeScript runtime packaging and all dual-backend code;
- update public install/agent docs for the PostgreSQL-only contract;
- merge through reviewed commits to `main`;
- cut a signed v2.0.0 release from `main`.

## Immediate next actions

1. Add project operation lease metadata with owner/process-start identity,
   heartbeat, bounded acquisition, and tested stale-owner takeover rules.
2. Add PostgreSQL COPY loaders for files, symbols, edges, references, and search
   documents, plus a deterministic logical-generation digest independent of
   worker count and insertion order.
3. Add `db remove`, backup/restore, and explicit image/extension upgrade with
   ownership checks and recovery tests.
4. Add Windows ACL hardening or keep managed lifecycle explicitly unsupported
   there; never weaken credential privacy to make the platform pass.

## Risks and decisions still requiring evidence

- Keep ParadeDB pinned to manifest digest
  `sha256:c3efc689b6ebd2fb396d7f50d68735b2dcff3e03f3bf51a926258d942201da2d`;
  the manifest contains amd64 and arm64, local arm64 passed, and CI must prove
  amd64 before M0 closes.
- Measure Community crash/reindex behavior before declaring it acceptable for
  the local product. Shared production needs a durability decision.
- Complete AGPL/commercial licensing review before distributing an image or
  offering a hosted service.
- Benchmark one shared `search_documents` table against project partitioning;
  preserve the same logical API until measured data selects the layout.
- Benchmark HNSW vs IVFFlat and model-scoped partial expression indexes on real
  code corpora.
- Decide whether specialized parsers need sandboxed worker processes after
  fault and memory measurements. Prefer Rust threads/tasks for safe parsers,
  isolated processes only where a crash boundary is justified.

## Definition of done for any continuation

Do not report a milestone complete from code inspection. Record objective
compiler/test/integration/benchmark output, run the repository's independent
reviewer step, keep the worktree/commit scope explicit, and update this handoff
with the exact next failing gate or actionable slice.
