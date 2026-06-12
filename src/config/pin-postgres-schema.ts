import type { CartographConfig } from '../types.js';
import { saveConfig } from '../config.js';
import { derivePostgresSchema } from '../db/project-ownership.js';

/**
 * Pin the auto-derived PostgreSQL schema into the project config.
 * The derived name hashes the project's absolute path, so a later
 * directory rename would silently re-derive a DIFFERENT schema and
 * the index would appear to vanish. Persisting the name on the first
 * config-driven open makes it travel with the project. Only applies
 * to config-file-driven postgres setups with no explicit schema
 * anywhere (config or CARTOGRAPH_DATABASE_SCHEMA) — env-only setups
 * are left untouched so removing the env vars cleanly returns the
 * project to sqlite.
 */
export function pinDerivedPostgresSchema(projectRoot: string, config: CartographConfig): void {
  const db = config.database;
  if (db?.provider !== 'postgres') return;
  if (db.schema || process.env['CARTOGRAPH_DATABASE_SCHEMA']) return;
  db.schema = derivePostgresSchema(projectRoot);
  saveConfig(projectRoot, config);
}
