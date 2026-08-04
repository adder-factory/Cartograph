# Troubleshooting Cartograph v2

Start with the exact native executable and project:

```sh
command -v cartograph
cartograph --version
cartograph doctor /absolute/path/to/project
cartograph status /absolute/path/to/project
```

Do not infer runtime health from installed files alone. A real doctor/status or
MCP call is the control evidence.

## PostgreSQL capability failure

Cartograph requires PostgreSQL 18.4 or newer within major version 18,
`pg_search` 0.25.0 with the expected preload state/ParadeDB access method/BM25
tokenizer behavior, and pgvector 0.8.4 or newer. Pgvector 0.8.6 is recommended
for external PostgreSQL; the managed ParadeDB 0.25.0 image bundles 0.8.4.
Upgrade or correct the external service, or use the pinned managed database on
macOS/Linux. There is no SQLite or plain-FTS
fallback.

## Managed database cannot start

- Start a local Docker daemon; remote Docker contexts are rejected.
- Inspect `cartograph db status` and bounded `db logs` output.
- If the default loopback port is occupied, select another consistently with
  command help/environment configuration.
- Do not delete a same-name container/volume unless Cartograph proves its exact
  project ownership. Foreign resources are intentionally refused.
- Do not remove a live lifecycle lock. Verify its recorded owner first.

## Doctor works in a shell but MCP cannot connect

The agent host may have an older absolute command, environment, managed port,
or process. Re-run the project-local installer from the working shell:

```sh
cartograph install --yes --target <codex|claude|cursor> --location local \
  --project-path /absolute/path/to/project \
  --managed-database-port <PORT>
```

Omit `--managed-database-port` when the project uses the default `55432`.
Restart the host. An open session is not assumed to hot-register a replaced MCP
server. CLI success proves the native/database control path, not the old MCP
transport.

Versioned installation registers
`~/.cartograph-cli/current/bin/cartograph`. Run the resumable upgrade sequence
instead of manually stitching the binary, database, index, and registration
steps together:

```sh
cartograph upgrade --apply --project-path /absolute/path/to/project --json
```

Success requires `completed: true`; `applied: false` can simply mean the newest
binary was already installed and the remaining project steps were reconciled.
If `restartRequired` is true, close and reopen the host once. If the report is
blocked, inspect `projectReconciliation`, `registrationRepair`, and the bounded
`nextSteps`; after fixing the named boundary, rerun the same command to resume.
An idempotent rerun reports `restartRequired: false` when it changed neither the
binary nor a host pin; that run-local result does not claim that a process left
open across an earlier upgrade has been inspected. A database step with
`state: timed_out` means the 15-minute cold image-pull/readiness budget expired,
not that incompatibility was detected; rerun the same command without invoking
the destructive database replacement path.

If startup says the database schema is newer than the binary, do not retry the
old process. The error reports the running binary version, database schema
version, and maximum supported schema version. Upgrade the native binary,
repair the registration, restart the host, and verify the newly loaded MCP
version. Startup exits nonzero; it never serves against a schema it cannot
interpret.

If MCP startup reports managed-image or HNSW shared-memory incompatibility,
`upgrade --apply` stops before replacement and prints the named fresh-backup and
exact confirmed `db upgrade` commands. Run them, then rerun `upgrade --apply`
before restarting the host. This preflight is
intentionally stricter than read-only `status` or an ordinary relational index:
an MCP process exposes semantic maintenance paths that may need HNSW, so it
refuses an older 64 MiB managed container even when non-vector reads still
work. `doctor` is the readiness authority for that boundary.

## Index is stale

`status.fresh` is true only when the complete supported-source manifest matches
the current immutable generation. Run a bounded `cartograph index` (or explicit
MCP admin job), then re-check status. Context packets may include a separate
changed-source overlay while stale; they still lower confidence and retain the
stale abstention.

## Source excerpt is omitted

`cartograph node/show` returns source only when the complete live manifest still
matches the generation owning the symbol's line range. On stale or racing
source, metadata remains but the excerpt is omitted rather than slicing the
wrong bytes. Re-index and retry.

## Native generation reaches its capacity bound

Inspect the exact stage/reason and the returned native metrics. A
`generation_capacity_exceeded` result is a real admission boundary, not a
database-health diagnosis. With the default `generationStorage: "auto"`, large
source manifests select PostgreSQL spill automatically. For a dense smaller
manifest, force it in `.cartograph/config.json`:

