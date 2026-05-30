import type { MigrationModule } from './types.js';

/**
 * `code_health_findings.pass_kind` — annotates each finding with the
 * surface reason ('full-pass' / 'partial-rescan' / 'cached') so the
 * ranked-mode response can tell the agent whether a finding was
 * re-evaluated by the most recent full project pass, surfaced by a
 * per-edit partial rescan, or carried over from a prior full pass
 * (file content unchanged → cache-skipped).
 *
 * Why this matters: cross-file rules (unused_export / god_class /
 * feature_envy / illegal_import) re-run on every partial sync against
 * the current global graph state. An edit to one symbol can therefore
 * surface NEW findings on adjacent symbols that the previous full pass
 * never enumerated — the agent had no way to tell "this was latent"
 * from "this is new from your edit". Tagging each row at write time
 * makes the surface honest.
 *
 * Column type / default: `TEXT NOT NULL DEFAULT 'cached'`. Existing rows
 * (written before this migration) get 'cached' which matches the
 * "haven't been re-evaluated since the last full pass but still believed
 * accurate" semantic. The next full pass restamps everything it touches
 * to 'full-pass'; partial syncs overwrite touched rows to
 * 'partial-rescan'.
 *
 * Idempotent: PRAGMA table_info guard so re-running on an already-
 * migrated DB is a no-op.
 *
 * Pairs with the BIOMARKER_CACHE_KEY v8→v9 bump in
 * `src/biomarkers/index.ts` so the next afterSync hook forces a full
 * pass and the column starts at the canonical 'full-pass' state for
 * every emitted row.
 */
export const MIGRATION: MigrationModule = {
  description: 'pass_kind on code_health_findings',
  up: (db) => {
    // Skip cleanly when the table doesn't exist yet — synthetic test
    // fixtures (e.g. __tests__/migrations-022.test.ts) bootstrap a
    // partial pre-022 schema and run forward migrations through; the
    // table only enters via `schema.sql` or earlier migrations that
    // those fixtures don't replay. PRAGMA table_info on a missing
    // table returns zero rows.
    const rows = db.prepare(`PRAGMA table_info(code_health_findings)`).all() as Array<{ name: string }>;
    if (rows.length === 0) return;
    if (rows.some((r) => r.name === 'pass_kind')) return;
    db.exec(`
      ALTER TABLE code_health_findings
        ADD COLUMN pass_kind TEXT NOT NULL DEFAULT 'cached';
    `);
  },
};
