import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import path from 'path';
import fs from 'fs';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import {
  enqueueForPrioritySummary,
  getPriorityNodeIds,
  clearPriorityQueueForNode,
  getPriorityQueueStats,
  recordPriorityQueueFailure,
  MAX_PRIORITY_QUEUE_ATTEMPTS,
} from '../src/db/queries-summary-priority.js';
import { countPendingSummarizable } from '../src/db/queries-summaries.js';

describe('Summary Priority Queue', () => {
  let tempDir: string;
  let dbPath: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'cartograph-test-'));
    dbPath = path.join(tempDir, 'test.db');
    db = DatabaseConnection.initialize(dbPath);
    qb = new QueryBuilder(db.getDb());

    // Seed the files row that nodes.file_path FK (migration 056) requires.
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('test.ts', 'h', 'typescript', 0, 0, 0);

    // Insert a test node for FK references
    qb.insertNode({
      id: 'test-node-1',
      kind: 'function',
      name: 'testFunction',
      qualifiedName: 'test::testFunction',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 1,
      endLine: 10,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  it('should enqueue a node', () => {
    const result = enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    expect(result.enqueued + result.refreshed).toBeGreaterThan(0);

    const stats = getPriorityQueueStats(qb);
    expect(stats.pending).toBe(1);
    expect(stats.oldestEnqueuedAt).not.toBeNull();
    expect(stats.newestEnqueuedAt).not.toBeNull();
  });

  it('should bump requestedCount on duplicate enqueue', () => {
    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    const stats = getPriorityQueueStats(qb);
    expect(stats.pending).toBe(1); // Still only one row

    const rows = db
      .getDb()
      .prepare('SELECT requested_count FROM summary_priority_queue WHERE node_id = ?')
      .all('test-node-1') as Array<{ requested_count: number }>;
    expect(rows).toHaveLength(1);
    expect(rows[0].requested_count).toBe(2);
  });

  it('should silently skip FK-missing nodeIds', () => {
    const result = enqueueForPrioritySummary({
      qb,
      nodeIds: ['nonexistent-node'],
    });

    // FK check prevents the insert, so changes == 0
    const stats = getPriorityQueueStats(qb);
    expect(stats.pending).toBe(0);
  });

  it('should cascade-delete on parent node deletion', () => {
    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    expect(getPriorityQueueStats(qb).pending).toBe(1);

    // Delete the parent node
    db.getDb().prepare('DELETE FROM nodes WHERE id = ?').run('test-node-1');

    // Queue row should be gone
    expect(getPriorityQueueStats(qb).pending).toBe(0);
  });

  it('should return priority node IDs in newest-first order', () => {
    // Insert multiple nodes
    qb.insertNode({
      id: 'test-node-2',
      kind: 'function',
      name: 'testFunction2',
      qualifiedName: 'test::testFunction2',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 20,
      endLine: 30,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    qb.insertNode({
      id: 'test-node-3',
      kind: 'function',
      name: 'testFunction3',
      qualifiedName: 'test::testFunction3',
      filePath: 'test.ts',
      language: 'typescript',
      startLine: 40,
      endLine: 50,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
    });

    // Enqueue with small delays to ensure distinct timestamps
    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    // Ensure timestamp is newer
    const now = Date.now();
    db.getDb()
      .prepare('UPDATE summary_priority_queue SET enqueued_at = ? WHERE node_id = ?')
      .run(now + 100, 'test-node-1');

    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-2'],
    });

    db.getDb()
      .prepare('UPDATE summary_priority_queue SET enqueued_at = ? WHERE node_id = ?')
      .run(now + 50, 'test-node-2');

    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-3'],
    });

    db.getDb()
      .prepare('UPDATE summary_priority_queue SET enqueued_at = ? WHERE node_id = ?')
      .run(now + 200, 'test-node-3');

    const ids = getPriorityNodeIds(qb, 2);
    expect(ids).toHaveLength(2);
    // Newest first: test-node-3 (200), then test-node-1 (100)
    expect(ids[0]).toBe('test-node-3');
    expect(ids[1]).toBe('test-node-1');
  });

  it('should clear a specific node from the queue', () => {
    enqueueForPrioritySummary({
      qb,
      nodeIds: ['test-node-1'],
    });

    expect(getPriorityQueueStats(qb).pending).toBe(1);

    clearPriorityQueueForNode(qb, 'test-node-1');

    expect(getPriorityQueueStats(qb).pending).toBe(0);
  });

  it('should handle empty nodeIds gracefully', () => {
    const result = enqueueForPrioritySummary({
      qb,
      nodeIds: [],
    });

    expect(result.enqueued).toBe(0);
    expect(result.refreshed).toBe(0);
    expect(getPriorityQueueStats(qb).pending).toBe(0);
  });

  it('should bump attempts on failure without evicting before the cap', () => {
    enqueueForPrioritySummary({ qb, nodeIds: ['test-node-1'] });
    expect(MAX_PRIORITY_QUEUE_ATTEMPTS).toBeGreaterThan(1);

    for (let i = 1; i < MAX_PRIORITY_QUEUE_ATTEMPTS; i++) {
      const res = recordPriorityQueueFailure(qb, 'test-node-1');
      expect(res.evicted).toBe(false);
      const row = db
        .getDb()
        .prepare('SELECT attempts FROM summary_priority_queue WHERE node_id = ?')
        .get('test-node-1') as { attempts: number };
      expect(row.attempts).toBe(i);
    }
    expect(getPriorityQueueStats(qb).pending).toBe(1);
  });

  it('should evict the row when attempts reaches MAX_PRIORITY_QUEUE_ATTEMPTS', () => {
    enqueueForPrioritySummary({ qb, nodeIds: ['test-node-1'] });

    let lastResult: { evicted: boolean } = { evicted: false };
    for (let i = 0; i < MAX_PRIORITY_QUEUE_ATTEMPTS; i++) {
      lastResult = recordPriorityQueueFailure(qb, 'test-node-1');
    }
    expect(lastResult.evicted).toBe(true);
    expect(getPriorityQueueStats(qb).pending).toBe(0);
  });

  it('should be a no-op on an unknown node_id', () => {
    const res = recordPriorityQueueFailure(qb, 'never-enqueued');
    expect(res.evicted).toBe(false);
    expect(getPriorityQueueStats(qb).pending).toBe(0);
  });

  it('preserves attempts across ON CONFLICT re-enqueue (no budget refresh)', () => {
    enqueueForPrioritySummary({ qb, nodeIds: ['test-node-1'] });
    recordPriorityQueueFailure(qb, 'test-node-1');
    recordPriorityQueueFailure(qb, 'test-node-1');

    enqueueForPrioritySummary({ qb, nodeIds: ['test-node-1'] });

    const row = db
      .getDb()
      .prepare('SELECT attempts, requested_count FROM summary_priority_queue WHERE node_id = ?')
      .get('test-node-1') as { attempts: number; requested_count: number };
    expect(row.attempts).toBe(2);
    expect(row.requested_count).toBe(2);
  });

  it('should report queue stats accurately', () => {
    // Empty queue
    let stats = getPriorityQueueStats(qb);
    expect(stats.pending).toBe(0);
    expect(stats.oldestEnqueuedAt).toBeNull();
    expect(stats.newestEnqueuedAt).toBeNull();

    // One entry
    const now = Date.now();
    db.getDb()
      .prepare(`
      INSERT INTO summary_priority_queue (node_id, enqueued_at, requested_count)
      VALUES (?, ?, 1)
    `)
      .run('test-node-1', now);

    stats = getPriorityQueueStats(qb);
    expect(stats.pending).toBe(1);
    expect(stats.oldestEnqueuedAt).toBe(now);
    expect(stats.newestEnqueuedAt).toBe(now);
  });
});

