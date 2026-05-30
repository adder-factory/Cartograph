import type { MigrationModule } from './types.js';

/**
 * Backfill: rewrite synthetic `node:<id>` body_hash keys in
 * `embedding_store` + `embedding_refs` to use the real `nodes.body_hash`.
 *
 * Migration 050 (Phase 4 / Design C) introduced content-addressed
 * embedding storage but ran BEFORE the EXTRACTION_LOGIC_VERSION 4→5
 * heal populated `nodes.body_hash`. Its data-migration's COALESCE
 * fallback wrote `'node:' || node_id` as a synthetic key for every
 * embedding row (because `nodes.body_hash` was `''` at migration
 * time). The synthetic key permanently mismatches `nodes.body_hash`
 * once the heal completes, so `getStaleArtifactsCount` reports ~89%
 * of embeddings stale even after a freshly successful index — the
 * staleness query is correct; the data is stuck.
 *
 * Pure data migration — no schema changes. Idempotent: the predicate
 * `body_hash LIKE 'node:%'` is empty on a clean DB.
 *
 * Three SQL passes in order:
 *   1. DELETE store rows whose target real-key already has a row
 *      (PK collision avoidance for duplicate-body siblings).
 *   2. UPDATE remaining synthetic store rows in place (rowid stable,
 *      so vec0 mirror keeps its join).
 *   3. UPDATE refs to point at the rewritten store keys.
 *
 * vec0 mirror tables are keyed by `embedding_store.rowid`. The UPDATE
 * branch (step 2) preserves rowid; the DELETE branch (step 1) does
 * not. We clear `vec_symbol_embeddings_*` at the end and rely on the
 * bootstrap path in `DatabaseConnection.initialize` to repopulate —
 * same strategy migration 050 used after its swap.
 *
 * Nodes whose `body_hash = ''` (not yet re-extracted under
 * EXTRACTION_LOGIC_VERSION 5) are skipped by the EXISTS guards; their
 * embeddings stay on the synthetic key until the next index pass
 * fills the column, at which point they'll be naturally re-embedded
 * (the staleness query already flags them).
 */
export const MIGRATION: MigrationModule = {
  description: "Backfill synthetic 'node:<id>' body_hash keys in embedding_store/refs (migration 050 debt)",
  // Same as migration 050: the rebind walks across tables with FK
  // constraints into nodes; disable for the duration to avoid
  // transient mid-statement violations.
  requiresFkDisable: true,
  up: (db) => {
    const hasStore = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_store'").get();
    const hasRefs = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='embedding_refs'").get();
    if (!hasStore || !hasRefs) return;

    // Step 1a: drop synthetic-keyed store rows whose target real-key
    // already has a real-keyed row. Two nodes with identical bodies
    // collide on (body_hash, model, grain); the pre-existing real row
    // is authoritative — both were produced by the same model over
    // the same body, so the bytes match.
    db.exec(`
      DELETE FROM embedding_store
       WHERE body_hash LIKE 'node:%'
         AND EXISTS (
           SELECT 1
             FROM embedding_store es2
             JOIN nodes n ON n.id = substr(embedding_store.body_hash, 6)
            WHERE es2.body_hash = n.body_hash
              AND es2.model = embedding_store.model
              AND es2.grain = embedding_store.grain
              AND n.body_hash <> ''
         );
    `);

    // Step 1b: de-dup remaining synthetic rows that would collide
    // with EACH OTHER after rebind. When two synthetic rows resolve
    // to the same (real_body_hash, model, grain), keep min(rowid)
    // as the canonical row — the Step 2 UPDATE on the loser would
    // violate the PK. The "winner" is arbitrary (both store the same
    // embedding bytes by construction), so min(rowid) gives a
    // deterministic, idempotent choice.
    db.exec(`
      DELETE FROM embedding_store
       WHERE rowid IN (
         SELECT es.rowid
           FROM embedding_store es
           JOIN nodes n ON n.id = substr(es.body_hash, 6)
          WHERE es.body_hash LIKE 'node:%'
            AND n.body_hash <> ''
            AND EXISTS (
              SELECT 1
                FROM embedding_store es2
                JOIN nodes n2 ON n2.id = substr(es2.body_hash, 6)
               WHERE es2.body_hash LIKE 'node:%'
                 AND n2.body_hash = n.body_hash
                 AND es2.model = es.model
                 AND es2.grain = es.grain
                 AND es2.rowid < es.rowid
            )
       );
    `);

    // Step 2: rewrite surviving synthetic store keys in place.
    // Predicate guards against nodes still on body_hash='' (not yet
    // re-extracted under EXTRACTION_LOGIC_VERSION 5) — rewriting to
    // an empty key would be worse than leaving the synthetic key
    // alone (every staleness query would still flag the row).
    db.exec(`
      UPDATE embedding_store
         SET body_hash = (
           SELECT n.body_hash
             FROM nodes n
            WHERE n.id = substr(embedding_store.body_hash, 6)
              AND n.body_hash <> ''
         )
       WHERE body_hash LIKE 'node:%'
         AND EXISTS (
           SELECT 1 FROM nodes n
            WHERE n.id = substr(embedding_store.body_hash, 6)
              AND n.body_hash <> ''
         );
    `);

    // Step 3: rewrite embedding_refs body_hash to point at the new
    // store keys. refs PK is (node_id, model, grain), so updating
    // body_hash never collides.
    db.exec(`
      UPDATE embedding_refs
         SET body_hash = (
           SELECT n.body_hash
             FROM nodes n
            WHERE n.id = embedding_refs.node_id
              AND n.body_hash <> ''
         )
       WHERE body_hash LIKE 'node:%'
         AND EXISTS (
           SELECT 1 FROM nodes n
            WHERE n.id = embedding_refs.node_id
              AND n.body_hash <> ''
         );
    `);

    // Step 4: clear vec0 mirror tables; bootstrap repopulates from
    // embedding_store on next DatabaseConnection.initialize. Same
    // strategy migration 050 used.
    const vecTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_symbol_embeddings_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of vecTables) {
      if (!/^vec_symbol_embeddings_\d+$/.test(name)) continue;
      try {
        db.exec(`DELETE FROM ${name}`);
      } catch {
        // vec0 extension may not be loaded in this session.
      }
    }
  },
};
