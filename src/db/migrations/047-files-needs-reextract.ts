import type { MigrationModule } from './types.js';

/**
 * Friction F4 / staleness-redesign Phase 1 (Design B).
 *
 * Replace the "zero every files.content_hash on EXTRACTION_LOGIC_VERSION
 * bump" heal pattern with an explicit `needs_reextract` flag. The old
 * heal corrupted the stale-artifact display: after the wipe, every
 * embedding/summary's stored source-hash differed from the new (empty)
 * file hash, so getStaleArtifactsCount reported 100% stale even when
 * file content was unchanged. The flag carries the same "force re-extract"
 * signal without destroying the hash-comparison basis.
 *
 * The sync path treats `needs_reextract = 1` as "re-extract regardless of
 * hash match". After re-extraction completes, upsertFile writes
 * `needs_reextract = 0` along with the fresh content_hash.
 *
 * See project_cartograph_staleness_redesign.md for the full design memo
 * and Phase 2 plan (per-symbol body_hash on nodes).
 */
export const MIGRATION: MigrationModule = {
  description: 'Add files.needs_reextract flag (staleness-redesign Phase 1, friction F4)',
  up: (db) => {
    // Partial-schema test setups (see migrations-022.test.ts) can run
    // individual migrations without the `files` table present — skip in
    // that case. Mirrors the guard in migration 023.
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='files'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(files)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'needs_reextract')) return;
    db.exec(`ALTER TABLE files ADD COLUMN needs_reextract INTEGER NOT NULL DEFAULT 0`);
  },
};
