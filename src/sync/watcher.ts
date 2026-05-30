/**
 * File Watcher
 *
 * Watches the project directory for file changes and triggers
 * debounced sync operations to keep the code graph up-to-date.
 *
 * Uses `@parcel/watcher` — a native (Rust) shim over FSEvents
 * (macOS), inotify (Linux), and ReadDirectoryChangesW (Windows).
 * Replaced Node's `fs.watch(root, {recursive: true})` on 2026-05-22
 * (G8): the native variant silently stopped firing under load on
 * macOS (caught when a 607-file biome format pass on disk didn't
 * trigger any sync), and the `watcher.on('error', …)` channel
 * logged nothing — `fs.watch`'s only failure signal is a no-op.
 * `@parcel/watcher` either delivers events or surfaces a callback
 * `err` we can route through `onSyncError`, and is the de-facto
 * native solution used by VS Code, Parcel, and Vite.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { subscribe as parcelSubscribe, type AsyncSubscription } from '@parcel/watcher';
import type { CartographConfig } from '../types.js';
import { shouldIncludeFile } from '../extraction/index.js';
import { logDebug, logWarn } from '../errors.js';
import { normalizePath } from '../utils.js';

/**
 * Recognise filesystem events that indicate the project's HEAD or branch
 * refs have moved. `fs.watch` already sees these inside `.git/` since the
 * watcher recurses the project root; the include/exclude filter would
 * otherwise drop them.
 *
 * Covers:
 *   - bare commit / checkout / branch creation: .git/HEAD, .git/refs/heads/*
 *   - merge: .git/MERGE_HEAD (the marker that a merge is in progress)
 *   - rebase: .git/rebase-merge/HEAD, .git/rebase-apply/HEAD
 *   - tags: .git/refs/tags/*
 *   - packed refs: .git/packed-refs
 *   - reflog leading edge: .git/logs/HEAD
 *   - worktrees: .git/worktrees/<name>/HEAD
 *   - submodules: .git/modules/<path>/HEAD
 */
export function isGitHeadChange(p: string): boolean {
  if (p === '.git/HEAD' || p === '.git/MERGE_HEAD' || p === '.git/packed-refs') return true;
  if (p === '.git/logs/HEAD') return true;
  if (p === '.git/rebase-merge/HEAD' || p === '.git/rebase-apply/HEAD') return true;
  if (p.startsWith('.git/refs/heads/') || p.startsWith('.git/refs/tags/')) return true;
  // Worktrees keep their own HEAD under .git/worktrees/<name>/HEAD.
  if (p.startsWith('.git/worktrees/') && p.endsWith('/HEAD')) return true;
  // Submodule HEAD movements live under .git/modules/<path>/HEAD.
  if (p.startsWith('.git/modules/') && p.endsWith('/HEAD')) return true;
  return false;
}

/**
 * Time abstraction — F#69 (2026-05-28). The FileWatcher's debounce,
 * safety-net interval, and stats timestamps all route through this
 * interface instead of calling `Date.now` / `setTimeout` /
 * `setInterval` directly. Production passes the default `realClock`;
 * tests pass a `VirtualClock` (see `__tests__/helpers/virtual-clock.ts`)
 * to advance time deterministically with `clock.advance(ms)` instead
 * of waiting wall-clock. Eliminates the macOS-scheduling-induced
 * flake class (F#67/F#68 root cause) at its source for logic tests —
 * they no longer wait on real timers at all.
 */
export interface Clock {
  /** Replaces `Date.now()`. */
  now(): number;
  /** Schedule a one-shot callback after `ms` of clock time. */
  setTimeout(fn: () => void, ms: number): TimeoutHandle;
  /** Schedule a repeating callback every `ms` of clock time. */
  setInterval(fn: () => void, ms: number): IntervalHandle;
}

export interface TimeoutHandle {
  /** Cancel the pending callback. No-op if already fired. */
  cancel(): void;
}

export interface IntervalHandle {
  /** Stop the repeating callback. */
  cancel(): void;
  /** Signal that the underlying timer should not pin the event loop
   *  alive (production wraps `setInterval(...).unref()`; virtual
   *  clocks treat this as a no-op). */
  unref(): void;
}

