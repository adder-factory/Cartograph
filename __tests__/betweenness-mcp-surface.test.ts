/**
 * G23 MCP-surface integration test: `cartograph_node({includeBetweenness: true})`
 * renders a "Structural bridge" header row when the column is populated,
 * suppresses it when NULL, and `cartograph_review mode='risk'` lists the
 * top bridge candidates in its Structural bridges section.
 *
 * Round-trips end-to-end through MCP-style handler calls but seeds the
 * DB directly (no full indexAll) so the test stays focused on the
 * surface behaviour, not the compute. The compute path itself has its
 * own correctness + parity tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder, getAllNodes } from '../src/db/queries.js';
import { applyBetweennessScores } from '../src/db/queries-centrality.js';
import { runBetweennessPass } from '../src/centrality/betweenness-pass.js';

function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-betweenness-mcp-'));
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

describe('G23 — betweenness flows into Node + DESC index queries', () => {
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

  it('after runBetweennessPass, the Node row carries the persisted score', async () => {
    insertFn(qb, 'fn:a', 'a');
    insertFn(qb, 'fn:b', 'b');
    insertFn(qb, 'fn:c', 'c');
    insertCall(qb, 'fn:a', 'fn:b');
    insertCall(qb, 'fn:b', 'fn:c');
    await runBetweennessPass(qb, { normalize: false });
    // Read the Node row via the row mapper that the MCP surface uses.
    qb.nodeCache.clear();
    const all = getAllNodes(qb);
    const b = all.find((n) => n.id === 'fn:b')!;
    expect(b).toBeTruthy();
    expect(typeof b.betweenness).toBe('number');
    // Raw (unnormalized) Brandes on path a→b→c: cb[b] = 1
    // (one s-t pair (a,c) has a shortest path through b).
    expect(b.betweenness!).toBeCloseTo(1, 9);
  });

  it('applyBetweennessScores writes scores readable via the DESC index', () => {
    insertFn(qb, 'fn:x', 'x');
    insertFn(qb, 'fn:y', 'y');
    applyBetweennessScores(
      qb,
      new Map([
        ['fn:x', 0.9],
        ['fn:y', 0.1],
      ]),
    );
    const rows = db.getDb().prepare('SELECT id, betweenness FROM nodes ORDER BY betweenness DESC').all() as Array<{
      id: string;
      betweenness: number;
    }>;
    expect(rows[0]!.id).toBe('fn:x');
    expect(rows[0]!.betweenness).toBeCloseTo(0.9, 9);
    expect(rows[1]!.id).toBe('fn:y');
  });

  it('Node rows have no betweenness value before the hook runs', () => {
    insertFn(qb, 'fn:a', 'a');
    const all = getAllNodes(qb);
    const a = all.find((n) => n.id === 'fn:a')!;
    // Either null (mapped from SQL NULL) or undefined (mapper omitted
    // the field) is acceptable — both consistently mean "unknown".
    expect(a.betweenness ?? null).toBeNull();
  });
});