describe('countPendingSummarizable', () => {
  let tempDir: string;
  let db: DatabaseConnection;
  let qb: QueryBuilder;

  const SUMMARIZABLE = new Set(['function']);
  const FILTER = {
    minBodyLinesByKind: new Map([['route', 1]]),
    defaultMinBodyLines: 4,
    docCharThreshold: 20,
  };

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join('/tmp', 'cartograph-pending-test-'));
    db = DatabaseConnection.initialize(path.join(tempDir, 'test.db'));
    qb = new QueryBuilder(db.getDb());
    db.getDb()
      .prepare(
        `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run('test.ts', 'h', 'typescript', 0, 0, 0);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  function seedNode(id: string, opts: { startLine: number; endLine: number; docstring?: string }): void {
    qb.insertNode({
      id,
      kind: 'function',
      name: id,
      qualifiedName: `test::${id}`,
      filePath: 'test.ts',
      language: 'typescript',
      startLine: opts.startLine,
      endLine: opts.endLine,
      startColumn: 0,
      endColumn: 1,
      updatedAt: Date.now(),
      ...(opts.docstring !== undefined ? { docstring: opts.docstring } : {}),
    });
  }

  it('subtracts nodes already in summary_refs from the candidate count', () => {
    // Two summarizable functions (no docstring, body >= 4 lines).
    seedNode('fn-a', { startLine: 1, endLine: 10 });
    seedNode('fn-b', { startLine: 20, endLine: 30 });
    expect(countPendingSummarizable(qb, SUMMARIZABLE, FILTER)).toBe(2);

    // Link fn-a via the content-addressed pair (summary_store + summary_refs).
    db.getDb()
      .prepare(`INSERT INTO summary_store (body_hash, model, summary, generated_at) VALUES (?, ?, ?, ?)`)
      .run('hash-a', 'm', 'summary text', Date.now());
    db.getDb()
      .prepare(`INSERT INTO summary_refs (node_id, body_hash, model) VALUES (?, ?, ?)`)
      .run('fn-a', 'hash-a', 'm');

    expect(countPendingSummarizable(qb, SUMMARIZABLE, FILTER)).toBe(1);
  });

  it('excludes nodes with a sufficient docstring (above the char threshold)', () => {
    seedNode('fn-short-doc', { startLine: 1, endLine: 10, docstring: 'tiny' }); // < 20 chars: pending
    seedNode('fn-long-doc', {
      startLine: 20,
      endLine: 30,
      docstring: 'this docstring is long enough to skip summarisation',
    });
    expect(countPendingSummarizable(qb, SUMMARIZABLE, FILTER)).toBe(1);
  });

  it('excludes nodes whose body is shorter than the per-kind floor', () => {
    seedNode('fn-tiny', { startLine: 1, endLine: 3 }); // body 2 lines: under floor
    seedNode('fn-meaty', { startLine: 10, endLine: 20 });
    expect(countPendingSummarizable(qb, SUMMARIZABLE, FILTER)).toBe(1);
  });

  it('returns 0 when the kind set is empty', () => {
    seedNode('fn-a', { startLine: 1, endLine: 10 });
    expect(countPendingSummarizable(qb, new Set<string>(), FILTER)).toBe(0);
  });
});
