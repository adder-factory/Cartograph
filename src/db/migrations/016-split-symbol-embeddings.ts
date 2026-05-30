import type { MigrationModule } from './types.js';

/**
 * Split symbol embeddings out of `symbol_summaries` into a dedicated
 * `symbol_embeddings` table.
 *
 * Why: every common-path query against `symbol_summaries` (FTS-anchor
 * lookups, role filters, content-hash freshness checks) was paying
 * to skip past a 768-dim Float32 BLOB on the same page chain, even
 * though almost no query needs the embedding bytes. Spike measurement
 * on a 50K-summary synthetic DB showed a 3.34× slowdown on summary-
 * only scans for the inline layout vs. a separate table, with only
 * an ~11% penalty on the rare summary+embedding scan path.
 *
 * The split moves embeddings to their own page chain, leaving
 * `symbol_summaries` row pages dense with the small text/metadata
 * fields that matter for the hot read paths.
 *
 * See `scripts/spikes/spike-embedding-split.mjs` for the reproducer.
 *
 * Migration shape:
 *   1. Create `symbol_embeddings` (node_id PK, embedding BLOB,
 *      embedding_model TEXT).
 *   2. Copy existing rows (`embedding IS NOT NULL`) over.
 *   3. Drop the now-orphaned columns + their index from
 *      `symbol_summaries`.
 *
 * Requires SQLite 3.35+ for `ALTER TABLE DROP COLUMN`. Cartograph's
 * native (better-sqlite3) and WASM (node-sqlite3-wasm) backends both
 * ship with newer versions, so this is safe.
 */
export const MIGRATION: MigrationModule = {
  description: 'Split symbol embeddings into dedicated symbol_embeddings table',
  up: (db) => {
    // Post-migration-049 / 050 (Design C) both symbol_summaries and
    // symbol_embeddings are VIEWs. On the forward-replay scenario this
    // migration is dead work — the new schema's tables already exist
    // (embedding_store, summary_store). Skip entirely.
    const summariesEntity = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_summaries'").get() as
      | { type: string }
      | undefined;
    const embeddingsEntity = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if (
      (summariesEntity && summariesEntity.type === 'view') ||
      (embeddingsEntity && embeddingsEntity.type === 'view')
    ) {
      return;
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_embeddings (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        embedding_model TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES symbol_summaries(node_id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON symbol_embeddings(embedding_model);

      INSERT OR IGNORE INTO symbol_embeddings (node_id, embedding, embedding_model)
        SELECT node_id, embedding, embedding_model
        FROM symbol_summaries
        WHERE embedding IS NOT NULL AND embedding_model IS NOT NULL;

      DROP INDEX IF EXISTS idx_summaries_embedding_model;
      ALTER TABLE symbol_summaries DROP COLUMN embedding;
      ALTER TABLE symbol_summaries DROP COLUMN embedding_model;
    `);
  },
};
