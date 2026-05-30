/**
 * Hardware-aware tuning recommendations.
 *
 * Single source of truth for "given THIS machine, what's the right
 * `llama-server --parallel N` per tier and what's the right
 * cartograph-side outbound concurrency?". Consumed by:
 *
 *   1. `src/llm/embeddings.ts` + `src/llm/summarizer.ts` — the
 *      DEFAULT_*_CONCURRENCY constants become calls to
 *      `recommendedTuning().cartographConcurrency` per tier.
 *
 *   2. `src/installer/llm-setup-plan.ts` — the `install-llama-cpp`
 *      preset's `nextSteps` strings include the right `--parallel N`
 *      baked in for the detected hardware (e.g. on M4 Max it suggests
 *      `--parallel 8` for embed, `--parallel 4` for chat).
 *
 *   3. `src/installer/doctor.ts` — informational row in the report
 *      surfacing "this is the recommended tuning for your hardware"
 *      so users can self-tune their llama-server invocations even if
 *      they didn't use the wizard.
 *
 * Detection budget: pure `os.*` calls + `process.platform` / `arch`.
 * No subprocess spawning (no `nvidia-smi`, no `system_profiler`) —
 * we stay in the "detect, don't manage" lane that's load-bearing for
 * the migration's "cartograph is no longer a process manager" promise.
 *
 * The recommendations are conservative — they aim to saturate the GPU
 * without OOMing, on the *recommended* GGUFs cartograph ships
 * (jina-base for embed, Qwen 3B/7B for chat, bge for rerank). Users
 * with larger models or smaller hardware can override per tier in
 * `.cartograph/config.json` (the legacy `endpoints[0]` numeric-string
 * concurrency knob is still honoured for back-compat).
 */

import * as os from 'node:os';

/** What the planner detected about the running machine. */
export interface DetectedHardware {
  /** Logical CPU count. */
  readonly cpus: number;
  /** Total system memory in GB (rounded down). On unified-memory
   *  platforms (Apple Silicon) this is also the GPU's available
   *  memory pool. */
  readonly totalMemGb: number;
  /** `'darwin'` / `'linux'` / `'win32'`. */
  readonly platform: NodeJS.Platform;
  /** `'arm64'` / `'x64'` / `'arm'` / etc. */
  readonly arch: NodeJS.Architecture;
  /** True when platform === 'darwin' && arch === 'arm64' — Apple
   *  Silicon with unified memory + Metal GPU. The recommended tuning
   *  for this combo is more aggressive than for discrete-GPU x86
   *  machines because there's no PCIe transfer cost between RAM and
   *  GPU memory. */
  readonly isAppleSilicon: boolean;
}

/** Per-tier tuning recommendation. The same shape applies to every
 *  tier; the actual NUMBERS differ because embed is cheap (small
 *  model, batched), chat is heavier (larger model, longer generations).
 */
interface TierTuning {
  /** `llama-server --parallel N` — number of internal scheduler
   *  slots. Higher means more concurrent requests can be in flight
   *  at the backend, but each slot reserves KV-cache memory. */
  readonly llamaServerParallel: number;
  /** Cartograph-side: concurrent in-flight HTTP requests the embed
   *  pipeline / summarizer push at the backend. Matching this to
   *  `llamaServerParallel` keeps every slot full without piling up
   *  extra requests at the client. */
  readonly cartographConcurrency: number;
}

/** Per-tier tuning bundle returned by {@link recommendedTuning}. */
export interface RecommendedTuning {
  /** Embed tier (`/v1/embeddings`). Cheapest tier — tiny model
   *  (jina-base is 104 MB), high parallelism scales linearly. */
  readonly embed: TierTuning;
  /** Chat tier — summarize / local. The recommended model is
   *  Qwen 2.5 Coder 3B (~2 GB). Each slot allocates a KV-cache
   *  proportional to context size, so the number is more
   *  conservative than embed. */
  readonly chat: TierTuning;
  /** Ask tier — the higher-stakes 7B Qwen (~4.5 GB). More slots
   *  means more KV-cache per slot; this tier defaults to the
   *  fewest slots so we don't blow out unified memory. */
  readonly ask: TierTuning;
  /** Reranker (`/v1/rerank`). bge-reranker-v2-m3 is mid-sized
   *  (~418 MB); behaves like a medium-sized encoder. */
  readonly reranker: TierTuning;
}

