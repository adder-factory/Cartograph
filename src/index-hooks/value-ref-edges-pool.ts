/**
 * Orchestrator for the value-ref-edges worker pool. Partitions a file
 * batch across N workers, awaits all replies, returns aggregated edges
 * to the caller. Main thread does the actual `insertEdges` call
 * (bun:sqlite serializes writes; one connection is simpler).
 *
 * B28 v2 (2026-05-24) — mirrors `src/biomarkers/worker-pool.ts`'s
 * `runOneRuleInWorker` shape, with one deliberate divergence on the
 * `'exit'` handler (see #2 below). Three resilience features that
 * B28 v1 (commit `0d0afde`, reverted) lacked:
 *
 *   1. **Per-worker `settled` flag + setTimeout budget.** A worker that
 *      blocks past `perWorkerTimeoutMs` is terminated and surfaced as
 *      an empty result with `error` populated. Without this, a single
 *      silently-hung worker would pin `Promise.all` for the full
 *      `HOOK_TIMEOUT_MS` and kill the entire hook with zero edges.
 *
 *   2. **`'exit'` handler that settles when the worker exits before
 *      posting a message.** Code 0 + no message → empty reply with
 *      error. Without this the promise would hang forever even when
 *      the worker quietly died (postMessage flush race / OOM kill).
 *      **Deliberate divergence from G9**: G9's guard is
 *      `if (code !== 0 && !settled)` (only acts on non-zero exit);
 *      ours is `if (!settled)` (acts on any exit). The strict
 *      condition is what fixed the v1 hang — a code-0 silent exit
 *      WOULD have been the original failure mode.
 *
 *   3. **Single `settle()` helper that flips the `settled` flag.**
 *      Prevents double-settle if message and exit both fire.
 *
 * Without these, B28 v1 timed out at 300s on microsoft/TypeScript
 * (one or more workers silently failed) and shipped zero
 * value-ref-edges — a correctness regression. v2 will surface a
 * per-worker error in the log AND still emit the survivors' edges.
 *
 * Routing: caller (`value-ref-edges.ts:buildValueRefEdges`) gates on
 * file count. Below `VALUE_REF_WORKER_FILE_THRESHOLD` the in-main path
 * is used (worker spawn cost would dominate). Override via
 * `CARTOGRAPH_VALUE_REF_WORKERS=N` / `=0` (0 forces serial).
 */

import { fileURLToPath } from 'node:url';
import { partitionRoundRobin } from '../utils.js';
import { runWorkerSlice } from '../utils/worker-slice.js';
import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';
import type { ValueRefEdgeRecord } from './value-ref-edge-scan.js';
import type { ValueRefWorkerReply } from './value-ref-edges-worker.js';

/** Below this file count, the in-main sync path beats the worker-spawn
 *  overhead. Tuned for M-series; small projects should never see the
 *  pool. */
export const VALUE_REF_WORKER_FILE_THRESHOLD = 2000;

/** Per-worker wall-clock budget. A worker that blocks past this is
 *  terminated and surfaced as an error result. Sized to be comfortably
 *  larger than the heaviest realistic slice (full TS shard ~30-60s
 *  post-B25+B27) but well under the hook's 300s timeout so a hung
 *  worker still leaves time for the survivors' edges to land. */
const DEFAULT_PER_WORKER_TIMEOUT_MS = 120_000;
/** CPU-count fallback + pool floor/ceiling for the cpus-minus-one
 *  heuristic. Same shape as biomarkers/per-file-pool.ts. */
const DEFAULT_CPU_COUNT_FALLBACK = 4;
const POOL_FLOOR = 2;
const POOL_CEILING = 8;

/** Resolve worker count: `os.cpus()-1`, capped 8 (memory) + floored 2
 *  (a 1-worker pool is just spawn overhead). Override via env. */
