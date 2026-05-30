import type { MigrationModule } from './types.js';

/**
 * Stage 5 C.2 — sibling table for multi-vector chunk embeddings.
 *
 * Long symbols (>= 500 LOC) are split into overlapping ~200-LOC chunks
 * for higher-fidelity retrieval. Each chunk gets its own embedding row
 * here; the canonical per-symbol embedding stays in `symbol_embeddings`
 * at chunk_idx=0 (migration 044). The compound PK (node_id, chunk_idx)
 * lets the retrieval layer query all chunks for a symbol in one scan
 * and apply max-sim grouping without modifying the live `symbol_embeddings`
 * table structure.
 *
 * chunk_idx starts at 1 — chunk_idx=0 is reserved for the canonical
 * single-vector row in `symbol_embeddings`.
 *
 * FK ON DELETE CASCADE keeps the table tidy: when a node is pruned
 * (file deleted, forced reindex) its chunk rows go with it.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add symbol_chunk_embeddings table for multi-vector chunk retrieval (Stage 5 C.2)',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_chunk_embeddings (
        node_id               TEXT    NOT NULL,
        chunk_idx             INTEGER NOT NULL,
        embedding             BLOB    NOT NULL,
        embedding_model       TEXT    NOT NULL,
        start_line            INTEGER NOT NULL,
        end_line              INTEGER NOT NULL,
        summary_hash_at_embed TEXT    NOT NULL DEFAULT '',
        PRIMARY KEY (node_id, chunk_idx),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      )
    `);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model ON symbol_chunk_embeddings(embedding_model)`);
  },
};
