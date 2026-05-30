/**
 * Watcher facade — owns the FileWatcher lifecycle and the auto-sync
 * thunk. Extracted from `Cartograph` so the public-API class no longer
 * carries the watcher field or the 3 wrapper methods. Constructed
 * once in the Cartograph constructor and exposed as `cg.watcher`.
 */

import { FileWatcher, type WatchOptions, type WatcherStats, type PendingFile } from './sync/index.js';
import type { Cartograph } from './index.js';

export class CartographWatcher {
  private impl: FileWatcher | null = null;

  constructor(private readonly cg: Cartograph) {}

  /**
   * Start watching for file changes and auto-syncing.
   *
   * Uses native OS file events (FSEvents on macOS, inotify on Linux ≥20,
   * ReadDirectoryChangesW on Windows) with debouncing to avoid thrashing.
   * A periodic safety-net sync (default 5min) recovers from any events
   * the OS dropped under load.
   *
   * @returns true if watching started successfully
   */
  start(options: WatchOptions = {}): boolean {
    if (this.impl?.isActive()) return true;
    this.impl = new FileWatcher({
      projectRoot: this.cg.projectRoot,
      config: this.cg.config,
      syncFn: async () => {
        const result = await this.cg.sync();
        const filesChanged = result.filesAdded + result.filesModified + result.filesRemoved;
        return { filesChanged, durationMs: result.durationMs };
      },
      options,
    });
    return this.impl.start();
  }

  /** Stop watching for file changes. */
  stop(): void {
    if (this.impl) {
      this.impl.stop();
      this.impl = null;
    }
  }

  /** Check if the file watcher is active. */
  isActive(): boolean {
    return this.impl?.isActive() ?? false;
  }

  /**
   * Resolve once the underlying `@parcel/watcher.subscribe()` opens
   * its kernel handle — see `FileWatcher.untilReady` for the
   * detailed rationale. Throws when the watcher hasn't been started.
   * Used by F#67 watcher tests to replace fixed-delay
   * `letWatcherSettle()` band-aids with a real readiness signal.
   */
  async untilReady(timeoutMs = 5000): Promise<void> {
    if (!this.impl) throw new Error('CartographWatcher.untilReady called before start()');
    await this.impl.untilReady(timeoutMs);
  }

  /** Snapshot of sync activity since the last `start()`. Returns
   *  null when the watcher hasn't been started yet — distinguishes
   *  "no syncs ever" from "no syncs in this start session". */
  getStats(): WatcherStats | null {
    return this.impl?.getStats() ?? null;
  }

  /** F#60 — Snapshot of files the watcher has seen events for since
   *  the last successful sync. Returns `[]` when the watcher isn't
   *  running OR when there's nothing pending — the staleness banner
   *  path can call this unconditionally. */
  getPendingFiles(): PendingFile[] {
    return this.impl?.getPendingFiles() ?? [];
  }

  /**
   * Test-only deterministic event injection — bypasses real OS file
   * events to make F#60 watcher tests reliable under parallel-shard
   * contention (task #14, 2026-05-27). Delegates to the underlying
   * FileWatcher; no-ops when the watcher isn't running.
   *
   * @internal Underscore prefix marks the seam as test-only — see
   *           the `FileWatcher._injectFileEventForTest` JSDoc for
   *           the full rationale.
   */
  _injectFileEventForTest(absPath: string): void {
    this.impl?._injectFileEventForTest(absPath);
  }
}
