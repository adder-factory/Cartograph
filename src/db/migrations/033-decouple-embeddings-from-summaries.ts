import type { MigrationModule } from './types.js';

/**
 * Decouple `symbol_embeddings` from `symbol_summaries`.
 *
 * Before this migration the FK was:
 *
 *   symbol_embeddings.node_id → symbol_summaries.node_id ON DELETE CASCADE
 *
 * That meant embeddings could only exist for symbols that had an
 * LLM-generated summary — roughly 19% of nodes in practice. The
 * embedding pipeline therefore covered only the summarised minority,
 * capping `cartograph_search(mode='semantic')` recall at 19%.
 *
 * After this migration the FK targets `nodes(id)` directly:
 *
 *   symbol_embeddings.node_id → nodes.id ON DELETE CASCADE
 *
 * Embeddings are now generated from `name + signature + docstring`
 * (no summary required), with the summary used as an optional richer
 * source when one is available. Coverage moves from ~19% → ~100% of
 * indexed symbols (excluding file/import/export container nodes).
 *
 * SQLite cannot `ALTER TABLE DROP CONSTRAINT`, so the standard
 * table-rebuild dance is used. The migration sets
 * `requiresFkDisable: true` so the runner issues `PRAGMA
 * foreign_keys = OFF` outside the transaction (per-migration
 * PRAGMA inside `up()` is a no-op while a transaction is active).
 *
 * The PRAGMA is defensive: every existing `symbol_embeddings.node_id`
 * was guaranteed by the OLD FK to be in `symbol_summaries`, which
 * was itself in `nodes` (CASCADE chain), so every existing row
 * already satisfies the NEW FK to `nodes(id)` and the rebuild would
 * succeed even with FKs enabled. Disabling them keeps the migration
 * robust against future additions of incoming FK constraints to
 * `symbol_embeddings`.
 *
 * The vec0 mirror tables (`vec_symbol_embeddings_<dim>`) are keyed by
 * `symbol_embeddings.rowid`. After the table-swap the rowids are
 * preserved (INSERT INTO … SELECT * preserves rowid order in SQLite),
 * but we DELETE + let the bootstrapper backfill on the next open to be
 * safe — the data volume is small and correctness beats a fiddly
 * rowid preservation proof.
 */
export const MIGRATION: MigrationModule = {
  description: 'Retarget symbol_embeddings FK from symbol_summaries to nodes — enables embedding every node',
  requiresFkDisable: true,
  up: (db) => {
    // Post-migration-050 (Design C) symbol_embeddings is a VIEW. The
    // CREATE TABLE / DROP TABLE / RENAME dance fails against the view.
    // Skip on the forward-replay scenario — Design C's tables (embedding_store,
    // embedding_refs) already exist and superseded this migration's outcome.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if (existing?.type === 'view') return;

    // --- 1. Rebuild symbol_embeddings with FK to nodes(id) --------
    db.exec(`
      CREATE TABLE IF NOT EXISTS symbol_embeddings_new (
        node_id TEXT PRIMARY KEY,
        embedding BLOB NOT NULL,
        embedding_model TEXT NOT NULL,
        source_content_hash TEXT NOT NULL DEFAULT '',
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
    `);

    // Copy all existing rows. Every node_id is FK-guaranteed (per the
    // structural argument in the file-level docstring) to satisfy the
    // new FK to nodes(id). INSERT OR IGNORE so a partial backfill on a
    // crashed-then-rerun migration doesn't throw.
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'").get();

    if (tableExists) {
      db.exec(`
        INSERT OR IGNORE INTO symbol_embeddings_new
          SELECT node_id, embedding, embedding_model, source_content_hash
            FROM symbol_embeddings;

        DROP TABLE symbol_embeddings;
      `);
    }

    db.exec(`
      ALTER TABLE symbol_embeddings_new RENAME TO symbol_embeddings;
      CREATE INDEX IF NOT EXISTS idx_embeddings_model ON symbol_embeddings(embedding_model);
    `);

    // --- 2. Clear vec0 mirror tables so the bootstrapper can ---
    // backfill cleanly on next DatabaseConnection.initialize().
    // vec0 tables have no FK so they don't cascade automatically.
    const vecTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_symbol_embeddings_%'")
      .all() as Array<{ name: string }>;

    for (const { name } of vecTables) {
      // Whitelist by exact prefix + numeric suffix.
      if (!/^vec_symbol_embeddings_\d+$/.test(name)) continue;
      try {
        db.exec(`DELETE FROM ${name}`);
      } catch {
        // Best-effort — vec0 extension may not be loaded in this session.
      }
    }
  },
};
