import type { MigrationModule } from './types.js';

/**
 * Add `build_context_refs` table — per-site occurrences of
 * `__dirname`, `__filename`, `import.meta.dirname`,
 * `import.meta.filename`, `import.meta.url`.
 *
 * Mirrors the shape of `config_refs` (migration 006). One row per
 * occurrence; source_node_id links to the enclosing function via the
 * standard line-range lookup, NULL for top-level reads. Used by
 * downstream tooling that needs to know where module-format-sensitive
 * identifiers appear (e.g. CJS↔ESM migration audits).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add build_context_refs table for __dirname / import.meta.* sites',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS build_context_refs (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        ref_kind TEXT NOT NULL,
        source_node_id TEXT,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        FOREIGN KEY (source_node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_build_context_refs_kind
        ON build_context_refs(ref_kind);
      CREATE INDEX IF NOT EXISTS idx_build_context_refs_node
        ON build_context_refs(source_node_id);
      CREATE INDEX IF NOT EXISTS idx_build_context_refs_file
        ON build_context_refs(file_path);
    `);
  },
};
