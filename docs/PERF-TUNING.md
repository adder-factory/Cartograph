# Performance tuning

Cartograph v2 chooses bounded parallelism from supported-file count, exact
indexed source bytes, hardware, and the caller cap. Supported index worker
counts are 1, 2, 4, 8, and 16. A deterministic reducer must produce identical
logical facts, digests, and ordered retrieval evidence at every count; faster
output is never allowed to change meaning.

## Operator controls

```sh
cartograph index . --workers 8

export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
export CARTOGRAPH_DATABASE_QUERY_TIMEOUT_MS=120000
```

- The adaptive selector promotes at 8/16/32/128 supported files or
  128 KiB/512 KiB/1 MiB/4 MiB indexed source bytes, using whichever dimension
  requests more parallelism, then applying caller and hardware caps. The
  measured 34-file/1.05 MiB native corpus selects eight workers; the
  256-file/5.86 MiB synthetic corpus selects 16.
- More parse workers help only when corpus size and CPU justify them. Database
  COPY, derived-index build, and publication remain bounded phases.
- Keep the database pool large enough for the selected operation but below the
  64-connection hard cap. Local agent use normally needs no manual change.
- Do not increase timeouts to hide a lost lease, stale fence, blocked database,
  or oversized corpus. Inspect task/lease status and the failing phase first.
- Semantic HNSW indexes are per model; unused model generations should be
  audited and cleaned with explicit semantic-maintenance commands.
- ParadeDB BM25 is generation-local derived state. Inspect/rebuild it through
  `cartograph db derived-index`, not ad-hoc DDL.

Native MCP auto-sync uses a recursive OS watcher where available, debounces
bursts, and periodically reconciles missed events. If native watching cannot be
established it uses the bounded polling watcher. Status exposes watcher events,
reconciliations, attempts, publications, and errors without project paths.
Watcher admission uses the same default/project include, exclude, and language
policy as indexing, reloads after `config.json` changes, and ignores access-only,
build-output, dependency-cache, and private `.cartograph` churn. Configuration
and SCIP-overlay events remain explicit reconciliation triggers.

An unchanged source revision that fails automatic indexing is not retried in a
tight loop. Auto-sync records its stable stage code and uses exponential retry
delays from 30 seconds through a 15-minute cap. After five failed automatic
attempts, that revision is suppressed until the supported source revision
changes. Explicit/manual index requests remain available. Structured status
exposes `lastErrorCode`, `lastFailureAt`, `nextRetryAt`,
`failedRevisionAttempts`, and `retrySuppressed`; a new source revision clears
the failed-revision state before the next bounded attempt.

Managed local LLM logs rotate at 32 MiB and retain one `.1` file. Inspect stale
rotated logs and invalid PID state without mutation, then apply only a bounded
age-qualified batch with the exact confirmation:

```sh
cartograph backend cleanup . --json
cartograph backend cleanup . --apply --confirm cleanup-backend-junk --json
```

Cleanup never removes current logs, valid process state, or any active backend.

## Measurement gates

Committed reports under `docs/v2/benchmarks/` cover synthetic COPY/index
scaling, native corpus 1/2/4/8/16-worker identity, and patch-task retrieval.
The benchmark executables live under `crates/cartograph-indexer/benches/` and
Rust integration tests. Measure a representative corpus before changing
defaults, and retain raw bounds/digests with the report.

The live release workflow also verifies cancellation, timeout, panic, caller
drop, database fault, lease takeover, rollback, and zero staged residue. A
throughput improvement is not releasable if any cleanup or deterministic-output
gate regresses.
