import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add sql_refs table for SQL string-literal references to tables',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS sql_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        table_name TEXT NOT NULL,
        op TEXT NOT NULL CHECK (op IN ('read','write','ddl')),
        source_node_id TEXT,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_sql_refs_table
        ON sql_refs(lower(table_name));
      CREATE INDEX IF NOT EXISTS idx_sql_refs_node
        ON sql_refs(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_sql_refs_file
        ON sql_refs(file_path);
    `);
  },
};
