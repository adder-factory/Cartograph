/**
 * Database Migrations — runner + backward-compat surface.
 *
 * The migration definitions themselves live in
 * `./migrations/<NNN>-<name>.ts`, one file per migration, with
 * version derived from the filename prefix. This file is the
 * runner (read schema_versions, apply pending in order) and the
 * stable API surface that the rest of the codebase imports.
 *
 * Adding a migration: see `./migrations/index.ts`.
 */

import * as fs from 'fs';
import * as path from 'path';

import type { SqliteDatabase } from './sqlite-adapter.js';
import { ALL_MIGRATIONS } from './migrations/index.js';

/**
 * Highest registered migration version. Derived from the registry
 * (last entry by version) so adding a migration requires no
 * hand-maintained constant.
 */
export const CURRENT_SCHEMA_VERSION: number = ALL_MIGRATIONS[ALL_MIGRATIONS.length - 1]!.version;

/**
 * Get the current schema version from the database
 */
export function getCurrentVersion(db: SqliteDatabase): number {
  try {
    const row = db.prepare('SELECT MAX(version) as version FROM schema_versions').get() as
      | { version: number | null }
      | undefined;
    return row?.version ?? 0;
  } catch {
    // Table doesn't exist yet
    return 0;
  }
}

/**
 * Record a migration as applied
 */
function recordMigration(db: SqliteDatabase, version: number, description: string): void {
  db.prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)').run(
    version,
    Date.now(),
    description,
  );
}

/**
 * Run pending migrations. `targetVersion` (optional) caps how far
 * forward to migrate — useful for tests that exercise a narrow band
 * of migrations against a minimal hand-built fixture and don't want
 * the chain to keep going through every later migration whose
 * dependencies the fixture doesn't satisfy. When omitted, every
 * pending migration runs (production behaviour).
 */
export function runMigrations(db: SqliteDatabase, fromVersion: number, targetVersion?: number): void {
  const pending = ALL_MIGRATIONS.filter(
    (m) => m.version > fromVersion && (targetVersion === undefined || m.version <= targetVersion),
  );
  if (pending.length === 0) return;

  // ALL_MIGRATIONS is already sorted by version, but filtering can
  // be cheap to re-confirm.
  const ordered = [...pending].sort((a, b) => a.version - b.version);

  for (const migration of ordered) {
    // SQLite ignores `PRAGMA foreign_keys` changes inside an active
    // transaction, so any migration that needs FK enforcement
    // disabled (e.g. a table-rebuild swapping a parent table) must
    // toggle the PRAGMA OUTSIDE the transaction. Default migrations
    // run with FKs enabled to catch invariant violations early.
    if (migration.requiresFkDisable) {
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.transaction(() => {
          migration.up(db);
          recordMigration(db, migration.version, migration.description);
        })();
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
    } else {
      db.transaction(() => {
        migration.up(db);
        recordMigration(db, migration.version, migration.description);
      })();
    }
  }

  // Post-migration integrity check. If any migration silently dropped
  // a table its `up()` was supposed to create (the migration-054
  // swallow class of bug, friction F1 / 2026-05-11), refuse to mark
  // the DB as fully migrated and surface the missing names. Bypass
  // with CARTOGRAPH_SKIP_SCHEMA_INTEGRITY_CHECK=1 only when a partial
  // test fixture intentionally omits tables. Also skipped on targeted
  // (`targetVersion` set) runs — by definition the fixture isn't yet
  // at the canonical post-migration shape.
  if (targetVersion === undefined && !process.env['CARTOGRAPH_SKIP_SCHEMA_INTEGRITY_CHECK']) {
    verifyMigratedSchemaIntegrity(db);
  }
}

/**
 * Names parsed from `schema.sql` once at module load. The file is the
 * canonical post-migration shape — every name here must exist in
 * `sqlite_master` after `runMigrations` finishes.
 */
const SCHEMA_SQL_OBJECTS = parseSchemaSqlObjects();

/**
 * Parse every `CREATE TABLE` / `CREATE VIRTUAL TABLE` / `CREATE VIEW`
 * name out of `schema.sql`. Single shared regex pass; comments are
 * tolerated (they can't contain a CREATE keyword in the canonical
 * file). Done at module load so the cost is paid once.
 */
function parseSchemaSqlObjects(): { tables: ReadonlySet<string>; views: ReadonlySet<string> } {
  const schemaPath = path.join(import.meta.dirname, 'schema.sql');
  const src = fs.readFileSync(schemaPath, 'utf-8');
  const tables = new Set<string>();
  const views = new Set<string>();
  const re = /CREATE\s+(VIRTUAL\s+TABLE|TABLE|VIEW)\s+(?:IF\s+NOT\s+EXISTS\s+)?([A-Za-z_][A-Za-z0-9_]*)/gi;
  for (;;) {
    const m = re.exec(src);
    if (!m) break;
    const kind = m[1]!.toUpperCase();
    const name = m[2]!;
    if (kind === 'VIEW') views.add(name);
    else tables.add(name);
  }
  return { tables, views };
}

/**
 * Same check as the runMigrations post-condition, exported so the
 * fresh-bootstrap path (`DatabaseConnection.initialize`) can run it
 * after applying `schema.sql`. A typo in schema.sql that omits a
 * table would otherwise produce a fresh install that silently
 * diverges from the migrated shape.
 */
export function verifySchemaIntegrity(db: SqliteDatabase): void {
  if (process.env['CARTOGRAPH_SKIP_SCHEMA_INTEGRITY_CHECK']) return;
  verifyMigratedSchemaIntegrity(db);
}

/**
 * Assert every table / view declared by `schema.sql` exists in
 * `sqlite_master` after migrations have run. Throws with a list of
 * missing names so the caller (host process, test) can surface the
 * exact repair path.
 */
function verifyMigratedSchemaIntegrity(db: SqliteDatabase): void {
  const present = new Set(
    (db.prepare("SELECT name FROM sqlite_master WHERE type IN ('table', 'view')").all() as Array<{ name: string }>).map(
      (r) => r.name,
    ),
  );
  const missingTables: string[] = [];
  for (const name of SCHEMA_SQL_OBJECTS.tables) {
    if (!present.has(name)) missingTables.push(name);
  }
  const missingViews: string[] = [];
  for (const name of SCHEMA_SQL_OBJECTS.views) {
    if (!present.has(name)) missingViews.push(name);
  }
  if (missingTables.length === 0 && missingViews.length === 0) return;
  const parts: string[] = [];
  if (missingTables.length > 0) parts.push(`tables: ${missingTables.join(', ')}`);
  if (missingViews.length > 0) parts.push(`views: ${missingViews.join(', ')}`);
  throw new Error(
    `[Cartograph] post-migration integrity check failed — schema.sql declares ` +
      `objects missing from the DB after runMigrations completed (${parts.join('; ')}). ` +
      `This usually means a prior migration silently swallowed a CREATE error ` +
      `(see migration 054's pre-rethrow swallow). Fix: open an issue and capture ` +
      `the schema_versions table; the missing objects can typically be repaired ` +
      `with a follow-up migration (see 057-repair-strictify-drops.ts as a precedent).`,
  );
}

// Re-export the registry surface for callers that want it.
export { ALL_MIGRATIONS } from './migrations/index.js';
export type { Migration, MigrationModule } from './migrations/types.js';
