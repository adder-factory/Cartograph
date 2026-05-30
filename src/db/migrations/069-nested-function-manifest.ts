import type { MigrationModule } from './types.js';

/**
 * F#12 slice 2: nested-function manifest + popularity tables.
 *
 * Mega-files (where ANY function body crosses `largeFunctionThreshold`,
 * default 500 LOC) skip eager nested-function extraction — the cost
 * model for ~10× node multiplication on `checker.ts`-class files is
 * prohibitive (see `docs/F12-NESTED-FUNCTION-PROMOTION-PLAN.md`).
 * Slice 2 routes those files through a manifest path instead: cheap
 * name+position rows that record which nested functions exist without
 * persisting them as graph nodes.
 *
 * Two side tables:
 *
 * - `nested_function_names` — one row per nested-function declaration
 *   in a manifest-mode file. Carries the position, an inferred
 *   signature, a body hash (so re-extracts after a body change can
 *   detect "is this the same function?"), and the future-slice-3
 *   `hit_count` / `promoted_node_id` columns (NULL/0 until slice 3
 *   wires them). `parent_node_id` cascades on parent-node delete; the
 *   `UNIQUE(file_path, name, start_line)` guards re-extract idempotency
 *   when the upsert path is "delete-all-for-file then re-insert".
 *
 * - `nested_function_popularity` — slice 3 carryover table. Keyed by
 *   `(file_path, name)` so the learned popularity signal survives file
 *   edits that shift position / change body. Created here so slice 3's
 *   migration footprint is purely behavioural (no schema add when the
 *   hit-count code lands). No NOT-NULL columns beyond the PK so it can
 *   be safely populated incrementally.
 *
 * FTS5 mirror over the `name` column powers `cartograph_find`'s new 4th
 * corpus — when a name doesn't match any indexed `nodes` row, the find
 * tool falls through to this corpus to surface "this name DOES exist
 * as a nested fn in a mega-file; pass `deep: true` to inspect it".
 *
 * Idempotent: every CREATE uses IF NOT EXISTS, the `nodes` existence
 * probe guards partial-schema test setups (matching 064/066/068
 * patterns).
 */
export const MIGRATION: MigrationModule = {
  description: 'F#12 slice 2 — add nested_function_names + popularity tables + FTS5 mirror',
  up: (db) => {
    const tableExists = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='nodes'").get();
    if (!tableExists) return;

    db.exec(`
      CREATE TABLE IF NOT EXISTS nested_function_names (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          parent_node_id TEXT NOT NULL REFERENCES nodes(id) ON DELETE CASCADE,
          file_path TEXT NOT NULL,
          name TEXT NOT NULL,
          start_line INTEGER NOT NULL,
          start_col INTEGER NOT NULL,
          end_line INTEGER NOT NULL,
          end_col INTEGER NOT NULL,
          signature TEXT,
          body_hash TEXT NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          promoted_node_id TEXT REFERENCES nodes(id) ON DELETE SET NULL,
          promoted_at INTEGER,
          UNIQUE(file_path, name, start_line)
      ) STRICT;
    `);

    db.exec('CREATE INDEX IF NOT EXISTS idx_nested_function_names_name ON nested_function_names(name)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nested_function_names_file ON nested_function_names(file_path)');
    db.exec('CREATE INDEX IF NOT EXISTS idx_nested_function_names_parent ON nested_function_names(parent_node_id)');

    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nested_function_names_fts USING fts5(
          name,
          content='nested_function_names',
          content_rowid='id',
          tokenize='porter unicode61'
      );
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_ai AFTER INSERT ON nested_function_names BEGIN
          INSERT INTO nested_function_names_fts(rowid, name) VALUES (NEW.id, NEW.name);
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_ad AFTER DELETE ON nested_function_names BEGIN
          INSERT INTO nested_function_names_fts(nested_function_names_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name);
      END;
    `);

    db.exec(`
      CREATE TRIGGER IF NOT EXISTS nested_function_names_fts_au AFTER UPDATE ON nested_function_names BEGIN
          INSERT INTO nested_function_names_fts(nested_function_names_fts, rowid, name) VALUES ('delete', OLD.id, OLD.name);
          INSERT INTO nested_function_names_fts(rowid, name) VALUES (NEW.id, NEW.name);
      END;
    `);

    db.exec(`
      CREATE TABLE IF NOT EXISTS nested_function_popularity (
          file_path TEXT NOT NULL,
          name TEXT NOT NULL,
          hit_count INTEGER NOT NULL DEFAULT 0,
          last_hit_at INTEGER,
          PRIMARY KEY (file_path, name)
      ) STRICT, WITHOUT ROWID;
    `);
  },
};
