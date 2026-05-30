import type { MigrationModule } from './types.js';

/**
 * Tag pre-computed artifacts (biomarker findings, symbol embeddings) with
 * the file content_hash they were generated against. Mirrors the existing
 * `symbol_summaries.content_hash` field so downstream queries can detect
 * stale artifacts without re-computing them.
 *
 * Why: the freshness gate already warns when the index is stale relative
 * to git HEAD or to disk content, but it can't tell when the *index itself
 * is fresh* yet a particular pre-computed artifact (an LLM-generated
 * embedding or a biomarker finding) was produced against an older version
 * of the symbol's source. Joining `source_content_hash` against
 * `files.content_hash` answers "which artifacts are out of sync?" without
 * re-running the LLM / biomarker pass.
 *
 * Existing rows are backfilled with the empty string '' as a sentinel
 * meaning "unknown — assume potentially-stale-on-read." The next
 * regeneration (re-summarisation, re-biomark) populates the real value.
 */
export const MIGRATION: MigrationModule = {
  description: 'source_content_hash on code_health_findings and symbol_embeddings',
  up: (db) => {
    // schema.sql ships the latest column set (so fresh DBs get the
    // freshness-aware column right away). For DBs created at an older
    // version, the columns are missing and we need ALTER TABLE — which
    // SQLite refuses if the column already exists. Guard with PRAGMA
    // table_info so the migration is idempotent across both paths.
    const hasColumn = (table: string, col: string): boolean => {
      const rows = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
      return rows.some((r) => r.name === col);
    };
    // SQLite ALTER TABLE ADD COLUMN with NOT NULL requires a default.
    if (!hasColumn('code_health_findings', 'source_content_hash')) {
      db.exec(`
        ALTER TABLE code_health_findings
          ADD COLUMN source_content_hash TEXT NOT NULL DEFAULT '';
      `);
    }
    // Post-migration-050 symbol_embeddings is a VIEW; ALTER TABLE fails.
    // Skip when already-view — Design C carries source_content_hash via
    // embedding_refs.body_hash.
    const embEntity = db.prepare("SELECT type FROM sqlite_master WHERE name='symbol_embeddings'").get() as
      | { type: string }
      | undefined;
    if ((!embEntity || embEntity.type !== 'view') && !hasColumn('symbol_embeddings', 'source_content_hash')) {
      db.exec(`
        ALTER TABLE symbol_embeddings
          ADD COLUMN source_content_hash TEXT NOT NULL DEFAULT '';
      `);
    }
  },
};
