import type { MigrationModule } from './types.js';

/**
 * MCP trace tables — capture every tool call the MCP server
 * dispatches, plus a session row that groups them. Drives the
 * viewer's "Agent trace" tab (replay how an agent discovered
 * symbols, with each step's args and result visible alongside the
 * graph view) and the "Live" tab's real-time tool-call feed.
 *
 * Storage shape:
 *   - mcp_sessions: one row per `cartograph serve --mcp` invocation
 *     (id is the start-time-derived random string from the runtime).
 *   - mcp_tool_calls: one row per dispatched tool call. `step` is
 *     the 1-indexed sequence within a session; the index on
 *     (session_id, step) makes per-session reads ordered without
 *     a sort.
 *
 * Retention: the runtime caps mcp_tool_calls at 10000 rows,
 * dropping the oldest by ts. Sessions older than the oldest
 * surviving call are pruned on the same sweep.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add mcp_sessions + mcp_tool_calls — tool-call trace log driving the viewer trace bar',
  up: (db) => {
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_sessions (
        id TEXT PRIMARY KEY,
        started_ts INTEGER NOT NULL,
        last_activity_ts INTEGER NOT NULL,
        tool_count INTEGER NOT NULL DEFAULT 0
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_sessions_started_ts
        ON mcp_sessions(started_ts DESC);

      CREATE TABLE IF NOT EXISTS mcp_tool_calls (
        session_id TEXT NOT NULL,
        step INTEGER NOT NULL,
        ts INTEGER NOT NULL,
        tool_name TEXT NOT NULL,
        args_json TEXT NOT NULL,
        result_summary TEXT NOT NULL,
        duration_ms INTEGER NOT NULL,
        PRIMARY KEY (session_id, step),
        FOREIGN KEY (session_id) REFERENCES mcp_sessions(id) ON DELETE CASCADE
      );
      CREATE INDEX IF NOT EXISTS idx_mcp_tool_calls_ts
        ON mcp_tool_calls(ts);
    `);
  },
};
