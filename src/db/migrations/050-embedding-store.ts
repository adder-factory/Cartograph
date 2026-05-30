import type { MigrationModule } from './types.js';

/**
 * Staleness-redesign Phase 4 / Design C — content-addressed embedding
 * storage. Mirror of migration 049 (summary side).
 *
 * Restructures `symbol_embeddings` into:
 *
 *   embedding_store(body_hash, model, grain, embedding, generated_at)
 *     PK (body_hash, model, grain). One row per unique
 *     (body_hash, model, grain). Two nodes with identical bodies share
 *     a single row — saves space + lets a file rename / function move
 *     reuse the embedding bytes with no LLM/local-model call.
 *
 *   embedding_refs(node_id, body_hash, model, grain, summary_hash_at_embed)
 *     PK (node_id, model, grain). Per-node pointer at a store row. FK
 *     to nodes(id) ON DELETE CASCADE. The (model, grain) compound PK
 *     allows a single node to have both a 'symbol' grain row and a
 *     'file' grain row (different embedders / sources).
 *
 * Backward-compat: `symbol_embeddings` becomes a VIEW joining refs +
 * store, preserving the legacy column shape. INSTEAD OF triggers on
 * the view forward INSERT / UPDATE / DELETE through to the new tables.
 *
 * vec0 / HNSW coupling: the `vec_symbol_embeddings_<dim>` virtual
 * tables are keyed by rowid. After the swap, those rowids change —
 * vec0 must be cleared + repopulated. The migration clears them; the
 * bootstrap path at DatabaseConnection.initialize (vec-helpers.ts
 * bootstrapVecTables -> backfillVecTable) repopulates from
 * embedding_store on first use. HNSW (`hnsw_meta`) auto-rebuilds on
 * the next query when max_rowid drift is detected — same machinery
 * migration 033 already relied on.
 *
 * `summary_hash_at_embed` lives on refs (not store) because the same
 * embedding row could have been generated against different summary
 * versions for different nodes — refs carries the per-node provenance.
 *
 * See project_cartograph_staleness_redesign.md for the full design memo.
 */
