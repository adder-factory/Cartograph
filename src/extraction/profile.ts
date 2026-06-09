/**
 * Lightweight per-phase extraction profiler. Env-gated via
 * `CARTOGRAPH_EXTRACTION_PROFILE=1`; zero overhead when off (one env-var
 * lookup at module load).
 *
 * Useful when triaging why extraction on a particular corpus is slow:
 * wraps a `label` around a sync or async callable, records count + total
 * ms + max ms in a per-label bucket. The orchestrator calls
 * {@link flushProfileReport} after the parse+store phase so the report
 * lands in the same log stream as the standard `[Ns] Phase: …` lines.
 *
 * Designed for bisection, not microbenchmarking: `Date.now()`
 * granularity (1 ms) is fine for per-file phases that take 1-100 ms,
 * and the wrap itself adds <1 µs when ON. When the per-phase total is
 * dominant in the parse+store wall-clock, that's the place to look
 * first — the report's `totalMs` column is the ranked answer.
 *
 * Surfaced by `[[project_session_handoff_2026_05_23e_typescript_bench_profile]]`
 * — wip's 6-8-worker parse pool ran 3.3× SLOWER than upstream's 1-worker
 * setup on microsoft/TypeScript, and our own `DEFAULT_PARSE_POOL_SIZE`
 * JSDoc already calls out the suspect (main-thread store bound at scale).
 */

import { parseStrictUnsignedDecimalInteger } from '../strict-numeric.js';

const ON = process.env['CARTOGRAPH_EXTRACTION_PROFILE'] === '1';
const OUTLIER_MS =
  parseStrictUnsignedDecimalInteger(process.env['CARTOGRAPH_EXTRACTION_PROFILE_OUTLIER_MS'] ?? '') ?? 1000;

interface Bucket {
  count: number;
  totalMs: number;
  maxMs: number;
}

const buckets = new Map<string, Bucket>();

function record(label: string, ms: number): void {
  const b = buckets.get(label);
  if (b) {
    b.count++;
    b.totalMs += ms;
    if (ms > b.maxMs) b.maxMs = ms;
  } else {
    buckets.set(label, { count: 1, totalMs: ms, maxMs: ms });
  }
}

/** Wrap a sync callable; pass-through when the profiler is off. */
export function profile<T>(label: string, fn: () => T): T {
  if (!ON) return fn();
  const start = Date.now();
  try {
    return fn();
  } finally {
    record(label, Date.now() - start);
  }
}

export interface ProfileAsyncTagArgs<T> {
  label: string;
  suffix: string;
  detail: string;
  fn: () => Promise<T>;
}

export interface ProfileTagArgs<T> {
  label: string;
  suffix: string;
  detail: string;
  fn: () => T;
}

/** Async variant that ALSO records under `${label}:${suffix}` (e.g. per-language
 *  buckets) AND emits a `slow` log line when the call exceeds
 *  `CARTOGRAPH_EXTRACTION_PROFILE_OUTLIER_MS` (default 1000ms). `detail` is
 *  inlined into the slow line so callers can identify the file/symbol
 *  without the profile module knowing about extraction internals. */
export async function profileAsyncTagged<T>(args: ProfileAsyncTagArgs<T>): Promise<T> {
  const { label, suffix, detail, fn } = args;
  if (!ON) return fn();
  const start = Date.now();
  try {
    return await fn();
  } finally {
    const ms = Date.now() - start;
    record(label, ms);
    record(`${label}:${suffix}`, ms);
    if (ms >= OUTLIER_MS) {
      process.stdout.write(`[ext-profile] slow ${label} ${ms}ms  ${suffix}  ${detail}\n`);
    }
  }
}

/** Sync variant of {@link profileAsyncTagged}. */
export function profileTagged<T>(args: ProfileTagArgs<T>): T {
  const { label, suffix, detail, fn } = args;
  if (!ON) return fn();
  const start = Date.now();
  try {
    return fn();
  } finally {
    const ms = Date.now() - start;
    record(label, ms);
    record(`${label}:${suffix}`, ms);
    if (ms >= OUTLIER_MS) {
      process.stdout.write(`[ext-profile] slow ${label} ${ms}ms  ${suffix}  ${detail}\n`);
    }
  }
}

