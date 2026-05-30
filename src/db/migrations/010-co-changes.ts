import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add co_changes table for file-level co-change graph',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b),
        CHECK (file_a < file_b)
      );
      CREATE INDEX IF NOT EXISTS idx_co_changes_a ON co_changes(file_a);
      CREATE INDEX IF NOT EXISTS idx_co_changes_b ON co_changes(file_b);
    `);
  },
};
