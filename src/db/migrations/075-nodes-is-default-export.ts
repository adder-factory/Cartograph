import type { MigrationModule } from './types.js';

/**
 * Add `nodes.is_default_export` — 1 when a symbol is an ES module
 * default export (`export default …`), 0 otherwise.
 *
 * Why: a default export keeps its LOCAL name in the graph (a
 * `export default function serverEntry()` node is named `serverEntry`,
 * not `default`) and carries no other marker, so consumers that need to
 * recognise the default export — e.g. the `unused_export` biomarker's
 * framework-convention filter, which must exempt React Router route /
 * root / entry.server default exports (issue #50) — had no signal to key
 * on. This column is the signal; only the JS/TS extractor populates it.
 *
 * Shape mirrors the sibling `is_exported` / `is_async` / `is_static`
 * boolean columns in `schema.sql`: a nullable INTEGER with `DEFAULT 0`.
 * The non-NULL default backfills existing rows to 0 in place (SQLite
 * fills the default, not NULL), so `NodeRowSchema`'s `z.number()` holds
 * for legacy rows immediately — the next re-extract (triggered by the
 * EXTRACTION_LOGIC_VERSION bump from the extractor edit) sets the real
 * value. The column definition is kept byte-for-byte in step with
 * `schema.sql` so `schema-drift.test.ts` (fresh-vs-migrated parity)
 * stays green.
 *
 * Idempotent: PRAGMA-guarded ADD COLUMN so re-running on an already-
 * migrated DB is a no-op, and partial-schema test fixtures without a
 * `nodes` table skip cleanly.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add nodes.is_default_export column (ES module default-export flag)',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'is_default_export')) {
      db.exec('ALTER TABLE nodes ADD COLUMN is_default_export INTEGER DEFAULT 0');
    }
  },
};