/** Column-pad constants for the rollup-table layout. */
const MIN_LABEL_PAD = 12;
const COL_PAD_COUNT = 8;
const COL_PAD_TOTAL_MS = 10;
const COL_PAD_AVG_MS = 8;
const COL_PAD_MAX_MS = 8;
const AVG_MS_DECIMALS = 2;

/** Print the per-label rollup. Sorted by `totalMs` descending — the
 *  ranked answer to "where did the time go". No-op when the profiler
 *  is off OR no labels were recorded. */
export function flushProfileReport(prefix = '[ext-profile]'): void {
  if (!ON || buckets.size === 0) return;
  const rows = [...buckets.entries()]
    .map(([label, b]) => ({
      label,
      count: b.count,
      totalMs: b.totalMs,
      avgMs: b.totalMs / b.count,
      maxMs: b.maxMs,
    }))
    .sort((a, b) => b.totalMs - a.totalMs);
  const padLabel = Math.max(...rows.map((r) => r.label.length), MIN_LABEL_PAD);
  const head = `${'phase'.padEnd(padLabel)}  ${'count'.padStart(COL_PAD_COUNT)}  ${'totalMs'.padStart(COL_PAD_TOTAL_MS)}  ${'avgMs'.padStart(COL_PAD_AVG_MS)}  ${'maxMs'.padStart(COL_PAD_MAX_MS)}`;
  process.stdout.write(`\n${prefix} ${'='.repeat(head.length)}\n`);
  process.stdout.write(`${prefix} ${head}\n`);
  for (const r of rows) {
    process.stdout.write(
      `${prefix} ${r.label.padEnd(padLabel)}  ${String(r.count).padStart(COL_PAD_COUNT)}  ${String(r.totalMs).padStart(COL_PAD_TOTAL_MS)}  ${r.avgMs.toFixed(AVG_MS_DECIMALS).padStart(COL_PAD_AVG_MS)}  ${String(r.maxMs).padStart(COL_PAD_MAX_MS)}\n`,
    );
  }
  process.stdout.write(`${prefix} ${'='.repeat(head.length)}\n\n`);
  buckets.clear();
}

// ---- Worker → main delta protocol -----------------------------------
//
// Profile data accumulates inside the parse-worker's module instance —
// separate from main's because each worker_thread has its own JS isolate.
// To get worker-side timings into the main `flushProfileReport` rollup
// we ship a tiny snapshot delta back with every `parse-result` message:
// {label, count, totalMs, maxMs}[] for labels that changed since the
// last send. Main calls {@link mergeProfileEntries} to fold them in.
//
// Per-parse IPC overhead is ~few hundred bytes — negligible compared
// to the parse times we're measuring (10-100 ms per file).

export interface ProfileEntry {
  label: string;
  count: number;
  totalMs: number;
  maxMs: number;
}

/** Tracks the last-sent snapshot per label so we only ship deltas. */
const lastSent = new Map<string, Bucket>();

/** Build a delta of buckets whose count grew since the last call.
 *  No-op return when the profiler is off — keeps the worker happy
 *  even when the env var is unset. */
export function snapshotProfileDelta(): ProfileEntry[] {
  if (!ON) return [];
  const out: ProfileEntry[] = [];
  for (const [label, cur] of buckets) {
    const prev = lastSent.get(label);
    const baseCount = prev?.count ?? 0;
    if (cur.count > baseCount) {
      out.push({
        label,
        count: cur.count - baseCount,
        totalMs: cur.totalMs - (prev?.totalMs ?? 0),
        maxMs: cur.maxMs,
      });
      lastSent.set(label, { count: cur.count, totalMs: cur.totalMs, maxMs: cur.maxMs });
    }
  }
  return out;
}

/** Fold a worker-shipped delta into this module's buckets. Called on
 *  the main thread by the parse-worker-pool message handler. Always
 *  records — independent of the env-gate (the worker decides whether
 *  to ship anything). */
export function mergeProfileEntries(entries: ReadonlyArray<ProfileEntry>): void {
  for (const e of entries) {
    const b = buckets.get(e.label);
    if (b) {
      b.count += e.count;
      b.totalMs += e.totalMs;
      if (e.maxMs > b.maxMs) b.maxMs = e.maxMs;
    } else {
      buckets.set(e.label, { count: e.count, totalMs: e.totalMs, maxMs: e.maxMs });
    }
  }
}
