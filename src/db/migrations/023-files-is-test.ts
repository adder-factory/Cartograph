import type { MigrationModule } from './types.js';

/**
 * Add `is_test` column to the `files` table.
 *
 * Populated at index-time from path globs (see src/test-detection.ts).
 * Used as a substrate by downstream tools — dead-code analysis can
 * exclude functions only called from tests, biomarkers can skip test
 * files in centrality rollups, etc. The column itself is small; the
 * payoff is the consumers.
 *
 * Backfill on existing rows is not done in this migration — the next
 * `cartograph admin index --force` (or per-file re-index via sync) will
 * populate it. Old rows keep `is_test = 0` until then, which is the
 * safe default (a function flagged "live in prod" but actually
 * test-only is the existing behaviour, not a regression).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add files.is_test column for test-file flagging',
  up: (db) => {
    // Partial-schema test setups can run individual migrations without
    // the `files` table present — skip in that case (mirrors the
    // tableExists guard in migration 022).
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'is_test')) return;
    db.exec('ALTER TABLE files ADD COLUMN is_test INTEGER NOT NULL DEFAULT 0');
  },
};