function resolveWorkerCount(): number {
  const raw = process.env['CARTOGRAPH_VALUE_REF_WORKERS'];
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
export function shouldUseValueRefWorkers(fileCount: number): boolean {
  if (fileCount < VALUE_REF_WORKER_FILE_THRESHOLD) return false;
  return resolveWorkerCount() > 0;
}

interface PoolArgs {
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly files: ReadonlyArray<{ path: string; language: string }>;
  /** Per-worker wall-clock budget. Defaults to {@link DEFAULT_PER_WORKER_TIMEOUT_MS}. */
  readonly perWorkerTimeoutMs?: number;
}

/** @internal — exported for tests in `__tests__/value-ref-edges-pool.test.ts`
 *  which substitutes a custom `workerPath` to drive the resilience
 *  paths (silent exit, timeout, error event) without exercising the
 *  full edge-extraction stack. */
export interface RunOneWorkerArgs {
  readonly workerPath: string;
  readonly dbPath: string;
  readonly projectRoot: string;
  readonly fileRecords: ReadonlyArray<{ path: string; language: string }>;
  readonly timeoutMs: number;
  readonly sliceLabel: string;
}

/** Spawn one worker with a slice of file records and return its reply.
 *  Mirrors G9's `runOneRuleInWorker` (src/biomarkers/worker-pool.ts:86)
 *  — settled flag + per-worker timeout + exit-without-message handling
 *  so a silent worker failure surfaces as a logged error instead of
 *  hanging `Promise.all`.
 *
 *  @internal — exported for the resilience-path tests; production
 *  callers go through `buildValueRefEdgesInWorkers`. */
export function runOneWorker(args: RunOneWorkerArgs): Promise<ValueRefWorkerReply> {
  return runWorkerSlice<ValueRefWorkerReply>({
    workerPath: args.workerPath,
    workerData: {
      dbPath: args.dbPath,
      projectRoot: args.projectRoot,
      fileRecords: args.fileRecords,
    },
    timeoutMs: args.timeoutMs,
    sliceLabel: args.sliceLabel,
    logPrefix: 'value-ref-edges:',
    makeErrorReply: (error) => ({ ok: false, error }),
  });
}

/** Pool result — survivor edges plus an `isPartial` flag the caller
 *  uses to gate the algo-version metadata stamp. When `isPartial` is
 *  true (any worker failed / timed out), the caller MUST NOT stamp
 *  `last_mined_value_ref_edges_algo_version` because the survivor
 *  edges are an incomplete shard of the full project's value-refs;
 *  stamping would convince the next sync that mining is complete,
 *  leaving the dropped edges silently missing until a manual
 *  `admin index --force` or an algo-version change re-mines. The
 *  2026-05-24 rabbit hole confirmed the gap empirically (2 of 8
 *  workers consistently timing out on microsoft/TypeScript, dropping
 *  ~25K of ~38K edges per indexAll). */
export interface ValueRefPoolResult {
  readonly edges: ValueRefEdgeRecord[];
  readonly isPartial: boolean;
}

/** Build the value-ref edges by farming work out to N workers. Returns
 *  the aggregated edge list + an `isPartial` flag set when any worker
 *  failed / timed out. Survivor workers' edges are returned even when
 *  some workers fail; the caller is responsible for skipping the
 *  algo-version metadata stamp when `isPartial` is true so the next
 *  sync re-mines the project. */
export async function buildValueRefEdgesInWorkers(args: PoolArgs): Promise<ValueRefPoolResult> {
  const workerCount = resolveWorkerCount();
  if (workerCount <= 0 || args.files.length === 0) return { edges: [], isPartial: false };
  // Resolve worker entry — `.ts` under bun, `.js` in dist. Same shape
  // as B10's pagerank-parallel and G9's worker-pool.
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  const workerPath = fileURLToPath(new URL(`./value-ref-edges-worker${ext}`, import.meta.url));

  // B34 (2026-05-24) — partition via round-robin (file `j` → worker
  // `j mod n`) through the shared `partitionRoundRobin` util.
  // Contiguous slicing put TS's `checker.ts` / `tsc.ts` cluster all
  // in worker #3, blowing past the 120s per-worker timeout while
  // the others finished in 30-40s; round-robin distribution gives
  // statistical balance with zero overhead and no per-file size
  // metadata required.
  const slices = partitionRoundRobin(args.files, workerCount);
  const timeoutMs = args.perWorkerTimeoutMs ?? DEFAULT_PER_WORKER_TIMEOUT_MS;

  const replies = await Promise.all(
    slices.map((slice, i) =>
      runOneWorker({
        workerPath,
        dbPath: args.dbPath,
        projectRoot: args.projectRoot,
        fileRecords: slice,
        timeoutMs,
        sliceLabel: `#${i}/${slices.length}`,
      }),
    ),
  );

  const edges: ValueRefEdgeRecord[] = [];
  let okCount = 0;
  let failCount = 0;
  for (let i = 0; i < replies.length; i++) {
    const reply = replies[i]!;
    if (reply.ok) {
      okCount++;
      edges.push(...reply.edges);
    } else {
      failCount++;
      // Promote failures to console.error so they're visible without
      // DEBUG env. The B34 probe arc (2026-05-24) showed the pool
      // routinely loses 2 workers to the per-worker timeout on the
      // microsoft/TypeScript corpus — silent logDebug would have
      // hidden a partial-data correctness regression.
      console.error(
        `[value-ref-edges] worker #${i}/${replies.length} FAIL files=${slices[i]!.length} error=${reply.error}`,
      );
    }
  }
  // Summary only when there's something to report (failures, or a
  // multi-worker pool where the count itself is interesting).
  if (failCount > 0) {
    console.error(
      `[value-ref-edges] pool: ${okCount} OK / ${failCount} FAIL / ${replies.length} total, ${edges.length} edges aggregated`,
    );
  }
  return { edges, isPartial: failCount > 0 };
}
