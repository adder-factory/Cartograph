/**
 * Migration 062 — node_id FK on role_assignments + dead-node orphan reap.
 *
 * Verifies:
 *   - Fresh DB has the FK declared on role_assignments (added by the
 *     migration's rebuild, since schema.sql declares the no-FK shape
 *     and `INSERT OR IGNORE INTO schema_versions(CURRENT_SCHEMA_VERSION)`
 *     marks migrations applied on fresh installs — so we exercise the
 *     migration directly here via a forced replay).
 *   - Insert of an orphan row (node_id with no matching nodes row) is
 *     rejected with FOREIGN KEY constraint failed.
 *   - Pre-existing orphan rows are reaped when the migration is replayed
 *     against a DB that had them before the FK was added.
 *   - Deleting a `nodes` row CASCADEs the dependent role_assignment.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { MIGRATION as MIG_062 } from '../src/db/migrations/062-role-assignments-fk-cascade.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-062-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function seedNode(db: ReturnType<DatabaseConnection['getDb']>, id: string): void {
  // First make sure the parent file exists for the file_path FK
  // added by migration 056.
  const filePath = `src/${id}.ts`;
  db.prepare(
    `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(filePath, 'h', 'typescript', 0, 0, 0);
  db.prepare(
    `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(id, 's', 's', 'function', 'typescript', filePath, 1, 2, 0, 0, 0, '');
}

describe('Migration 062 — role_assignments node_id FK + orphan reap', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('fresh DB declares the FK on role_assignments after replay', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const db = dbConn.getDb();
      // Force migration replay: schema.sql still has the no-FK shape on
      // fresh installs, so we manually re-run the migration here.
      MIG_062.up(db);
      const sqlRow = db
        .prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='role_assignments'`)
        .get() as { sql: string };
      expect(sqlRow.sql).toMatch(/FOREIGN\s+KEY\s*\(\s*node_id\s*\)\s+REFERENCES\s+nodes/i);
    } finally {
      dbConn.close();
    }
  });

  it('rejects insert with non-existent node_id after migration', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'reject.db'));
    try {
      const db = dbConn.getDb();
      MIG_062.up(db);
      expect(() =>
        db
          .prepare(
            `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('n_missing', 'business_logic', 'test', '', 0),
      ).toThrow(/FOREIGN KEY constraint failed/);
    } finally {
      dbConn.close();
    }
  });

  it('reaps pre-existing orphan rows during migration replay', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'reap.db'));
    try {
      const db = dbConn.getDb();
      // Seed: 1 live node + 1 orphan role_assignment.
      // We have to do this BEFORE the migration adds the FK, so
      // temporarily disable FK to insert the orphan, then run the
      // migration which will reap it.
      seedNode(db, 'n_live');
      db.exec('PRAGMA foreign_keys = OFF');
      try {
        db.prepare(
          `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at) VALUES (?, ?, ?, ?, ?)`,
        ).run('n_live', 'business_logic', 'test', '', 0);
        db.prepare(
          `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at) VALUES (?, ?, ?, ?, ?)`,
        ).run('n_orphan', 'business_logic', 'test', '', 0);
      } finally {
        db.exec('PRAGMA foreign_keys = ON');
      }
      const before = (db.prepare(`SELECT COUNT(*) AS n FROM role_assignments`).get() as { n: number }).n;
      expect(before).toBe(2);

      MIG_062.up(db);

      const after = (db.prepare(`SELECT COUNT(*) AS n FROM role_assignments`).get() as { n: number }).n;
      expect(after).toBe(1); // orphan reaped, live row preserved
      const orphanCount = (
        db
          .prepare(
            `SELECT COUNT(*) AS n FROM role_assignments ra LEFT JOIN nodes n ON n.id = ra.node_id WHERE n.id IS NULL`,
          )
          .get() as { n: number }
      ).n;
      expect(orphanCount).toBe(0);
    } finally {
      dbConn.close();
    }
  });

  it('CASCADEs role_assignment rows when parent node is deleted', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'cascade.db'));
    try {
      const db = dbConn.getDb();
      MIG_062.up(db);

      seedNode(db, 'n_doomed');
      db.prepare(
        `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at) VALUES (?, ?, ?, ?, ?)`,
      ).run('n_doomed', 'business_logic', 'test', '', 0);

      const before = (db.prepare(`SELECT COUNT(*) AS n FROM role_assignments`).get() as { n: number }).n;
      expect(before).toBe(1);

      db.prepare(`DELETE FROM nodes WHERE id = ?`).run('n_doomed');

      const after = (db.prepare(`SELECT COUNT(*) AS n FROM role_assignments`).get() as { n: number }).n;
      expect(after).toBe(0);
    } finally {
      dbConn.close();
    }
  });

  it('is idempotent — re-running the migration is a no-op', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'idempotent.db'));
    try {
      const db = dbConn.getDb();
      MIG_062.up(db); // first replay adds the FK
      const firstSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='role_assignments'`).get() as {
          sql: string;
        }
      ).sql;
      MIG_062.up(db); // second replay should detect the FK and skip
      const secondSql = (
        db.prepare(`SELECT sql FROM sqlite_master WHERE type='table' AND name='role_assignments'`).get() as {
          sql: string;
        }
      ).sql;
      expect(secondSql).toBe(firstSql);
    } finally {
      dbConn.close();
    }
  });
});