const realClock: Clock = {
  now: () => Date.now(),
  setTimeout: (fn, ms) => {
    const id = setTimeout(fn, ms);
    return { cancel: () => clearTimeout(id) };
  },
  setInterval: (fn, ms) => {
    const id = setInterval(fn, ms);
    return {
      cancel: () => clearInterval(id),
      unref: () => {
        if (typeof id.unref === 'function') id.unref();
      },
    };
  },
};

/**
 * Options for the file watcher
 */
export interface WatchOptions {
  /**
   * Debounce delay in milliseconds.
   * After the last file change, wait this long before triggering sync.
   * Default: 2000ms
   */
  debounceMs?: number;

  /**
   * Periodic safety-net interval in milliseconds. Every tick, if no
   * sync is in flight and no changes are pending, run a sync anyway
   * to recover from any FSEvents/inotify events the OS dropped under
   * load. Set to 0 to disable.
   * Default: 300_000ms (5 minutes).
   */
  safetyNetIntervalMs?: number;

  /**
   * Callback when a sync completes (for logging/diagnostics).
   */
  onSyncComplete?: (result: { filesChanged: number; durationMs: number }) => void;

  /**
   * Callback when a sync errors (for logging/diagnostics).
   */
  onSyncError?: (error: Error) => void;

  /**
   * Clock used by the debounce, safety-net interval, and stats
   * timestamps. Defaults to {@link realClock}; tests pass a
   * `VirtualClock` for deterministic time-warping (F#69, 2026-05-28).
   */
  clock?: Clock;
}

/** Snapshot returned by {@link FileWatcher.getStats}. Useful for the
 *  agent debugging "did the watcher miss this?" — pair with
 *  `isActive()` to confirm the watcher is up. */
export interface WatcherStats {
  /** Total successful syncs since `start()`. */
  syncCount: number;
  /** Total `syncFn()` rejections since `start()`. */
  failureCount: number;
  /** Epoch ms of the last successful sync; null when none yet. */
  lastSyncAt: number | null;
  /** Epoch ms of the last sync rejection; null when none yet. */
  lastErrorAt: number | null;
  /** Number of consecutive failures since the last success.
   *  Drives the exponential-backoff debounce (2× per failure,
   *  capped at MAX_DEBOUNCE_MS). */
  consecutiveFailures: number;
}

/** Hard cap on the per-failure exponential backoff. 60s keeps
 *  retries from spinning when an error is transient but not
 *  resolving (e.g. another process holds the index lock). */
const MAX_DEBOUNCE_MS = 60_000;

/** Coerce an unknown thrown value into an Error. */
function toError(err: unknown): Error {
  if (err instanceof Error) return err;
  return new Error(String(err));
}

// ---------------------------------------------------------------------------
// Mutable runtime state — grouped so free-function helpers share it without
// each needing per-field parameters.
// ---------------------------------------------------------------------------

/**
 * F#60 — per-file pending entry exposed to MCP tool responses so the
 * staleness banner can flag "this file's index entry may be stale,
 * Read it directly" for the specific files referenced in the
 * response. `pending` = in the debounce window, sync hasn't started
 * yet; `indexing` = sync is currently consuming this file's edits.
 */
export interface PendingFile {
  /** Project-relative POSIX path (e.g. "src/foo.ts"). */
  path: string;
  /** Wall-clock ms at the first event seen for this path since the last successful sync. */
  firstSeenMs: number;
  /** Wall-clock ms at the most recent event. */
  lastSeenMs: number;
  /** True when a sync is in flight that began AFTER this file's most recent event. */
  indexing: boolean;
}

interface PendingEntry {
  firstSeenMs: number;
  lastSeenMs: number;
}

