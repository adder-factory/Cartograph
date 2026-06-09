/**
 * Schema-compatibility guard (B4).
 *
 * Long-running MCP servers hold the project DB open with whatever
 * code they were started against. If a separate process (test runner,
 * eval, second server) opens the same DB with newer code that runs
 * a forward migration, the original server is now driving the OLD
 * schema-mapper against the NEW table shape. The damage paths:
 *
 *   - Schema-driven INSERTs bind the OLD column set against the NEW
 *     table — misses the new column. With NOT NULL DEFAULT it slots
 *     the default; with NOT NULL no default it fails the constraint
 *     and `INSERT OR IGNORE` swallows the row silently. We saw this
 *     when migration 032 added `confidence` and the running server's
 *     edge inserts started silently dropping (14214 → 5340 in one
 *     session).
 *   - Auto-sync via the file watcher keeps churning the same broken
 *     INSERTs, so the longer the server runs, the more edges leak.
 *
 * The guard makes the failure LOUD instead of silent: every tool call
 * checks whether the on-disk schema version exceeds the version the
 * loaded code knows about, and fails closed with a clear "restart
 * required" message. The watcher refuses to start when a mismatch is
 * detected at boot. Equal or older on-disk versions pass through —
 * `runMigrations` already brings them forward at open time.
 */
import type Cartograph from '../index.js';
import { CURRENT_SCHEMA_VERSION } from '../db/migrations.js';

interface SchemaCompatCheck {
  /** True when the loaded code is at-or-newer than what's on disk. */
  ok: boolean;
  /** Schema version the loaded code knows about. */
  expected: number;
  /** Schema version recorded in the project's `schema_versions` table. */
  actual: number;
}

export function checkSchemaCompat(cg: Cartograph): SchemaCompatCheck {
  const v = cg.db.getSchemaVersion();
  // `null` → 0 is intentional safe-open: a DB whose schema_versions
  // table is empty (botched migration, very-early DB) trips ok=true so
  // the next `runMigrations` call can backfill from 0. Newer-than-known
  // is the ONLY direction we block.
  const actual = v?.version ?? 0;
  return {
    ok: actual <= CURRENT_SCHEMA_VERSION,
    expected: CURRENT_SCHEMA_VERSION,
    actual,
  };
}

/**
 * One-line human-readable explanation of an incompatible schema.
 * Used in stderr boot warnings, in errorResult bodies, and in any
 * surface that needs to tell the operator what's wrong + how to fix.
 */
export function formatSchemaMismatch(check: SchemaCompatCheck): string {
  return (
    `MCP server is running stale code: knows schema v${check.expected}, ` +
    `database is at v${check.actual}. The DB was upgraded by a newer cartograph ` +
    `process (test run / eval / second server). Operations are blocked to prevent ` +
    `silent data corruption (B4) — bypassing the guard would route writes through ` +
    `the OLD schema mapper against the NEW tables.\n\n` +
    `To recover:\n` +
    `  1. Restart the MCP server (your MCP client will reconnect automatically).\n` +
    `  2. As an in-session fallback, run any \`cartograph <subcommand>\` via CLI ` +
    `(\`npm run cli:dev -- <cmd>\` from a checkout, or \`npx cartograph <cmd>\`) — ` +
    `each invocation spawns a fresh process that loads current code. MCP requests ` +
    `through this stale server stay blocked until restart; use CLI mirrors where ` +
    `available (for example \`cartograph local-chat\`, \`cartograph note list\`, ` +
    `or \`cartograph session list\`).`
  );
}
