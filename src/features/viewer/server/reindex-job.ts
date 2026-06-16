/**
 * Single-flight guard for the viewer's in-process re-index job.
 *
 * The indexer already takes a cross-process file lock, but this gives a
 * fast in-process answer: at most one `/api/reindex` runs per viewer
 * process (a second concurrent request gets a 409 instead of contending
 * on the lock), and `/api/status` can surface a `reindexing` flag so a
 * second browser tab / agent sees a pass is already underway.
 */
let active = false;

export function isReindexInProgress(): boolean {
  return active;
}

/** Returns false if a job is already running (caller should answer 409). */
export function tryBeginReindexJob(): boolean {
  if (active) return false;
  active = true;
  return true;
}

export function endReindexJob(): void {
  active = false;
}