```json
{
  "generationStorage": "postgres",
  "maxSpillBytes": 137438953472,
  "maxSpillRows": 1000000000
}
```

Before raising quotas, verify PostgreSQL data/WAL/temporary-disk headroom;
logical spill bytes are not physical storage estimates. A spill-specific byte
or row limit leaves the current generation visible and the failed staging work
eligible for bounded cleanup. Lease loss, cancellation, and a byte-different
retry also fail closed. Exact retained retries reuse immutable batches and the
durable canonical partition cursor.

PostgreSQL spill does not make every native structure unlimited. Resolution
lookups, clone profiles, and the centrality graph retain a separate compact
bound based on `maxGenerationBytes`. If that bound is named, raise it only with
observed host headroom or reduce the admitted source/features. A configured SCIP
overlay currently selects the memory path in `auto`; forcing `postgres` with
that overlay is rejected until streamed replacement parity is available.

## Native stage reports `progress_stalled`

The supervisor cancels an operation when its active stage produces no durable
work inside the configured progress watchdog. Direct CLI, MCP admin, and
auto-sync output retain a qualified privacy-safe reason such as
`parse_progress_stalled`, `resolve_progress_stalled`, or
`relational_merge_progress_stalled`; source paths, SQL, database URLs, and
driver text are not included. This differs from `*_deadline_exceeded`: a
deadline is an item or whole-stage execution horizon, while a progress stall
means the watchdog observed no completed work checkpoint.

Inspect the named stage, bounded database logs, host memory/CPU, and PostgreSQL
I/O or lock pressure. Retry only after identifying transient resource pressure
or a fixed defect. The prior generation remains visible, and a failed staging
generation is handled by normal bounded cleanup.

## Semantic search is skipped

Hybrid mode requires a reachable OpenAI-compatible embedding endpoint and a
model registration whose fingerprint, dimension, current-generation coverage,
HNSW index, and query probe all pass. The packet reports `not_configured`,
`not_indexed`, `stale`, or `unavailable` and falls back explicitly to lexical
evidence. It never labels BM25-only results as hybrid.

## ParadeDB derived index is unhealthy after a crash

Treat relational graph and search-document rows as source of truth. Inspect:

```sh
cartograph db derived-index --project-path .
```

Use the exact confirmed rebuild form from help. Community BM25 is rebuildable
local derived state; do not claim it is WAL-crash-durable or use a rebuild to
hide relational data loss.

## V1 import fails

- The source must be a v1.1.33 PostgreSQL schema in the same database as a
  distinct v2 destination schema.
- The destination may already have a current generation, but project
  index/sync/hook/rebuild writers should be quiesced during the import.
- Run `--dry-run` first against the exact checkout represented by v1.
- Unsupported languages, mismatched bytes/hashes, invalid required symbol
  coordinates, orphan relations, oversized JSON, malformed required data, incomplete schema
  history, or an inconsistent checkpoint fail closed. Malformed optional JSON
  evidence is treated as unavailable rather than imported.
- Repeat the identical confirmed command only when the error says the durable
  run is resumable.
- `ConcurrentPublication` means another writer won publication. Quiesce those
  writers and repeat the identical confirmed command; Cartograph has already
  failed/released the stale generation and will reserve a newer one.
- If v1 exists only in SQLite, rebuild from source or use v1.1.33 to migrate it
  to PostgreSQL first. V2 never opens the SQLite file.

See [PostgreSQL operations](STORAGE-BACKENDS.md) for the exact sequence.

## Generation prune fails or rolls back

Prune requires the exact `prune-old-generations` confirmation and a live
project-wide migration lease. Publication/retention locks and a final
PostgreSQL-clock fence check intentionally roll the transaction back if
ownership expires or changes. Retry only after inspecting current operations;
never bypass the fence.

## Git review is unavailable

Review requires a Git worktree and a valid non-option revision. Git execution is
shell-free, output-bounded, deadline-bounded, and noninteractive. Confirm the
ref exists locally and the project root is a repository. A missing/invalid ref,
unavailable Git, output limit, and timeout are distinct redacted failures.

## Release archive or install checksum fails

Do not bypass a mismatch. Download `SHA256SUMS` and the archive from the same
immutable release, verify the tag/version/asset name, and retry the download.
Release archives should contain only the native binary and allowlisted notices/
documentation—never PostgreSQL, ParadeDB, pgvector, SQLite, or credentials.
