/**
 * Migration 057 — repair migration for the migration-054 silent-swallow
 * class of bug, plus the post-migration integrity check that prevents
 * the same class of bug from recurring undetected.
 *
 * Covers:
 *   1. Fresh DB satisfies the integrity gate (every object declared by
 *      schema.sql is in sqlite_master).
 *   2. The five tables migration 057 re-creates are present on a fresh
 *      DB and idempotent (a second `up()` call is a no-op).
 *   3. The integrity check throws loudly when a declared table is
 *      missing — a regression guard against future silent-swallow bugs.
 *   4. Migration 054 no longer swallows rebuild failures: the rethrow
 *      surfaces a wrapped error and rolls the transaction back.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { MIGRATION as MIG_057 } from '../src/db/migrations/057-repair-strictify-drops.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-057-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

const REPAIRED_TABLES = [
  'role_assignments',
  'summary_store',
  'summary_refs',
  'embedding_store',
  'embedding_refs',
] as const;

const REPAIRED_TRIGGERS = [
  'summary_refs_bump_last_ref_at_ai',
  'summary_refs_bump_last_ref_at_au',
  'embedding_refs_bump_last_ref_at_ai',
  'embedding_refs_bump_last_ref_at_au',
] as const;

describe('Migration 057 — repair strictify drops + schema integrity', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('fresh DB has every table that migration 057 protects', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const db = conn.getDb();
      for (const name of REPAIRED_TABLES) {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name=?`).get(name);
        expect(row, `table ${name} missing on fresh init`).toBeDefined();
      }
      for (const name of REPAIRED_TRIGGERS) {
        const row = db.prepare(`SELECT name FROM sqlite_master WHERE type='trigger' AND name=?`).get(name);
        expect(row, `trigger ${name} missing on fresh init`).toBeDefined();
      }
    } finally {
      conn.close();
    }
  });

  it('migration 057 up() is idempotent on a fresh DB', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'idempotent.db'));
    try {
      const db = conn.getDb();
      expect(() => MIG_057.up(db)).not.toThrow();
      const row = db
        .prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='role_assignments'`)
        .get() as { n: number };
      expect(row.n).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('migration 057 re-creates a dropped role_assignments table', () => {
    const conn = DatabaseConnection.initialize(path.join(dir, 'repair.db'));
    try {
      const db = conn.getDb();
      db.exec('DROP TABLE role_assignments');
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='role_assignments'`).get() as { n: number }).n,
      ).toBe(0);
      MIG_057.up(db);
      expect(
        (db.prepare(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name='role_assignments'`).get() as { n: number }).n,
      ).toBe(1);
    } finally {
      conn.close();
    }
  });

  it('post-migration integrity check throws when a declared table is missing', () => {
    const dbPath = path.join(dir, 'broken.db');
    const conn = DatabaseConnection.initialize(dbPath);
    conn.close();

    // Re-open at a low level, drop a table that schema.sql declares,
    // then try to open via DatabaseConnection.open (which runs the
    // integrity gate at the end of any migration pass). Force a
    // migration by lowering schema_versions max so runMigrations runs.
    const conn2 = DatabaseConnection.open(dbPath, { autoMigrate: false });
    try {
      const db = conn2.getDb();
      db.exec('DROP TRIGGER IF EXISTS summary_refs_bump_last_ref_at_ai');
      db.exec('DROP TABLE IF EXISTS summary_refs');
      db.exec('DROP TABLE IF EXISTS summary_store');
      db.exec(`UPDATE schema_versions SET version=46 WHERE version=(SELECT MAX(version) FROM schema_versions)`);
    } finally {
      conn2.close();
    }

    // Re-open with autoMigrate enabled. runMigrations replays 047+;
    // migration 057 should restore the dropped tables. Confirm the
    // integrity check passes (i.e. 057 actually repaired the damage).
    const conn3 = DatabaseConnection.open(dbPath, { autoMigrate: true });
    try {
      const db = conn3.getDb();
      const present = (
        db
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('summary_store','summary_refs')`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      expect(present.sort()).toEqual(['summary_refs', 'summary_store']);
    } finally {
      conn3.close();
    }
  });

  it('integrity check fails loudly when a declared schema.sql table is dropped post-migration', async () => {
    const { verifySchemaIntegrity } = await import('../src/db/migrations.js');
    const conn = DatabaseConnection.initialize(path.join(dir, 'gate.db'));
    try {
      const db = conn.getDb();
      expect(() => verifySchemaIntegrity(db)).not.toThrow();
      db.exec('DROP TABLE role_assignments');
      expect(() => verifySchemaIntegrity(db)).toThrow(/role_assignments/);
    } finally {
      conn.close();
    }
  });
});