/** Fallback CPU count when `os.cpus()` is unavailable (older Bun /
 *  embedded contexts). */
const DEFAULT_CPU_COUNT_FALLBACK = 4;
/** Bytes per gigabyte — for the `os.totalmem()` divide. */
const BYTES_PER_GB = 1024 * 1024 * 1024;

/** Detect the running machine's specs. Pure `os.*` reads — no
 *  subprocess, no FFI, sub-millisecond. */
export function detectHardware(): DetectedHardware {
  const cpus = typeof os.cpus === 'function' ? os.cpus().length : DEFAULT_CPU_COUNT_FALLBACK;
  const totalMemGb = Math.floor(os.totalmem() / BYTES_PER_GB);
  const platform = process.platform;
  const arch = process.arch;
  return {
    cpus,
    totalMemGb,
    platform,
    arch,
    isAppleSilicon: platform === 'darwin' && arch === 'arm64',
  };
}

/** Compute the recommended per-tier tuning from detected hardware.
 *  Pure function — same inputs → same outputs. Tests pass mocked
 *  hardware to assert the shape.
 *
 *  Heuristic shape (validated on M4 Max via the embed bench in
 *  `bench/value-ref-edges-worker-cap.mts` — `--parallel 8` +
 *  concurrency 8 gave 2.3× speedup over `--parallel 1` + concurrency
 *  2 on the jina embed model):
 *
 *  - Apple Silicon with ≥ 16 GB unified memory: aggressive (embed 8,
 *    chat 4, ask 2, reranker 4). Unified memory means no PCIe
 *    bottleneck.
 *  - Apple Silicon with ≥ 8 GB: moderate (embed 4, chat 2, ask 1,
 *    reranker 2). Still better than CPU baseline because Metal is
 *    fast even on the smallest M-series.
 *  - Linux/Windows x64: assume CPU-only OR unknown GPU; conservative
 *    (embed 4, chat 2, ask 1, reranker 2) keyed on CPU count.
 *  - Tiny boxes (< 8 GB total): minimum viable (embed 2, chat 1,
 *    ask 1, reranker 1). Cartograph still works, just slower.
 */
/** Memory-tier breakpoints in GB. */
const MEM_TIER_TINY_MAX_GB = 8;
const MEM_TIER_SMALL_MAX_GB = 16;
const MEM_TIER_MEDIUM_MAX_GB = 48;
/** Per-(platform × memory-tier) static slot counts. Apple Silicon's
 *  unified-memory GPU pool lets the GPU see the full RAM, so the
 *  Apple tiers are more aggressive than the x86 conservative ones. */
const SLOTS_APPLE_BIG = { embed: 8, chat: 4, ask: 2, reranker: 4 } as const;
const SLOTS_APPLE_SMALL = { embed: 4, chat: 2, ask: 1, reranker: 2 } as const;
const SLOTS_APPLE_TINY = { embed: 2, chat: 1, ask: 1, reranker: 1 } as const;
const SLOTS_X86_SMALL = { embed: 4, chat: 2, ask: 1, reranker: 2 } as const;
const SLOTS_X86_TINY = { embed: 2, chat: 1, ask: 1, reranker: 1 } as const;
/** CPU-cap floor / ceiling for the x86 medium/large branch. */
const X86_CPU_CAP_MIN = 2;
const X86_CPU_CAP_MAX = 8;
const X86_EMBED_MAX = 8;
const X86_CHAT_MAX = 4;
const X86_CHAT_MIN = 2;
const X86_ASK_MAX = 2;
const X86_ASK_MIN = 1;
const X86_RERANKER_MAX = 4;
const X86_RERANKER_MIN = 2;

