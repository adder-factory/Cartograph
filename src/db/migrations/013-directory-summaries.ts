import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add directory_summaries table for module-level LLM descriptions',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS directory_summaries (
        dir_path TEXT PRIMARY KEY,
        summary TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      );
      CREATE INDEX IF NOT EXISTS idx_dir_summaries_model ON directory_summaries(model);
    `);
  },
};
