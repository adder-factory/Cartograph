import type { MigrationModule } from './types.js';

/**
 * Drop the legacy `vectors` table from upgraded DBs.
 *
 * `vectors` was the original embedding storage created in migration
 * 001-initial-schema. It was superseded by `symbol_embeddings` (and
 * the vec0 mirrors built around it — migrations 012 / 016 / 033 /
 * 042 / 046) but never explicitly DROP'd, so every upgraded DB still
 * carries an empty leftover while fresh installs (`schema.sql`) never
 * had it. The two install paths have therefore been silently
 * divergent on this one table for the entire migration chain.
 *
 * Verified zero production references before landing this: no
 * `FROM vectors`, `INTO vectors`, `UPDATE vectors`, or `DELETE FROM
 * vectors` anywhere under `src/` (all `vectors`-shaped tokens in the
 * codebase are plural English — "embedding vectors", "vec0 vectors").
 * No data lives here on any realistic install — the table has been
 * empty since the chain rerouted embedding writes to
 * `symbol_embeddings`.
 *
 * Surfaced by `__tests__/db-schema-parity.test.ts` on its first run;
 * the corresponding `KNOWN_HISTORICAL_DRIFT` allowlist entry is
 * removed in the same diff so the test now gates new drift with an
 * EMPTY allowlist.
 *
 * Idempotent. `DROP TABLE IF EXISTS` cleanly no-ops on a fresh DB
 * (where `vectors` was never created). SQLite implicitly drops
 * indexes when their table goes, but the explicit `DROP INDEX IF
 * EXISTS` first is a noise-free defensive cleanup for the rare case
 * where the index name might survive a partial-state rebuild.
 */
export const MIGRATION: MigrationModule = {
  description: 'Drop legacy vectors table (superseded by symbol_embeddings)',
  up: (db) => {
    db.exec('DROP INDEX IF EXISTS idx_vectors_model;');
    db.exec('DROP TABLE IF EXISTS vectors;');
  },
};
