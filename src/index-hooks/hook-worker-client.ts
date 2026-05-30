/**
 * `HookWorkerClient` — main-process handle to the index-hook worker.
 *
 * Owns one long-lived forked child process (`hook-worker.ts`) that
 * runs the derived-signal hook phase. `Cartograph.sync` / `indexAll`
 * dispatch the phase here instead of running the hooks inline, so the
 * CPU-bound synchronous passes (PageRank centrality, biomarker clone
 * detection) execute off the main event loop and the MCP server stays
 * responsive. See `hook-worker.ts` for the why — including why this is
 * a `child_process.fork` and NOT a `worker_threads` Worker (tsx's
 * `.js`→`.ts` resolver does not activate in worker threads).
 *
 * Lifecycle: a single child, spawned lazily on the first `runPhase`
 * and reused. `sync` / `indexAll` are already serialized by
 * `Cartograph.lock.mutex`, so the child is never asked to run two
 * phases at once — no request queue is needed. The child is recycled
 * every {@link RECYCLE_INTERVAL} phases so the biomarker pass's WASM
 * grammar heap can't grow without bound across a long server lifetime.
 *
 * Failure policy:
 *  - Spawn-handshake failure → the client permanently `disabled`s
 *    itself and `runPhase` returns `null`, the signal for the caller
 *    to fall back to running hooks in-process. No worse than the
 *    pre-worker behaviour.
 *  - Mid-phase crash / timeout → the child is killed and a synthetic
 *    timeout/crash outcome is returned (NOT `null`): the caller must
 *    NOT re-run in-process, since that would re-freeze the main
 *    thread. Derived signals are simply slightly stale until the next
 *    sync — the deliberate trade. The next `runPhase` respawns.
 */

import { fork, type ChildProcess } from 'node:child_process';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { logDebug, logWarn, errMsg } from '../errors.js';
import { HOOK_TIMEOUT_MS } from './registry.js';
import type { IndexHookOutcome } from './types.js';
import type { SyncResult } from '../extraction/index.js';
import type { CartographConfig } from '../types.js';

/** True iff we're running on the Bun runtime. */
const IS_BUN = typeof (globalThis as { Bun?: unknown }).Bun !== 'undefined';

/**
 * Minimal Node-style child handle the rest of this file talks to.
 * Under Node we get a real {@link ChildProcess} from `fork`; under Bun
 * we get a hand-rolled wrapper around `Bun.spawn({ ipc })`.
 *
 * Why a wrapper at all: `child_process.fork` on Bun 1.3.x has an open
 * intermittent IPC-polling bug (oven-sh/bun#27002, Feb 2026) where the
 * forked child stops draining its IPC channel after ~1-in-3 spawns.
 * That bug class is precisely what this whole worker exists to avoid
 * (the original MCP freeze fix). `Bun.spawn({ ipc })` is a different
 * code path and is reliable. So under Bun we route through it.
 */
interface HookChild {
  send(msg: unknown, cb?: (err: Error | null) => void): boolean;
  on(event: 'message', handler: (msg: unknown) => void): this;
  on(event: 'exit', handler: (code: number | null) => void): this;
  on(event: 'error', handler: (err: Error) => void): this;
  kill(): void;
}

/**
 * Whole-phase wall-clock budgets on the MAIN process, split by phase
 * shape:
 *
 *   - `sync`: small changeset (often a single file). Group A+B+C work
 *     touches just the dirty subset, so the per-hook 5-min budget is
 *     also a sane whole-phase cap. Reuses {@link HOOK_TIMEOUT_MS}.
 *   - `indexAll`: full-project pass. The phase is ~17 hooks run as
 *     A → B (parallel) → C; group C alone runs the cross-file
 *     biomarker pass + centrality PageRank over the whole graph. On a
 *     39 311-file / 329K-node corpus (microsoft/TypeScript) the
 *     cross-file pass ran past the old 5-min cap and was killed mid-
 *     run, leaving `code_health_findings` empty and `cartograph_status`
 *     reporting a misleading "Project clean ✓". 30 min covers that
 *     case with headroom; still bounds a genuinely-wedged child to
 *     half an hour rather than forever.
 *
 * Exceeding the budget means a hook genuinely hung the child (a
 * synchronous hook can block the child's own loop so the child-side
 * per-hook timeout can't fire) — the client kills the child and
 * respawns next phase.
 */
