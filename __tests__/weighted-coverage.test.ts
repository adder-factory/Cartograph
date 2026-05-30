import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'node:path';
import fs from 'node:fs';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { getWeightedSummaryCoverage, upsertSymbolSummary } from '../src/db/queries-summaries.js';

describe('getWeightedSummaryCoverage', () => {
  let tempDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'cg-weighted-cov-'));
    db = DatabaseConnection.initialize(path.join(tempDir, 'test.db'));
    qb = new QueryBuilder(db.getDb());

    // Seed the files row that nodes.file_path FK (migration 056) requires.
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('src/x.ts', 'h', 'typescript', 0, 0, 0);
  });

  afterEach(() => {
    db.close();
    fs.rmSync(tempDir, { recursive: true });
  });

  function insertNode(id: string, opts: { centrality?: number | null; docstring?: string } = {}): void {
    qb.insertNode({
      id,
      kind: 'function',
      name: id,
      qualifiedName: id,
      filePath: 'src/x.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 5,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
      docstring: opts.docstring,
    });
    if (opts.centrality !== undefined) {
      db.getDb().prepare('UPDATE nodes SET centrality = ? WHERE id = ?').run(opts.centrality, id);
    }
  }

  it('returns null ratio when no centrality computed yet', () => {
    insertNode('a');
    insertNode('b');
    const r = getWeightedSummaryCoverage(qb, new Set(['function']));
    expect(r.totalNodes).toBe(2);
    expect(r.totalWeight).toBe(0);
    expect(r.weightedRatio).toBeNull();
  });

  it('weighted ratio counts summary as covered, weighted by centrality', () => {
    insertNode('high', { centrality: 0.9 });
    insertNode('low', { centrality: 0.1 });
    upsertSymbolSummary({ qb, nodeId: 'high', contentHash: 'h', summary: 'sums it', model: 'test' });
    const r = getWeightedSummaryCoverage(qb, new Set(['function']));
    expect(r.totalNodes).toBe(2);
    expect(r.coveredNodes).toBe(1);
    expect(r.totalWeight).toBeCloseTo(1.0, 3);
    expect(r.coveredWeight).toBeCloseTo(0.9, 3);
    expect(r.weightedRatio).toBeCloseTo(0.9, 3);
  });

  it('decent docstring counts as covered when coveredDocOnly=true (default)', () => {
    insertNode('hasDoc', { centrality: 0.5, docstring: 'A useful description here' });
    insertNode('noDoc', { centrality: 0.5 });
    const r = getWeightedSummaryCoverage(qb, new Set(['function']));
    expect(r.coveredNodes).toBe(1);
    expect(r.weightedRatio).toBeCloseTo(0.5, 3);
  });

  it('docstring excluded when coveredDocOnly=false', () => {
    insertNode('hasDoc', { centrality: 0.5, docstring: 'A useful description here' });
    insertNode('noDoc', { centrality: 0.5 });
    const r = getWeightedSummaryCoverage(qb, new Set(['function']), { coveredDocOnly: false });
    expect(r.coveredNodes).toBe(0);
    expect(r.weightedRatio).toBe(0);
  });

  it('NULL centrality contributes 0 weight without skewing the ratio', () => {
    insertNode('weighted', { centrality: 0.7 });
    insertNode('unweighted', { centrality: null });
    upsertSymbolSummary({ qb, nodeId: 'weighted', contentHash: 'h', summary: 's', model: 't' });
    const r = getWeightedSummaryCoverage(qb, new Set(['function']));
    expect(r.totalWeight).toBeCloseTo(0.7, 3);
    expect(r.coveredWeight).toBeCloseTo(0.7, 3);
    expect(r.weightedRatio).toBe(1);
  });

  it('empty kinds set short-circuits', () => {
    const r = getWeightedSummaryCoverage(qb, new Set());
    expect(r.totalNodes).toBe(0);
    expect(r.weightedRatio).toBeNull();
  });
});
