# Cartograph v2 Rust/PostgreSQL/ParadeDB handoff

This is the durable continuation point for the v2 rewrite. Read
`docs/v2/ARCHITECTURE.md` completely before changing the implementation.

## User decisions that must not be reopened

- Ship v1.1.33 as the final v1 checkpoint, then build v2 from that exact tag.
- Remove SQLite. Do not preserve a SQLite runtime, fallback, config branch,
  importer, test utility, optional feature, or dual-backend abstraction.
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
- Observable project operation leases: `f43831c`; [run 29992907823](https://github.com/adder-factory/cartograph/actions/runs/29992907823)
  passed the quality/no-SQLite job in 1m03s and the PostgreSQL 18 + pinned
  ParadeDB + pgvector job in 1m44s. The latter includes the capability doctor,
  generation/BM25 test, lease upgrade/concurrency/takeover test, and full
  managed Docker lifecycle on GitHub's amd64 runner.
- Deterministic COPY ingestion and logical digest: `95530d2`; [run 29999242349](https://github.com/adder-factory/cartograph/actions/runs/29999242349)
  passed the quality/no-SQLite job in 1m01s and the PostgreSQL 18 + pinned
  ParadeDB + pgvector job in 1m44s. The database job passed the capability,
  generation/BM25, COPY/digest/chunk/NULL/rollback, lease, and managed Docker
  lifecycle tests on GitHub's amd64 runner.
- Deterministic COPY handoff checkpoint: `172a5af`.
- Cancellation-safe bounded index supervisor: `bcafdc6`; [run 30020453887](https://github.com/adder-factory/cartograph/actions/runs/30020453887)
  passed the Rust quality/no-SQLite job. Its live job passed 21/22 supervisor
  cases but exposed a shared-runner-only 50 ms heartbeat SQL deadline in the
  otherwise-correct large-COPY test envelope.
- Large-COPY test isolation: `65caa64`; [run 30021281266](https://github.com/adder-factory/cartograph/actions/runs/30021281266)
  keeps the injected COPY duration above the heartbeat SQL deadline and below
  its independent COPY deadline, while leaving the aggressive heartbeat-
  uncertainty configuration unchanged. Its live job then failed two different
  tight-deadline cases at 20/22, proving unrelated parallel fault cases were
  contending on the shared GitHub ParadeDB service.
- Deterministic supervisor fault harness: `d12bf23`; [run 30021933926](https://github.com/adder-factory/cartograph/actions/runs/30021933926)
  runs the 22-case supervisor binary with `--test-threads=1`. Concurrency inside
  each case remains intact; only unrelated lock/deadline cases stop stealing
  one another's scheduler and database budgets. The run passed the 1m09s Rust
  quality/no-SQLite job and the 1m57s PostgreSQL 18 + pinned ParadeDB job,
  including doctor, capability, generation/BM25, COPY/digest, leases, all 22
  supervisor cases, and the managed Docker lifecycle.
- Bounded deterministic stage runner: `8e06435`; [run 30028908774](https://github.com/adder-factory/cartograph/actions/runs/30028908774)
  passed the Rust quality/no-SQLite job in 1m12s and the PostgreSQL 18 + pinned
  ParadeDB job in 2m04s. This adds typed stage
  envelopes, hard worker/queue/task/byte admission, ordered reduction, retained
  output reservations, stage/item/cleanup deadlines, drop-safe poisoning, and
  a 23rd live supervisor case that reaches PostgreSQL/ParadeDB publication only
  after reverse-completing parallel work is reduced in exact input order.
- Frozen parallel-index benchmark and COPY observability: `b814932`; [run 30036702684](https://github.com/adder-factory/cartograph/actions/runs/30036702684)
  passed the Rust quality/no-SQLite job in 1m16s and the PostgreSQL 18 + pinned
  ParadeDB job in 3m25s. The live job passed doctor, capability,
  generation/BM25, COPY/digest, lease, all 23 supervisor cases, the complete
  1/2/4/8/16-worker benchmark in 1m25s, and managed Docker lifecycle on
  GitHub's amd64 runner.
- Frozen benchmark handoff checkpoint: `09bf269`.
- Bounded native TypeScript/JavaScript extraction: `00fbfe9`;
  [run 30048359888](https://github.com/adder-factory/cartograph/actions/runs/30048359888)
  passed the Rust format/Clippy/unit/no-SQLite job in 1m28s and the full
  PostgreSQL 18 + pinned ParadeDB + pgvector job in 3m41s. The live job passed
  doctor, capability, generation/BM25, COPY/digest, lease, all 23 supervisor
  cases, the frozen 1/2/4/8/16-worker benchmark, and managed lifecycle.
- Do not amend the v1.1.33 tag or release. Fix v2 work with new commits.

The branch and origin are checkpointed through the native extraction
implementation at `00fbfe9`, with both v2 GitHub jobs green. Do not reopen the
PostgreSQL-only, no-SQLite, or Rust-first decisions.

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

## Observable project operation lease slice

Implemented in Rust and migration 2:

- `LeaseId` is a branded non-nil UUID and `ProjectOperation` has stable values
  for `index`, `sync`, `hook`, `migration`, and derived-index `rebuild` work.
- `project_operation_leases` stores one row per project/operation with a fresh
  ownership token, owner PID, boot/session-qualified process-start marker,
  optional generation, acquisition/heartbeat timestamps, and expiry. Composite
  foreign keys preserve project/generation isolation.
- The append-only migration runner now applies ordered versions 1 and 2,
  refuses a missing predecessor, rejects newer schemas, and verifies every
  recorded name/checksum. Golden tests freeze the exact BLAKE3 checksum of both
  committed migrations so an accidental edit to shipped SQL fails locally
  before an existing database reports ledger conflict.
- Acquisition validates owner metadata and a bounded 1-second-to-5-minute
  duration, then takes a non-blocking transaction advisory lock scoped to the
  configured schema, project, and operation. A conditional upsert returns
  `Busy` for a live owner or atomically replaces an expired row with a new
  token.
- Heartbeat and release require the exact unexpired token. PostgreSQL's clock,
  not a process clock, decides expiry; a stale token cannot mutate a row after
  takeover. Read-only status exposes owner/generation/timestamps and whether
  the database considers the row expired.
- Public errors omit driver/query/credential details. The opaque mutation token
  is distinct from serializable diagnostic status.

The live pinned-ParadeDB test proves a fresh `[1, 2]` migration, an existing-v1
to-v2 upgrade, idempotent reuse, ledger-gap refusal, active-owner exclusion,
database-side heartbeat renewal by the exact configured duration, observable
expiry, deterministic stale-owner takeover, stale-token rejection, release,
and exactly one winner under simultaneous acquisition. It uses direct
database-clock fixture updates instead of sleeps or client wall time.

Independent review first returned `REQUEST_CHANGES` because the tests did not
freeze committed migration checksums or prove that heartbeat advanced expiry.
Both proofs were added; the same reviewer then returned `APPROVE` with no
findings. Final local evidence includes Rust format/clippy/workspace tests,
live capability/generation/lease tests, the full managed Docker lifecycle,
7,139 v1 tests with zero failures, 29 v1 PostgreSQL tests, strict TypeScript and
architecture/Biome gates, actionlint, a SQLite-free Cargo graph/lockfile, forced
biomarkers at 0/0/0, and Sonar `OK` with 86.0% overall coverage, 91.5% new-code
coverage, and zero new violations. GitHub run 29992907823 repeats the Rust and
real-database proof on amd64.

## Deterministic COPY ingestion and logical digest slice

Implemented in Rust:

- `GenerationFacts` is the unordered typed boundary for files, symbols, edges,
  references, and ParadeDB search documents. The generation API no longer
  accepts a caller-provided digest: readiness can only carry the digest computed
  from the complete validated fact set.
- The reducer validates normalized relative paths, language and text bounds,
  finite confidence, database numeric bounds, source spans, branded
  relationships, and document ownership. Symbols/references cannot extend past
  their owning file or belong to `failed`/`skipped` files; file- and
  symbol-bound documents must agree with the owning path and language.
- Stable logical keys drive `BTreeMap` ordering and exact deduplication.
  Conflicting repeated identities fail closed. JSON object keys are recursively
  sorted, and canonical encoding streams through a hard 64 KiB writer budget
  so oversized/wide metadata cannot first allocate an unbounded second copy.
- A domain-separated BLAKE3 digest covers every reduced logical fact. It
  deliberately excludes project ID, generation UUID/sequence, worker count,
  database surrogate identity, and arrival order. Fixed-width numeric encoding,
  explicit optional markers, length-delimited text, canonical JSON, and
  normalized negative zero make the representation deterministic.
- PostgreSQL text COPY coalesces ordinary encoded rows in an at-most-1 MiB
  aggregation buffer and loads files, symbols, edges, references, then search
  documents in foreign-key order. Tabs, newlines, carriage returns,
  backslashes, COPY control escapes, and the difference between SQL NULL and
  literal `\\N` are encoded explicitly. An individually validated row larger
  than 1 MiB is sent directly rather than copied again.
- All five COPY streams, exact completion-count checks, the computed digest,
  and the transition to `ready` share one transaction under a locked generation
  row. A failure in the final search-document COPY rolls back every earlier
  table and returns the original opaque staging token.
- Ready/current tokens expose the computed content digest. Recovery validates
  and restores a durable ready digest after process loss. The publication lock
  key now includes both configured schema and project identity.
- CI has a dedicated live COPY integration step. Its frozen fixture proves the
  same golden digest when generation metadata records worker counts of 1 and 16
  with reversed input, canonical JSON, and duplicate
  edges/references/documents. It also proves actual PostgreSQL round trips
  across cumulative and individual 1 MiB chunk boundaries, SQL NULL optional
  foreign keys, COPY escaping, all five table counts, ready recovery, and
  late-trigger transaction rollback.

Independent review first returned `REQUEST_CHANGES` for missing file-size and
document-owner consistency, parse-status semantics, post-allocation metadata
bounds, and live COPY chunk/NULL proof. Every finding received a focused
regression and fix. The same reviewer returned `APPROVE` with no findings, then
separately approved the named-count-only cleanup requested by the live
Cartograph findings delta.

Final local proof on commit `95530d2` includes Rust format, strict workspace
Clippy, all workspace unit/doc tests, all four live pinned-ParadeDB tests, a
SQLite-free Cargo graph/lockfile, TypeScript typecheck and architecture/Biome,
7,139 v1 tests with zero failures under the supported `N=16` shard layout, 29
v1 PostgreSQL tests, two forced biomarker passes at 0/0/0 with zero cross-file
errors, a live Cartograph delta with zero introduced findings, and Sonar `OK`
at 86.0% overall coverage, 91.5% new-code coverage, and zero new violations.

One infrastructure caveat is intentionally not hidden: the default `N=8`
`npm test` layout repeatedly made Bun 1.3.14 terminate shard 7 natively with
`Trace/BPT trap`/segfault near `stress-test-roundtwo-fixes.test.ts`, including
three harness retries and a direct isolated-shard retry. The run had no product
assertion failure, but the harness correctly remained failed. Running the same
555 files at the documented `N=16` layout completed 7,139/0/41 in 61 seconds.
Do not weaken or skip tests to mask the Bun runtime failure; retain `N=16` as
the full-suite gate while investigating the runtime separately.

## Cancellation-safe bounded supervisor slice

Implemented in Rust at `bcafdc6`:

- New `cartograph-indexer` crate owns one supervised, generation-bound project
  operation. The request binds the project/operation/generation target, an
  observable PID/process-start owner, and a bounded lease duration.
- `SupervisorConfig` validates every deadline relationship before lease
  acquisition. Whole-operation, progress, cancellation-grace, heartbeat
  interval/request, and PostgreSQL COPY deadlines are distinct. COPY defaults
  to one quarter of the operation budget and is never shortened to the lease
  heartbeat request timeout. Worker admission has hard task and byte limits.
- Status is structured and observable: queued, active, cancelling, wedged,
  completed, failed, or cancelled; current stage, item/byte progress, heartbeat
  count, idle duration, cancellation reason, and grace-exceeded state are
  exposed without the lease mutation token.
- Cancellation and publication share one synchronous lifecycle gate. A
  cancellation accepted before publication guarantees publication cannot
  start. Once publication has begun, a late cancellation is rejected and the
  supervisor reports the durable publication result rather than lying about a
  cancelled commit.
- Public `IndexerSupervisor::run` immediately moves the operation into one
  owned Tokio task. `SupervisorRunGuard` retains both that task and the exact
  spawning runtime handle. If the caller aborts its task, applies an outer
  timeout, or moves a polled future to a plain thread and drops it there, the
  guard still signals cancellation and schedules one bounded reaper on the
  correct runtime. The reaper awaits graceful shutdown, then aborts and awaits
  only at its absolute bound.
- `TaskScope` has no hidden queue. Every admitted child reserves task/byte
  capacity, every completion/failure remains visible until joined, and
  publication fails when a worker result is unobserved, panicked, or still
  active. Scope shutdown aborts and joins all registered children by the
  operation deadline.
- `PrepareScope` permits exactly one retained prepare/COPY task. The work
  context exposes only `prepare_generation(contents)`, progress, cancellation,
  and bounded child spawning; it never exposes a lease fence or a terminal
  mutation capability. Separate prepare and terminal newtypes have compile-fail
  proof that pipeline work cannot publish or clean up a generation.
- Lease acquisition uses a fresh opaque UUID-v4 token for each attempt. A
  single acquisition attempt is recoverable after a client timeout but cannot
  be replayed with the same token. Read-only lease status deliberately excludes
  that token. Takeover uses PostgreSQL time and rejects a live owner or a stale
  worker trying to mutate after replacement.
- The database mutation order is operation advisory, generation advisory, then
  exact lease validation. Prepare checks token, generation, and database-clock
  expiry after both advisories and before entering COPY, while leaving the
  lease row unlocked so heartbeats can run. A final `FOR UPDATE` fence check
  immediately precedes the ready transition.
- Heartbeats, acquisition, reconciliation, COPY, publication, and cleanup all
  run as retained tasks with server-side statement bounds. Every transaction
  rolls back explicitly on its body error. Timeout/commit uncertainty is
  reconciled from generation and exact-token lease state in one bounded query;
  retries are permitted only when that durable snapshot proves them safe.
- Terminal cleanup atomically fails the exact staging/ready generation and
  releases the exact lease. Authority-uncertain lost-heartbeat/lost-lease paths
  do not mutate a possible new owner's generation.
- COPY table mechanics are one typed static plan per table, preserving the
  deterministic files -> symbols -> edges -> references -> search-documents
  order, exact encoders, bounded chunks, completion counts, and transactional
  rollback.

The pinned-ParadeDB live supervisor suite now has 22 cases. Beyond normal
success, it proves progress-stall and operation-deadline cancellation,
cooperative and noncooperative work, dropped child failures, ownership loss,
stale takeover, long 2 MiB COPY payloads, bounded acquisition/publication/
cleanup reconciliation, blocked COPY/publication/cleanup reaping, concurrent
heartbeat uncertainty plus blocked COPY, caller task abort, and cross-thread
drop of an already-polled public run future. Lock-injection cases assert zero
active schema queries and free operation/generation advisories before releasing
the external blocker, then verify the exact durable generation and lease state.

Independent review went through multiple strict `REQUEST_CHANGES` rounds: it
caught reusable authority tokens, lock ordering, pre-COPY stale-fence work,
unbounded/dropped durable futures, heartbeat-scaled COPY timeouts, incomplete
rollback, already-expired reaping, caller-future cancellation, and finally the
non-runtime-thread Drop path. Each finding received a focused implementation
change and live regression. The final reviewer verdict on `bcafdc6` is
`APPROVE` with no findings. The same reviewer separately approved `65caa64` as
a test-isolation correction: its 200 ms injected COPY remains above the 150 ms
heartbeat SQL deadline and below the independent 500 ms COPY deadline, so it
would still fail if production accidentally reused the heartbeat bound. The
reviewer also approved `d12bf23`: serializing the fault-injection binary removes
unmodelled cross-case server contention without serializing the Tokio tasks,
locks, takeovers, or reconciliation races exercised inside each case.

Final local proof for this slice includes Rust format/check/strict Clippy, all
workspace unit and compile-fail doc tests, 22/22 live supervisor tests, 6/6
live capability/generation/COPY/lease tests, actionlint, a SQLite-free Cargo
graph and lockfile, TypeScript strict/architecture/Biome gates, 7,139 v1 tests
with zero failures, a 0/0/0 biomarker floor, Sonar quality-gate `PASSED`, and
zero active test schemas or Cartograph v2 PostgreSQL statements afterward.

## Bounded deterministic stage-executor slice

Implemented in Rust at `8e06435`:

- `SupervisorContext::stages()` creates a supervisor-bound `StageRunner`.
  Callers provide contiguous `StageSequence` values, stable keys, payloads,
  reserved/progress bytes, absolute item deadlines, explicit worker/queue
  capacity, a stage deadline, and a separate cleanup grace.
- The active-plus-queued window is exactly bounded. Tasks waiting for a Tokio
  semaphore are the explicit queue and every admitted task remains registered
  with the existing global `TaskScope`; there is no second hidden channel.
- A completed out-of-order result retains its task and byte reservation until
  ordered reduction and progress acknowledgement. Later fast files therefore
  cannot route around an earlier blocked file or exceed global admission.
- Work can complete in any order, but reduction and progress are contiguous
  from sequence zero. Non-contiguous input fails closed. The iterator advances
  only while a bounded slot exists and may retain at most one unadmitted
  lookahead envelope under byte pressure.
- Item time covers semaphore wait plus worker execution and is capped by the
  whole-stage deadline. The driver checks that stage deadline before/after
  bounded input and reducer callbacks, while waiting for results, and around
  asynchronous progress. Slow item, slow final exhaustion, and slow reducer
  regressions prove an expired stage cannot report success.
- Iterator `next` and the per-item reducer are explicitly trusted bounded,
  nonblocking callbacks. Blocking I/O and expensive CPU work belongs in the
  abortable worker future or another supervised stage; unsafe/crashy parser
  process isolation remains a later evidence-based decision.
- Worker failure, item deadline, stage deadline, panic/unexpected exit, reducer
  failure, progress failure, cancellation, local join failure, and incomplete
  cleanup have credential/path-safe structured provenance. A distinct cleanup
  grace remains usable after the stage deadline has already expired.
- Dropping a started `execute` future aborts retained workers and poisons the
  publication scope. Reservations are acknowledged only after reduction plus
  progress, or deliberately cancelled after accepted parent cancellation.
  Thus selecting away from a stage cannot silently permit publication, while
  supervisor-driven cancellation is not mislabeled as a worker failure.
- `StageMetrics` follows the exact reservation lifetime and reports admitted,
  reduced, current, and peak item/byte counts. A failed observer is a structured
  stage failure; even the task registered immediately before that failure is
  aborted and reaped before `execute` returns.

The focused Rust suite now has 24 `cartograph-indexer` unit tests. New tests
cover reverse completion, exact reduction, worker/queue caps, byte
backpressure, retained out-of-order capacity, empty input, non-contiguous
input, item/stage deadlines, slow exhaustion, cancellation before/while work,
worker/reducer failure, panic, execute-future drop after delivery, cancellation
aware drop, cooperative deadline reaping, surfaced uncooperative cleanup
timeout, exact successful metrics, failed-reservation release, and poisoned
observer cleanup. The pinned live suite is 23/23 and the new case proves ordered stage
work, progress counters, supervised COPY, generation publication, and exact
lease release on PostgreSQL 18 + ParadeDB 0.23.5 + pgvector 0.8.1.

Independent review required two correction rounds. It first found that the
stage deadline did not cover producer/reducer time, a delivered result could be
discarded by dropping `execute`, and cleanup reused an expired stage deadline.
After those fixes, it found the slow final `next() -> None` path could still
report success. Each finding received a direct regression; final review is
`APPROVE` with no findings.

Local proof after the final review includes Rust format/check/strict Clippy,
all workspace unit and compile-fail doc tests, the SQLite-free Cargo graph and
lockfile, 23/23 live supervisor tests, TypeScript strict/architecture/Biome and
actionlint, a forced full Cartograph biomarker pass at 0/0/0 with zero
cross-file errors, and Sonar `OK` at 91.5% new-code coverage, 86.0% overall
coverage, zero bugs/vulnerabilities/new violations, and 100% reviewed security
hotspots.

The legacy Bun suite remains an explicitly recorded infrastructure caveat, not
a hidden green check. One full `N=16` run during this slice passed
7,139/0/41. Later identical runs repeatedly ended with Bun 1.3.14 native
`Trace/BPT trap` exits in shard 15 (and occasionally an initially retried shard
3); all 34 shard-15 files passed alone, every product assertion passed, and the
harness correctly stayed failed after its three whole-shard retries. No v2
Rust file is imported by that v1 suite. Do not weaken the harness or relabel
the failed process run; v2 removes this failure class when Bun/TypeScript is no
longer the shipped runtime or release gate.

## Frozen scaling benchmark and COPY observability slice

This slice adds two observers without changing scheduling or persistence:

- `StageMetrics` remains cloneable outside a moved stage execution and exposes
  exact admission, successful reduction, current reservation, and high-water
  counters. Failed/cancelled work releases current capacity without being
  mislabeled as completed.
- `PrepareGenerationMetrics` is attached to `GenerationContents` and times
  exactly the five PostgreSQL COPY streams. It includes bounded row encoding
  and excludes Rust validation, lease/generation fencing, the ready transition,
  publication, and benchmark verification queries.

`crates/cartograph-indexer/benches/index_scaling.rs` is an optimized,
machine-readable, assertion-bearing benchmark rather than a timing-only demo.
For each worker count 1/2/4/8/16 it runs one warmup and five measured samples,
each in a fresh schema. Every sample executes the real bounded stage runner,
deterministic reduction, supervisor-owned prepare/COPY, atomic publication,
ParadeDB BM25 lookup, row-count checks, task-publication gate, exact lease
release, and schema cleanup. GitHub's live ParadeDB job now runs the same matrix
as a cross-architecture invariant gate without a flaky wall-clock threshold.
The harness pins a length-delimited fixture/config fingerprint, source digest,
logical digest, literal row counts, and ordered BM25 IDs; the first run cannot
silently adopt drift as a new baseline. A preflight intentionally fails project
registration after migration and proves setup cleanup leaves no schema.

The committed fixture metadata and reports are in
`docs/v2/benchmarks/INDEX-SCALING.md`, the immutable original
`docs/v2/benchmarks/index-scaling-aarch64-2026-07-22.json`, and the separately
captured digest-v2 report
`docs/v2/benchmarks/index-scaling-aarch64-2026-07-22-digest-v2.json`. The measured host
was Apple arm64 with 14 logical CPUs, Rust 1.96.1, PostgreSQL 18.4,
`pg_search` 0.23.5, and pgvector 0.8.1. The fixture contains 256
TypeScript-shaped items, 6,145,536 source bytes, and 32 deterministic BLAKE3
analysis rounds per item.

All 30 current warmup/measured runs produced logical digest version 2
`3fcf25b6aef136419808799cc59b4b95ceb3f5014acef35192645242b4dd5d25`,
row counts 256 files / 256 symbols / 255 edges / 255 references / 256 search
documents, and BM25 first hit
`30000000-0000-4000-8000-000000000001`. Every successful run had zero retained
stage reservations, zero active tasks before publication, no lease afterward,
and no residual benchmark schema.

Median supervised Parse-plus-Reduce throughput increased from 1,696 items/s at
one worker to 6,754 at 16 workers. Median end-to-end time fell from 240.11 ms to
116.38 ms; COPY p50 stayed near 57-67 ms and became the dominant floor. Eight workers
reached 130.72 ms, so 16 workers added a final 11.0% end-to-end improvement while doubling the
bounded window from 16 to 32 items. The initial policy is therefore up to 16
parse/extract workers, capped by available parallelism, one queued envelope per
active worker, and the independent byte budget as the hard memory authority.
The benchmark now runs canonical Reduce as a one-item supervised stage with the
full 256 MiB working reservation, so all worker rows honestly report
268,435,456 peak reserved bytes rather than only the smaller Parse window.
COPY remains one retained database task. Re-measure this choice on the real
TypeScript/JavaScript extractor corpus before locking production defaults.

Independent review first rejected self-adoption of the benchmark's first run
as its baseline and incomplete schema ownership after post-migration setup
failure. The final implementation pins committed fixture and logical-output
oracles, injects that failure before timing, proves the schema is absent through
a new connection, preserves primary plus cleanup errors, and always closes the
pool. The exact final staged candidate requires a fresh reviewer verdict after
all benchmark code and evidence are staged together.

Final local proof on the exact code commit includes Rust format, strict Clippy,
all workspace unit and compile-fail doc tests, all live PostgreSQL/ParadeDB
suites, the optimized 30-run matrix, TypeScript typecheck and
architecture/Biome, actionlint, a SQLite-free Cargo graph and lockfile, forced
Cartograph biomarkers at 0/0/0 with zero cross-file errors, and Sonar `OK` at
91.5% new-code coverage, 86.0% overall coverage, zero bugs, zero
vulnerabilities, zero new violations, and 100% reviewed security hotspots.

## Native TypeScript/JavaScript extraction slice

The current branch adds the first production-Rust extraction family without
calling the v1 TypeScript runtime:

- `cartograph-domain` now owns validated normalized source paths, typed
  start/end positions and spans, source languages, declaration/reference
  kinds, visibility, and deterministic RFC 9562 UUIDv8 constructors.
- `cartograph-extract` classifies TypeScript/TSX/JavaScript/JSX extensions,
  validates UTF-8 and bounded exact bytes, computes BLAKE3 hashes, performs
  symlink-aware bounded reads, loads statically linked native Tree-sitter
  grammars, and emits normalized declarations, lexical containment, unresolved
  imports/types/heritage/calls/construction/JSX/field references, and bounded
  syntax diagnostics.
- Stable file IDs use canonical paths. Stable symbol IDs use path, kind,
  scope-qualified name, and same-scope ordinal, so formatting/line changes and
  inserting the same local name in another class do not churn existing IDs.
  Symbol structural digests ignore comments and formatting while retaining
  semantic syntax.
- Tree-sitter's progress callback, the Rust walker, diagnostics, structural
  hashing, and the file reader all poll cooperative cancellation. The shared
  stage runner now carries parent, sibling/stage, and effective-deadline state
  into CPU work before abort/reap fallback.
- `run_native_extraction_stage` lazily admits snapshots with conservative byte
  reservations, per-envelope deadlines beginning at admission, one bounded
  queue, ordered reduction, and exact in-flight reservation metrics. It no
  longer accumulates a corpus-sized `Vec<ExtractedFile>`: a trusted fixed-state
  validation observer sees each ordered output while its reservation is held,
  then the output is dropped. A complete field digest is identical at one and
  four workers, and a 256-file regression keeps peak declared bytes under the
  scope. The observer is explicitly not the owned/backpressured persistence
  handoff; that remains in the next slice.
- Four locked v1.1.33 fixtures provide the initial declaration/reference
  projection. A temporary Zod-parsed TypeScript test independently reruns the
  v1.1.33 extractor against all four expected cases before Rust consumes the
  oracle. Rust-owned regressions cover exact BLAKE3, path/language/size/UTF-8
  rejection, recoverable parse damage, cancellation across flat and large-leaf
  trees, syntax-stable identity/digests, semantic template/JSX whitespace,
  duplicate ordinals, cross-scope identity stability, validated Serde spans/
  language values, alias/component type references, enum-member isolation,
  bounded adversarial output, outside-root symlinks/FIFOs, split UTF-8, redacted
  debug output, and oversized files.

The exact contract and limitation ledger is
[`docs/v2/EXTRACTION.md`](docs/v2/EXTRACTION.md). This slice deliberately stops
before claiming end-to-end M3/M4 completion: the real-corpus 1/2/4/8/16
benchmark, module/import resolution, body-bearing search documents, remaining
language families, and measured RSS policy are not implemented yet. The 32x
parse reservation remains conservative accounting, not an OS-level
Tree-sitter RSS cap.

### Native discovery-to-COPY pipeline slice

The branch now connects the first native language family to the existing
PostgreSQL engine without invoking TypeScript in production:

- Rust `ignore` discovery applies standard Git-compatible ignore files,
  includes hidden source, hard-excludes `.git/` and `.cartograph/`, honors
  `.cartographignore` directory markers, skips symlinks, sorts deterministically,
  and fails closed on unreadable/non-UTF-8 trees or configured file/path-memory
  limits.
- A supervised read/hash stage reserves `2 * source bytes + 128 KiB`, streams
  UTF-8 and BLAKE3 with cancellation, and drops source into a compact manifest.
  Parse reopens under the exact observed size and rejects content hash,
  language, or stable-ID drift before native Tree-sitter executes.
- Ordered `ExtractedFile` ownership is converted immediately into separately
  budgeted project facts before its parse reservation is released. No corpus
  vector of snapshots or raw extractor outputs exists. The retained canonical
  generation has its own hard cap. Resolve charges candidates, capacities, and
  output clones within a 3x task envelope; storage validation measures actual
  outer-vector and JSON-array capacities with type-correct roots inside its
  supervised blocking stage. Modeling, map conversion, relation-map construction,
  and relation validation are cancellation-polled under a 4x working envelope.
  The input/output measurements travel in the validation report, so Tokio workers
  do not rescan the corpus.
- Resolution first selects one exact same-file symbol, then one unique project
  symbol. Qualified members stay unresolved until receiver/type/import evidence
  exists; ambiguous/missing targets retain name, lexical owner, span,
  confidence, and provenance. This is intentionally not yet import-alias,
  module-path, lexical-shadowing, or overload resolution.
- Deterministic reduction produces an opaque five-table
  `CanonicalGenerationFacts` capability after field/relation validation,
  deduplication, canonical JSON, and a complete digest. Async prepare/COPY no
  longer runs a synchronous cloning reducer. Search documents carry paths,
  qualified names, safe callable declaration signatures, and JSDoc; non-callable
  initializer RHS values, callable signatures containing default/literal
  expressions, and complete implementation bodies are excluded.
- Append-only migration 3 expands the `edges` constraint for all native
  relationship kinds, including `type_of`, `returns`, `instantiates`,
  `overrides`, `decorates`, `field_access`, `def_use`, and `exports`.
- Append-only migration 4 persists bounded reference names, owner symbols, and
  resolution provenance and adds an owner index.
- Append-only migration 5 persists the logical digest contract version. A
  populated v1 reference-generation upgrade proves its historical digest is
  unchanged and marked v1; newly prepared complete-reference facts are v2.
- The new live supervisor case proves native discovery -> read/hash ->
  parse/extract -> resolve -> reduce -> PostgreSQL COPY -> publish -> ParadeDB
  BM25, including unresolved reference evidence. Unit coverage proves
  `.gitignore`/marker behavior, test-path routing, cancellation/limits,
  complete-digest one-vs-four-worker identity, long-path/many-symbol and spare
  edge/JSON/vector capacity charging, cancellation during model/map/relation
  passes, storage-cap rejection, qualified-member false-positive prevention,
  non-callable plus scalar/destructured/arrow/method/component secret initializer
  exclusion, and read-to-parse drift rejection.

Known limits are deliberate and test-visible: the first walker applies ignore
rules uniformly and therefore does not yet restore already-tracked files later
covered by an ignore rule; embedded repository/submodule parity needs a locked
corpus; canonical facts remain in bounded memory until COPY; and Tree-sitter
RSS still needs a real-corpus measurement.

### Native extraction verification and exact continuation state

Independent review of the exact staged diff against `09bf269` returned
`APPROVE` with no findings. The final local proof on `00fbfe9` includes:

- Rust format, strict workspace Clippy, all offline workspace unit/integration
  tests plus three compile-fail doc tests, and no SQLite crate in the
  production tree or lockfile;
- PostgreSQL 18.4, `pg_search` 0.23.5, pgvector 0.8.1, source-code tokenizer,
  generation/BM25, COPY/digest, lease, all 23 live supervisor tests, and both
  managed lifecycle tests;
- the assertion-bearing 30-sample frozen 1/2/4/8/16-worker benchmark with the
  committed digest/row/BM25/task/lease/cleanup invariants;
- TypeScript typecheck, architecture/Biome, actionlint, the independent
  v1.1.33 oracle test, a forced full Cartograph biomarker rebuild at
  0 error / 0 warning / 0 info with zero cross-file errors, and Sonar quality
  gate `OK`;
- the full TypeScript harness reached 7,140 passing assertions and 41 skips.
  Bun 1.3.14 repeatedly terminated shard 7 with `Trace/BPT trap` after all
  three same-shard retries; the fail-closed harness then ran every one of that
  shard's 69 files alone and all passed. Treat this as the known Bun runtime
  instability, not a green aggregate harness exit and not a test assertion
  failure.

On this machine, `.cartograph/v2/postgres.env` remains private but its password
did not match the already-running ParadeDB container. Local live gates used the
container's current credential in-process without printing it and did not edit
the secret file. A continuation that restarts/recreates the service should
reconcile the private env through the managed lifecycle rather than copying a
credential into source or logs.

### Native real-corpus scaling slice

The Rust-owned real corpus gate is now implemented in
`tests/live_supervisor/native_corpus.rs`. It compiles 24 representative
Cartograph TypeScript files plus the four TS/JS/TSX/JSX v1.1.33 oracle sources
into the test binary, materializes them into an isolated checkout, and locks the
length-delimited 28-file / 1,052,338-byte fingerprint
`5be02b94045f978010d7c8ffeba1a8568a16aaad1ff15f884609524aa61f4d20`.

Each 1/2/4/8/16-worker row runs in a separate child process with one warmup,
three measured fresh-schema samples, a 180-second kill-and-reap deadline, and
fail-closed 25 ms current-RSS sampling. The report identifies macOS/aarch64 and
records each child's successful RSS sample count. Parent-known schema names are
removed after an abnormal child exit; a dedicated live regression hangs a child
and proves kill, reap, and cleanup. All 20 runs produced digest-v2
`c51f87287539116a4f60149f65241053821046f4045fa7e0dc1e5a92343f0059`,
28 files / 3,840 symbols / 4,473 edges / 12,651 references / 3,868 documents,
the same eight edge kinds and ordered BM25 IDs, completed publication, exact
lease release, and schema cleanup. Canonical payload accounting was 8,074,529
bytes retained, 56,600,216 bytes resolve high-water, and 46,054,906 bytes
validation high-water.

Four workers are the real-corpus scheduling knee: native p50 falls from
1,108.77 ms at one worker to 573.75 ms, supervised pipeline time falls from
6,585.26 to 6,117.48 ms, and peak RSS is 71.30 MiB. Eight workers buy only 0.4%
lower native p50 for 5.89 MiB more peak RSS; 16 regress to 763.17 ms and 87.08
MiB. COPY is 5,519.16 ms at four workers, 90.2% of median supervised pipeline
time. Keep 16 only as the upper cap for large queues; the future selector should
use at most four for projects around this size. The selector is not implemented
yet. The raw evidence and measurement contract are in
`docs/v2/benchmarks/NATIVE-CORPUS-SCALING.md` and
`native-corpus-scaling-aarch64-2026-07-23.json`.

The next code slice is module/import resolution and bounded symbol-body search
documents, plus focused measurement of the dominant PostgreSQL/ParadeDB
COPY/index-maintenance floor. The RSS sampler measures the process; it does not
turn the 32x Tree-sitter accounting reservation into an allocator-enforced cap.

Exact closeout for this slice on 2026-07-23:

- Rust formatting, strict workspace Clippy, all workspace unit/integration/doc
  tests, and the SQLite-free dependency/lockfile checks pass.
- PostgreSQL 18.4 / `pg_search` 0.23.5 / pgvector 0.8.1 doctor and live
  capability, generation, COPY/digest, lease, all 26 supervisor cases, both
  worker matrices, and both managed lifecycle tests pass. The final 26-case run
  generated the committed native-corpus JSON and included the forced timeout
  cleanup regression.
- TypeScript typecheck, architecture, Biome, actionlint, and the v1.1.33 oracle
  pass. The complete v1 harness reports 7,140 passes, zero failures, and 41
  skips; Bun's known shard-7 `Trace/BPT trap` occurred twice before the exact
  shard passed on its third fail-closed retry.
- The forced Cartograph biomarker rebuild reports 0 error / 0 warning / 0 info,
  zero cross-file errors, and the structural delta reports zero introduced
  findings. Sonar reports quality gate `OK`, 91.5% new coverage, 86.0% overall
  coverage, 0.0% new duplication, 0.9% overall duplication, zero bugs/new
  violations/vulnerabilities, and 100% reviewed security hotspots.
- Independent read-only review requested changes for timing semantics, RSS
  failure handling, scheduler wording, child timeout/reaping, provenance, and
  timeout schema cleanup. Every finding was fixed and regression-tested; the
  final verdict is `APPROVE` with no findings.

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

The first TypeScript/JavaScript/TSX/JSX parser and normalized-fact slice is now
implemented and matches its locked v1.1.33 projection. Its bounded discovery,
read/hash, exact-resolution, canonical-fact, COPY, publication, and BM25 path is
also implemented. M3 remains open until the Rust-owned real corpus, richer
module/import resolution, remaining language families, and framework/
cross-language hooks meet their exit gates.

### M4 — bounded parallel indexer

The one-shot lease-owned supervisor, cancellation/reaping model, hard worker
task/byte admission, progress/status contract, retained COPY task, and exact
terminal cleanup are implemented at `bcafdc6`. The reusable typed bounded
stage executor is implemented at `8e06435`. The frozen synthetic benchmark now
passes at 1/2/4/8/16 workers with one identical logical digest, row-count set,
and ParadeDB BM25 result. TypeScript/JavaScript discovery, read/hash,
parse/extract, exact resolve, reduce, COPY, publication, and BM25 are now wired
through that executor at one and four workers. Next replace the synthetic timing
baseline with a Rust-owned real extractor corpus and extend the frozen matrix to
the complete pipeline while preserving the same determinism gate.

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

Implement a v1.1.33 PostgreSQL importer first. There will be no SQLite importer,
runtime, optional feature, or test utility in v2. Users preserving a v1 SQLite
index must migrate it to PostgreSQL with v1.1.33 before cutover; otherwise v2
rebuilds PostgreSQL state from the source checkout.

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

1. Add module/import alias resolution, lexical shadowing and overload rules,
   tracked-ignored-file plus embedded-repository parity, and bounded
   implementation-body search documents.
2. Measure and optimize the 3,868-document COPY/ParadeDB indexing floor while
   preserving atomic publication and current-generation-only BM25 semantics.
3. Implement and test a deterministic corpus-aware worker selector, using at
   most four workers for small queues while retaining 16 as the measured upper
   cap for sufficiently large queues; re-run both committed matrices.
4. Add stage-level cancellation/deadline/failure/cap injection for
   discovery, read/hash, parse/extract, resolution, reduction, and COPY.
5. Add `db remove`, backup/restore, and explicit image/extension upgrade with
   ownership checks and recovery tests.
6. Add Windows ACL hardening or keep managed lifecycle explicitly unsupported
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