export const PHASE_TIMEOUT_MS_SYNC = HOOK_TIMEOUT_MS;
export const PHASE_TIMEOUT_MS_INDEX_ALL = 30 * 60 * 1000;

/** Look up the per-phase wall-clock budget. Centralised so the
 *  raceWithTimeout call site and any future caller share one
 *  selection rule. Exported so unit tests can pin the selector's
 *  branches without reaching into module internals. */
export function phaseTimeoutMs(phase: 'sync' | 'indexAll'): number {
  return phase === 'indexAll' ? PHASE_TIMEOUT_MS_INDEX_ALL : PHASE_TIMEOUT_MS_SYNC;
}

/**
 * Wall-clock cap on awaiting the child's `exit` event during
 * `terminate()`. Generous enough for a graceful SIGTERM cleanup on a
 * busy machine; short enough that a stuck child doesn't hang
 * `Cartograph.uninitialize()` (the call path that motivated the await).
 * After the timeout the host proceeds — the child either died and
 * the listener already fired, or it's still alive and the OS will
 * reap it via the eventual SIGKILL on process exit.
 */
const TERMINATE_TIMEOUT_MS = 5000;

/** Recycle the child after this many phases so the biomarker pass's
 *  WASM grammar heap AND per-phase libsqlite mmap/metadata residue
 *  are reclaimed periodically. Empirically the child grows ~0.8 MB
 *  per phase on a small synthetic and ~17 MB per phase on a 15k-node
 *  live repo; the residue is dominated by libsqlite mmap/extension
 *  state that survives `db.close()`, not the page cache (reducing
 *  PRAGMA cache_size from 64 MB to 8 MB moves per-phase growth by
 *  <0.1 MB on the synthetic). Per-phase reopen is intentional for
 *  schema-refresh safety, so the only knob is recycle frequency. 100
 *  caps a long-running MCP at ~1.7 GB worst-case child RSS on a live
 *  repo; respawn costs ~500 ms and happens during natural idle
 *  between sync bursts. */
const RECYCLE_INTERVAL = 100;

/**
 * Backstop for the spawn handshake. The child normally posts `ready`
 * within a second of fork; if it neither readies nor exits within this
 * budget (a genuinely wedged child), the client kills it and degrades
 * to in-process. In an environment with no TS loader (e.g. a test
 * harness) the child instead exits fast with a module-resolution error
 * — that path rejects immediately via the `exit` handler, well before
 * this timeout.
 */
const SPAWN_TIMEOUT_MS = 20_000;

/** Arguments for one {@link HookWorkerClient.runPhase} call. */
export interface RunPhaseArgs {
  readonly phase: 'sync' | 'indexAll';
  readonly projectRoot: string;
  /** Absolute path to `.cartograph/cartograph.db`. */
  readonly dbPath: string;
  /** The live `CartographConfig` — structured-cloned across the IPC boundary. */
  readonly config: CartographConfig;
  /** Required for `phase: 'sync'`; carries `changedFilePaths`. */
  readonly syncResult?: SyncResult;
}

/** Wire form of an outcome (Error flattened to a string in the child). */
interface WireOutcome {
  readonly name: string;
  readonly phase: IndexHookOutcome['phase'];
  readonly durationMs: number;
  readonly error?: string;
}

interface ReadyMessage {
  readonly type: 'ready';
}
interface DoneMessage {
  readonly type: 'hooks-done';
  readonly id: number;
  readonly outcomes: WireOutcome[];
}
interface ErrorMessage {
  readonly type: 'hooks-error';
  readonly id: number;
  readonly message: string;
}
type ChildMessage = ReadyMessage | DoneMessage | ErrorMessage;

/** One in-flight phase awaiting its child reply. */
interface Pending {
  resolve: (outcomes: IndexHookOutcome[]) => void;
  reject: (err: Error) => void;
}

