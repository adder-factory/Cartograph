/**
 * Sync Module
 *
 * Provides synchronization functionality for keeping the code graph
 * up-to-date with file system changes.
 *
 * Components:
 * - FileWatcher: Debounced `@parcel/watcher` subscription that auto-
 *   triggers sync on file changes (was `fs.watch` pre-G8 — see
 *   `src/sync/watcher.ts` header for the swap rationale).
 * - Content hashing for change detection (in extraction module)
 * - Incremental reindexing (in extraction module)
 */

export { FileWatcher } from './watcher.js';
export type { WatchOptions, WatcherStats, PendingFile } from './watcher.js';
