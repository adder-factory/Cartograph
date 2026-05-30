import type { MigrationModule } from './types.js';

/**
 * Add `string_imports` table — import-shaped specifiers that appear
 * inside template strings or quoted strings (test fixtures, codegen
 * sources, doc examples).
 *
 * NOT real imports — the static graph correctly omits them from the
 * import edge set. This table surfaces them separately so migration
 * tooling can answer "before this sed pass, what import-like strings
 * will it touch?" without false positives polluting the call graph.
 *
 * container_kind discriminates between template_string and
 * string_literal so callers can scope to the high-signal case
 * (template_string for codegen sources / parser fixtures) when
 * string_literal would be too noisy.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add string_imports table for template-literal / string-literal import sites',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS string_imports (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        file_path TEXT NOT NULL,
        line INTEGER NOT NULL,
        module_name TEXT NOT NULL,
        raw TEXT NOT NULL,
        container_kind TEXT NOT NULL CHECK (container_kind IN ('template_string','string_literal'))
      );
      CREATE INDEX IF NOT EXISTS idx_string_imports_module
        ON string_imports(module_name);
      CREATE INDEX IF NOT EXISTS idx_string_imports_file
        ON string_imports(file_path);
      CREATE INDEX IF NOT EXISTS idx_string_imports_kind
        ON string_imports(container_kind);
    `);
  },
};
