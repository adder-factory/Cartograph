import type { MigrationModule } from './types.js';

/**
 * Staleness-redesign Phase 2 (Design A — friction F4 follow-on).
 *
 * Add `nodes.body_hash` — the per-symbol sha256(signature + body) that
 * `getStaleArtifactsCount` joins against to flag stale summaries.
 * Until now the stale-summary query compared `symbol_summaries.content_hash`
 * (per-symbol body hash) against `files.content_hash` (per-file hash),
 * an always-mismatch that reported 100% stale forever. Quick-win D in
 * 46ec645 mitigated the display by returning 0 with a TODO. This
 * migration unblocks the proper fix.
 *
 * `body_hash` is computed by the extractor (tree-sitter `createNode`)
 * using the same `symbolBodyHash` helper that the summarizer uses to
 * write `symbol_summaries.content_hash`. The two hashes are produced
 * by the same function, so the stale comparison is now semantically
 * sound.
 *
 * Existing rows get `''` (DEFAULT). The companion bump in
 * `EXTRACTION_LOGIC_VERSION` (4 → 5) triggers a one-shot full
 * re-extraction on the next sync, which populates the column for
 * every node. Until that re-extraction completes, the stale-summary
 * query treats `body_hash = ''` as "tracking pending" (returns the
 * node from the count only when body_hash is non-empty AND mismatches).
 *
 * See `project_cartograph_staleness_redesign.md` for the full design memo.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add nodes.body_hash for per-symbol stale-summary detection (Phase 2, Design A)',
  up: (db) => {
    // Partial-schema test setups can run migrations without the `nodes`
    // table present — skip in that case (mirrors the guard in migration 023).
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;
    const cols = db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    if (cols.some((c) => c.name === 'body_hash')) return;
    db.exec(`ALTER TABLE nodes ADD COLUMN body_hash TEXT NOT NULL DEFAULT ''`);
  },
};
