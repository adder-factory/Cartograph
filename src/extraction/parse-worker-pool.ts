/**
 * ParseWorkerPool — manages a pool of N tree-sitter parse workers.
 *
 * Extracted from `ExtractionOrchestrator.indexAll` so the lifecycle
 * (spawn, dispatch, recycle, terminate) lives in one place instead
 * of as a tangle of closures inside the indexAll body. The orchestrator
 * keeps owning the file-reading + DB-storage pipeline; this class
 * owns only the worker pool itself.
 *
 * Concurrency invariants preserved from the inline implementation:
 *   - Pool size is bounded; concurrent `requestParse` calls beyond
 *     the pool size park on `idleWaiters` until a worker frees up.
 *   - `spawnWorker` SYNCHRONOUSLY claims the slot (sets busy=true)
 *     before awaiting grammar load — without this, two concurrent
 *     pickWorker calls observing the null slot would both spawn into
 *     slot N and the loser would leak.
 *   - Per-worker recycle counter (`parseCount >= recycleInterval`)
 *     terminates and respawns just that one worker, preserving the
 *     rest of the pool's heap.
 *   - Timeouts terminate the offending worker only; pending parses
 *     for that slot reject; other workers keep serving.
 *   - `closing` flag suppresses the "Worker exited unexpectedly" log
 *     for terminate() paths (recycle, end-of-index, timeout).
 */

import type { ExtractionResult } from '../types.js';
import type { Worker as NodeWorker } from 'node:worker_threads';
import { mergeProfileEntries, type ProfileEntry } from './profile.js';

/** Race ceiling on a `worker.terminate()` Promise so we don't hang on a stuck WASM. */
const TERMINATE_RACE_TIMEOUT_MS = 1000;
/** Base parse timeout — applied to every file regardless of size. */
const BASE_PARSE_TIMEOUT_MS = 10_000;
/** Per-100KB timeout extension — large files get scaled budgets. */
const TIMEOUT_PER_BYTE_DENOM = 100_000;
/** Extra timeout (ms) added per 100KB chunk above the base. */
const TIMEOUT_EXTENSION_PER_CHUNK_MS = 10_000;

/** Per-file wall-clock threshold above which we surface a slow-parse
 *  warning. Set well BELOW the per-file timeout so the warning fires
 *  while the parse is still in flight (helps the user see WHICH file
 *  is hot during a long-running index) AND again at completion with
 *  the final elapsed time. B13 (2026-05-23) — surfaces the cost of
 *  pathological files (e.g. microsoft/TypeScript's
 *  `tests/cases/fourslash/reallyLargeFile.ts` at 3.3 MB / 583K lines,
 *  which takes ~7 min on a single worker after B12 removed the batch
 *  barrier). The user can then add the file to `.cartograph/config.json`
 *  `exclude` if it's a generated fixture that doesn't carry code-
 *  intelligence value. */
export const SLOW_PARSE_WARN_MS = 30_000;

interface WorkerEntry {
  worker: NodeWorker;
  parseCount: number;
  busy: boolean;
  slotIndex: number;
  /**
   * We initiated terminate() ourselves; the upcoming `exit` event is
   * expected and should not log a warning. Lifecycle:
   *   - true via recycleWorkerAt() (threshold-driven recycle)
   *   - true via terminateAll() (end-of-index cleanup)
   *   - true via the timeout path in requestParse()
   * false otherwise (worker crashed on its own — that's the
   * "Worker exited unexpectedly" warning we want to surface).
   */
  closing: boolean;
}

interface PendingParse {
  resolve: (result: ExtractionResult) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  slotIndex: number;
}

interface ParseWorkerPoolOptions {
  WorkerClass: typeof NodeWorker;
  parseWorkerPath: string;
  poolSize: number;
  neededLanguages: string[];
  /** Per-worker parse count after which the slot is recycled. */
  recycleInterval: number;
  /** Verbose logger. The pool only emits informational messages here. */
  log: (msg: string) => void;
  /** Warning logger. The pool emits unexpected-exit / worker-error warnings here. */
  logWarn: (msg: string, ctx?: Record<string, unknown>) => void;
}