/** Mutable runtime state for a single {@link FileWatcher} instance. */
interface WatcherState {
  /** Resolved parcel subscription once the async `subscribe()` returns.
   *  `null` while the subscribe call is in flight or after `stop()`. */
  subscription: AsyncSubscription | null;
  /** True once `start()` was called and the subscribe call has been
   *  kicked off, even before it resolves. Lets `isActive()` answer
   *  truthy during the (typically <10ms) window between `start()`
   *  returning and the subscription actually opening — the existing
   *  synchronous-start API contract callers depend on. Cleared by
   *  `stop()`. */
  subscribing: boolean;
  debounceTimer: TimeoutHandle | null;
  safetyNetTimer: IntervalHandle | null;
  hasChanges: boolean;
  syncing: boolean;
  stopped: boolean;
  /**
   * F#60 — per-file event tracking for the staleness banner.
   * `pendingFiles` are in the debounce window; `indexingFiles` are
   * those a currently-running sync committed to picking up. Events
   * that arrive DURING a sync land in `pendingFiles` (will be
   * absorbed by the next sync round); on sync success we drop
   * `indexingFiles`; on failure we roll them back into `pendingFiles`
   * so the dropped batch isn't forgotten.
   */
  pendingFiles: Map<string, PendingEntry>;
  indexingFiles: Map<string, PendingEntry>;
  // Stats — updated in watcherFlush(), read via getStats().
  syncCount: number;
  failureCount: number;
  lastSyncAt: number | null;
  lastErrorAt: number | null;
  consecutiveFailures: number;
  // Callbacks and config — bundled to reduce parameter count.
  syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  debounceMs: number;
  onSyncComplete?: WatchOptions['onSyncComplete'];
  onSyncError?: WatchOptions['onSyncError'];
  /** Source of `now()` + timer scheduling. {@link realClock} in
   *  production; a `VirtualClock` in deterministic tests. */
  clock: Clock;
}

interface WatcherMakeStateArgs {
  syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  debounceMs: number;
  onSyncComplete?: WatchOptions['onSyncComplete'];
  onSyncError?: WatchOptions['onSyncError'];
  clock?: Clock;
}

function watcherMakeState(args: WatcherMakeStateArgs): WatcherState {
  const { syncFn, debounceMs, onSyncComplete, onSyncError, clock } = args;
  return {
    subscription: null,
    subscribing: false,
    debounceTimer: null,
    safetyNetTimer: null,
    hasChanges: false,
    syncing: false,
    stopped: false,
    pendingFiles: new Map(),
    indexingFiles: new Map(),
    syncCount: 0,
    failureCount: 0,
    lastSyncAt: null,
    lastErrorAt: null,
    consecutiveFailures: 0,
    syncFn,
    debounceMs,
    onSyncComplete,
    onSyncError,
    clock: clock ?? realClock,
  };
}

// ---------------------------------------------------------------------------
// Module-scope helpers — operate on WatcherState + the config they need.
// ---------------------------------------------------------------------------

/** Bounded exponential backoff: `baseDebounce × 2^failures`,
 *  capped at MAX_DEBOUNCE_MS. Resets on the first success. */
function watcherCurrentDebounceMs(st: WatcherState, debounceMs: number): number {
  if (st.consecutiveFailures === 0) return debounceMs;
  const scaled = debounceMs * 2 ** st.consecutiveFailures;
  return Math.min(scaled, MAX_DEBOUNCE_MS);
}

/**
 * Schedule a debounced sync. Delay scales with consecutive failures
 * (2× per failure, capped at MAX_DEBOUNCE_MS) so a persistent error
 * doesn't pin the event loop in a tight 2s retry loop.
 */
function watcherScheduleSync(st: WatcherState, flushFn: () => void): void {
  if (st.debounceTimer) {
    st.debounceTimer.cancel();
  }
  const delay = watcherCurrentDebounceMs(st, st.debounceMs);
  st.debounceTimer = st.clock.setTimeout(() => {
    st.debounceTimer = null;
    flushFn();
  }, delay);
}

/** Start (or restart) the periodic safety-net timer. Skipped when
 *  `safetyNetIntervalMs` is 0. */
function watcherStartSafetyNet(st: WatcherState, safetyNetIntervalMs: number): void {
  if (safetyNetIntervalMs <= 0) return;
  if (st.safetyNetTimer) st.safetyNetTimer.cancel();
  st.safetyNetTimer = st.clock.setInterval(() => {
    // Skip when something else has the watcher busy — the in-flight
    // sync / pending debounce will pick up any real drift on its own.
    if (st.stopped || st.syncing || st.hasChanges) return;
    // Force a sync without setting `hasChanges`: the underlying
    // cg.sync() walks the FS itself and decides if anything needs
    // re-indexing. If nothing changed it's a fast no-op; if FSEvents
    // dropped a real change we recover here.
    logDebug('Safety-net sync tick');
    // `watcherFlush` has a complete try/catch/finally that handles
    // all error paths internally — its returned Promise never
    // rejects. `void` makes the intentional fire-and-forget contract
    // explicit (the setInterval callback can't await anyway).
    void watcherFlush(st);
  }, safetyNetIntervalMs);
  // Don't pin the event loop on this timer — let process exit
  // naturally if everything else has drained. Virtual clock's
  // `unref()` is a no-op (no underlying libuv timer to ref).
  st.safetyNetTimer.unref();
}

