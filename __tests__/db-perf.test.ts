/**
 * DB Performance / Correctness Tests
 *
 * Regression tests for three changes:
 *   1. Batch `getNodesByIds` collapses graph-traversal N+1 reads.
 *   2. `insertNode` invalidates the LRU cache so INSERT OR REPLACE
 *      doesn't serve a stale cached row on next `getNodeById`.
 *   3. `runMaintenance` runs `PRAGMA optimize`, freelist reclaim, and a
 *      bounded WAL truncate after indexAll/sync without throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection, dbOptimize, dbRunMaintenance } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import type { Node } from '../src/types.js';

function makeNode(id: string, name = id): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

// Seed a row in `files` for the given path so the FK on `nodes.file_path`
// (migration 056) doesn't reject test-only direct inserts. Safe to call
// repeatedly for the same path.
function seedFile(db: ReturnType<DatabaseConnection['getDb']>, fpath: string): void {
  db.prepare(
    `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
  ).run(fpath, 'h', 'typescript', 0, 0, 0);
}

describe('getNodesByIds (batch lookup)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-batch-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    seedFile(db.getDb(), 'a.ts');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns a Map keyed by id, with one entry per existing node', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2'), makeNode('n3')]);
    const out = q.getNodesByIds(['n1', 'n2', 'n3']);
    expect(out.size).toBe(3);
    expect(out.get('n1')!.name).toBe('n1');
    expect(out.get('n3')!.name).toBe('n3');
  });

  it('omits missing IDs from the result map (no nulls, no exceptions)', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    const out = q.getNodesByIds(['n1', 'missing', 'n2']);
    expect(out.size).toBe(2);
    expect(out.has('missing')).toBe(false);
    expect(out.has('n1')).toBe(true);
    expect(out.has('n2')).toBe(true);
  });

  it('handles an empty input array', () => {
    expect(q.getNodesByIds([]).size).toBe(0);
  });

  it('handles batches over the SQLite parameter limit (chunking)', () => {
    // Insert 1500 nodes; the helper chunks at 500 internally.
    const nodes = Array.from({ length: 1500 }, (_, i) => makeNode(`n${i}`));
    q.insertNodes(nodes);
    const ids = nodes.map((n) => n.id);
    const out = q.getNodesByIds(ids);
    expect(out.size).toBe(1500);
    // Spot-check a few from the first / middle / last chunk.
    expect(out.has('n0')).toBe(true);
    expect(out.has('n750')).toBe(true);
    expect(out.has('n1499')).toBe(true);
  });

  it('serves cache hits from memory and queries only the misses', () => {
    q.insertNodes([makeNode('n1'), makeNode('n2'), makeNode('n3')]);
    // Warm the cache for n1 only.
    q.getNodeById('n1');
    // Replace the underlying row to make a miss-vs-cache-hit detectable.
    db.getDb().prepare('UPDATE nodes SET name = ? WHERE id = ?').run('changed', 'n1');
    const out = q.getNodesByIds(['n1', 'n2']);
    // The cached n1 (still 'n1', not 'changed') must be returned.
    expect(out.get('n1')!.name).toBe('n1');
    expect(out.get('n2')!.name).toBe('n2');
  });
});

describe('insertNode cache invalidation', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-cache-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    seedFile(db.getDb(), 'a.ts');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('does not serve a stale cached node after INSERT OR REPLACE', () => {
    // Regression: insertNode (which uses INSERT OR REPLACE) used to skip
    // cache invalidation, so the next getNodeById returned the pre-replace
    // version until LRU eviction.
    const original = makeNode('n1', 'oldName');
    q.insertNode(original);
    const beforeReplace = q.getNodeById('n1');
    expect(beforeReplace!.name).toBe('oldName');

    // Replace via insertNode (the bug path).
    q.insertNode({ ...original, name: 'newName', updatedAt: Date.now() });
    const afterReplace = q.getNodeById('n1');
    expect(afterReplace!.name).toBe('newName');
  });
});

describe('runMaintenance', () => {
  let dir: string;
  let db: DatabaseConnection;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-maint-'));
    dbPath = path.join(dir, 'test.db');
    db = DatabaseConnection.initialize(dbPath);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('runs without throwing on a fresh database', () => {
    expect(() => dbRunMaintenance(db)).not.toThrow();
  });

  it('runs without throwing after writes', () => {
    const q = new QueryBuilder(db.getDb());
    seedFile(db.getDb(), 'a.ts');
    q.insertNodes([makeNode('n1'), makeNode('n2')]);
    expect(() => dbRunMaintenance(db)).not.toThrow();
  });

  it('truncates the WAL after write-heavy maintenance', () => {
    const walPath = `${dbPath}-wal`;
    const sql = db.getDb();
    sql.exec('CREATE TABLE _wal_bloat (b BLOB)');
    const stmt = sql.prepare('INSERT INTO _wal_bloat VALUES (?)');
    for (let i = 0; i < 16; i++) stmt.run(Buffer.alloc(64 * 1024));

    const before = fs.statSync(walPath).size;
    expect(before).toBeGreaterThan(0);

    dbRunMaintenance(db);

    const after = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
    expect(after).toBeLessThan(before);
    expect(after).toBeLessThan(64 * 1024);
  });

  it('swallows failures rather than propagating (best-effort)', () => {
    // Close the DB so the underlying handle would normally throw on any
    // exec(). runMaintenance must still not propagate.
    db.close();
    expect(() => dbRunMaintenance(db)).not.toThrow();
  });

  function postgresMaintenanceConnection(statements: string[]) {
    return {
      getBackend(): 'postgres' {
        return 'postgres';
      },
      getDb() {
        return {
          exec(sql: string): void {
            statements.push(sql);
          },
          pragma<T = unknown>(): T {
            throw new Error('PostgreSQL maintenance must not read SQLite pragmas');
          },
        };
      },
    };
  }

  it('does not analyze PostgreSQL after an idle sync', () => {
    const statements: string[] = [];

    dbRunMaintenance(postgresMaintenanceConnection(statements), 'idle');

    expect(statements).toEqual([]);
  });

  it('analyzes only the current PostgreSQL schema after writes with skip-locked relation acquisition', () => {
    const statements: string[] = [];

    dbRunMaintenance(postgresMaintenanceConnection(statements), 'after-write');

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('n.nspname = current_schema()');
    expect(statements[0]).toContain("c.relkind IN ('r', 'p', 'm')");
    expect(statements[0]).toContain('ANALYZE (SKIP_LOCKED)');
    expect(statements[0]?.trim()).not.toBe('ANALYZE');
  });

  it('routes explicit PostgreSQL optimization through scoped maintenance', () => {
    const statements: string[] = [];

    dbOptimize(postgresMaintenanceConnection(statements));

    expect(statements).toHaveLength(1);
    expect(statements[0]).toContain('n.nspname = current_schema()');
    expect(statements[0]).toContain('ANALYZE (SKIP_LOCKED)');
  });
});

describe('auto-vacuum / freelist reclaim', () => {
  // Mirrors RECLAIM_FREELIST_RATIO in src/db/index.ts (module-private there).
  const RECLAIM_THRESHOLD = 0.25;
  let dir: string;
  let conn: DatabaseConnection;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'db-perf-vac-'));
    conn = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  });

  afterEach(() => {
    if (conn.isOpen()) conn.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  /** Read a single-value integer PRAGMA. node:sqlite returns one row
   *  object; better-sqlite3 returns an array of rows — handle both. */
  function pragmaInt(name: string): number {
    const raw = conn.getDb().pragma(name);
    const row = (Array.isArray(raw) ? raw[0] : raw) as Record<string, number>;
    return Number(Object.values(row)[0]);
  }

  /** Insert then drop a temp table to push ~`bytes` of pages onto the freelist. */
  function bloatFreelist(bytes: number): void {
    const db = conn.getDb();
    db.exec('CREATE TABLE _bloat (b BLOB)');
    const chunk = Buffer.alloc(64 * 1024);
    const stmt = db.prepare('INSERT INTO _bloat VALUES (?)');
    for (let written = 0; written < bytes; written += chunk.length) stmt.run(chunk);
    db.exec('DROP TABLE _bloat');
  }

  it('creates new databases in incremental auto-vacuum mode', () => {
    // auto_vacuum: 0 = none, 1 = full, 2 = incremental.
    expect(pragmaInt('auto_vacuum')).toBe(2);
  });

  it('reclaims freelist pages on an incremental DB via dbRunMaintenance', () => {
    bloatFreelist(3 * 1024 * 1024);
    expect(pragmaInt('freelist_count')).toBeGreaterThan(0);

    dbRunMaintenance(conn);

    // incremental_vacuum returns every free page to the OS — no full
    // rewrite, no auto_vacuum mode change.
    expect(pragmaInt('freelist_count')).toBe(0);
    expect(pragmaInt('auto_vacuum')).toBe(2);
  });

  it('VACUUMs and converts a legacy auto_vacuum=0 DB bloated past the threshold', () => {
    const db = conn.getDb();
    // Simulate a pre-feature DB: a full VACUUM at auto_vacuum=0 rewrites
    // the file in legacy mode.
    db.exec('PRAGMA auto_vacuum = 0');
    db.exec('VACUUM');
    expect(pragmaInt('auto_vacuum')).toBe(0);

    bloatFreelist(3 * 1024 * 1024);
    const freeBefore = pragmaInt('freelist_count');
    expect(freeBefore / pragmaInt('page_count')).toBeGreaterThan(RECLAIM_THRESHOLD);

    dbRunMaintenance(conn);

    // The one-time full VACUUM both reclaimed the dead pages AND
    // converted the file to incremental mode for good.
    expect(pragmaInt('auto_vacuum')).toBe(2);
    expect(pragmaInt('freelist_count')).toBeLessThan(freeBefore);
  });

  it('leaves a legacy DB untouched when its freelist is below the threshold', () => {
    const db = conn.getDb();
    db.exec('PRAGMA auto_vacuum = 0');
    db.exec('VACUUM');
    expect(pragmaInt('auto_vacuum')).toBe(0);

    // No bloat — a healthy legacy DB. Maintenance must not pay the cost
    // of a full VACUUM, so the file stays in legacy mode.
    dbRunMaintenance(conn);
    expect(pragmaInt('auto_vacuum')).toBe(0);
  });
});