/**
 * Resolve the worker entry file next to this module, matching THIS
 * module's extension: `.ts` when running under `tsx` (the dev path and
 * the `cartograph serve --mcp` path), `.js` in a built `dist/`.
 */
function resolveWorkerPath(): string {
  const here = fileURLToPath(import.meta.url);
  const ext = here.endsWith('.ts') ? '.ts' : '.js';
  return path.join(path.dirname(here), `hook-worker${ext}`);
}

/**
 * The `execArgv` to fork the child with — the loader-setup flags of
 * the current process (`--require` / `--import` / `--loader`), nothing
 * else.
 *
 * Why explicit: when the process runs under `tsx` (the dev path and
 * the `cartograph serve --mcp` path), the forked child must launch with
 * tsx's loader or it cannot resolve the `.ts` worker file's
 * `.js`-suffix relative imports (`import '../db/index.js'` →
 * `../db/index.ts`). A forked child is a fresh Node *main* process, so
 * — unlike a worker thread — passing the loader flags here gives it
 * full tsx (resolver included). In a built `dist/` there are no loader
 * flags, so this is `[]` and the child runs plain `.js` — correct for
 * both modes. The script-positional / `--eval` entries of
 * `process.execArgv` are dropped (the child takes its own entry file).
 */
function workerExecArgv(): string[] {
  const argv = process.execArgv;
  const kept: string[] = [];
  const loaderFlags = new Set(['--require', '-r', '--import', '--loader', '--experimental-loader']);
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!;
    if (loaderFlags.has(arg) && i + 1 < argv.length) {
      kept.push(arg, argv[++i]!);
    } else if (/^--(require|import|loader|experimental-loader)=/.test(arg)) {
      kept.push(arg);
    }
  }
  return kept;
}

/**
 * Spawn the hook worker under Bun via `Bun.spawn({ ipc })` and adapt
 * its handle to the Node `ChildProcess`-shaped {@link HookChild}
 * interface the rest of this client talks to.
 *
 * Differences smoothed over here:
 * - Bun.spawn's IPC delivery is via a single `ipc(message, child)`
 *   callback, not `on('message')`. We route all messages through one
 *   internal dispatcher and re-emit to whatever listener `.on('message')`
 *   has registered.
 * - Bun.spawn returns a process handle with `.exited` (a Promise) and
 *   no `'exit'` event. We surface a Node-style `on('exit', code)` by
 *   awaiting that promise in the background.
 * - Bun.spawn does not emit `'error'` separately from a non-zero exit.
 *   We approximate: a non-zero exit (or stderr-only fail-fast) maps
 *   to `code` on the exit handler; spawn-throws happen synchronously
 *   in this function and surface to the caller.
 *
 * The child code (`hook-worker.ts`) is unchanged — Bun supports
 * `process.send` / `process.on('message')` in IPC children.
 *
 * G10.8 history (2026-05-21): observed two concurrent orphan children
 * (PIDs 76866 + 77199) of a single live MCP server PID 76819 on macOS
 * 26.5 under bun 1.3.14. The older orphan had no IPC fd in `lsof` —
 * the parent had closed its end but the child didn't observe the
 * `disconnect` event and exit. `sample` showed both children idle in
 * `kevent64`, not deadlocked. Five reproduction scenarios all CLEAN
 * (cannot reproduce the failure):
 *   1. `bench/hook-worker-spawn-cycle.mts` BENCH_PHASES=30 — clean
 *      spawn/sync/terminate cycles, peak concurrent child = 1, zero
 *      lingering after close.
 *   2. `bench/hook-worker-spawn-cycle.mts` BENCH_PHASES=201 — exercises
 *      the recycle path (fire-and-forget `terminate()` followed
 *      immediately by re-spawn) twice at `RECYCLE_INTERVAL=100`, peak
 *      concurrent = 1, 3 distinct PIDs observed across the run, zero
 *      lingering.
 *   3. `bench/hook-worker-rapid-terminate.mts` — forces an explicit
 *      `hookWorker.terminate()` between every sync (20 cycles) plus
 *      4-parallel-sync bursts every 5 iterations. 21 distinct PIDs
 *      observed across the run, peak concurrent = 1, zero lingering.
 *      Exercises the same `terminate()` + immediate `ensureSpawned`
 *      race the natural recycle path uses, but at a much higher rate.
 *   4. `scripts/hook-worker-parent-exit-runner.sh` — parent exits
 *      cleanly without calling `terminate()`; OS-mediated disconnect
 *      reaches the child and it exits within ~2s.
 *   5. `scripts/hook-worker-sigkill-parent-runner.sh` — parent SIGKILLed
 *      mid-flight; child still observes channel closure and exits.
 * The live-MCP-orphan failure mode is a more specific race we can't
 * reach via stress — possibilities include the spawn-handshake exit
 * handler firing on a child that's NOT the current `this.child` (the
 * `if (this.child === child)` guard at line ~435 deliberately skips
 * cleanup in that case), concurrent runPhase calls hitting an in-
 * flight `ensureSpawned`, or a Bun-version-specific IPC-close race
 * specific to long-uptime states (the live orphans accumulated over
 * several hours of mixed sync / index-force / watcher events). The
 * five scripts stand as regression guards: if a future change causes
 * any of them to leak, exit code 1 catches it.
 */
