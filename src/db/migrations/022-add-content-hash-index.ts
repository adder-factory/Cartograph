import type { MigrationModule } from './types.js';

/**
 * Add the (content_hash, model) index on symbol_summaries so the
 * content-hash fallback lookup in summarizer.ts is fast.
 *
 * Why a content-hash fallback exists: `clearStructural()` (called by
 * --force re-index) toggles foreign_keys OFF around the deletes so
 * symbol_summaries rows survive even though `symbol_summaries.node_id
 * REFERENCES nodes(id) ON DELETE CASCADE` would normally cascade them
 * away. After re-index, surviving rows whose node_id no longer exists
 * are still useful — the summarizer can look them up by content_hash
 * and copy the cached summary onto the freshly-minted node_id row,
 * skipping the LLM call.
 *
 * The CASCADE itself is preserved because incremental sync (single-
 * symbol delete, file-level delete) genuinely wants the summary
 * cleaned up — only the bulk structural-only clear path needs the
 * FK suppressed, and that's done at the SQL/PRAGMA level rather
 * than the schema level.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add (content_hash, model) index on symbol_summaries for fallback lookup',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_summaries'").get();
    if (!tableExists) return;
    db.exec('CREATE INDEX IF NOT EXISTS idx_summaries_content_hash ON symbol_summaries(content_hash, model)');
  },
};
