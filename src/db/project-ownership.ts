/**
 * Per-project separation on a shared PostgreSQL instance.
 *
 * SQLite gets project separation for free — the database file lives in
 * the project directory. PostgreSQL is one shared server, so the same
 * guarantee has to be manufactured from two halves:
 *
 *  1. **Derived schema names** — when `database.provider` is
 *     `postgres` and no schema was configured, every open derives
 *     `cartograph_<slug>_<hash8>` from the project root instead of
 *     silently landing in `public`. Two projects pointed at the same
 *     server therefore get disjoint schemas without any manual
 *     `--database-schema` bookkeeping. The first read-write open pins
 *     the derived name into `.cartograph/config.json` so a later
 *     directory rename cannot re-derive a different name and "lose"
 *     the index (see `pinDerivedPostgresSchema`).
 *
 *  2. **Ownership stamp** — the first open of a schema records the
 *     project root under the `project_root` metadata key; every
 *     subsequent open verifies it. Two projects misconfigured onto
 *     ONE schema (both explicitly `--database-schema cartograph`,
 *     say) fail loudly on the second project's first open instead of
 *     silently interleaving two file trees into one graph.
 *
 * The stamp comparison uses the canonical (realpath'd) project root,
 * so `/tmp` vs `/private/tmp` style aliases don't false-positive.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { SqliteDatabase } from './sqlite-adapter.js';
import type { DatabaseConfig } from './database-config.js';

/** Env override: re-stamp ownership instead of failing on mismatch.
 *  For the legitimate "I moved/renamed the project" case. */
export const REBIND_ENV = 'CARTOGRAPH_DATABASE_REBIND_PROJECT_ROOT';

/** PostgreSQL identifiers truncate at 63 bytes; the derived name must
 *  stay comfortably inside that budget: `cartograph_` (11) + slug
 *  (≤24) + `_` + hash (8) = ≤44. */
const SCHEMA_SLUG_MAX = 24;
const UNDERSCORE = 0x5f;
const SCHEMA_HASH_LEN = 8;

/** Resolve symlinks so the same directory always canonicalizes to one
 *  string (macOS `/tmp` → `/private/tmp`); fall back to the resolved
 *  path when it does not exist yet (fresh init). */
export function canonicalProjectRoot(projectRoot: string): string {
  const resolved = path.resolve(projectRoot);
  try {
    return fs.realpathSync(resolved);
  } catch {
    return resolved;
  }
}

/** The project root a database path belongs to —
 *  `<root>/.cartograph/cartograph.db` is two levels up. */
export function projectRootFromDbPath(dbPath: string): string {
  return path.dirname(path.dirname(path.resolve(dbPath)));
}

/**
 * Deterministic per-project schema name: `cartograph_<slug>_<hash8>`.
 * The slug keeps the name human-readable in `psql \dn`; the hash of
 * the canonical root makes same-basename projects (`~/a/api`,
 * `~/b/api`) disjoint. Lowercase `[a-z0-9_]` only — safe to splice
 * into `CREATE SCHEMA`/`search_path` without quoting.
 */
export function derivePostgresSchema(projectRoot: string): string {
  const canonical = canonicalProjectRoot(projectRoot);
  const collapsed = path
    .basename(canonical)
    .toLowerCase()
    .replaceAll(/[^a-z0-9]+/g, '_');
  // Trim underscores with index walks, not `/^_+|_+$/` — anchored
  // `x+` trims are the super-linear-backtracking shape Sonar flags,
  // and the loop idiom is this repo's precedent (stripTrailingSlashes).
  let start = 0;
  let end = Math.min(collapsed.length, SCHEMA_SLUG_MAX);
  while (start < end && collapsed.codePointAt(start) === UNDERSCORE) start++;
  while (end > start && collapsed.codePointAt(end - 1) === UNDERSCORE) end--;
  const slug = collapsed.slice(start, end) || 'project';
  const hash = createHash('sha256').update(canonical).digest('hex').slice(0, SCHEMA_HASH_LEN);
  return `cartograph_${slug}_${hash}`;
}

/** Fill in the derived schema on a resolved config (no-op for sqlite
 *  or when a schema was configured explicitly). Returns the same
 *  object for call-site convenience. */
export function withDerivedPostgresSchema(database: DatabaseConfig, projectRoot: string): DatabaseConfig {
  if (database.provider === 'postgres' && !database.schema) {
    database.schema = derivePostgresSchema(projectRoot);
    database.schemaDerived = true;
  }
  return database;
}

/**
 * Verify (or establish) which project owns this schema. Called after
 * migrations on every PostgreSQL open, so `project_metadata` exists.
 *
 *  - no stamp yet → stamp the current root and proceed (first open);
 *  - stamp matches → proceed;
 *  - stamp differs → throw with both roots and the remediations,
 *    unless {@link REBIND_ENV} is set, which re-stamps (the
 *    moved-project escape hatch).
 */
export function enforceProjectRootOwnership(db: SqliteDatabase, dbPath: string, schema: string | undefined): void {
  const root = canonicalProjectRoot(projectRootFromDbPath(dbPath));
  const row = db.prepare(`SELECT value FROM project_metadata WHERE key = 'project_root'`).get() as
    | { value: string }
    | undefined
    | null;
  if (!row) {
    stampProjectRoot(db, root);
    return;
  }
  if (row.value === root) return;
  if (isTruthy(process.env[REBIND_ENV])) {
    stampProjectRoot(db, root);
    return;
  }
  const schemaLabel = schema ?? 'public';
  throw new Error(
    `PostgreSQL schema "${schemaLabel}" is already indexed for a different project root.\n` +
      `  stamped: ${row.value}\n` +
      `  current: ${root}\n\n` +
      `Each project needs its own schema (one schema = one graph). Either:\n` +
      `  - point this project at its own schema: \`--database-schema <name>\` on \`admin init\`, ` +
      `\`database.schema\` in .cartograph/config.json, or CARTOGRAPH_DATABASE_SCHEMA ` +
      `(leave it unset to get an auto-derived per-project schema), or\n` +
      `  - if this project was MOVED from the stamped path, re-bind once with ${REBIND_ENV}=1.`,
  );
}

function stampProjectRoot(db: SqliteDatabase, root: string): void {
  db.prepare(
    `INSERT INTO project_metadata (key, value, updated_at) VALUES ('project_root', ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(root, Date.now());
}

function isTruthy(value: string | undefined): boolean {
  if (value === undefined) return false;
  const normalized = value.toLowerCase();
  return normalized === '1' || normalized === 'true' || normalized === 'yes';
}
