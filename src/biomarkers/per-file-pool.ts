/**
 * Per-file biomarker worker pool — partitions a file batch across N
 * worker_threads, awaits all per-file COMPUTE results, returns
 * aggregated results to the caller. Main thread does the persist
 * (SQLite writes serialize at the engine level so parallelizing them
 * wouldn't help).
 *
 * B22 (2026-05-24) — mirrors G9's `runOneRuleInWorker` shape exactly
 * (src/biomarkers/worker-pool.ts:86): settled flag + per-worker
 * setTimeout + 'exit'-without-message handling. Same resilience
 * contract as B28 v2's `value-ref-edges-pool.ts`. Any silent worker
 * failure surfaces as a logged error with a slice label; survivor
 * workers' results are still emitted.
 *
 * Routing: caller (`runFileLoop` in `src/biomarkers/index.ts`) gates
 * on file count. Below `PER_FILE_WORKER_THRESHOLD` the existing
 * `streamingDispatch` path beats the worker-spawn overhead. Override
 * via `CARTOGRAPH_BIOMARKER_PERFILE_WORKERS=N` / `=0` (0 forces the
 * existing single-thread path; bench A/B escape hatch).
 */

import { fileURLToPath } from 'node:url';
import { errMsg, logDebug } from '../errors.js';
import { partitionRoundRobin } from '../utils.js';
import { runWorkerSlice } from '../utils/worker-slice.js';
import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';
import {
  parsePerFileWorkerReply,
  type PerFileResult,
  type PerFileWorkerInit,
  type PerFileWorkerReply,
} from './per-file-worker-contract.js';

/** Below this file count, the in-main streamingDispatch path beats the
 *  worker-spawn overhead (per-worker bun:sqlite open + grammar preload
 *  ~250ms × N workers). On microsoft/TypeScript (39K files) the worker
 *  pool wins comfortably; on smaller projects spawn cost dominates. */
export const PER_FILE_WORKER_THRESHOLD = 1000;

/** Per-worker wall-clock budget. Sized to cover the heaviest realistic
 *  slice (TS-scale ~6500 files per worker × 0.62ms compute averaged =
 *  ~4s; with slow-file outliers and the grammar preload, ~30s is a
 *  comfortable upper bound). Stays well under the hook's 300s
 *  `HOOK_TIMEOUT_MS` so a hung worker still leaves time for survivors. */
const DEFAULT_PER_WORKER_TIMEOUT_MS = 120_000;
/** Cap when `os.cpus()` is unavailable — assume a small-medium box. */
const DEFAULT_CPU_COUNT_FALLBACK = 4;
/** Worker-pool sizing floor / ceiling for the cpus-minus-one
 *  heuristic. Floor avoids the "single worker = pure spawn overhead"
 *  degenerate case; ceiling bounds memory pressure on big boxes. */
const POOL_FLOOR = 2;
const POOL_CEILING = 8;

function resolveWorkerCount(): number {
  const raw = process.env['CARTOGRAPH_BIOMARKER_PERFILE_WORKERS'];
  if (raw !== undefined) {
    const n = parseStrictUnsignedDecimalInteger(raw);
    if (n !== null) return n;
  }
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const os = require('node:os') as typeof import('node:os');
  const cpus = typeof os.cpus === 'function' ? os.cpus().length : DEFAULT_CPU_COUNT_FALLBACK;
  return Math.max(POOL_FLOOR, Math.min(cpus - 1, POOL_CEILING));
}

/** True iff worker count > 0 AND file count clears the threshold. */
export function shouldUsePerFileWorkers(fileCount: number): boolean {
  if (fileCount < PER_FILE_WORKER_THRESHOLD) return false;
  return resolveWorkerCount() > 0;
}

interface PoolArgs {
  readonly dbPath: string;
  readonly projectRoot: string;
  /** Files that need real compute. Caller MUST pre-filter diagnostic
   *  paths and cache hits — the worker treats every file as needing
   *  compute. */
  readonly files: ReadonlyArray<{ relPath: string; currentHash: string | null }>;
  readonly nowMs: number;
  readonly perWorkerTimeoutMs?: number;
}

interface RunOneWorkerArgs {
  readonly workerPath: string;
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly batch: ReadonlyArray<{ relPath: string; currentHash: string | null }>;
  readonly nowMs: number;
  readonly timeoutMs: number;
  readonly sliceLabel: string;
}

/** Spawn one worker with a batch of files and return its reply.
 *  Mirrors G9's `runOneRuleInWorker` shape — settled flag + per-worker
 *  timeout + exit-without-message handling. */
function runOneWorker(args: RunOneWorkerArgs): Promise<PerFileWorkerReply> {
  return runWorkerSlice<unknown>({
    workerPath: args.workerPath,
    workerData: {
      dbPath: args.dbPath,
      projectRoot: args.projectRoot,
      batch: [...args.batch],
      nowMs: args.nowMs,
    } satisfies PerFileWorkerInit,
    timeoutMs: args.timeoutMs,
    sliceLabel: args.sliceLabel,
    logPrefix: 'biomarkers per-file',
    makeErrorReply: (error) => ({ ok: false, error }),
  }).then((raw) => {
    try {
      return parsePerFileWorkerReply(raw);
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  });
}

/** Run the per-file biomarker compute across N workers. Returns the
 *  aggregated per-file result list; caller persists. Survivor workers'
 *  results are emitted even when some workers fail; per-worker failures
 *  log via `logDebug` so the bench can grep for which slice died. */
export async function runPerFileBiomarkersInWorkers(args: PoolArgs): Promise<PerFileResult[]> {
  // Cap effective workers to file count so a small filesToCompute set
  // (e.g. 1001 targetFiles but 1000 cache-hit so only 1 needs compute)
  // doesn't spawn N empty-batch workers each paying the bun:sqlite +
  // grammar-preload cost for nothing.
  const requestedWorkers = resolveWorkerCount();
  const workerCount = Math.min(requestedWorkers, args.files.length);
  if (workerCount <= 0 || args.files.length === 0) return [];
  // Resolve worker entry — `.ts` under bun, `.js` in dist. Same shape
  // as G9's worker-pool and B28 v2's value-ref-edges-pool.
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = fileURLToPath(new URL(`./per-file-worker${ext}`, import.meta.url));

  // B35 (2026-05-24) — round-robin partition via the shared util.
  // Pre-B35 the slicing was contiguous on the rationale of OS-page-cache
  // locality; in practice directory-order clusters of expensive files
  // dominated a single worker. Round-robin spreads them across the pool
  // with no measurable cache-miss penalty.
  const slices = partitionRoundRobin(args.files, workerCount);
  const timeoutMs = args.perWorkerTimeoutMs ?? DEFAULT_PER_WORKER_TIMEOUT_MS;

  const replies = await Promise.all(
    slices.map((batch, i) =>
      runOneWorker({
        workerPath,
        dbPath: args.dbPath,
        projectRoot: args.projectRoot,
        batch,
        nowMs: args.nowMs,
        timeoutMs,
        sliceLabel: `#${i}/${slices.length}`,
      }),
    ),
  );

  const aggregated: PerFileResult[] = [];
  for (const reply of replies) {
    if (reply.ok) {
      aggregated.push(...reply.results);
    } else {
      logDebug(`biomarkers per-file worker failed: ${reply.error}`);
    }
  }
  return aggregated;
}