/** Flush pending changes by running sync. */
async function watcherFlush(st: WatcherState): Promise<void> {
  // If already syncing, the post-sync check will re-trigger
  if (st.syncing || st.stopped) return;

  st.hasChanges = false;
  st.syncing = true;

  // F#60 — snapshot pending files into indexing: this sync is
  // committed to picking them up. Events that arrive during sync land
  // in a fresh pendingFiles map (the watcher event handler keeps
  // writing) and will be absorbed by the NEXT round. On success we
  // drop indexingFiles; on failure we restore so the staleness banner
  // keeps flagging them until the retry succeeds.
  st.indexingFiles = st.pendingFiles;
  st.pendingFiles = new Map();

  let syncFailed = false;
  try {
    const result = await st.syncFn();
    st.syncCount += 1;
    st.lastSyncAt = st.clock.now();
    st.consecutiveFailures = 0;
    st.onSyncComplete?.(result);
  } catch (err) {
    syncFailed = true;
    st.failureCount += 1;
    st.lastErrorAt = st.clock.now();
    st.consecutiveFailures += 1;
    const error = toError(err);
    logWarn('Watch sync failed', { error: error.message, consecutiveFailures: st.consecutiveFailures });
    st.onSyncError?.(error);
  } finally {
    st.syncing = false;

    // Re-set hasChanges if the sync failed so the dropped batch isn't
    // forgotten — without this, a transient sync failure leaves the index
    // stale until a *new* file event happens to retrigger.
    if (syncFailed) {
      st.hasChanges = true;
      // F#60 — fold indexingFiles back into pendingFiles so the banner
      // keeps flagging the unfulfilled batch. Don't overwrite entries
      // that arrived mid-sync (those have fresher lastSeenMs).
      for (const [path, entry] of st.indexingFiles) {
        const newer = st.pendingFiles.get(path);
        if (!newer) st.pendingFiles.set(path, entry);
      }
    }
    st.indexingFiles = new Map();

    // If we have pending changes (either from the failed sync or new
    // events that arrived during it), schedule another flush.
    if (st.hasChanges && !st.stopped) {
      watcherScheduleSync(st, () => watcherFlush(st));
    }
  }
}

/** Context for the parcel-watcher callback — groups the four co-varying fields. */
interface WatchEventCtx {
  st: WatcherState;
  config: CartographConfig;
  projectRoot: string;
  scheduleFn: () => void;
}

/**
 * Handle one parcel-watcher event: normalise the absolute path back
 * to a project-relative path, apply filters, and schedule a sync
 * when the file should be tracked.
 */
function watcherHandleFileEvent(ctx: WatchEventCtx, absPath: string): void {
  const { st, config, projectRoot, scheduleFn } = ctx;
  if (!absPath || st.stopped) return;

  // Parcel hands us absolute paths; the rest of the pipeline
  // (`shouldIncludeFile`, `isGitHeadChange`, the `.cartograph/`
  // prefix check) operates on project-relative paths. `path.relative`
  // is symlink-naive but the watcher subscribes to the realpath of
  // `projectRoot` anyway (callers pass through `Cartograph.projectRoot`
  // which is already resolved), so relative-by-prefix is safe.
  const rel = path.relative(projectRoot, absPath);
  // Outside the project root — defensive; parcel shouldn't deliver
  // these but a symlink-out target could surface one.
  if (rel.startsWith('..') || path.isAbsolute(rel)) return;
  const normalized = normalizePath(rel);

  // Ignore .cartograph/ directory changes (our own DB writes).
  if (normalized === '.cartograph' || normalized.startsWith('.cartograph/')) return;

  // Detect HEAD-moving git operations (commit, checkout, rebase,
  // pull, reset) that leave the working tree unchanged but bump
  // the indexed sha. Sync needs to re-stamp freshness even
  // though no source file moved.
  if (isGitHeadChange(normalized)) {
    logDebug('Git HEAD change detected', { file: normalized });
    st.hasChanges = true;
    scheduleFn();
    return;
  }

  // Filter against include/exclude patterns
  if (!shouldIncludeFile(normalized, config)) return;

  // F#60 — record this file's event so the staleness banner can
  // flag it. New entries get firstSeenMs; existing entries refresh
  // lastSeenMs. Events that arrive DURING a sync still record here
  // (not indexingFiles), so the NEXT sync round absorbs them.
  const now = st.clock.now();
  const existing = st.pendingFiles.get(normalized);
  if (existing) {
    existing.lastSeenMs = now;
  } else {
    st.pendingFiles.set(normalized, { firstSeenMs: now, lastSeenMs: now });
  }

  logDebug('File change detected', { file: normalized });
  st.hasChanges = true;
  scheduleFn();
}

