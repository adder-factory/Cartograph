# Native CLI reference

Last release audit: 2026-08-10 (`v2.1.14`).

The installed executable is `cartograph`. Run `cartograph <command> --help` for
the exact bounds and confirmation phrases in the installed version. This page
lists the complete top-level command inventory and selected high-use forms;
subcommand help remains the authority for every option and default.

## High-use coding forms

```text
cartograph index [PROJECT] [--exclude GLOB]...
cartograph sync-if-dirty [PROJECT] [--quiet] [--max-file-size SIZE]
cartograph status [PROJECT]
cartograph find <QUERY> --by auto|name|content|env|sql|build|path|reference|bm25|hybrid
cartograph context <TASK> [--exact-name NAME] [--exact-path PATH] [--exact-reference TEXT]
cartograph entry-points [--bucket routes|cli|cli-commands|mcp-tools|cli-files|public-exports]
  [--limit 20]
cartograph graph <SYMBOL_ID> --direction callers|callees|both|impact
cartograph graph <SYMBOL_ID> --direction path --to <TARGET_SYMBOL_ID>
  [--edge-kind calls|imports|references|implements|extends|tests|type-of|returns|instantiates|overrides|decorates|field-access|def-use|exports|contains]
cartograph graph <SYMBOL_ID> --direction similar
  [--k 5] [--min-score 0.3] [--same-language] [--model-id <UUID>]
cartograph affected [CHANGED_FILE ...] [--stdin | --files CHANGED_FILE ...]
  [--max-depth 5] [--max-nodes 40] [--limit 40]
cartograph affected --symbol-id <SYMBOL_ID> [--max-depth 5] [--max-nodes 40]
  [--limit 40]
cartograph show <SYMBOL_ID>
cartograph review --ref <GIT_REF>
cartograph doctor [PROJECT]
cartograph admin scip-export [--out index.scip] [--maximum-rows 5000000]
cartograph admin scip-import [--in index.scip] [--maximum-rows 10000000]
  [--maximum-source-bytes 268435456] [--workers 16]
```

Retrieval inputs and result counts are bounded. `context` selects a deterministic
typed task intent and can use exact anchors, ParadeDB BM25, a ready matching
semantic model, graph expansion, affected tests, and a separate stale
working-tree overlay. JSON is the stable automation format; text favors concise
operator output.

`sync-if-dirty` skips a clean, current checkout. If another native watcher or
manual index owns the project's index lease, it observes that lease for a
bounded five minutes instead of stealing it or immediately returning
`lease_failed`. After the competing writer releases, the command succeeds when
that writer published the now-current source revision; otherwise it retries its
own complete index.

`scip-export` requires a fresh generation and writes atomically inside the
project. It emits standard SCIP plus a forward-compatible Cartograph extension
for every exact edge kind and represented site count. `scip-import` validates a
bounded project-local artifact, installs it at
`.cartograph/scip/overlay.scip`, and forces a new generation. Covered files use
SCIP facts; uncovered files retain native extraction. A failed publication
restores the prior overlay when the importer still owns the installed bytes.
The overlay digest participates in freshness, so changing it cannot leave an
apparently current generation.

`entry-points` reads typed structural facts rather than asking BM25 to infer an
API boundary. It returns stable pages for routes, CLI commands, exported MCP
tool definitions, conventional CLI source, and exported declarations with no
in-tree calls/references/type-use. Every page includes its exact pre-limit total
and truncation flag. V2 includes exported constants, types, enums, traits,
modules, components, and resources in the public surface in addition to v1's
function/class categories.

`doctor --json` separates hard capability health from completed onboarding.
The legacy `ready` boolean and new `capabilitiesReady` boolean preserve the
existing exit-code contract. `projectReadiness` independently reports
`database`, `index`, `freshness`, `deterministicRetrieval`,
`semanticRetrieval`, `registration`, `liveTransport`, and `overall` states.
A missing generation is `not_indexed`; a published generation can be `stale`
without being confused with absence; optional semantic configuration does not
gate deterministic retrieval. `--no-project-checks` returns `not_checked` for
the skipped layers. `nextActions` uses placeholders rather than absolute paths
or database settings.

## Complete top-level command inventory

This inventory contains every non-hidden v2.1.14 top-level command advertised
by `cartograph --help`. Hidden compatibility adapters and Clap's generated
`help` command are intentionally excluded.

<!-- CARTOGRAPH_TOP_LEVEL_COMMANDS_START -->

- Project and runtime: `index`, `status`, `embed`, `embedding-status`, `show`,
  `export`, `similar`, `sync-if-dirty`, `install-hooks`, `mcp-budget`,
  `completions`, `guide`, `doctor`.
