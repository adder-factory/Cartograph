/**
 * VirtualClock — F#69 (2026-05-28) deterministic time substitute for
 * `FileWatcher` logic tests. Implements the `Clock` interface
 * declared in `src/sync/watcher.ts`.
 *
 * Why it exists: real `setTimeout` / `setInterval` / `Date.now` make
 * watcher debounce/safety-net tests wall-clock-dependent, which
 * means they fail when macOS demotes the bun:test process under
 * load (F#67/F#68 root cause — the same JS timer doesn't fire for
 * 5-30s under contention). Tests that drive time through this
 * clock instead of `await waitFor(...)` are immune: `clock.advance(ms)`
 * fires all due timers synchronously and the test asserts post-tick
 * state with no wall-clock dependency.
 *
 * Usage shape:
 *
 *   const clock = new VirtualClock();
 *   const watcher = new FileWatcher({ ..., options: { ..., clock } });
 *   watcher.start();
 *   await watcher.untilReady();        // parcel.subscribe is still
 *                                       // real-time (~10ms); tests
 *                                       // that don't need real events
 *                                       // can skip start() + untilReady.
 *   watcher._injectFileEventForTest(somePath);
 *   await tick(clock, 200);            // advance + flush microtasks
 *   expect(syncFn).toHaveBeenCalled();
 *
 * Sequential timer firings are honored: if two callbacks are due at
 * different virtual times within a single `advance()` call, the
 * earlier one fires first AND can synchronously schedule new timers
 * that fire later in the same `advance()` window. This matches what
 * a real event loop would do under load.
 */
import type { Clock, IntervalHandle, TimeoutHandle } from '../../src/sync/watcher.js';

interface ScheduledEntry {
  /** Virtual ms at which this should fire (or fired-and-rescheduled-to). */
  at: number;
  fn: () => void;
  /** Null for one-shot; the repeat interval for setInterval. */
  intervalMs: number | null;
  cancelled: boolean;
}

export class VirtualClock implements Clock {
  private currentMs = 0;
  private pending: ScheduledEntry[] = [];

  now(): number {
    return this.currentMs;
  }

  setTimeout(fn: () => void, ms: number): TimeoutHandle {
    const entry: ScheduledEntry = {
      at: this.currentMs + ms,
      fn,
      intervalMs: null,
      cancelled: false,
    };
    this.pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
    };
  }

  setInterval(fn: () => void, ms: number): IntervalHandle {
    // Guard against the trivial infinite-loop: a zero-or-negative
    // interval would never advance `at` past `target` inside
    // `advance()`, hanging the test runner. Real `setInterval(fn, 0)`
    // is also problematic in practice (event-loop saturation), so
    // failing loud here is strictly better than mirroring it.
    if (ms <= 0) {
      throw new Error(`VirtualClock.setInterval requires ms > 0 (got ${ms})`);
    }
    const entry: ScheduledEntry = {
      at: this.currentMs + ms,
      fn,
      intervalMs: ms,
      cancelled: false,
    };
    this.pending.push(entry);
    return {
      cancel: () => {
        entry.cancelled = true;
      },
      // No-op on virtual: there's no libuv timer to unref.
      unref: () => {},
    };
  }

  /**
   * Advance virtual time by `ms`. All timers due within the new
   * window fire in chronological order, each one able to schedule
   * fresh timers that may also fire before `advance()` returns.
   * Interval timers reschedule themselves until they fall outside
   * the window or get cancelled.
   *
   * This call is purely synchronous — async work inside the timer
   * callbacks (e.g. `await syncFn()`) needs a microtask flush AFTER
   * `advance()` returns. Use the `tick()` helper below for that.
   */
  advance(ms: number): void {
    const target = this.currentMs + ms;
    // Loop until no more due entries remain in the window.
    while (true) {
      let earliest: ScheduledEntry | null = null;
      for (const e of this.pending) {
        if (e.cancelled || e.at > target) continue;
        if (earliest === null || e.at < earliest.at) earliest = e;
      }
      if (earliest === null) break;
      this.currentMs = earliest.at;
      // Eagerly reschedule intervals BEFORE firing so a same-tick
      // cancel inside the callback can override.
      if (earliest.intervalMs !== null) {
        earliest.at = earliest.at + earliest.intervalMs;
      } else {
        earliest.cancelled = true;
      }
      earliest.fn();
    }
    this.currentMs = target;
  }

  /** Test-only: drop any cancelled entries so a heavy/long-running
   *  suite doesn't accumulate. Optional; tests typically don't need it. */
  gc(): void {
    this.pending = this.pending.filter((e) => !e.cancelled);
  }

  /** Test-only inspection: how many non-cancelled timers are armed. */
  pendingCount(): number {
    return this.pending.filter((e) => !e.cancelled).length;
  }
}

/**
 * Advance the virtual clock by `ms` and flush microtasks so the
 * watcher's `await syncFn()` (and any chained `.then()`s in
 * `watcherFlush`) can land before the test asserts post-state.
 *
 * Three microtask flushes covers the current `watcherFlush` chain
 * exactly:
 *   1. `await st.syncFn()` resolves the mock promise.
 *   2. The `finally` block runs (`st.syncing = false` + reschedule
 *      if `hasChanges` accumulated during the sync).
 *   3. Headroom for the `onSyncComplete?.()` callback's microtask
 *      and any test-side `.then()` chains.
 *
 * If a future refactor adds an intermediate `await` to that chain
 * (e.g. a lock-check before `syncFn` or an async cleanup step), bump
 * this; conversely if the chain shrinks the extra ticks are no-ops.
 * A `tick` that returns too eagerly silently breaks tests — surface
 * a depth change in code review.
 */
export async function tick(clock: VirtualClock, ms: number): Promise<void> {
  clock.advance(ms);
  await Promise.resolve(); // (1) syncFn resolution
  await Promise.resolve(); // (2) finally block + reschedule
  await Promise.resolve(); // (3) callback + headroom
}
