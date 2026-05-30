import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add config_refs table for env var / feature flag read sites',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS config_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        config_kind TEXT NOT NULL,
        config_key TEXT NOT NULL,
        source_node_id TEXT,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_config_refs_key
        ON config_refs(config_kind, config_key);
      CREATE INDEX IF NOT EXISTS idx_config_refs_node
        ON config_refs(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_config_refs_file
        ON config_refs(file_path);
    `);
  },
};
