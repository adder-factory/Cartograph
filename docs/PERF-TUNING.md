# Performance tuning knobs

> Extracted from CLAUDE.md (2026-05-29) to keep the always-loaded project memory lean — reference-when-tuning material. CLAUDE.md keeps a one-paragraph pointer to this file.

Cartograph's perf-sensitive paths expose env-var overrides so users can
re-tune for different hardware without recompiling. The shipped defaults
are measured on M-series; most are graph-shape-dependent (universal) but
ONE — the PageRank parallel-path edge threshold — is genuinely
device-tuned.

### Universal vs device-tuned

| Knob | Default | Universal or device-tuned? |
|---|---|---|
| value-ref-edges per-file pre-fetch (B37) | always on | **Universal** — 30× DB-call reduction. Same speedup ratio on any CPU. |
| PageRank LPT bin-pack partition (B38) | always on | **Universal** — fixes a 7× load imbalance caused by power-law in-degrees; the imbalance is a property of code graphs, not hardware. |
| PageRank dangling-index precompute (B39) | always on | **Universal** — pure algorithmic improvement; per-iter O(N) → O(dangling). |
| `CARTOGRAPH_PAGERANK_PARALLEL_EDGE_THRESHOLD` (B40) | `500_000` | **Device-tuned.** Below this edge count, the worker-pool's setup overhead exceeds the saved compute. Measured on M4 Max; the crossover is hardware-dependent (different per-CPU spawn cost + memory bandwidth + IO speed). On faster CPUs, real crossover may be higher (~1M+); on slower CPUs, lower (~200K). The 500K default biases toward serial — safer than running parallel and losing. Re-tune via `bench/probe-pagerank-balance.mts`. |
| `CARTOGRAPH_PAGERANK_SERIAL=1` | unset | Forces serial PageRank regardless of edge count. Bench A/B-test or escape hatch. |
| `CARTOGRAPH_PAGERANK_ITERATION_TIMEOUT_MS` | `60_000` | Per-iteration wall-clock budget; bounds a stuck worker. |
| `CARTOGRAPH_VALUE_REF_WORKERS=N` | derived from `os.cpus()-1`, capped 8 (`POOL_CEILING`) | Worker count for value-ref-edges. 8-cap is incidentally near-optimal on M-series — wall is flat from 8 up because the pool is IO-bound (measured 2026-05-25). Setting `=0` forces serial. |
| `CARTOGRAPH_VALUE_REF_VERBOSE=1` | unset | Per-file enter/exit logging in the value-ref-edges worker. Used to chase the historical 120s timeout pattern; needed once, kept for diagnostics. |
| `CARTOGRAPH_BIOMARKER_PERFILE_WORKERS=N` | derived from `os.cpus()-1`, capped 8 | Worker count for per-file biomarker compute. `=0` forces serial. |
| `CARTOGRAPH_BIOMARKER_SERIAL=1` | unset | Forces serial cross-file biomarker rule dispatch. |
| `CARTOGRAPH_LARGE_FUNCTION_THRESHOLD=N` (F#12) | `500` (LOC) | Per-file mode threshold for eager nested-function extraction (JS-family only). When the largest function body in a file is ≤ this LOC, nested function declarations + `const foo = () => {}` arrow-bound shapes are extracted as first-class `function` nodes. When at least one body crosses the threshold (e.g. `checker.ts`), nested extraction skips — slice 2's manifest path will own those files. Source of truth is `config.largeFunctionThreshold` (default 500); the orchestrator exports this env var from the config before the parse worker pool spawns. Override via env: `Infinity` forces eager everywhere (Option A — max fidelity); `0` disables eager entirely. **Universal** — fires per-file based on actual content, not hardware. |

### Why most are universal

Three of the four big perf wins this codebase ships (B37 / B38 / B39)
are **algorithmic improvements over graph-shape invariants**. Code
graphs have power-law in-degree distributions; files have a bounded
unique-identifier count; CSR layouts let you precompute dangling
indices once. None of those depend on CPU speed, core count, or disk
IO. Same speedup ratio anywhere.

The fourth (B40 threshold) is the exception because it answers a
**relative** question: "at what graph size does parallel compute
outweigh worker spawn overhead?" That depends on:
- per-worker bun:sqlite open cost (~50-200ms on M-series)
- inter-worker memory bandwidth contention
- per-CPU JIT warm-up cost
- IO subsystem speed (file reads in parallel)

The default is calibrated for M-series. The env override + bench
scripts (`bench/probe-pagerank-balance.mts`,
`bench/probe-pagerank-iter-cost.mts`) let other environments re-tune
without code change.

### Bench scripts for re-tuning

```bash
# PageRank load-balance + serial-vs-parallel wall on a real project
BENCH_PROJECT_DIR=/path bun bench/probe-pagerank-balance.mts

# PageRank per-phase cost attribution (CSR / LPT / spawn / danglingSum / workers)
BENCH_PROJECT_DIR=/path bun bench/probe-pagerank-iter-cost.mts

# Cross-file biomarker rule per-rule timings
BENCH_PROJECT_DIR=/path bun bench/probe-cross-file-rule-timings.mts

# Biomarker compute+persist phase (cold/warm cache diff)
BENCH_PROJECT_DIR=/path bun bench/probe-biomarker-persist.mts

# Per-hook indexAll timings ranked desc (identify the next long pole)
BENCH_PROJECT_DIR=/path bun bench/probe-hook-timings.mts

# Per-hook STANDALONE wall (no Promise.all wait on sibling hooks)
BENCH_PROJECT_DIR=/path bun bench/probe-hook-isolated.mts value-ref-edges
```

The bench scripts open the project's DB read-only at `autoMigrate:false`
— safe to run alongside the live MCP server.
