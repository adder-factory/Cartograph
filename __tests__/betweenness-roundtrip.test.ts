/**
 * End-to-end test for the G23 persist path: migration 068 adds the
 * `nodes.betweenness` column, `runBetweennessPass` reads the edge
 * subgraph, runs Brandes, writes scores back through
 * `applyBetweennessScores`. Round-trip checks that the column
 * exists, the index exists, and a high-betweenness bridge node ends
 * up with a strictly larger persisted score than non-bridge nodes.
 *
 * Mirrors the at-range fixture pattern (direct DB seed + minimal
 * helper). No Cartograph-class wrapping needed.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { runBetweennessPass } from '../src/centrality/betweenness-pass.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-betweenness-roundtrip-'));
}

function seedFile(db: DatabaseConnection, fpath: string): void {
  db.getDb()
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'h', 'typescript', 0, 0, 0);
}

function insertFn(qb: QueryBuilder, id: string, name: string): void {
  qb.insertNode({
    id,
    kind: 'function',
    name,
    qualifiedName: name,
    filePath: 'src/file.ts',
    language: 'typescript',
    startLine: 1,
    endLine: 2,
    startColumn: 0,
    endColumn: 1,
    updatedAt: Date.now(),
  });
}

function insertCall(qb: QueryBuilder, source: string, target: string): void {
  qb.db.prepare("INSERT OR IGNORE INTO edges (source, target, kind) VALUES (?, ?, 'calls')").run(source, target);
}

describe('runBetweennessPass — migration + persist round-trip (G23)', () => {
  let testDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    testDir = createTempDir();
    db = DatabaseConnection.initialize(path.join(testDir, 'cartograph.db'));
    qb = new QueryBuilder(db.getDb());
    seedFile(db, 'src/file.ts');
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('migration 068 added the betweenness column + DESC index', () => {
    const cols = db.getDb().prepare('PRAGMA table_info(nodes)').all() as Array<{ name: string }>;
    expect(cols.some((c) => c.name === 'betweenness')).toBe(true);
    const idx = db
      .getDb()
      .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'idx_nodes_betweenness'")
      .get();
    expect(idx).toBeTruthy();
  });

  it('empty graph: pass returns zero-counts result and no rows written', async () => {
    const result = await runBetweennessPass(qb);
    expect(result.nodesScored).toBe(0);
    expect(result.edgeCount).toBe(0);
    expect(result.sampleCount).toBe(0);
  });

  it('bridge node ends up with strictly higher persisted betweenness than non-bridge nodes', async () => {
    // Two 3-node bidirectional cliques (a,b,c) and (d,e,f) joined by
    // an x that bridges them — same shape as the unit test's barbell.
    for (const name of ['a', 'b', 'c', 'x', 'd', 'e', 'f']) {
      insertFn(qb, `fn:${name}`, name);
    }
    const cliques: Array<[string, string]> = [
      ['a', 'b'],
      ['b', 'a'],
      ['a', 'c'],
      ['c', 'a'],
      ['b', 'c'],
      ['c', 'b'],
      ['d', 'e'],
      ['e', 'd'],
      ['d', 'f'],
      ['f', 'd'],
      ['e', 'f'],
      ['f', 'e'],
    ];
    for (const [s, t] of cliques) insertCall(qb, `fn:${s}`, `fn:${t}`);
    for (const [s, t] of [
      ['a', 'x'],
      ['x', 'a'],
      ['d', 'x'],
      ['x', 'd'],
    ] as Array<[string, string]>) {
      insertCall(qb, `fn:${s}`, `fn:${t}`);
    }

    const result = await runBetweennessPass(qb, { normalize: false });
    expect(result.nodesScored).toBe(7);
    expect(result.edgeCount).toBe(16);

    // Read persisted scores via the DESC index.
    const rows = db
      .getDb()
      .prepare('SELECT id, betweenness FROM nodes ORDER BY betweenness DESC NULLS LAST')
      .all() as Array<{ id: string; betweenness: number | null }>;
    const x = rows.find((r) => r.id === 'fn:x')!;
    expect(x.betweenness).not.toBeNull();
    expect(x.betweenness!).toBeGreaterThan(0);
    for (const id of ['fn:b', 'fn:c', 'fn:e', 'fn:f']) {
      const r = rows.find((row) => row.id === id)!;
      expect(x.betweenness!).toBeGreaterThan(r.betweenness ?? 0);
    }
    // Top row in the DESC-ordered scan should be the bridge.
    expect(rows[0]!.id).toBe('fn:x');
  });

  it('repeated pass overwrites prior scores (idempotent)', async () => {
    insertFn(qb, 'fn:a', 'a');
    insertFn(qb, 'fn:b', 'b');
    insertFn(qb, 'fn:c', 'c');
    insertCall(qb, 'fn:a', 'fn:b');
    insertCall(qb, 'fn:b', 'fn:c');
    await runBetweennessPass(qb, { normalize: false });
    const beforeRows = db.getDb().prepare('SELECT id, betweenness FROM nodes').all();
    await runBetweennessPass(qb, { normalize: false });
    const afterRows = db.getDb().prepare('SELECT id, betweenness FROM nodes').all();
    expect(afterRows).toEqual(beforeRows);
  });
});
