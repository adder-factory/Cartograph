import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add file_summaries table for per-file LLM prose descriptions',
  up: (db) => {
    // The summary tier between symbol and directory: one prose
    // paragraph per file, rolled up from the file's symbol summaries.
    // FK ON DELETE CASCADE to files(path) so a deleted/renamed file
    // drops its summary automatically — unlike directory_summaries,
    // which has no FK anchor and relies on an explicit prune pass.
    db.exec(`
      CREATE TABLE IF NOT EXISTS file_summaries (
        file_path TEXT PRIMARY KEY
          REFERENCES files(path) ON DELETE CASCADE,
        summary TEXT NOT NULL,
        content_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        generated_at INTEGER NOT NULL
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_file_summaries_model ON file_summaries(model);
    `);
  },
};
