/**
 * Result Diversification Tests
 *
 * Verifies the per-file cap on search results: queries that match many
 * symbols in one file (the methods of a class) no longer return 10 hits
 * from one file, but instead surface representative breadth across files.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { searchNodes } from '../src/db/queries-search.js';
import { diversifyByFile } from '../src/search/query-utils.js';
import type { Node } from '../src/types.js';

describe('diversifyByFile (unit)', () => {
  function r(score: number, name: string, filePath: string) {
    return { node: { id: name, name, filePath } as Node, score };
  }

  it('caps consecutive results from the same file at perFileCap', () => {
    const results = [
      r(10, 'a1', 'a.ts'),
      r(9, 'a2', 'a.ts'),
      r(8, 'a3', 'a.ts'),
      r(7, 'a4', 'a.ts'),
      r(6, 'b1', 'b.ts'),
    ];
    const out = diversifyByFile(results, 5, 2);
    expect(out.map((x) => x.node.name)).toEqual(['a1', 'a2', 'b1', 'a3', 'a4']);
    // First two from a.ts (cap), then b.ts (different file), then backfill.
  });

  it('preserves overall ranking when no file dominates', () => {
    const results = [r(10, 'a1', 'a.ts'), r(9, 'b1', 'b.ts'), r(8, 'c1', 'c.ts'), r(7, 'a2', 'a.ts')];
    const out = diversifyByFile(results, 4, 2);
    expect(out.map((x) => x.node.name)).toEqual(['a1', 'b1', 'c1', 'a2']);
  });

  it('does not lose results — backfills from skipped when limit not yet filled', () => {
    // 10 candidates all from one file, limit 5, cap 2: pick 2, backfill 3.
    const results = Array.from({ length: 10 }, (_, i) => r(10 - i, `n${i}`, 'a.ts'));
    const out = diversifyByFile(results, 5, 2);
    expect(out).toHaveLength(5);
    expect(out.every((x) => x.node.filePath === 'a.ts')).toBe(true);
  });

  it('returns the input slice unchanged when perFileCap=0', () => {
    const results = [r(10, 'a1', 'a.ts'), r(9, 'a2', 'a.ts'), r(8, 'a3', 'a.ts')];
    expect(diversifyByFile(results, 3, 0)).toEqual(results);
  });

  it('returns input unchanged when results.length <= limit and no reordering needed', () => {
    const results = [r(10, 'a1', 'a.ts'), r(9, 'a2', 'a.ts')];
    expect(diversifyByFile(results, 5, 2)).toEqual(results);
  });

  it('still reorders within limit when results.length === limit but cap rearranges', () => {
    // Same total count as limit, but the cap reorders to surface peer files
    // earlier in the list.
    const results = [
      r(10, 'a1', 'a.ts'),
      r(9, 'a2', 'a.ts'),
      r(8, 'a3', 'a.ts'),
      r(7, 'a4', 'a.ts'),
      r(6, 'b1', 'b.ts'),
    ];
    const out = diversifyByFile(results, 5, 2);
    // First 2 from a.ts (cap), then b.ts, then backfill a.ts.
    expect(out.map((x) => x.node.name)).toEqual(['a1', 'a2', 'b1', 'a3', 'a4']);
  });

  it('respects the limit even when picked + skipped exceed it', () => {
    const results = [r(10, 'a1', 'a.ts'), r(9, 'a2', 'a.ts'), r(8, 'a3', 'a.ts'), r(7, 'b1', 'b.ts')];
    const out = diversifyByFile(results, 2, 2);
    expect(out).toHaveLength(2);
    expect(out.map((x) => x.node.name)).toEqual(['a1', 'a2']);
  });

  it('always preserves the top-scoring result at position 0', () => {
    const results = [
      r(100, 'top', 'big.ts'),
      r(50, 'big2', 'big.ts'),
      r(40, 'big3', 'big.ts'),
      r(30, 'big4', 'big.ts'),
      r(20, 'other', 'other.ts'),
    ];
    const out = diversifyByFile(results, 3, 2);
    expect(out[0].node.name).toBe('top');
  });
});

describe('searchNodes per-file diversification (integration)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  function makeNode(id: string, name: string, kind: Node['kind'], filePath: string): Node {
    return {
      id,
      kind,
      name,
      qualifiedName: `${filePath}::${name}`,
      filePath,
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
  function seedFile(fpath: string): void {
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(fpath, 'h', 'typescript', 0, 0, 0);
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'diversify-search-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    seedFile('src/db.ts');
    seedFile('src/pool.ts');
    // Simulate the "10 methods of one class" scenario: a class plus many
    // methods all sharing a common token, all in one file. Plus a peer
    // file with a sibling implementation.
    const nodes: Node[] = [
      makeNode('cls', 'DatabaseConnection', 'class', 'src/db.ts'),
      makeNode('m1', 'connect', 'method', 'src/db.ts'),
      makeNode('m2', 'disconnect', 'method', 'src/db.ts'),
      makeNode('m3', 'reconnect', 'method', 'src/db.ts'),
      makeNode('m4', 'isConnected', 'method', 'src/db.ts'),
      makeNode('m5', 'connectionString', 'property', 'src/db.ts'),
      makeNode('peer', 'PoolConnection', 'class', 'src/pool.ts'),
      makeNode('peer2', 'connectPool', 'function', 'src/pool.ts'),
    ];
    q.insertNodes(nodes);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('caps results per file at the default (3) so peer files surface', () => {
    const results = searchNodes(q, 'connect', { limit: 5 });
    const fromDbTs = results.filter((r) => r.node.filePath === 'src/db.ts').length;
    const fromPool = results.filter((r) => r.node.filePath === 'src/pool.ts').length;
    expect(fromDbTs).toBeLessThanOrEqual(3); // cap
    expect(fromPool).toBeGreaterThanOrEqual(1); // peer file represented
  });

  it('honors perFileCap: 0 (disabled) — does not enforce a per-file limit', () => {
    // Insert a heavy imbalance so dominance is unambiguous: 10 matching
    // methods in db.ts, only the existing pool.ts entries elsewhere.
    const heavyDb: Node[] = Array.from({ length: 10 }, (_, i) =>
      makeNode(`heavy${i}`, `connectVariant${i}`, 'method', 'src/db.ts'),
    );
    q.insertNodes(heavyDb);
    const results = searchNodes(q, 'connect', { limit: 8, perFileCap: 0 });
    const fromDbTs = results.filter((r) => r.node.filePath === 'src/db.ts').length;
    expect(fromDbTs).toBeGreaterThan(3);
  });

  it('honors a higher perFileCap', () => {
    const results = searchNodes(q, 'connect', { limit: 6, perFileCap: 5 });
    const fromDbTs = results.filter((r) => r.node.filePath === 'src/db.ts').length;
    expect(fromDbTs).toBeLessThanOrEqual(5);
  });

  it('preserves the top-scoring hit even with diversification', () => {
    // Class node with the most direct name match is the most relevant —
    // diversification must never displace it from #1.
    const results = searchNodes(q, 'DatabaseConnection', { limit: 3 });
    expect(results[0].node.name).toBe('DatabaseConnection');
  });

  it('does not lose results — fills limit by backfilling skipped same-file hits', () => {
    // If only one file has matches, all results legitimately come from it.
    // The cap should not cause us to return fewer than `limit` results.
    const onlyOneFileNodes: Node[] = Array.from({ length: 10 }, (_, i) =>
      makeNode(`only${i}`, `solo${i}`, 'function', 'src/only.ts'),
    );
    seedFile('src/only.ts');
    q.insertNodes(onlyOneFileNodes);
    const results = searchNodes(q, 'solo', { limit: 5 });
    expect(results.length).toBe(5);
  });
});
