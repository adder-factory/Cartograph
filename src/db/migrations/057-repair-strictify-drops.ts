import type { MigrationModule } from './types.js';

/**
 * Repair migration — re-create the five tables that migration 054's
 * silent rebuild-error swallow dropped from production DBs.
 *
 * Background. Migration 054 (`054-strict-tables.ts`) rebuilds every
 * base table as STRICT. The rebuild loop wraps `strictifyTable` in a
 * per-table try/catch with a silent swallow. If the rebuild
 * failed mid-flight on a content-addressed store table — after the
 * `DROP TABLE <original>` step but before the `ALTER TABLE … RENAME`
 * — the catch absorbed the error, the migration runner recorded
 * version 54 as applied, and the table was simply gone. The
 * `symbol_summaries` / `symbol_embeddings` backward-compat VIEWs
 * (also created by 049 / 050) survived because they aren't base
 * tables that 054 iterates over, leaving the live DB with VIEWs
 * pointing at non-existent backing tables. Every read through the
 * views errors with `no such table: main.summary_refs` (or the
 * embedding equivalent).
 *
 * Five tables were observed missing on the affected DB:
 *
 *   - summary_store / summary_refs   (migration 049)
 *   - embedding_store / embedding_refs (migration 050)
 *   - role_assignments               (migration 052)
 *
 * Plus the migration-053 `last_ref_at` columns on summary_store /
 * embedding_store and the four `*_refs_bump_last_ref_at_{ai,au}`
 * triggers were lost with the tables. This repair re-creates all
 * five tables in their post-054 (STRICT) shape, the indexes
 * declared by 049 / 050 / 052 / 053, and the four bump triggers
 * from 053. We declare STRICT directly here so the result matches
 * `src/db/schema.sql` even though migration 054 won't re-run.
 *
 * Idempotent. `CREATE TABLE IF NOT EXISTS` / `CREATE INDEX IF NOT
 * EXISTS` / `CREATE TRIGGER IF NOT EXISTS` make the migration a
 * no-op on DBs where the 054 swallow never fired (fresh installs
 * from `schema.sql`; older DBs whose 054 rebuild succeeded).
 *
 * Data is NOT restored. The summary text + embedding vectors + role
 * labels lived only in those dropped tables; the next `admin
 * summarize` / `admin embed` / `admin classify` pass repopulates
 * them from source. `nodes.role` is the denormalized read-cache
 * (migration 040) so existing role reads keep working until a
 * force-reindex wipes it.
 *
 * Migration 054's silent-swallow is fixed in a separate edit on the
 * same change set so future strict-rebuild migrations fail loud.
 */
export const MIGRATION: MigrationModule = {
  description: 'Repair: re-create summary/embedding/role tables dropped by migration 054 swallow',
  up: (db) => {
    const hasNodes = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!hasNodes) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS role_assignments (
        node_id      TEXT NOT NULL PRIMARY KEY,
        role         TEXT NOT NULL,
        role_model   TEXT NOT NULL DEFAULT '',
        body_hash    TEXT NOT NULL DEFAULT '',
        generated_at INTEGER NOT NULL DEFAULT 0
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_role_assignments_body_hash
        ON role_assignments(body_hash);

      CREATE TABLE IF NOT EXISTS summary_store (
        body_hash    TEXT NOT NULL,
        model        TEXT NOT NULL,
        summary      TEXT NOT NULL,
        generated_at INTEGER NOT NULL,
        last_ref_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (body_hash, model)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS summary_refs (
        node_id   TEXT PRIMARY KEY,
        body_hash TEXT NOT NULL,
        model     TEXT NOT NULL,
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      ) STRICT, WITHOUT ROWID;
      CREATE INDEX IF NOT EXISTS idx_summary_refs_body_hash
        ON summary_refs(body_hash, model);

      CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_ai
      AFTER INSERT ON summary_refs BEGIN
        UPDATE summary_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash AND model = NEW.model;
      END;
      CREATE TRIGGER IF NOT EXISTS summary_refs_bump_last_ref_at_au
      AFTER UPDATE ON summary_refs BEGIN
        UPDATE summary_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash AND model = NEW.model;
      END;

      CREATE TABLE IF NOT EXISTS embedding_store (
        body_hash    TEXT NOT NULL,
        model        TEXT NOT NULL,
        grain        TEXT NOT NULL DEFAULT 'symbol',
        embedding    BLOB NOT NULL,
        generated_at INTEGER NOT NULL DEFAULT 0,
        last_ref_at  INTEGER NOT NULL DEFAULT 0,
        PRIMARY KEY (body_hash, model, grain)
      ) STRICT;

      CREATE TABLE IF NOT EXISTS embedding_refs (
        node_id               TEXT NOT NULL,
        body_hash             TEXT NOT NULL,
        model                 TEXT NOT NULL,
        grain                 TEXT NOT NULL DEFAULT 'symbol' CHECK (grain IN ('symbol', 'file')),
        summary_hash_at_embed TEXT NOT NULL DEFAULT '',
        PRIMARY KEY (node_id, model, grain),
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      ) STRICT;
      CREATE INDEX IF NOT EXISTS idx_embedding_refs_body_hash
        ON embedding_refs(body_hash, model, grain);
      CREATE INDEX IF NOT EXISTS idx_embedding_refs_model
        ON embedding_refs(model);
      CREATE INDEX IF NOT EXISTS idx_embedding_store_model
        ON embedding_store(model);

      CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_ai
      AFTER INSERT ON embedding_refs BEGIN
        UPDATE embedding_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model
           AND grain = NEW.grain;
      END;
      CREATE TRIGGER IF NOT EXISTS embedding_refs_bump_last_ref_at_au
      AFTER UPDATE ON embedding_refs BEGIN
        UPDATE embedding_store
           SET last_ref_at = (strftime('%s', 'now') * 1000)
         WHERE body_hash = NEW.body_hash
           AND model = NEW.model
           AND grain = NEW.grain;
      END;
    `);
  },
};
