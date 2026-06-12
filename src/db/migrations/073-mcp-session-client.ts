import type { MigrationModule } from './types.js';

/**
 * Session identity. The trace tables (028/030) record sessions as
 * opaque ids — indistinguishable in the viewer's pickers when several
 * agents (or several cartograph-served projects) run at once. Stamp
 * each session with what we know at creation time:
 *
 * 1. `client_name` / `client_version` — the MCP client's self-reported
 *    identity from the `initialize` handshake (e.g. "claude-code").
 * 2. `project_root` — the server's resolved default project root. A
 *    session's calls land in THIS project's DB; per-call cross-project
 *    targeting (the `projectPath` tool arg) stays visible in each
 *    call's recorded args.
 *
 * All three are nullable: sessions recorded by older binaries, or by
 * clients that skip `clientInfo`, simply render as "unknown client".
 */
export const MIGRATION: MigrationModule = {
  description: 'Add mcp_sessions client_name/client_version/project_root — human-readable session identity',
  up: (db) => {
    const cols = db.prepare(`PRAGMA table_info(mcp_sessions)`).all() as Array<{ name: string }>;
    const have = new Set(cols.map((c) => c.name));
    if (!have.has('client_name')) db.exec(`ALTER TABLE mcp_sessions ADD COLUMN client_name TEXT`);
    if (!have.has('client_version')) db.exec(`ALTER TABLE mcp_sessions ADD COLUMN client_version TEXT`);
    if (!have.has('project_root')) db.exec(`ALTER TABLE mcp_sessions ADD COLUMN project_root TEXT`);
  },
};
