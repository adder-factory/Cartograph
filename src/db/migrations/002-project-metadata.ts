import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add project metadata, provenance tracking, and unresolved ref context',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS project_metadata (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL,
        updated_at INTEGER NOT NULL
      );
      ALTER TABLE unresolved_refs ADD COLUMN file_path TEXT NOT NULL DEFAULT '';
      ALTER TABLE unresolved_refs ADD COLUMN language TEXT NOT NULL DEFAULT 'unknown';
      ALTER TABLE edges ADD COLUMN provenance TEXT DEFAULT NULL;
      CREATE INDEX IF NOT EXISTS idx_unresolved_file_path ON unresolved_refs(file_path);
      CREATE INDEX IF NOT EXISTS idx_edges_provenance ON edges(provenance);
    `);
  },
};
