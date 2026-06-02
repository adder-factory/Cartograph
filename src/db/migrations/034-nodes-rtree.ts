import type { MigrationModule } from './types.js';

/**
 * R*Tree virtual table on `nodes(start_line, end_line)`.
 *
 * Enables O(log n) range-overlap lookups: "which symbols span any
 * part of lines [S, E] in file F?". Used by `cartograph_at_range`
 * for PR-review and diff-overlay workflows where "what's in this
 * hunk?" is more useful than "what's in this file?".
 *
 * `rtree_i32` uses 32-bit signed integers for coordinates — correct
 * for line numbers which never exceed 2^31. The `id` column mirrors
 * `nodes.rowid` so the R*Tree entry can JOIN back to the full row.
 *
 * Three sync triggers keep the R*Tree consistent with `nodes`:
 *   - `nodes_rtree_ai` — AFTER INSERT
 *   - `nodes_rtree_ad` — AFTER DELETE
 *   - `nodes_rtree_au` — AFTER UPDATE OF start_line, end_line
 *
 * The backfill `INSERT OR REPLACE` is idempotent: if the migration
 * runs on an already-populated DB (e.g. schema.sql applied first)
 * the REPLACE is a silent no-op.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add R*Tree on nodes(start_line, end_line) for range-overlap lookups',
  up: (db) => {
    db.exec(`
      CREATE VIRTUAL TABLE IF NOT EXISTS nodes_rtree USING rtree_i32(
        id,           -- rowid (mirrors nodes.rowid)
        start_line,
        end_line
      );

      -- Sync triggers
      CREATE TRIGGER IF NOT EXISTS nodes_rtree_ai AFTER INSERT ON nodes
      BEGIN
        INSERT OR REPLACE INTO nodes_rtree (id, start_line, end_line)
          VALUES (NEW.rowid, NEW.start_line, NEW.end_line);
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_rtree_ad AFTER DELETE ON nodes
      BEGIN
        DELETE FROM nodes_rtree WHERE id = OLD.rowid;
      END;

      CREATE TRIGGER IF NOT EXISTS nodes_rtree_au AFTER UPDATE OF start_line, end_line ON nodes
      BEGIN
        INSERT OR REPLACE INTO nodes_rtree (id, start_line, end_line)
          VALUES (NEW.rowid, NEW.start_line, NEW.end_line);
      END;
    `);

    // Backfill from existing rows — guarded so migration tests that build
    // minimal `nodes (id TEXT PRIMARY KEY)` fixtures without start_line /
    // end_line don't fail. On real production DBs nodes always has these
    // columns (present since the initial schema v1).
    const cols = new Set((db.prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>).map((r) => r.name));
    if (cols.has('start_line') && cols.has('end_line')) {
      db.exec(`
        INSERT OR REPLACE INTO nodes_rtree (id, start_line, end_line)
          SELECT rowid, start_line, end_line FROM nodes;
      `);
    }
  },
};
