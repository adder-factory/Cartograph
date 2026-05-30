/**
 * Migration 054 — convert every base table to SQLite STRICT.
 *
 * Verifies:
 *   - Fresh DB: every base table is declared STRICT (PRAGMA tbl_info).
 *   - Runtime enforcement: writing a TEXT into an INTEGER column now
 *     raises a type error (in pre-STRICT loose typing it would have
 *     silently coerced or stored as a string).
 *   - `code_health_findings.metric` was promoted from INTEGER to REAL
 *     (brain_method emits a fractional composite score).
 *   - Virtual tables (FTS5 / RTree) and their shadow backing tables
 *     are NOT strictified — they have their own type system that
 *     would reject the keyword.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { createDatabase } from '../src/db/sqlite-adapter.js';
import { strictifyTable } from '../src/db/migrations/054-strict-tables.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-mig-054-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('Migration 054 — STRICT tables', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => {
    cleanup(dir);
  });

  it('fresh DB has STRICT on every base table (and not on virtual / shadow)', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'fresh.db'));
    try {
      const rows = dbConn
        .getDb()
        .prepare(
          `SELECT name, sql FROM sqlite_master WHERE type='table' AND sql IS NOT NULL AND name NOT LIKE 'sqlite_%'`,
        )
        .all() as Array<{ name: string; sql: string }>;
      // Partition into base tables vs virtual-shadow tables.
      const virtualNames = (
        dbConn
          .getDb()
          .prepare(`SELECT name FROM sqlite_master WHERE type='table' AND sql LIKE 'CREATE VIRTUAL TABLE%'`)
          .all() as Array<{ name: string }>
      ).map((r) => r.name);
      const isShadow = (n: string) => virtualNames.some((v) => n.startsWith(`${v}_`)) || n.startsWith('vec_');
      const baseTables = rows.filter((r) => !virtualNames.includes(r.name) && !isShadow(r.name));
      expect(baseTables.length).toBeGreaterThan(20);
      const notStrict = baseTables.filter((t) => !/\bSTRICT\b/i.test(t.sql));
      expect(notStrict.map((t) => t.name)).toEqual([]);
    } finally {
      dbConn.close();
    }
  });

  it('STRICT actually rejects a TEXT-into-INTEGER write', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'strict.db'));
    try {
      // schema_versions.version is INTEGER PRIMARY KEY. Inserting a string
      // would have silently coerced (or stored as text) before STRICT;
      // STRICT raises immediately.
      expect(() =>
        dbConn
          .getDb()
          .prepare(`INSERT INTO schema_versions (version, applied_at, description) VALUES (?, ?, ?)`)
          .run('not_a_number', Date.now(), 'bogus'),
      ).toThrow();
    } finally {
      dbConn.close();
    }
  });

  it('code_health_findings.metric was promoted to REAL', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'real.db'));
    try {
      const cols = dbConn.getDb().prepare(`PRAGMA table_info('code_health_findings')`).all() as Array<{
        name: string;
        type: string;
      }>;
      const metric = cols.find((c) => c.name === 'metric');
      expect(metric?.type).toBe('REAL');
    } finally {
      dbConn.close();
    }
  });

  it('CHECK constraint on nodes.kind rejects typos', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'check-kind.db'));
    try {
      const db = dbConn.getDb();
      // Seed the files row that nodes.file_path FK (migration 056) requires.
      db.prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('a.ts', 'h', 'typescript', 0, 0, 0);
      // 'function' (legal) succeeds.
      expect(() =>
        db.exec(
          `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES ('n_ok', 'f', 'f', 'function', 'typescript', 'a.ts', 1, 2, 0, 0, 0, '')`,
        ),
      ).not.toThrow();
      // 'funtion' (typo) should be rejected.
      expect(() =>
        db.exec(
          `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES ('n_bad', 'f', 'f', 'funtion', 'typescript', 'a.ts', 1, 2, 0, 0, 0, '')`,
        ),
      ).toThrow(/CHECK constraint failed/);
    } finally {
      dbConn.close();
    }
  });

  it('CHECK constraint on edges.kind rejects bogus values', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'check-edge.db'));
    try {
      const db = dbConn.getDb();
      // Seed the files rows that nodes.file_path FK (migration 056) requires.
      const insFile = db.prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      );
      insFile.run('a.ts', 'h', 'typescript', 0, 0, 0);
      insFile.run('b.ts', 'h', 'typescript', 0, 0, 0);
      db.exec(
        `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES ('a', 'a', 'a', 'function', 'typescript', 'a.ts', 1, 2, 0, 0, 0, '')`,
      );
      db.exec(
        `INSERT INTO nodes (id, name, qualified_name, kind, language, file_path, start_line, end_line, start_column, end_column, updated_at, body_hash) VALUES ('b', 'b', 'b', 'function', 'typescript', 'b.ts', 1, 2, 0, 0, 0, '')`,
      );
      expect(() => db.exec(`INSERT INTO edges (source, target, kind) VALUES ('a', 'b', 'totally_bogus_kind')`)).toThrow(
        /CHECK constraint failed/,
      );
    } finally {
      dbConn.close();
    }
  });

  it('REAL metric accepts a fractional brain_method score', () => {
    const dbConn = DatabaseConnection.initialize(path.join(dir, 'frac.db'));
    try {
      const db = dbConn.getDb();
      // Seed the files row that nodes.file_path FK (migration 056) requires.
      db.prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      ).run('src/m.ts', 'h', 'typescript', 0, 0, 0);
      // Need a node row to satisfy the FK.
      db.exec(`
        INSERT INTO nodes (
          id, name, qualified_name, kind, language, file_path,
          start_line, end_line, start_column, end_column, updated_at, body_hash
        )
        VALUES ('n_metric', 'm', 'm', 'function', 'typescript', 'src/m.ts', 1, 10, 0, 0, 0, '');
      `);
      expect(() =>
        db
          .prepare(
            `INSERT INTO code_health_findings (node_id, biomarker, severity, metric, detected_at) VALUES (?, ?, ?, ?, ?)`,
          )
          .run('n_metric', 'brain_method', 'warning', 12.345, 0),
      ).not.toThrow();
      const row = db.prepare(`SELECT metric FROM code_health_findings WHERE node_id = 'n_metric'`).get() as {
        metric: number;
      };
      expect(row.metric).toBeCloseTo(12.345, 3);
    } finally {
      dbConn.close();
    }
  });

  it('coerces a legacy REAL modified_at into the STRICT INTEGER column instead of crashing', () => {
    // Pre-054 indexes (built before the extractor floored stats.mtimeMs)
    // stored files.modified_at as a fractional REAL via loose type
    // affinity. A blind `SELECT *` strict-copy throws "cannot store REAL
    // value in INTEGER column"; the CAST-coercing copy must floor it into
    // the STRICT INTEGER column. Regression for the migration-054 crash
    // that blocked every pre-054 (v53) index from opening on a newer binary.
    const { db } = createDatabase(path.join(dir, 'real-coerce.db'));
    try {
      const createSql =
        'CREATE TABLE files (' +
        'path TEXT PRIMARY KEY, content_hash TEXT NOT NULL, language TEXT, ' +
        'size INTEGER NOT NULL, modified_at INTEGER NOT NULL, indexed_at INTEGER NOT NULL)';
      db.exec(createSql);
      // Loose (non-STRICT) affinity lets the REAL in — the pre-054 state.
      db.prepare('INSERT INTO files VALUES (?, ?, ?, ?, ?, ?)').run(
        'a.ts',
        'h',
        'typescript',
        100,
        1778438740299.182,
        0,
      );
      expect((db.prepare('SELECT typeof(modified_at) AS t FROM files').get() as { t: string }).t).toBe('real');

      expect(() => strictifyTable(db, { name: 'files', sql: createSql })).not.toThrow();

      const row = db.prepare('SELECT modified_at AS m, typeof(modified_at) AS t FROM files').get() as {
        m: number;
        t: string;
      };
      expect(row.t).toBe('integer'); // coerced from REAL
      expect(row.m).toBe(1778438740299); // CAST AS INTEGER truncates the fraction (matches the write-path Math.floor)
      const sql = (db.prepare("SELECT sql FROM sqlite_master WHERE name='files'").get() as { sql: string }).sql;
      expect(/\bSTRICT\b/i.test(sql)).toBe(true);
    } finally {
      db.close();
    }
  });
});