/** Runtime counters/queues for the pool — grouped to reduce field count. */
interface PoolState {
  /** FIFO queue of one-shot resolvers, woken when a worker goes idle. */
  idleWaiters: Array<() => void>;
  pendingParses: Map<number, PendingParse>;
  nextId: number;
}

/** Wake the first waiter in the idle queue (if any). */
function poolNotifyIdle(state: PoolState): void {
  const w = state.idleWaiters.shift();
  if (w) w();
}

/** Reject and clean up all pending parses associated with `slotIndex`. */
function poolRejectPendingForSlot(state: PoolState, slotIndex: number, reason: string): void {
  for (const [id, pending] of state.pendingParses) {
    if (pending.slotIndex === slotIndex) {
      clearTimeout(pending.timer);
      state.pendingParses.delete(id);
      pending.reject(new Error(reason));
    }
  }
}

/** Reject and clean up all pending parses. */
function poolRejectAllPending(state: PoolState, reason: string): void {
  for (const [id, pending] of state.pendingParses) {
    clearTimeout(pending.timer);
    state.pendingParses.delete(id);
    pending.reject(new Error(reason));
  }
}

/** One record per file that crossed {@link SLOW_PARSE_WARN_MS}. */
export interface SlowFileRecord {
  readonly filePath: string;
  readonly startMs: number;
  /** `inflight` = warning fired but parse hadn't returned by the time
   *  the snapshot was read; `done` = parse completed (possibly long
   *  after the in-flight warning). */
  readonly status: 'inflight' | 'done';
  /** Wall-clock duration; only set when `status === 'done'`. */
  readonly elapsedMs?: number;
}

export class ParseWorkerPool {
  private readonly opts: ParseWorkerPoolOptions;
  private readonly workers: Array<WorkerEntry | null>;
  private readonly state: PoolState = { idleWaiters: [], pendingParses: new Map(), nextId: 0 };
  /** Per-file slow-parse records, surfaced via {@link getSlowFiles}. */
  private readonly slowFiles: SlowFileRecord[] = [];

  constructor(opts: ParseWorkerPoolOptions) {
    this.opts = opts;
    this.workers = new Array(opts.poolSize).fill(null);
  }

