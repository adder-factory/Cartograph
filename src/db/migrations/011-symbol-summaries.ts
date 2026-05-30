import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add symbol_summaries table for LLM-generated one-line descriptions',
  up: (db) => {
    // Post-migration-049 (Design C), `symbol_summaries` exists as a
    // VIEW instead of a TABLE. CREATE INDEX on a view errors with
    // "views may not be indexed", so check the type and skip both
    // statements when the view shape is already in place — the test
    // harness replays migrations from various baselines (edges-unique
    // test backdates to v3 then forward-migrates) and would otherwise
    // hit this on the replay.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_summaries'").get() as
      | { type: string }
      | undefined;
    if (existing && existing.type === 'view') return;
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_summaries (
        node_id TEXT PRIMARY KEY,
        content_hash TEXT NOT NULL,
        summary TEXT NOT NULL,
        model TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_summaries_model ON symbol_summaries(model);
    `);
  },
};
