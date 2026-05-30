import type { MigrationModule } from './types.js';

/**
 * Parse-cache table. Skips the tree-sitter parse pass when the same
 * content+language+path has been extracted before — saves the
 * dominant non-LLM cost on `--force` reindex (existing per-file
 * `unchanged_files` short-circuit only saves the PERSIST step; this
 * extends that win to the PARSE step).
 *
 * Key shape `(content_hash, language, file_path)`: includes file_path
 * because `Node.id` is derived from `${filePath}:${kind}:${name}:${line}`,
 * so reusing a cached parse at a different path would require a full
 * id-rewrite of nodes / edges / unresolved refs. v1 keeps it simple —
 * same path, same content → cache hit; renames take a fresh parse.
 *
 * Eviction: the runtime layer caps row count and drops the oldest by
 * generated_at when over the limit. The schema doesn't enforce a
 * size; the index on generated_at gives the eviction sweep a
 * sub-millisecond ORDER BY LIMIT.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add parse_cache table — content-hash-keyed extract result cache',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS parse_cache (
        content_hash TEXT NOT NULL,
        language TEXT NOT NULL,
        file_path TEXT NOT NULL,
        payload TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        PRIMARY KEY (content_hash, language, file_path)
      );
      CREATE INDEX IF NOT EXISTS idx_parse_cache_generated_at
        ON parse_cache(generated_at);
    `);
  },
};