type MemTier = 'tiny' | 'small' | 'medium' | 'large';

/** Bucket the RAM amount into a discrete tier the slot-count table
 *  reads. Plain if-chain rather than a nested ternary so the
 *  complex_conditional biomarker stays clear. */
function classifyMemTier(totalMemGb: number): MemTier {
  if (totalMemGb < MEM_TIER_TINY_MAX_GB) return 'tiny';
  if (totalMemGb < MEM_TIER_SMALL_MAX_GB) return 'small';
  if (totalMemGb < MEM_TIER_MEDIUM_MAX_GB) return 'medium';
  return 'large';
}

export function recommendedTuning(hw: DetectedHardware = detectHardware()): RecommendedTuning {
  const memTier = classifyMemTier(hw.totalMemGb);

  if (hw.isAppleSilicon) {
    if (memTier === 'large' || memTier === 'medium') return mkTuning(SLOTS_APPLE_BIG);
    if (memTier === 'small') return mkTuning(SLOTS_APPLE_SMALL);
    return mkTuning(SLOTS_APPLE_TINY);
  }

  // Non-Apple-Silicon: be conservative because we can't detect
  // discrete-GPU VRAM without shelling out. CPU count is the
  // weakest of the available signals but it's all we have.
  if (memTier === 'tiny') return mkTuning(SLOTS_X86_TINY);
  if (memTier === 'small') return mkTuning(SLOTS_X86_SMALL);
  // medium / large: assume the user has either a beefy CPU or a
  // discrete GPU. Cap CPU-derived parallelism so we don't oversubscribe.
  const cpuCap = Math.max(X86_CPU_CAP_MIN, Math.min(hw.cpus - 1, X86_CPU_CAP_MAX));
  const half = Math.floor(cpuCap / X86_CHAT_MIN);
  const quarter = Math.floor(cpuCap / X86_RERANKER_MIN / X86_CHAT_MIN);
  return mkTuning({
    embed: Math.min(X86_EMBED_MAX, cpuCap),
    chat: Math.min(X86_CHAT_MAX, Math.max(X86_CHAT_MIN, half)),
    ask: Math.min(X86_ASK_MAX, Math.max(X86_ASK_MIN, quarter)),
    reranker: Math.min(X86_RERANKER_MAX, Math.max(X86_RERANKER_MIN, half)),
  });
}

/** Pack per-tier `{slots: N, conc: N}` pairs into the full
 *  `RecommendedTuning` shape. Keeping the slot+conc parity intentional —
 *  cartograph driving M concurrent HTTP requests against an N-slot
 *  llama-server is fully saturating when M >= N, wasteful when M > N
 *  (extra requests queue at the client), and slot-leaving when
 *  M < N. The default mirrors them. */
function mkTuning(slots: { embed: number; chat: number; ask: number; reranker: number }): RecommendedTuning {
  return {
    embed: { llamaServerParallel: slots.embed, cartographConcurrency: slots.embed },
    chat: { llamaServerParallel: slots.chat, cartographConcurrency: slots.chat },
    ask: { llamaServerParallel: slots.ask, cartographConcurrency: slots.ask },
    reranker: { llamaServerParallel: slots.reranker, cartographConcurrency: slots.reranker },
  };
}

/** Format the detected hardware as a one-line summary suitable for
 *  the doctor report / install-guide output. */
export function describeHardware(hw: DetectedHardware = detectHardware()): string {
  const platformLabel = hw.isAppleSilicon ? 'Apple Silicon (unified memory + Metal)' : `${hw.platform}/${hw.arch}`;
  return `${hw.cpus} CPUs, ${hw.totalMemGb} GB RAM, ${platformLabel}`;
}
