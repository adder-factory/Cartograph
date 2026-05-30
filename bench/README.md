# bench/

Cartograph perf benches. Each script runs against either a synthetic
seed (default) or an existing `.cartograph/`-bearing project via env
override. All scripts run with `bun bench/<name>.mts` from the repo
root; no transpile step needed.

## bench/sync-parallel-hooks.mts

Three sections measured on the same corpus:

1. **cold indexAll** — total wall-clock for a fresh full pass (parse
   + extract + cross-file resolve + Group A→B→C hook phase).
2. **warm sync x3** — three back-to-back no-op syncs after the cold
   index. Spots hook-side overhead when nothing changed.
3. **biomarker re-analysis (G9 Phase 2C target)** — direct
   `analyseProject` invocation, repeated five times in each of the
   **serial** and **worker-pool** modes. Bypasses the indexAll fork
   + IPC layer so the timing isolates the cross-file rule cost that
   Phase 2C parallelises. Reports speedup (or slowdown) + a
   findings-invariance check across modes.

### Env overrides

| Var | Default | Effect |
|---|---|---|
| `BENCH_FILE_COUNT` | `200` | Synthetic-seed file count. 200 = small-project stress (workers lose to spawn cost); 1500–2000 = mid-size; the cartograph repo's real complexity (~14k nodes) sits in a different regime. |
| `BENCH_PROJECT_DIR` | _(unset)_ | Path to an existing project with `.cartograph/`. Skips the synthetic seed and runs Section 3 only against the live DB. Read-only — bun:sqlite WAL lets it coexist with the live MCP. |
| `CARTOGRAPH_BIOMARKER_SERIAL` | _(unset)_ | When `1`, forces `runCrossFileBiomarkers` down the pre-Phase-2C serial path on the host connection. The bench toggles this internally to A/B-time each mode; production callers should never set it. |

### Reading the output

```
biomarker re-analysis (analyseProject):
  serial path     : 462ms (5) / 410 / 411 / 405 / 405  → 5 findings every pass
  worker pool path: 91ms (5) / 132 / 86 / 84 / 82      → 5 findings every pass
  findings invariance: ✓ (5 every pass, serial + parallel)
speedup: 4.77× — serial median 410ms, parallel median 86ms
```

- The `(N)` after each timing is the rule's `findingsEmitted` count
  for that pass. Stable counts mean the rule is deterministic on
  this corpus; a `findings A…B` summary with `A != B` flags a real
  determinism bug worth investigating.
- The speedup figure compares medians, not means — the cold pass
  spike (worker module load, grammar preload by the host's
  `preloadBiomarkerGrammars`) shows up as the `max` outlier in
  serial mode.

### Caveat: `BENCH_PROJECT_DIR` invariance

When the target project has a live MCP server attached, its own
post-hook child writes findings concurrently, racing the bench's
`clearFindingsByKind` + `appendFindings` transactions. The
invariance summary will surface "findings DIVERGED" in that case —
that's a bench artifact, not a Phase 2C bug. Use the synthetic
seed for correctness signal; use `BENCH_PROJECT_DIR` for the
speedup number.

## bench/sync-format-only-fast-path.mts

G7 bench — measures the format-only fast path (stable node ids +
struct_hash short-circuit). Mutates inter-symbol whitespace across
220 trivial TS files and re-syncs; gate is `<30s` wall-clock for the
220-file resync. See the file's header for the in-detail design
notes.

## bench/wal-autocheckpoint.mts

G21 bench — sweeps `PRAGMA wal_autocheckpoint` against a write-heavy
synthetic to pick the value that minimises full-index wall.

### Env overrides

| Var | Default | Effect |
|---|---|---|
| `BENCH_FILE_COUNT` | `2000` | Synthetic-seed file count (each importing 3 neighbours, so cross-file resolve + the edge-emitter hooks have realistic work). Push to 5000+ to make the checkpoint cadence matter more. |
| `BENCH_N_RUNS` | `3` | Iterations per value. Bench reports median + min + max so a single noisy run doesn't move the pick. |
| `BENCH_AUTOCHECKPOINT_VALUES` | `1000,5000,10000,20000,40000,0` | Comma-separated candidate values for `wal_autocheckpoint` (pages). Defaults reproduce the table cited in `src/db/index.ts` (the production-pick rationale). `0` disables auto-checkpointing entirely (WAL grows unbounded until a manual checkpoint — useful sanity check, not a viable production setting). Add `200,500,2500` back if you want to confirm the "smaller = slower" tail. |

### Production value lives in `src/db/index.ts`

`dbApplyPragmas` hard-codes the winner (20000 as of 2026-05-24c —
see the comment block citing this bench). The
`CARTOGRAPH_WAL_AUTOCHECKPOINT` env var is the override hook the
bench uses to sweep candidate values; production callers should not
set it.