- Code intelligence and agent state: `ask`, `blame`, `changed-since`, `context`,
  `compare-to-ref`, `digest`, `explore`, `find`, `node`, `files`,
  `entry-points`, `at-range`, `graph`, `affected`, `tests-for`, `biomarkers`,
  `numerical`, `coverage`, `dead-code`, `deps`, `hotspots`, `host`, `history`,
  `imports`, `note`, `propose-rename`, `role`, `session`, `summaries`, `sql`,
  `trace-to-culprits`, `verify`, `review`, `playbook`, `admin`.
- Configuration and lifecycle: `backend`, `llm`, `upgrade`, `install`,
  `uninstall`, `serve`, `db`.

<!-- CARTOGRAPH_TOP_LEVEL_COMMANDS_END -->

## MCP and agent configuration

```text
cartograph serve --mcp [--managed-database-port PORT] [--profile coding|core|full|read-only|review]
cartograph install --yes --target <TARGET[,TARGET...]> --location local [--managed-database-port PORT]
cartograph uninstall --yes --target <TARGET[,TARGET...]> --location local
```

The 19 concrete host target IDs are:

<!-- CARTOGRAPH_INSTALL_TARGETS_START -->

`claude`, `cursor`, `codex`, `codebuddy`, `copilot`, `codewhale`, `zed`,
`opencode`, `hermes`, `gemini`, `antigravity`, `kiro`, `factory`, `rovo`,
`qoder`, `bob`, `kimi`, `pi`, and `reasonix`.

<!-- CARTOGRAPH_INSTALL_TARGETS_END -->

`--target` also accepts the selectors `auto`, `all`, and `none`. All concrete
targets support global configuration. Project-local configuration is supported
for every target except `hermes`, `antigravity`, and `reasonix`. A project-local
selection skips those targets without writing elsewhere; text output prints a
warning, while JSON omits a report for each skipped target.

Install/uninstall preserves unrelated entries and pins the absolute native
executable. A versioned native installation is registered through the stable
`~/.cartograph-cli/current/bin/cartograph` launcher, whose target changes
atomically on upgrade. With `--location local`, installation modifies only
project-local agent configuration. For a non-default managed port, it also pins
the non-secret loopback port in the portable server arguments. Restart the host
after a configuration or binary change.

The stdio server is dual-era: MCP `2026-07-28` clients use stateless
`server/discover` and per-request metadata, while existing clients can continue
using the `2024-11-05` initialize handshake. Profiles and exact disabled tools
form a process-lifetime authorization ceiling. Modern `tools/list` is stable,
deterministically ordered, and private-cacheable for one hour; task-local schema
selection belongs in the host rather than a connection-mutating dispatcher.

`cartograph upgrade --project-path <PATH>` is a read-only release and
registration audit. The canonical version-to-version operation is:

```sh
cartograph upgrade --apply --project-path <PATH>
```

That command is safe to repeat. It checksum-verifies and smoke-tests the latest
native release, atomically switches the stable launcher, starts or reuses the
project-owned managed database when applicable, applies safe append-only schema
migrations, reconciles a complete current generation, runs `doctor`, and uses
the installed executable to require an exact installed-version/fresh-generation
status. It then repairs stale owned Codex, Claude, and Cursor registrations in
local and global locations through the normal installer, preserving unrelated
configuration and managed-port arguments. Running `--apply` when the binary is
already current resumes or heals the project and registration steps instead of
returning early.

The command never replaces an incompatible managed container implicitly. It
keeps the verified binary installed, reports `completed: false`, and emits the
exact private-backup and `--confirm upgrade-managed-database` commands. After
that approval-gated replacement, rerun the same `upgrade --apply` command to
resume. JSON distinguishes `currentVersion` (the process that began the
operation), `latestVersion` (the published release), `installedVersion`,
`applied`, `completed`, and `restartRequired`; `projectReconciliation` reports
database, index, doctor, verification, freshness, generation, port, and any
required confirmation independently. Registration failures likewise leave the
already-verified binary installed and report only the remaining repair.

`restartRequired` is deliberately run-local: it is true only when a completed
invocation changed the installed binary or repaired a configured host pin. A
pure idempotent project reconciliation does not request another reopen, while
false still does not prove the version of a process that remained attached
across an earlier invocation. Managed `db start` has a separate 15-minute cold
image-pull/readiness budget. Exceeding it reports the database step as
`timed_out`, draws no compatibility conclusion, and asks the caller to rerun
the same command; only a bounded status probe with positive image/shared-memory
incompatibility evidence can emit the destructive confirmation path.

An already-open host cannot hot-load the new child. When `restartRequired` is
true, close and reopen it once, then prove `server/discover` (or legacy
`initialize`), `tools/list`, `cartograph_status`, and one real query on the new
transport.

## Database lifecycle

