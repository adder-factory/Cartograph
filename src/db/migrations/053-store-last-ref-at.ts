import type { MigrationModule } from './types.js';

/**
 * Add `last_ref_at` to the content-addressed store tables so the
 * `admin prune-store` action (added in the same change set) can
 * evict orphan store rows that haven't been referenced in N days.
 *
 * Background. Migrations 049 (summaries) and 050 (embeddings)
 * intentionally keep store rows around even when no `*_refs` row
 * points at them — the rationale is "free reuse on revert / rename":
 * a body whose hash stays the same gets its prior summary or
 * embedding back without any LLM / local-model call. Costs are tiny
 * (sub-KB text + ~3 KB float32-768 vector per orphan), but on a
 * long-lived heavily-refactored codebase the orphan pool grows
 * without bound and there is no GC.
 *
 * `generated_at` alone isn't enough to gate eviction: a body
 * generated 100 days ago, orphaned 50 days ago, then revert-reused
 * 5 days ago, then orphaned again 1 day ago should NOT be evictable
 * — its 5-day-old reuse signal is what makes it a hot revert
 * candidate. Track that signal explicitly with `last_ref_at`,
 * bumped by triggers any time a `*_refs` row is inserted or
 * updated to point at the store row. Backfill from `generated_at`
 * (or current time when generated_at is the migration-050 default
 * of 0) so every existing row has a defensible starting age.
 *
 * The pruner itself lives at `pruneOrphanStoreRows` in
 * `src/db/queries-summaries.ts`; this migration only adds the
 * column + triggers + backfill it depends on.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add last_ref_at to summary_store + embedding_store with refresh triggers (prune-store)',
  up: (db) => {
    const summaryStoreExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='summary_store'")
      .get();
    const embeddingStoreExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_store'")
      .get();
    if (!summaryStoreExists || !embeddingStoreExists) return;

    // Column add — guarded by a PRAGMA check. Fresh DBs go through
    // schema.sql which already declares last_ref_at; for those, this
    // migration is a no-op on the column itself but still installs
    // the triggers + backfill (the trigger CREATE statements use
    // CREATE TRIGGER IF NOT EXISTS to stay idempotent in that case).
    const hasColumn = (table: string): boolean => {
      const cols = db.prepare(`PRAGMA table_info('${table}')`).all() as Array<{ name: string }>;
      return cols.some((c) => c.name === 'last_ref_at');
    };
    if (!hasColumn('summary_store')) {
      db.exec(`ALTER TABLE summary_store ADD COLUMN last_ref_at INTEGER NOT NULL DEFAULT 0;`);
    }
    if (!hasColumn('embedding_store')) {
      db.exec(`ALTER TABLE embedding_store ADD COLUMN last_ref_at INTEGER NOT NULL DEFAULT 0;`);
    }

    // Backfill. Use the existing generated_at when it's a real
    // (non-zero) timestamp; otherwise fall back to "now" so the
    // migration-050 rows whose generated_at defaulted to 0 don't
    // immediately read as decades-old to the pruner.
    const nowMs = Date.now();
    db.exec(`
      UPDATE summary_store
         SET last_ref_at = CASE
           WHEN generated_at > 0 THEN generated_at
           ELSE ${nowMs}
         END;
      UPDATE embedding_store
         SET last_ref_at = CASE
           WHEN generated_at > 0 THEN generated_at
           ELSE ${nowMs}
         END;
    `);

    // Refresh triggers. `INSERT ... ON CONFLICT(...) DO UPDATE` on a
    // ref table fires AFTER INSERT on the inserted-or-upserted row
    // for the insert branch and AFTER UPDATE on the conflict-update
    // branch. Cover both so revert/rename and first-time inserts
    // both bump last_ref_at on the parent store row. The triggers
    // are no-ops when no matching store row exists (e.g. when a ref
    // is being inserted before the store row, which the upsert path
    // never does — defensive).
    db.exec(`
      CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_ai
      AFTER INSERT ON summary_refs BEGIN
        UPDATE summary_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model;
      END;
      CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_au
      AFTER UPDATE ON summary_refs BEGIN
        UPDATE summary_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model;
      END;

      CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_ai
      AFTER INSERT ON embedding_refs BEGIN
        UPDATE embedding_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model
           AND grain = NEW.grain;
      END;
      CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_au
      AFTER UPDATE ON embedding_refs BEGIN
        UPDATE embedding_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model
           AND grain = NEW.grain;
      END;
    `);
  },
};