/**
 * FileWatcher monitors a project directory for changes and triggers
 * debounced sync operations via a provided callback.
 *
 * Design goals:
 * - Minimal resource usage (native OS file events, no polling)
 * - Debounced to avoid thrashing on rapid saves
 * - Filters against Cartograph include/exclude patterns
 * - Ignores .cartograph/ directory changes
 */
interface FileWatcherArgs {
  projectRoot: string;
  config: CartographConfig;
  syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  options?: WatchOptions;
}

/** Args for {@link FileWatcher.beginParcelSubscribe} — the canonical
 *  realpath-resolved root, the captured state reference, and the event
 *  context, bundled so the helper stays single-param. */
interface BeginParcelSubscribeArgs {
  /** Canonical (realpath-resolved) project root passed to parcel. */
  watchRoot: string;
  /** Captured state so a later `start()` replacing `this.st` doesn't shadow it. */
  stRef: WatcherState;
  /** Event context handed to `watcherHandleFileEvent` per parcel event. */
  watchCtx: WatchEventCtx;
}

export class FileWatcher {
  /** All mutable runtime state in one slot — helpers read/write via this. */
  private st: WatcherState;

  private readonly projectRoot: string;
  private readonly config: CartographConfig;
  private readonly debounceMs: number;
  private readonly safetyNetIntervalMs: number;
  private readonly syncFn: () => Promise<{ filesChanged: number; durationMs: number }>;
  private readonly onSyncComplete?: WatchOptions['onSyncComplete'];
  private readonly onSyncError?: WatchOptions['onSyncError'];
  private readonly clock: Clock;

  constructor(args: FileWatcherArgs) {
    const { projectRoot, config, syncFn, options = {} } = args;
    this.projectRoot = projectRoot;
    this.config = config;
    this.syncFn = syncFn;
    this.debounceMs = options.debounceMs ?? 2000;
    this.safetyNetIntervalMs = options.safetyNetIntervalMs ?? 300_000;
    this.onSyncComplete = options.onSyncComplete;
    this.onSyncError = options.onSyncError;
    this.clock = options.clock ?? realClock;
    this.st = watcherMakeState({
      syncFn,
      debounceMs: this.debounceMs,
      onSyncComplete: this.onSyncComplete,
      onSyncError: this.onSyncError,
      clock: this.clock,
    });
  }

  /**
   * Start watching for file changes.
   *
   * Returns `true` when a new watch session is started (the subscribe
   * attempt has been initiated), `false` when already watching (no-op) —
   * the actual `@parcel/watcher.subscribe()` resolves asynchronously
   * (typically <10ms after this call returns) and the resulting
   * subscription handle is stashed onto state once ready. The sync
   * return value preserves the pre-G8 API contract so existing
   * callers (`CartographWatcher` facade, MCP startup) don't have to
   * become async.
   *
   * `isActive()` reads `true` from the moment this call returns until
   * `stop()`, regardless of whether the underlying subscribe has
   * actually opened — losing an event in the open-window is a
   * theoretical race that the safety-net periodic sync covers, and
   * any test that depends on observing an event pairs `start()` with
   * `await watcher.untilReady()` (F#67) to deterministically wait for
   * the kernel handle to open before producing events.
   */
  start(): boolean {
    if (this.st.subscription || this.st.subscribing) return false; // Already watching / opening — no new session started
    this.st = watcherMakeState({
      syncFn: this.syncFn,
      debounceMs: this.debounceMs,
      onSyncComplete: this.onSyncComplete,
      onSyncError: this.onSyncError,
      clock: this.clock,
    });
    this.st.subscribing = true;

    const watchRoot = this.resolveWatchRoot();
    const stRef = this.st; // capture so a later start() that replaces this.st doesn't shadow
    const scheduleFn = () => watcherScheduleSync(stRef, () => watcherFlush(stRef));
    const watchCtx: WatchEventCtx = {
      st: stRef,
      config: this.config,
      projectRoot: watchRoot,
      scheduleFn,
    };

    this.beginParcelSubscribe({ watchRoot, stRef, watchCtx });

    watcherStartSafetyNet(this.st, this.safetyNetIntervalMs);
    return true;
  }