```text
cartograph db start
cartograph db stop
cartograph db status
cartograph db logs
cartograph db backup <OUTPUT>
cartograph db restore <ARCHIVE>
cartograph db upgrade
cartograph db derived-index
cartograph db remove
cartograph db import-v1
cartograph db prune
cartograph db usage
cartograph db compact
```

Managed lifecycle is supported on macOS/Linux with local Docker. Windows uses
external PostgreSQL. Restore, upgrade, derived-index rebuild, remove, v1 import,
and prune require explicit operation-specific confirmation. `db usage` is
read-only: it verifies the exact current append-only migration ledger and fails
with migration guidance instead of creating or upgrading a schema. `db compact`
is a dry run unless `--apply --confirm compact-online-indexes` is supplied;
managed mode always verifies filesystem headroom and rejects an operator
override, while external PostgreSQL requires `--available-headroom-bytes`. See
[PostgreSQL operations](STORAGE-BACKENDS.md).

Without an explicit `--port` or `CARTOGRAPH_MANAGED_DATABASE_PORT`, managed
commands inspect the deterministic project-owned container and reuse its actual
loopback port before falling back to `55432`. New/replaced containers reserve
256 MiB of Docker shared memory, use a 2 GiB hard memory limit with a 1 GiB
reservation, are limited to four CPUs and 256 processes, and use bounded
PostgreSQL memory/parallel-worker settings. A 15-minute checkpoint interval,
4 GiB soft maximum WAL size, and 512 MiB recycled-WAL floor absorb bursty
immutable-generation publication without repeated 1 GiB WAL checkpoints;
durability remains fully synchronous. `doctor`, MCP preflight, and
structured `db status` report both HNSW shared-memory and resource-policy
compatibility. Older containers require backup plus the confirmed managed
upgrade; status inspection never recreates them.
`status` includes compact allocated database/schema/heap/index/TOAST totals in
readable IEC units such as MiB and GiB. Structured JSON retains exact `*Bytes`
integers and adds `databaseStorage.humanReadable` display strings; `db usage`
retains the relation, cache, generation, and maintenance detail.
Full-generation biomarker statistics are computed once per exact input
fingerprint and then served from generation-fenced storage, so `status` only
ever reads the stored relation and never evaluates the detector cascade behind
its five-second deadline. The fingerprint covers the current generation, the
superseded generation the growth detector compares against, imported coverage,
materialised similarity, the calendar day bounding the growth window, and the
detector contract compiled into the binary; any change recomputes the relation.
Before the first computation `featureReadiness.biomarkers` reports
`state: pending` and `reason: not_computed` — never an empty finding set — and
`cartograph biomarkers` is the explicit path that computes it under the separate
insight deadline. `state: unavailable` with `reason: timeout` or
`reason: database_error` remains reserved for a storage read that genuinely
failed.

## LLM credentials and local backend state

```text
cartograph llm migrate-credentials [PROJECT] [--tier-env TIER=ENV]
  [--apply --confirm migrate-inline-credentials]
cartograph llm setup custom [--api-key-env ENV | --clear-credentials]
cartograph backend cleanup [PROJECT] [--minimum-age-hours 24]
  [--apply --confirm cleanup-backend-junk]
```

Both commands are dry-run-first, bounded, and emit secret-free JSON. Credential
migration requires an exact environment-value match, serializes Cartograph
writers with a private lock, and aborts if the config bytes changed after the
proof was made. Custom setup clears retained credentials automatically when the
provider/endpoint origin changes; `--clear-credentials` is the explicit
same-origin removal path and conflicts with `--api-key-env`. Backend cleanup
considers only generated-name rotated logs and
invalid current-version PID state; it preserves current logs, valid or active
processes, and state written by an unsupported newer/older format. Cleanup JSON
exposes only validated project-relative entry names and stable path-free reason
codes; unsafe/control-character names are never echoed.

## Database selection

External database settings are environment-only:

```sh
export CARTOGRAPH_DATABASE_URL='postgresql://cartograph:secret@127.0.0.1:5432/cartograph'
export CARTOGRAPH_DATABASE_SCHEMA='cartograph_project'
export CARTOGRAPH_DATABASE_MAX_CONNECTIONS=8
export CARTOGRAPH_DATABASE_ACQUIRE_TIMEOUT_MS=5000
```

The URL is secret and must not be committed or echoed. Without an external URL,
the project-local managed credential is resolved for a database started by
`cartograph db start`.

## Exit and error behavior

Invalid inputs, missing capabilities, stale/lost lease fences, unavailable
database/source/Git state, and operation failures return nonzero. Public errors
omit database URLs, query text, source literals, and absolute project paths.
Machine consumers should inspect JSON fields and stable MCP error codes rather
than parse human prose.
