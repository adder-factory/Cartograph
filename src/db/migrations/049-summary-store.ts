import type { MigrationModule } from './types.js';

/**
 * Staleness-redesign Phase 3 / Design C — content-addressed summary storage.
 *
 * Replace `symbol_summaries` (one-row-per-node) with two tables:
 *
 *   summary_store(body_hash, model, summary, generated_at)
 *     PK (body_hash, model). One row per unique (body, model) pair.
 *     Body hash = symbolBodyHash(sig, body), the SAME value the
 *     extractor writes to nodes.body_hash (migration 048). Nodes with
 *     identical bodies share a single store row.
 *
 *   summary_refs(node_id, body_hash, model, role, role_model)
 *     PK node_id; FK -> nodes(id) ON DELETE CASCADE. Points each node
 *     at its current summary_store row. Survives node-id rename: drop
 *     the old ref, insert a new one — the store row is reused.
 *
 * Backward-compat: `symbol_summaries` is recreated as a VIEW joining
 * refs + store, preserving the legacy column shape. The ~12 read sites
 * that SELECT or JOIN against `symbol_summaries` continue to work
 * unchanged. Writes go through `upsertSymbolSummary` which is updated
 * in this commit to write the new tables.
 *
 * FTS5 (`summary_fts`) moves to be `content=summary_store` — the
 * intent-search join at `src/mcp/tools/_search-intent.ts` is updated
 * to go through summary_refs to reach node_id.
 *
 * GC: rows in summary_store with zero refs are orphans (e.g. when
 * every node referring to a body hash gets re-extracted with a new
 * body). They are kept on disk by default — useful for revert/rename
 * reuse. An explicit GC sweep is not part of this migration; can be
 * added later as `cartograph admin gc` if disk usage becomes a concern.
 */
export const MIGRATION: MigrationModule = {
  description: 'Content-addressed summary_store + summary_refs (Phase 3 / Design C)',
  up: (db) => {
    // Partial-schema test setups can run individual migrations without
    // the `symbol_summaries` or `nodes` tables — skip cleanly.
    const summariesExists = db
      .prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='symbol_summaries'")
      .get();
    const nodesExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!summariesExists || !nodesExists) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS summary_store (
        body_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        summary TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        PRIMARY KEY (body_hash, model)
      );

      -- summary_refs deliberately omits role / role_model — those moved
      -- to nodes.role + nodes.role_model in migration 040. The legacy
      -- symbol_summaries columns were retained for rollback safety but
      -- had zero live readers; Design C drops them as part of the
      -- restructure.
      CREATE TABLE IF NOT EXISTS summary_refs (
        node_id TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        model TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );

      CREATE INDEX IF NOT EXISTS idx_summary_refs_body_hash
        ON summary_refs(body_hash, model);
    `);

    // Data migration. Use INSERT OR IGNORE so duplicate (body_hash, model)
    // pairs across many node_ids collapse to a single store row — the
    // first one wins (deterministic enough; all share the same summary
    // text when content_hash matches).
    db.exec(`
      INSERT OR IGNORE INTO summary_store (body_hash, model, summary, generated_at)
      SELECT content_hash, model, summary, generated_at FROM symbol_summaries;

      INSERT OR IGNORE INTO summary_refs (node_id, body_hash, model)
      SELECT node_id, content_hash, model FROM symbol_summaries;
    `);

    // Drop the FTS5 virtual table + its triggers BEFORE dropping the
    // base table — FTS5 with content= will error on a dropped content
    // source. Triggers are auto-dropped when the table they target
    // disappears, but the FTS virtual table is independent.
    db.exec(`
      DROP TRIGGER IF EXISTS summary_fts_ai;
      DROP TRIGGER IF EXISTS summary_fts_ad;
      DROP TRIGGER IF EXISTS summary_fts_au;
      DROP TABLE IF EXISTS summary_fts;
      DROP TABLE symbol_summaries;
    `);

    // Backward-compat VIEW: every legacy SELECT / JOIN against
    // symbol_summaries continues to work via this view. INSTEAD OF
    // triggers below also keep legacy INSERT / UPDATE / DELETE working
    // for tests + any caller we haven't yet migrated to write directly
    // through summary_store + summary_refs.
    db.exec(`
      CREATE VIEW symbol_summaries AS
      SELECT
        r.node_id      AS node_id,
        r.body_hash    AS content_hash,
        s.summary      AS summary,
        r.model        AS model,
        s.generated_at AS generated_at
      FROM summary_refs r
      JOIN summary_store s
        ON s.body_hash = r.body_hash AND s.model = r.model;

      CREATE TRIGGER symbol_summaries_insteadof_insert
      INSTEAD OF INSERT ON symbol_summaries BEGIN
        INSERT INTO summary_store (body_hash, model, summary, generated_at)
        VALUES (NEW.content_hash, NEW.model, NEW.summary, NEW.generated_at)
        ON CONFLICT(body_hash, model) DO UPDATE SET
          summary = excluded.summary,
          generated_at = excluded.generated_at;
        INSERT INTO summary_refs (node_id, body_hash, model)
        VALUES (NEW.node_id, NEW.content_hash, NEW.model)
        ON CONFLICT(node_id) DO UPDATE SET
          body_hash = excluded.body_hash,
          model = excluded.model;
      END;

      CREATE TRIGGER symbol_summaries_insteadof_update
      INSTEAD OF UPDATE ON symbol_summaries BEGIN
        INSERT INTO summary_store (body_hash, model, summary, generated_at)
        VALUES (NEW.content_hash, NEW.model, NEW.summary, NEW.generated_at)
        ON CONFLICT(body_hash, model) DO UPDATE SET
          summary = excluded.summary,
          generated_at = excluded.generated_at;
        UPDATE summary_refs SET body_hash = NEW.content_hash, model = NEW.model
        WHERE node_id = OLD.node_id;
      END;

      CREATE TRIGGER symbol_summaries_insteadof_delete
      INSTEAD OF DELETE ON symbol_summaries BEGIN
        DELETE FROM summary_refs WHERE node_id = OLD.node_id;
      END;
    `);

    // Re-create summary_fts attached to summary_store. The intent-search
    // join (src/mcp/tools/_search-intent.ts) is updated in this commit
    // to go through summary_refs to reach node_id (the prior path
    // joined directly on symbol_summaries.ROWID, which only worked while
    // summary_fts was attached to the underlying table).
    db.exec(`
      CREATE VIRTUAL TABLE summary_fts USING fts5(
        summary,
        content='summary_store',
        content_rowid='ROWID',
        tokenize='porter unicode61'
      );

      CREATE TRIGGER summary_fts_ai AFTER INSERT ON summary_store BEGIN
        INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
      END;
      CREATE TRIGGER summary_fts_ad AFTER DELETE ON summary_store BEGIN
        INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES('delete', OLD.ROWID, OLD.summary);
      END;
      CREATE TRIGGER summary_fts_au AFTER UPDATE ON summary_store BEGIN
        INSERT INTO summary_fts(summary_fts, rowid, summary) VALUES('delete', OLD.ROWID, OLD.summary);
        INSERT INTO summary_fts(rowid, summary) VALUES (NEW.ROWID, NEW.summary);
      END;

      INSERT INTO summary_fts(rowid, summary)
        SELECT ROWID, summary FROM summary_store;
    `);
  },
};