  /**
   * Resolve the project root to its canonical path BEFORE handing it
   * to `@parcel/watcher`. Parcel reports event paths under the
   * OS-canonical form (e.g. macOS prefixes `/var/folders/...` with
   * `/private/...` because `/var` is a symlink to `/private/var`).
   * Without this resolution `path.relative(projectRoot, eventPath)`
   * would walk up the directory tree out of the project (the relative
   * would start with `..`), the `rel.startsWith('..')` safety guard in
   * `watcherHandleFileEvent` would fire, and EVERY event would be
   * silently filtered out. Caught during G8 bring-up by
   * `bun __tests__/watcher.test.ts` (9 timeout fails).
   *
   * On a realpath miss, falls through with the original root —
   * `parcelSubscribe` will surface a real ENOENT; a transient realpath
   * miss shouldn't deny startup.
   */
  private resolveWatchRoot(): string {
    try {
      return fs.realpathSync(this.projectRoot);
    } catch (realpathErr) {
      logDebug('realpath on projectRoot failed; using as-is', { error: String(realpathErr) });
      return this.projectRoot;
    }
  }

  /**
   * Fire-and-forget the async parcel subscribe. On success, store the
   * subscription handle; on error, route through `onSyncError` and
   * mark stopped so `isActive()` trips to false and the user can
   * re-try via a fresh `start()`. Rejection vs the `subscribe`
   * callback `err` are two different channels — both are handled.
   */
  private beginParcelSubscribe(args: BeginParcelSubscribeArgs): void {
    const { watchRoot, stRef, watchCtx } = args;

    // F#59 — Pre-exclude default-ignored dirs from the OS watcher's
    // recursive walk. `@parcel/watcher`'s `ignore` option drops dirs
    // BEFORE registering a kernel watch on them; on Linux this stops
    // huge `node_modules/` / `vendor/` / build trees from chewing
    // through the per-user inotify watch budget. Pre-F#59 the watcher
    // registered every directory then filtered events in-callback,
    // which fired the watch-allocation regardless. macOS FSEvents
    // watches the whole tree at kernel level anyway, so the local
    // perf delta is zero — but the inotify case is real for Linux
    // production users with sprawling `node_modules`.
    //
    // Source-of-truth is `this.config.exclude`, the same glob list
    // the indexer's `shouldIncludeFile` consults — watcher scope can
    // never diverge from index scope by construction. Negation entries
    // (`!vendor/`) are filtered out because parcel-watcher's `ignore`
    // is a flat exclusion array with no opt-back-in semantics; the
    // resolver layer already handles negations downstream.
    const ignoreGlobs = this.config.exclude.filter((p) => !p.startsWith('!'));

    parcelSubscribe(
      watchRoot,
      (err, events) => {
        if (err) {
          logWarn('File watcher event error', { error: String(err) });
          this.onSyncError?.(toError(err));
          return;
        }
        // Parcel batches; events: Array<{type: 'create'|'update'|'delete', path: string}>.
        // We don't need to differentiate kinds here — any touch on a
        // tracked file should debounce a sync; sync itself reconciles
        // adds / modifies / deletes from disk reality.
        for (const e of events) {
          watcherHandleFileEvent(watchCtx, e.path);
        }
      },
      { ignore: ignoreGlobs },
    )
      .then((sub) => {
        if (stRef.stopped) {
          // stop() raced ahead of subscribe resolving — tear down the
          // freshly-opened subscription immediately. Fire-and-forget;
          // unsubscribe is safe to do asynchronously.
          void sub.unsubscribe().catch((cleanupErr) => {
            logDebug('parcel-watcher cleanup-after-stop unsubscribe failed', { error: String(cleanupErr) });
          });
          return;
        }
        stRef.subscription = sub;
        stRef.subscribing = false;
        logDebug('File watcher started', {
          projectRoot: this.projectRoot,
          debounceMs: this.debounceMs,
          safetyNetIntervalMs: this.safetyNetIntervalMs,
        });
      })
      .catch((subErr: unknown) => {
        // The async subscribe call rejected (bad permissions, ENOENT
        // on the root path, FD exhaustion, missing prebuilt native
        // binary for this platform). Surface and disable.
        logWarn('Could not start file watcher', { error: String(subErr) });
        stRef.subscribing = false;
        stRef.stopped = true;
        this.onSyncError?.(toError(subErr));
      });
  }