  /**
   * Parse one file via the pool. Spawns workers lazily up to
   * `poolSize`. Throws on parse error, timeout, or worker crash —
   * the caller decides whether to retry.
   */
  async requestParse(filePath: string, content: string): Promise<ExtractionResult> {
    const entry = await this.pickWorker();
    entry.busy = true;
    entry.parseCount++;
    const id = this.state.nextId++;

    const timeoutMs =
      BASE_PARSE_TIMEOUT_MS + Math.floor(content.length / TIMEOUT_PER_BYTE_DENOM) * TIMEOUT_EXTENSION_PER_CHUNK_MS;

    const startMs = Date.now();

    return new Promise<ExtractionResult>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.state.pendingParses.delete(id);
        this.opts.log(`TIMEOUT: ${filePath} exceeded ${timeoutMs}ms — killing worker ${entry.slotIndex}`);
        entry.closing = true;
        this.workers[entry.slotIndex] = null;
        clearTimeout(slowWarnTimer);
        reject(new Error(`Parse timed out after ${timeoutMs}ms`));
        poolNotifyIdle(this.state);
        entry.worker.terminate().catch(() => {});
      }, timeoutMs);

      // Mid-flight slow warning — fires while the parse is still
      // running so the user can see WHICH file is locking up a worker
      // during a long-running index. Cleared on resolve / reject /
      // timeout. B13 (2026-05-23).
      const slowWarnTimer = setTimeout(() => {
        this.opts.logWarn(
          `Slow parse: ${filePath} still extracting after ${SLOW_PARSE_WARN_MS}ms ` +
            `(${Math.round(content.length / 1024)}KB). One worker pinned. Add to ` +
            `\`.cartograph/config.json\` "exclude" if this file isn't needed for code intelligence.`,
          { filePath, bytes: content.length, warnMs: SLOW_PARSE_WARN_MS, slotIndex: entry.slotIndex },
        );
        this.slowFiles.push({ filePath, startMs, status: 'inflight' });
      }, SLOW_PARSE_WARN_MS);

      this.state.pendingParses.set(id, {
        resolve: (result) => {
          clearTimeout(slowWarnTimer);
          const elapsed = Date.now() - startMs;
          if (elapsed >= SLOW_PARSE_WARN_MS) {
            this.opts.logWarn(
              `Slow parse complete: ${filePath} took ${elapsed}ms ` + `(${Math.round(content.length / 1024)}KB).`,
              { filePath, bytes: content.length, elapsedMs: elapsed },
            );
            // Replace any in-flight record for this file with the
            // completion record; the summary only reports each file
            // once. Match by filePath since slowWarnTimer's record
            // is the same file.
            const idx = this.slowFiles.findIndex((s) => s.filePath === filePath && s.status === 'inflight');
            if (idx >= 0) this.slowFiles[idx] = { filePath, startMs, status: 'done', elapsedMs: elapsed };
            else this.slowFiles.push({ filePath, startMs, status: 'done', elapsedMs: elapsed });
          }
          resolve(result);
        },
        reject: (err) => {
          clearTimeout(slowWarnTimer);
          reject(err);
        },
        timer,
        slotIndex: entry.slotIndex,
      });
      entry.worker.postMessage({ type: 'parse', id, filePath, content });
    });
  }

  /** Snapshot of files that crossed the {@link SLOW_PARSE_WARN_MS}
   *  threshold. Callers (the indexAll log printer) read this at end
   *  of phase to render a summary table. Per-file dedup — a file
   *  that fired the in-flight warning and then completed is recorded
   *  once with status='done'. */
  getSlowFiles(): ReadonlyArray<SlowFileRecord> {
    return this.slowFiles;
  }

  /**
   * Recycle ALL pool workers — used by retry passes and abort paths
   * where every worker should start with a clean WASM heap.
   */
  async recycleAll(): Promise<void> {
    await Promise.all(
      this.workers.map(async (_e, idx) => {
        if (this.workers[idx]) await this.recycleWorkerAt(idx);
      }),
    );
  }

  /**
   * End-of-index shutdown: reject any in-flight parses and terminate
   * every worker. Idempotent.
   */
  async terminate(reason: string): Promise<void> {
    poolRejectAllPending(this.state, reason);
    const promises = this.workers
      .filter((e): e is WorkerEntry => e !== null)
      .map((e) => {
        e.closing = true;
        return e.worker.terminate().catch(() => {});
      });
    for (let i = 0; i < this.workers.length; i++) this.workers[i] = null;
    await Promise.all(promises);
  }

  // ── internals ──────────────────────────────────────────────────────

  private attachWorkerHandlers(entry: WorkerEntry): void {
    const { worker: w, slotIndex } = entry;
    w.on('message', (msg: { type: string; id?: number; result?: ExtractionResult; profileDelta?: ProfileEntry[] }) => {
      if (msg.type === 'parse-result' && msg.id !== undefined) {
        const pending = this.state.pendingParses.get(msg.id);
        if (pending) {
          clearTimeout(pending.timer);
          this.state.pendingParses.delete(msg.id);
          pending.resolve(msg.result!);
        }
        // Fold worker-side profile deltas into the main-thread
        // profile module. Empty / undefined when the profiler is off
        // — the merge is a no-op then.
        if (msg.profileDelta && msg.profileDelta.length > 0) {
          mergeProfileEntries(msg.profileDelta);
        }
        entry.busy = false;
        poolNotifyIdle(this.state);
      }
    });
    w.on('error', (err) => {
      this.opts.logWarn('Parse worker error', { slot: slotIndex, error: err.message });
      poolRejectPendingForSlot(this.state, slotIndex, `Worker error: ${err.message}`);
    });
    w.on('exit', (code) => {
      // Only warn on TRULY unexpected exits — `closing=true` covers
      // every code path where we ourselves called terminate().
      if (code !== 0 && !entry.closing) {
        this.opts.logWarn('Parse worker exited unexpectedly', { slot: slotIndex, code });
        poolRejectPendingForSlot(this.state, slotIndex, `Worker exited with code ${code}`);
      }
      if (this.workers[slotIndex] === entry) this.workers[slotIndex] = null;
      poolNotifyIdle(this.state);
    });
  }

  private async spawnWorker(slotIndex: number): Promise<WorkerEntry> {
    this.opts.log(`Spawning parse worker ${slotIndex}...`);
    const worker = new this.opts.WorkerClass(this.opts.parseWorkerPath);
    // Mark slot busy SYNCHRONOUSLY before awaiting grammar load —
    // without this, two concurrent pickWorker calls observing the
    // null slot would BOTH spawn into slot N (loser leaks).
    const entry: WorkerEntry = { worker, parseCount: 0, busy: true, slotIndex, closing: false };
    this.workers[slotIndex] = entry;
    this.attachWorkerHandlers(entry);
    await new Promise<void>((resolve, reject) => {
      worker.once('message', (msg: { type: string }) => {
        if (msg.type === 'grammars-loaded') resolve();
        else reject(new Error(`Unexpected message: ${msg.type}`));
      });
      worker.postMessage({ type: 'load-grammars', languages: this.opts.neededLanguages });
    });
    entry.busy = false;
    poolNotifyIdle(this.state);
    return entry;
  }

  private async recycleWorkerAt(slotIndex: number): Promise<void> {
    const entry = this.workers[slotIndex];
    if (!entry) return;
    this.opts.log(
      `Recycling worker ${slotIndex} after ${entry.parseCount} parses ` +
        `(heap: ${Math.round(process.memoryUsage().rss / 1024 / 1024)}MB RSS)`,
    );
    entry.closing = true;
    this.workers[slotIndex] = null;
    let timedOut = false;
    try {
      await Promise.race([
        entry.worker.terminate(),
        new Promise<void>((resolve) =>
          setTimeout(() => {
            timedOut = true;
            resolve();
          }, TERMINATE_RACE_TIMEOUT_MS),
        ),
      ]);
    } catch {
      // terminate() failing means the worker is already gone
    }
    if (timedOut) entry.worker.terminate().catch(() => {});
  }

  /**
   * Acquire an idle worker. Spawns lazily up to poolSize; once full,
   * waits for a busy worker to free up. Recycles the picked worker
   * if it has crossed the recycle threshold.
   */
  private async pickWorker(): Promise<WorkerEntry> {
    while (true) {
      const result = await this.claimIdleOrRecycle();
      if (result.kind === 'claimed') return result.worker;
      if (result.kind === 'recycled') continue;
      const emptySlot = this.workers.indexOf(null);
      if (emptySlot >= 0) {
        await this.spawnWorker(emptySlot);
        continue;
      }
      await new Promise<void>((resolve) => this.state.idleWaiters.push(resolve));
    }
  }

  /**
   * Single-pass scan of the worker slots. Returns:
   *  - `{ kind: 'claimed', worker }` — idle worker under recycle threshold.
   *  - `{ kind: 'recycled' }` — idle worker past threshold; recycled, re-scan.
   *  - `{ kind: 'no-idle' }` — no idle slot; caller spawns or waits.
   */
  private async claimIdleOrRecycle(): Promise<
    { kind: 'claimed'; worker: WorkerEntry } | { kind: 'recycled' } | { kind: 'no-idle' }
  > {
    for (let i = 0; i < this.workers.length; i++) {
      const e = this.workers[i];
      if (!e || e.busy) continue;
      if (e.parseCount < this.opts.recycleInterval) return { kind: 'claimed', worker: e };
      await this.recycleWorkerAt(i);
      return { kind: 'recycled' };
    }
    return { kind: 'no-idle' };
  }
}
