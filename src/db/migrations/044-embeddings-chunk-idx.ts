import type { MigrationModule } from './types.js';

/**
 * Multi-vector retrieval — Stage 5 #C of the embedding-features arc.
 *
 * Adds `chunk_idx INTEGER NOT NULL DEFAULT 0` to symbol_embeddings.
 * Existing single-vector rows live at chunk_idx=0; future chunked
 * embeddings (one row per body chunk) get chunk_idx >= 1.
 *
 * SQLite can't `ALTER TABLE` a primary key, so we keep `node_id` as
 * the PK and rely on application-level discipline: chunked rows
 * SHOULD be persisted to a sibling table (`symbol_chunk_embeddings`,
 * forthcoming migration) rather than coexisting under the same
 * node_id with different chunk_idx values. The chunk_idx column on
 * `symbol_embeddings` is forward-compat metadata for the canonical
 * per-symbol row (always 0).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add chunk_idx column to symbol_embeddings for multi-vector forward-compat',
  up: (db) => {
    // Post-migration-050 symbol_embeddings is a VIEW; ALTER fails.
    // chunk_idx is exposed by the VIEW as a literal `0` column (see
    // migration 050) — sufficient for the canonical-row use case
    // this column documented. Real chunked rows live in
    // symbol_chunk_embeddings (migration 046).
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if (existing && existing.type === 'view') return;
    const hasChunkIdx =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('symbol_embeddings') WHERE name='chunk_idx'`).get() as {
          c: number;
        }
      ).c > 0;
    if (hasChunkIdx) return;

    db.exec(`ALTER TABLE symbol_embeddings ADD COLUMN chunk_idx INTEGER NOT NULL DEFAULT 0`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_chunk ON symbol_embeddings(chunk_idx)`);
  },
};