  /**
   * Stop watching for file changes.
   *
   * The actual `subscription.unsubscribe()` is async; we mark the
   * watcher stopped and fire-and-forget the unsubscribe to keep the
   * existing sync-return API. If an in-flight subscribe is still
   * resolving, the `start()`'s `.then` handler also checks
   * `stopped` and unsubscribes immediately to avoid leaks.
   */
  stop(): void {
    this.st.stopped = true;
    this.st.subscribing = false;

    if (this.st.debounceTimer) {
      this.st.debounceTimer.cancel();
      this.st.debounceTimer = null;
    }

    if (this.st.safetyNetTimer) {
      this.st.safetyNetTimer.cancel();
      this.st.safetyNetTimer = null;
    }

    if (this.st.subscription) {
      const sub = this.st.subscription;
      this.st.subscription = null;
      void sub.unsubscribe().catch((err) => {
        logDebug('parcel-watcher unsubscribe failed', { error: String(err) });
      });
    }

    this.st.hasChanges = false;
    logDebug('File watcher stopped');
  }

  /**
   * Whether the watcher is currently active. Returns `true` while
   * the parcel subscribe is in flight as well as after it resolves —
   * any callable code that observed the synchronous `start()` return
   * already treats the watcher as live.
   */
  isActive(): boolean {
    return !this.st.stopped && (this.st.subscription !== null || this.st.subscribing);
  }

  /**
   * Resolve once `@parcel/watcher.subscribe()` has actually opened the
   * underlying kernel handle (FSEvents on macOS, inotify on Linux) —
   * `start()` returns synchronously the moment the subscribe attempt
   * is kicked off, but events can't possibly arrive until the
   * subscribe Promise resolves and stashes the subscription handle.
   *
   * Polls `this.st.subscription !== null` and `!this.st.subscribing`
   * with a tight cadence so tests don't need a fixed `await
   * letWatcherSettle()` band-aid. The 400ms guess was brittle on
   * slow systems and wasteful on fast ones; this resolves the moment
   * the underlying truth (subscription handle present) is observed.
   *
   * After this resolves, kernel-level event-delivery may still take
   * a few ms to warm up — that's hardware, not addressable in JS.
   * For tests that need to GUARANTEE an event arrives, pair this
   * with `_injectFileEventForTest()` instead of relying on real
   * FSEvents delivery.
   *
   * Silent-return on subscribe failure: if `parcelSubscribe` rejects
   * (`.catch` block in `start()` sets `stopped = true`), this resolves
   * without throwing. The same state holds if `stop()` is called
   * concurrently mid-poll, so `isActive()` after the await can't
   * distinguish those two paths — but it does confirm the watcher is
   * NOT live, which is what callers need to know. The `onSyncError`
   * channel surfaces the underlying subscribe-failure reason.
   *
   * NOT virtualizable. The F#69 (2026-05-28) `Clock` abstraction
   * covers every timer/timestamp inside the watcher's debounce /
   * safety-net / stats pipeline. `untilReady` deliberately stays on
   * real wall-clock because it polls for a REAL OS kernel-handle
   * being opened by `@parcel/watcher.subscribe`. A virtual clock
   * couldn't make a real subscribe finish faster. Tests that don't
   * need real parcel-watcher should skip `start()` + `untilReady()`
   * entirely and inject directly via `_injectFileEventForTest`;
   * tests that DO need parcel must accept this small real-time wait.
   */
  async untilReady(timeoutMs = 5000): Promise<void> {
    const start = Date.now();
    while (!this.st.stopped) {
      if (this.st.subscription !== null && !this.st.subscribing) return;
      if (Date.now() - start > timeoutMs) {
        throw new Error(`FileWatcher.untilReady timed out after ${timeoutMs}ms`);
      }
      await new Promise((r) => setTimeout(r, 25));
    }
    // If stopped while waiting, just return — caller will see
    // `isActive() === false` and handle accordingly.
  }

