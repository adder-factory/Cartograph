import type { MigrationModule } from './types.js';

/**
 * Persisted "this symbol's prompt is too large for the chat backend's
 * per-slot context" markers (issue #27, reactive half).
 *
 * When a summary attempt fails with an HTTP 400 context-window error
 * (the prompt exceeds `-c ÷ --parallel`), re-attempting the SAME body
 * every pass is futile — it deterministically re-fails, burns an LLM
 * call each time, and leaves the symbol stuck in the `N pending` count
 * forever. The summariser records a skip here instead; the
 * candidate/pending queries then exclude it (so it stops looping and
 * stops inflating "pending"), and status reports it as a distinct
 * "skipped — too large" bucket.
 *
 * Keyed by `node_id` (one marker per symbol) and stamped with the
 * `body_hash` it failed on, so a body change (new hash) re-qualifies the
 * symbol as a candidate automatically. `cartograph admin summarize --all`
 * clears the table to retry everything (e.g. after raising the backend's
 * `-c`, per the `doctor` warning). Cascade-deleted with the parent node.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add summary_skips table — persist context-too-large summary failures (issue #27)',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_skips (
          node_id TEXT PRIMARY KEY,
          body_hash TEXT NOT NULL,
          reason TEXT NOT NULL,
          recorded_at INTEGER NOT NULL,
          FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID
    `);
  },
};
