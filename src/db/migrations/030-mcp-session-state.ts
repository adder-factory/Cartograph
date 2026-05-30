import type { MigrationModule } from './types.js';

/**
 * Agent session state (#13). Two pieces of additive state on top of
 * the trace tables shipped in 028:
 *
 * 1. `mcp_sessions.label` — optional human label set by
 *    `cartograph_session({action: "create", label})`. Lets `resume`
 *    look up by name instead of opaque session id, and gives the
 *    session-summary surface a recognisable handle.
 * 2. `mcp_macros` — saved (name, steps_json) recipes the agent can
 *    `macro_run` against. Steps are a JSON array of
 *    `{tool, args}` objects; the runner replays each in order with
 *    optional positional substitution from the macro_run args.
 *
 * Both are agent-memory, not graph-derived: the index doesn't lose
 * value when these are absent, but they're small and accumulate
 * across sessions so they belong in the project DB rather than
 * volatile process memory.
 */
export const MIGRATION: MigrationModule = {
  description: 'Add mcp_sessions.label + mcp_macros — durable session handles and saved query recipes (#13)',
  up: (db) => {
    // Defensive guard: 028 created mcp_sessions without `label`; on
    // a fresh DB this column doesn't exist. Re-running on an already-
    // migrated DB is a no-op via the column-existence check.
    const cols = db.prepare(`PRAGMA table_info(mcp_sessions)`).all() as Array<{ name: string }>;
    if (!cols.some((c) => c.name === 'label')) {
      db.exec(`ALTER TABLE mcp_sessions ADD COLUMN label TEXT`);
    }
    db.exec(`
      CREATE TABLE IF NOT EXISTS mcp_macros (
        name TEXT PRIMARY KEY,
        steps_json TEXT NOT NULL,
        created_ts INTEGER NOT NULL,
        last_run_ts INTEGER
      );
    `);
  },
};