export const MIGRATION: MigrationModule = {
  description: 'Content-addressed embedding_store + embedding_refs (Phase 4 / Design C)',
  // Same pattern as migration 033: rebuild requires FK suppression so
  // the data migration doesn't trip the FK check during the brief
  // window where symbol_embeddings is dropped before refs is populated.
  requiresFkDisable: true,
  up: (db) => {
    const embeddingsExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_embeddings'")
      .get();
    const nodesExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!embeddingsExists || !nodesExists) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS embedding_store (
        body_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        grain TEXT NOT NULL DEFAULT 'symbol',
        embedding BLOB NOT NULL,
        generated_at INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (body_hash, model, grain)
      );

      CREATE TABLE IF NOT EXISTS embedding_refs (
        node_id TEXT NOT NULL,
        body_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        grain TEXT NOT NULL DEFAULT 'symbol',
        summary_hash_at_embed TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (node_id, model, grain),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_embedding_refs_body_hash
        ON embedding_refs(body_hash, model, grain);
      CREATE INDEX IF NOT EXISTS idx_embedding_refs_model
        ON embedding_refs(model);
      CREATE INDEX IF NOT EXISTS idx_embedding_store_model
        ON embedding_store(model);
    `);

    // Data migration. For embedding_store the "body_hash" comes from
    // nodes.body_hash (Phase 2 / migration 048). When that's empty
    // (pre-migration-048 leftovers OR test fixtures that bypass the
    // extractor), fall back to a synthetic `node:<id>` key so the
    // row is preserved (loses cross-rename dedup until next
    // re-extraction populates the real body_hash). INSERT OR IGNORE on
    // (body_hash, model, grain) collapses duplicate-body siblings.
    db.exec(`
      INSERT OR IGNORE INTO embedding_store (body_hash, model, grain, embedding)
      SELECT
        CASE WHEN COALESCE(n.body_hash, '') = ''
             THEN 'node:' || e.node_id
             ELSE n.body_hash
        END AS body_hash,
        e.embedding_model,
        COALESCE(e.grain, 'symbol'),
        e.embedding
      FROM symbol_embeddings e
      LEFT JOIN nodes n ON n.id = e.node_id;

      INSERT OR IGNORE INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
      SELECT
        e.node_id,
        CASE WHEN COALESCE(n.body_hash, '') = ''
             THEN 'node:' || e.node_id
             ELSE n.body_hash
        END AS body_hash,
        e.embedding_model,
        COALESCE(e.grain, 'symbol'),
        COALESCE(e.summary_hash_at_embed, '')
      FROM symbol_embeddings e
      LEFT JOIN nodes n ON n.id = e.node_id;
    `);

    // Drop legacy table.
    db.exec(`DROP TABLE symbol_embeddings;`);

    // Backward-compat VIEW with INSTEAD OF triggers (same pattern as
    // migration 049's summary VIEW). Legacy SELECTs continue to work;
    // legacy INSERT/UPDATE/DELETE flow through to refs + store.
    //
    // The VIEW exposes a synthetic ROWID — embedding_refs.ROWID. The
    // mirrorVecForNode path in queries-embeddings.ts is updated in
    // this commit to read from embedding_refs instead of via the view.
    db.exec(`
      CREATE VIEW symbol_embeddings AS
      SELECT
        r.node_id              AS node_id,
        s.embedding            AS embedding,
        r.model                AS embedding_model,
        r.body_hash            AS source_content_hash,
        r.summary_hash_at_embed AS summary_hash_at_embed,
        r.grain                AS grain,
        0                      AS chunk_idx
      FROM embedding_refs r
      JOIN embedding_store s
        ON s.body_hash = r.body_hash
       AND s.model = r.model
       AND s.grain = r.grain;

      CREATE TRIGGER symbol_embeddings_insteadof_insert
      INSTEAD OF INSERT ON symbol_embeddings BEGIN
        INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
        VALUES (NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), NEW.embedding, strftime('%s', 'now') * 1000)
        ON CONFLICT(body_hash, model, grain) DO UPDATE SET
          embedding = excluded.embedding,
          generated_at = excluded.generated_at;
        INSERT INTO embedding_refs (node_id, body_hash, model, grain, summary_hash_at_embed)
        VALUES (NEW.node_id, NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), COALESCE(NEW.summary_hash_at_embed, ''))
        ON CONFLICT(node_id, model, grain) DO UPDATE SET
          body_hash = excluded.body_hash,
          summary_hash_at_embed = excluded.summary_hash_at_embed;
      END;

      CREATE TRIGGER symbol_embeddings_insteadof_update
      INSTEAD OF UPDATE ON symbol_embeddings BEGIN
        INSERT INTO embedding_store (body_hash, model, grain, embedding, generated_at)
        VALUES (NEW.source_content_hash, NEW.embedding_model, COALESCE(NEW.grain, 'symbol'), NEW.embedding, strftime('%s', 'now') * 1000)
        ON CONFLICT(body_hash, model, grain) DO UPDATE SET
          embedding = excluded.embedding,
          generated_at = excluded.generated_at;
        UPDATE embedding_refs
           SET body_hash = NEW.source_content_hash,
               summary_hash_at_embed = COALESCE(NEW.summary_hash_at_embed, '')
         WHERE node_id = OLD.node_id
           AND model = OLD.embedding_model
           AND grain = COALESCE(OLD.grain, 'symbol');
      END;

      CREATE TRIGGER symbol_embeddings_insteadof_delete
      INSTEAD OF DELETE ON symbol_embeddings BEGIN
        DELETE FROM embedding_refs
         WHERE node_id = OLD.node_id
           AND model = OLD.embedding_model
           AND grain = COALESCE(OLD.grain, 'symbol');
      END;
    `);

    // Clear vec0 mirror tables. The bootstrap path repopulates from
    // embedding_store on next DatabaseConnection.initialize. Same
    // strategy migration 033 used after its swap.
    const vecTables = db
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'vec_symbol_embeddings_%'")
      .all() as Array<{ name: string }>;
    for (const { name } of vecTables) {
      if (!/^vec_symbol_embeddings_\d+$/.test(name)) continue;
      try {
        db.exec(`DELETE FROM ${name}`);
      } catch {
        // Best-effort — vec0 extension may not be loaded in this session.
      }
    }
  },
};