  /** Snapshot of sync activity since the last `start()`. Useful when
   *  diagnosing "did the watcher actually pick this up?" — a fresh
   *  `lastSyncAt` confirms recent activity, a non-zero
   *  `consecutiveFailures` confirms an ongoing problem. */
  getStats(): WatcherStats {
    return {
      syncCount: this.st.syncCount,
      failureCount: this.st.failureCount,
      lastSyncAt: this.st.lastSyncAt,
      lastErrorAt: this.st.lastErrorAt,
      consecutiveFailures: this.st.consecutiveFailures,
    };
  }

  /**
   * Test-only deterministic event injection — drives the watcher's
   * event handler directly, bypassing `@parcel/watcher` entirely.
   * Production code path is unchanged; this exists purely so the F#60
   * staleness-banner tests don't have to gamble on macOS FSEvents
   * delivery timing under parallel-shard contention (task #14 —
   * 8-way `npm run test:fast` could starve the FSEvents thread so
   * the watcher subscription opened but never received events,
   * blowing past even 6+ second `waitFor` budgets).
   *
   * Treats `absPath` exactly like a parcel-delivered event:
   *   - must be an absolute path inside the watcher's `projectRoot`,
   *   - flows through the same `path.relative` + `shouldIncludeFile`
   *     filters, and
   *   - on acceptance, lands in `pendingFiles` AND schedules the
   *     debounced sync via the same timer code real events use.
   *
   * Tests that previously called `start({debounceMs}) → fs.writeFile
   * → waitFor(pendingFiles contains X)` can now do
   * `start({debounceMs}) → fs.writeFile → _injectFileEventForTest(X)`
   * and skip the FSEvents-arrival waitFor entirely. The downstream
   * debounce + sync still runs through real timers, which are
   * reliable; only the OS-level event delivery is replaced.
   *
   * @internal Underscore prefix marks this as a test-only seam — not
   *           a stable API. Production callers must not reach for it.
   */
  _injectFileEventForTest(absPath: string): void {
    if (this.st.stopped) return;
    // Re-resolve watchRoot per call so this works whether or not
    // `start()` was invoked (some tests inject without subscribing).
    let watchRoot = this.projectRoot;
    try {
      watchRoot = fs.realpathSync(this.projectRoot);
    } catch {
      // Use the unresolved root — same fallback as start().
    }
    const stRef = this.st;
    const watchCtx: WatchEventCtx = {
      st: stRef,
      config: this.config,
      projectRoot: watchRoot,
      scheduleFn: () => watcherScheduleSync(stRef, () => watcherFlush(stRef)),
    };
    watcherHandleFileEvent(watchCtx, absPath);
  }

  /**
   * F#60 — Snapshot of files the watcher has seen events for since the
   * last successful sync. The MCP tool dispatcher intersects this with
   * the files a tool's response references and prepends a banner so
   * the agent knows which specific paths to Read directly without
   * waiting for the debounced sync to fire.
   *
   * `pending` = file is in the debounce window, no sync committed to
   * it yet. `indexing` = a sync is currently in flight that committed
   * to absorbing this file's edits; the staleness window ends when
   * that sync succeeds.
   */
  getPendingFiles(): PendingFile[] {
    const result: PendingFile[] = [];
    for (const [path, entry] of this.st.pendingFiles) {
      result.push({ path, firstSeenMs: entry.firstSeenMs, lastSeenMs: entry.lastSeenMs, indexing: false });
    }
    for (const [path, entry] of this.st.indexingFiles) {
      // Edge: a file could appear in BOTH maps (event arrived mid-sync
      // for a file the sync was already processing). Prefer the
      // `indexing` entry since the in-flight sync is the canonical
      // source of "what's being absorbed now."
      if (this.st.pendingFiles.has(path)) continue;
      result.push({ path, firstSeenMs: entry.firstSeenMs, lastSeenMs: entry.lastSeenMs, indexing: true });
    }
    return result;
  }
}
