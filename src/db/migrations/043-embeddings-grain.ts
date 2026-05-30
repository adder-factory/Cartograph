import type { MigrationModule } from './types.js';

/**
 * Multi-grain embeddings — Stage 2 of the embedding-features arc.
 *
 * Adds `grain TEXT NOT NULL DEFAULT 'symbol'` to `symbol_embeddings` so a
 * single table can carry per-symbol embeddings (existing) and per-file
 * aggregated embeddings (new). File-grain rows reuse the file's
 * `nodes.id` (kind='file') since `getEmbeddableNodes` already excludes
 * file kinds from per-symbol embedding — no PK collision.
 *
 * Future module-grain expansion that targets non-file nodes (e.g. a
 * class with both symbol-grain and module-grain rows) would require a
 * compound (node_id, grain) primary key, deferred until a concrete
 * caller needs it.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add grain column to symbol_embeddings (defaults to symbol)',
  up: (db) => {
    // Post-migration-050 symbol_embeddings is a VIEW; ALTER fails.
    // Design C carries grain on both embedding_store + embedding_refs.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if (existing && existing.type === 'view') return;
    const hasGrain =
      (
        db.prepare(`SELECT COUNT(*) AS c FROM pragma_table_info('symbol_embeddings') WHERE name='grain'`).get() as {
          c: number;
        }
      ).c > 0;
    if (hasGrain) return;

    db.exec(`ALTER TABLE symbol_embeddings ADD COLUMN grain TEXT NOT NULL DEFAULT 'symbol'`);
    db.exec(`CREATE INDEX IF NOT EXISTS idx_embeddings_grain ON symbol_embeddings(grain)`);
  },
};
