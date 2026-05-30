import type { MigrationModule } from './types.js';

/**
 * Agent annotations + bookmarks (#14). Per-symbol notes that
 * survive across sessions: anything the agent wants to leave for
 * "future-me" — invariants noticed during investigation, follow-up
 * questions, bookmark anchors for quick navigation.
 *
 * `kind` ∈ `note | question | followup | bookmark`. The discriminator
 * is just an enum-as-string (no separate table per kind) — same row
 * shape works for all four, and the agent filters by kind on read.
 *
 * `node_id` references nodes(id) ON DELETE CASCADE so re-indexing a
 * file (which drops & re-inserts its nodes) sweeps stale notes.
 * Free-floating notes (no node_id) survive — used for
 * project-scoped reminders, not symbol annotations.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add agent_notes — per-symbol annotations + bookmarks for cross-session memory (#14)',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS agent_notes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        node_id TEXT,
        author TEXT NOT NULL,
        ts INTEGER NOT NULL,
        text TEXT NOT NULL,
        kind TEXT NOT NULL DEFAULT 'note',
        FOREIGN KEY (node_id) REFERENCES nodes(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_agent_notes_node
        ON agent_notes(node_id, ts DESC);
      CREATE INDEX IF NOT EXISTS idx_agent_notes_kind_ts
        ON agent_notes(kind, ts DESC);
    `);
  },
};
