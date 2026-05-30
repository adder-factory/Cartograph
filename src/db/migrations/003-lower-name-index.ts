import type { MigrationModule } from './types.js';

export const MIGRATION: MigrationModule = {
  description: 'Add lower(name) expression index for memory-efficient case-insensitive lookups',
  up: (db) => {
    db.exec(`
      CREATE INDEX IF NOT EXISTS idx_nodes_lower_name ON nodes(lower(name));
    `);
  },
};
