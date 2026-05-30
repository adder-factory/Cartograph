/**
 * Migration registry types.
 *
 * Each migration ships its own self-contained file
 * (`./NNN-description.ts`) exporting a `MIGRATION:
 * MigrationModule`. The version number is derived from the
 * leading 3-digit prefix on the filename, NOT from a field in the
 * module — this guarantees no two PRs can claim the same version
 * silently (filenames collide on the filesystem; SQL migrations
 * never silently no-op).
 */

import type { SqliteDatabase } from '../sqlite-adapter.js';

export interface MigrationModule {
  /** One-line description for `schema_versions` table + diagnostics. */
  readonly description: string;
  /** The actual schema-mutation function. Wrapped in a transaction. */
  readonly up: (db: SqliteDatabase) => void;
  /**
   * Set to `true` when the migration must run with FK enforcement
   * disabled (e.g. table-rebuild migrations that swap a parent table
   * out from under existing FK references). The runner issues
   * `PRAGMA foreign_keys = OFF` BEFORE opening the transaction and
   * `... = ON` after — `PRAGMA foreign_keys` is silently ignored
   * inside an active transaction, so toggling it from inside `up()`
   * is a no-op.
   *
   * Default `false` — most schema additions and column-only changes
   * leave existing FK invariants intact and don't need this.
   */
  readonly requiresFkDisable?: boolean;
}

export interface Migration extends MigrationModule {
  /** Version derived from filename's leading NNN prefix. */
  readonly version: number;
}