function spawnHookChildOnBun(workerPath: string): HookChild {
  const Bun_ = (globalThis as unknown as { Bun: { spawn: (cmd: string[], opts: Record<string, unknown>) => unknown } })
    .Bun;
  const messageHandlers: Array<(msg: unknown) => void> = [];
  const exitHandlers: Array<(code: number | null) => void> = [];
  const errorHandlers: Array<(err: Error) => void> = [];

  const subprocess = Bun_.spawn(['bun', workerPath], {
    ipc(message: unknown) {
      for (const h of messageHandlers) {
        try {
          h(message);
        } catch (err) {
          for (const eh of errorHandlers) eh(err instanceof Error ? err : new Error(String(err)));
        }
      }
    },
    // Match Node's `serialization: 'advanced'` — Bun supports the same
    // option and uses V8 structured clone when set.
    serialization: 'advanced',
    stdio: ['ignore', 'inherit', 'inherit'],
  }) as {
    send: (msg: unknown) => boolean;
    kill: () => void;
    exited: Promise<number | null>;
  };

  // Surface 'exit' the moment the child terminates. Don't await
  // synchronously — let it settle in the background.
  void subprocess.exited.then((code) => {
    for (const h of exitHandlers) h(code ?? null);
  });

  return {
    send(msg: unknown, cb?: (err: Error | null) => void) {
      try {
        const ok = subprocess.send(msg);
        cb?.(null);
        return ok;
      } catch (err) {
        const wrapped = err instanceof Error ? err : new Error(String(err));
        cb?.(wrapped);
        return false;
      }
    },
    on(event: 'message' | 'exit' | 'error', handler: never): never {
      if (event === 'message') messageHandlers.push(handler as (msg: unknown) => void);
      else if (event === 'exit') exitHandlers.push(handler as (code: number | null) => void);
      else if (event === 'error') errorHandlers.push(handler as (err: Error) => void);
      return this as never;
    },
    kill() {
      try {
        subprocess.kill();
      } catch {
        /* already gone */
      }
    },
  };
}

function fromWireOutcome(w: WireOutcome): IndexHookOutcome {
  return {
    name: w.name,
    phase: w.phase,
    durationMs: w.durationMs,
    ...(w.error ? { error: new Error(w.error) } : {}),
  };
}

export class HookWorkerClient {
  private child: HookChild | null = null;
  /** Resolves once the live child has posted its `ready` handshake. */
  private ready: Promise<void> | null = null;
  private nextId = 0;
  private readonly pending = new Map<number, Pending>();
  /** Set once a spawn handshake has permanently failed — `runPhase`
   *  then always returns `null` (caller runs hooks in-process). */
  private disabled = false;
  /** Phases run by the CURRENT child; drives {@link RECYCLE_INTERVAL}. */
  private phasesOnChild = 0;

