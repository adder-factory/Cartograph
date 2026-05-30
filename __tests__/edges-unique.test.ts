/**
 * Edge Uniqueness Tests
 *
 * Regression tests for the bug where `INSERT OR IGNORE INTO edges` was
 * silently a no-op: the only candidate key was the AUTOINCREMENT id (which
 * never conflicts), so duplicate edges accumulated on every re-emission /
 * re-resolution.
 *
 * Fix: a UNIQUE index on (source, target, kind, COALESCE(line, -1),
 * COALESCE(col, -1)) backs a fresh-install schema and is also applied via
 * migration v4 (with a dedup pass over existing rows).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { insertEdge, insertEdges } from '../src/db/queries-edges.js';
import type { Edge, Node } from '../src/types.js';
import { runMigrations, getCurrentVersion, CURRENT_SCHEMA_VERSION } from '../src/db/migrations.js';

function tempDb(): { dir: string; db: DatabaseConnection; q: QueryBuilder } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-edges-unique-'));
  const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
  const q = new QueryBuilder(db.getDb());
  return { dir, db, q };
}

// Seed a row in `files` for the given path so the FK on `nodes.file_path`
// (migration 056) doesn't reject test-only direct inserts. Safe to call
// repeatedly for the same path.
function seedFile(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

function cleanup(dir: string, db: DatabaseConnection) {
  db.close();
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

function makeNode(id: string, name: string): Node {
  return {
    id,
    kind: 'function',
    name,
    qualifiedName: `f::${name}`,
    filePath: 'a.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

function edgesCount(db: DatabaseConnection): number {
  const row = db.getDb().prepare('SELECT COUNT(*) as c FROM edges').get() as { c: number };
  return row.c;
}

describe('Edge UNIQUE constraint (bug #2)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    ({ dir, db, q } = tempDb());
    seedFile(db, 'a.ts');
    q.insertNodes([makeNode('n1', 'foo'), makeNode('n2', 'bar')]);
  });

  afterEach(() => cleanup(dir, db));

  it('rejects duplicate (source, target, kind, line, col)', () => {
    const e: Edge = { source: 'n1', target: 'n2', kind: 'calls', line: 10, column: 5 };
    insertEdge(q, e);
    insertEdge(q, e); // INSERT OR IGNORE — should be a no-op now
    expect(edgesCount(db)).toBe(1);
  });

  it('treats two NULL line edges as duplicates (COALESCE in unique index)', () => {
    const e: Edge = { source: 'n1', target: 'n2', kind: 'calls' };
    insertEdge(q, e);
    insertEdge(q, e);
    expect(edgesCount(db)).toBe(1);
  });

  it('allows same source/target/kind on different lines', () => {
    insertEdge(q, { source: 'n1', target: 'n2', kind: 'calls', line: 1 });
    insertEdge(q, { source: 'n1', target: 'n2', kind: 'calls', line: 2 });
    expect(edgesCount(db)).toBe(2);
  });

  it('allows same source/target/line on different kinds', () => {
    insertEdge(q, { source: 'n1', target: 'n2', kind: 'calls', line: 1 });
    insertEdge(q, { source: 'n1', target: 'n2', kind: 'references', line: 1 });
    expect(edgesCount(db)).toBe(2);
  });

  it('insertEdges (batch) dedupes within the same call', () => {
    const e: Edge = { source: 'n1', target: 'n2', kind: 'calls', line: 1, column: 1 };
    insertEdges(q, [e, e, e]);
    expect(edgesCount(db)).toBe(1);
  });

  it('survives the same edge being re-emitted across many cycles', () => {
    const e: Edge = { source: 'n1', target: 'n2', kind: 'calls', line: 1 };
    for (let i = 0; i < 100; i++) {
      insertEdge(q, e);
    }
    expect(edgesCount(db)).toBe(1);
  });
});

describe('Migration v4: dedup existing edges', () => {
  let dir: string;
  let dbPath: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-migr-v4-'));
    dbPath = path.join(dir, 'test.db');
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('collapses pre-existing duplicates and adds the UNIQUE index', () => {
    // Build a v3-shaped database manually: schema, but simulate a stale
    // version row + insert duplicates that the missing UNIQUE index let
    // through. We use the real initialize() path then drop the index +
    // version row to back-date the DB.
    const db = DatabaseConnection.initialize(dbPath);
    db.getDb().exec(`DROP INDEX IF EXISTS idx_edges_unique;`);
    db.getDb().exec(`DELETE FROM schema_versions;`);
    db.getDb()
      .prepare('INSERT INTO schema_versions (version, applied_at, description) VALUES (3, ?, ?)')
      .run(Date.now(), 'simulated v3');

    const q = new QueryBuilder(db.getDb());
    seedFile(db, 'a.ts');
    q.insertNodes([makeNode('n1', 'foo'), makeNode('n2', 'bar')]);
    // Force-insert duplicates via raw SQL (bypassing the constraint that
    // is now absent). Three rows that should collapse to one.
    const stmt = db.getDb().prepare('INSERT INTO edges (source, target, kind, line, col) VALUES (?, ?, ?, ?, ?)');
    stmt.run('n1', 'n2', 'calls', 10, 5);
    stmt.run('n1', 'n2', 'calls', 10, 5);
    stmt.run('n1', 'n2', 'calls', 10, 5);
    // And one with NULL line/col, also duplicated
    stmt.run('n1', 'n2', 'references', null, null);
    stmt.run('n1', 'n2', 'references', null, null);

    expect(edgesCount(db)).toBe(5);
    expect(getCurrentVersion(db.getDb())).toBe(3);

    // Cap at v8 — the dedup + UNIQUE index actually live in migration
    // 008-edges-unique (the test's "v4" name is historical from a
    // pre-002 numbering that didn't survive the migration-renumber).
    // Capping prevents the chain from dragging in migration 066's
    // node wipe (G7 stable-id rollout), which cascade-deletes the
    // seed edges and defeats the dedup assertion below.
    runMigrations(db.getDb(), 3, 8);

    expect(getCurrentVersion(db.getDb())).toBe(8);
    expect(CURRENT_SCHEMA_VERSION).toBeGreaterThanOrEqual(8);
    // 3 calls dups → 1, 2 references dups → 1
    expect(edgesCount(db)).toBe(2);

    // Now the constraint is enforced: another duplicate insert is a no-op.
    const q2 = new QueryBuilder(db.getDb());
    insertEdge(q2, { source: 'n1', target: 'n2', kind: 'calls', line: 10, column: 5 });
    expect(edgesCount(db)).toBe(2);

    db.close();
  });
});
