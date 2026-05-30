import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add embedding BLOB + embedding_model columns on symbol_summaries for semantic search',
  up: (db) => {
    // Post-migration-049 symbol_summaries is a VIEW; ALTER errors.
    // Migration 016 already split embeddings out into symbol_embeddings,
    // so this migration's columns are dead — skip on the forward-replay.
    const existing = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_summaries'").get() as
      | { type: string }
      | undefined;
    if (existing?.type === 'view') return;
    const cols = db.prepare(`PRAGMA table_info(symbol_summaries);`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'embedding')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN embedding BLOB;`);
    }
    if (!cols.some((c) => c.name === 'embedding_model')) {
      db.exec(`ALTER TABLE symbol_summaries ADD COLUMN embedding_model TEXT;`);
    }
  },
};