  constructor() {
    // Operational escape hatch: `CARTOGRAPH_HOOKS_IN_PROCESS=1` skips the
    // child entirely and runs hooks inline. Set in the npm test scripts
    // (the forked child cannot resolve the project's TS under the test
    // harness's loader — tests exercise the in-process fallback, which
    // is the same code path), and available for debugging.
    if (process.env['CARTOGRAPH_HOOKS_IN_PROCESS']) this.disabled = true;
  }

  /**
   * Run one hook phase in the child process.
   *
   * @returns the per-hook outcomes, or `null` when the child could not
   *   be spawned at all — the caller's signal to run the hooks
   *   in-process. A mid-phase crash/timeout still returns an outcome
   *   array (a synthetic error outcome), never `null`.
   */
  async runPhase(args: RunPhaseArgs): Promise<IndexHookOutcome[] | null> {
    if (this.disabled) return null;
    try {
      if (this.phasesOnChild >= RECYCLE_INTERVAL) await this.recycle();
      await this.ensureSpawned();
    } catch (err) {
      // Spawn never succeeded — degrade permanently to in-process.
      this.disabled = true;
      logWarn('hook worker unavailable; running index hooks in-process', { error: errMsg(err) });
      return null;
    }
    this.phasesOnChild++;
    const id = this.nextId++;
    const child = this.child;
    if (!child) return null;

    const reply = new Promise<IndexHookOutcome[]>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send(
        {
          type: 'run-hooks',
          id,
          phase: args.phase,
          projectRoot: args.projectRoot,
          dbPath: args.dbPath,
          config: args.config,
          ...(args.syncResult ? { syncResult: args.syncResult } : {}),
        },
        (err) => {
          // `send` failed (channel closed mid-dispatch) — fail this
          // phase rather than hang on a reply that will never come.
          if (err && this.pending.delete(id)) reject(err);
        },
      );
    });

    try {
      return await this.raceWithTimeout(reply, args.phase);
    } catch (err) {
      // Child crashed or exceeded the phase budget. Kill it so the
      // next phase respawns clean. Return a synthetic outcome — NOT
      // `null` — so the caller does NOT re-run hooks in-process (that
      // would re-freeze the main thread). Derived signals are stale
      // until the next sync; the deliberate trade.
      logWarn('hook worker phase failed', { phase: args.phase, error: errMsg(err) });
      await this.terminate();
      return [{ name: 'hook-worker', phase: args.phase, durationMs: 0, error: new Error(errMsg(err)) }];
    }
  }

  /** Kill the child and reject any in-flight phase. Idempotent.
   *  Awaits the child's actual `exit` event so callers can safely
   *  delete the .cartograph directory (or take any other action
   *  that races a still-alive child holding open file handles on
   *  the project's DB) without an EBUSY on Windows or an orphan-
   *  inode write window on POSIX. Bounded by `TERMINATE_TIMEOUT_MS`
   *  so a stuck child doesn't hang the host.
   *  Call on `Cartograph.close()` / `Cartograph.uninitialize()`. */
  async terminate(): Promise<void> {
    const child = this.child;
    this.child = null;
    this.ready = null;
    this.phasesOnChild = 0;
    for (const [, p] of this.pending) p.reject(new Error('hook worker terminated'));
    this.pending.clear();
    if (!child) return;
    const exited = new Promise<void>((resolve) => {
      const onExit = (): void => resolve();
      child.on('exit', onExit);
    });
    try {
      child.kill();
    } catch {
      /* already gone — the exit listener still fires (or the child
       * is already dead, in which case the timeout below wins) */
    }
    await Promise.race([exited, new Promise<void>((resolve) => setTimeout(resolve, TERMINATE_TIMEOUT_MS))]);
  }

  // ── internals ──────────────────────────────────────────────────────

  /** Recycle = kill + drop, so the next `ensureSpawned` is fresh. */
  private async recycle(): Promise<void> {
    logDebug(`hook worker: recycling after ${this.phasesOnChild} phases`);
    await this.terminate();
  }

  /** Lazily fork the child and await its `ready` handshake. The
   *  promise is cached so concurrent callers share one spawn. */
  private ensureSpawned(): Promise<void> {
    if (this.ready) return this.ready;
    this.ready = new Promise<void>((resolve, reject) => {
      let child: HookChild;
      try {
        if (IS_BUN) {
          // Under Bun, sidestep child_process.fork's intermittent
          // IPC-polling bug (#27002) by going through Bun.spawn's
          // native IPC. Native TS execution means no execArgv hack.
          child = spawnHookChildOnBun(resolveWorkerPath());
        } else {
          // `fork()` returns a ChildProcess that satisfies HookChild's
          // structural subset (send / on / kill). Assigning into the
          // narrower HookChild local widens covariantly — no cast.
          const forked: HookChild = fork(resolveWorkerPath(), [], {
            execArgv: workerExecArgv(),
            // Structured-clone IPC — robust for the config / SyncResult
            // payloads and any future non-JSON values.
            serialization: 'advanced',
          });
          child = forked;
        }
      } catch (err) {
        reject(err instanceof Error ? err : new Error(String(err)));
        return;
      }
      this.child = child;

      // The handshake settles exactly once — on `ready`, on a spawn
      // error, on an early exit, or on the timeout backstop. Without
      // this guard an early `exit` (the child fails to load its `.ts`
      // imports — e.g. no TS loader) would leave the spawn promise
      // unsettled forever and `runPhase` would hang.
      let settled = false;
      let timer: ReturnType<typeof setTimeout> | null = null;
      const finish = (err?: Error): void => {
        if (settled) return;
        settled = true;
        if (timer) clearTimeout(timer);
        if (err) reject(err);
        else resolve();
      };

      timer = setTimeout(() => {
        finish(new Error(`hook worker spawn timed out after ${SPAWN_TIMEOUT_MS}ms`));
        try {
          child.kill();
        } catch {
          /* already gone */
        }
      }, SPAWN_TIMEOUT_MS);

      child.on('message', (msg: unknown) => {
        const m = msg as ChildMessage;
        if (m.type === 'ready') finish();
        else this.onMessage(m);
      });
      child.on('error', (err) => {
        finish(err);
        this.rejectAllPending(new Error(`hook worker error: ${err.message}`));
      });
      child.on('exit', (code) => {
        // An exit BEFORE the `ready` handshake is a spawn failure —
        // reject so `runPhase` falls back to in-process instead of
        // hanging. An exit after `ready` only affects in-flight phases.
        finish(new Error(`hook worker exited with code ${code ?? 'null'} before ready`));
        if (code) this.rejectAllPending(new Error(`hook worker exited with code ${code}`));
        if (this.child === child) {
          this.child = null;
          this.ready = null;
        }
      });
    });
    return this.ready;
  }

  /** Route a phase-reply message (`ready` is handled at the spawn
   *  handshake in {@link ensureSpawned}). */
  private onMessage(msg: DoneMessage | ErrorMessage): void {
    const pending = this.pending.get(msg.id);
    if (!pending) return;
    this.pending.delete(msg.id);
    if (msg.type === 'hooks-done') {
      pending.resolve(msg.outcomes.map(fromWireOutcome));
    } else {
      pending.reject(new Error(msg.message));
    }
  }

  private rejectAllPending(err: Error): void {
    for (const [, p] of this.pending) p.reject(err);
    this.pending.clear();
  }

  /** Race a phase reply against the wall-clock budget. The budget is
   *  phase-shaped (see {@link phaseTimeoutMs}): incremental syncs reuse
   *  the per-hook cap, full `indexAll` passes get a generous 30-min
   *  ceiling so cross-file biomarkers on large repos can complete. */
  private async raceWithTimeout(
    reply: Promise<IndexHookOutcome[]>,
    phase: 'sync' | 'indexAll',
  ): Promise<IndexHookOutcome[]> {
    let timer: ReturnType<typeof setTimeout> | null = null;
    const budgetMs = phaseTimeoutMs(phase);
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`hook phase '${phase}' exceeded ${budgetMs}ms budget`)), budgetMs);
    });
    try {
      return await Promise.race([reply, timeout]);
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}
