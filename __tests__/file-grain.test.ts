/**
 * Tests for the file-grain (multi-grain Stage 2) embedding pipeline.
 *
 * Covers:
 *   - computeCombinedHash: determinism, sensitivity, order-insensitivity
 *   - buildFileEmbedText: header, fallback priority, trimming
 *   - getFileGrainCandidates: per-file grouping, zero-symbol skip, topK, ordering
 *   - upsertFileEmbedding + isFileGrainStale: insert, update, staleness conditions
 *   - embedFilesAggregated: empty repo, all-stale, cache-hit, error handling,
 *     abort signal, wrong-length result
 *
 * Uses a lightweight DatabaseConnection + QueryBuilder setup (no full Cartograph
 * round-trip) for unit-level tests on candidates/upsert/stale. Integration-
 * style tests for embedFilesAggregated insert rows via direct SQL to avoid
 * depending on the full extractor.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import {
  FILE_GRAIN_TOP_K,
  computeCombinedHash,
  buildFileEmbedText,
  getFileGrainCandidates,
  isFileGrainStale,
  upsertFileEmbedding,
  embedFilesAggregated,
  type FileGrainCandidate,
  type FileGrainSymbol,
} from '../src/embeddings/file-grain.js';
import type { EmbeddingProvider } from '../src/llm/embedding-client.js';

// ---------------------------------------------------------------------------
// Helper utilities
// ---------------------------------------------------------------------------

function makeRandomNormalisedBuffer(dim: number): Buffer {
  const arr = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.random() - 0.5;
    sum += arr[i]! * arr[i]!;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) arr[i] = arr[i]! / norm;
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
}

function randomNormalisedFloat32(dim: number): Float32Array {
  const arr = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = Math.random() - 0.5;
    sum += arr[i]! * arr[i]!;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) arr[i] = arr[i]! / norm;
  return arr;
}

function makeStubEmbedClient(dim = 32): EmbeddingProvider {
  return {
    isConfigured: true,
    isReachable: async () => true,
    listModels: async () => ['stub-embed'],
    embed: async (inputs) => inputs.map(() => randomNormalisedFloat32(dim)),
  };
}

function makeErrorEmbedClient(): EmbeddingProvider {
  return {
    isConfigured: true,
    isReachable: async () => true,
    listModels: async () => [],
    embed: async (_inputs) => {
      throw new Error('embed client forced error');
    },
  };
}

function makeWrongLengthClient(dim = 32): EmbeddingProvider {
  return {
    isConfigured: true,
    isReachable: async () => true,
    listModels: async () => [],
    // Returns only 1 vector regardless of batch size
    embed: async (_inputs) => [randomNormalisedFloat32(dim)],
  };
}

// ---------------------------------------------------------------------------
// DB setup helpers
// ---------------------------------------------------------------------------

interface DbSetup {
  dir: string;
  conn: DatabaseConnection;
  qb: QueryBuilder;
}

function setupDb(): DbSetup {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fg-'));
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const qb = new QueryBuilder(conn.getDb(), conn.hasVecExtension());
  return { dir, conn, qb };
}

function teardownDb(setup: DbSetup): void {
  setup.conn.close();
  fs.rmSync(setup.dir, { recursive: true, force: true });
}

/**
 * Seed a row in `files` so node inserts referencing this path satisfy the
 * `nodes.file_path -> files(path)` FK (migration 056). Safe to call
 * repeatedly for the same path — `INSERT OR IGNORE` makes it idempotent.
 */
function seedFile(qb: QueryBuilder, filePath: string, contentHash: string = 'h'): void {
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
       VALUES (?, ?, 'typescript', 100, 0, 0)`,
    )
    .run(filePath, contentHash);
}

/**
 * Insert a file node into `nodes` and a matching row into `files`.
 * Returns the node id.
 */
function insertFileNode(qb: QueryBuilder, filePath: string, contentHash: string, nodeId?: string): string {
  const id = nodeId ?? `file:${filePath}`;
  // FK (migration 056) requires the parent files row before the node insert.
  seedFile(qb, filePath, contentHash);
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO nodes
         (id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column, updated_at)
       VALUES (?, 'file', ?, ?, ?, 'typescript', 1, 1, 0, 0, 0)`,
    )
    .run(id, path.basename(filePath), path.basename(filePath), filePath);
  return id;
}

/**
 * Insert a non-file symbol node into `nodes`. Returns the node id.
 */
function insertSymbolNode(
  qb: QueryBuilder,
  opts: {
    id?: string;
    name: string;
    filePath: string;
    kind?: string;
    startLine?: number;
    centrality?: number | null;
    signature?: string | null;
  },
): string {
  const id = opts.id ?? `sym:${opts.filePath}:${opts.name}`;
  // FK (migration 056): callers may insert symbol nodes for a path that has
  // no file-kind node yet. Seed the parent files row defensively.
  seedFile(qb, opts.filePath);
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO nodes
         (id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column, updated_at,
          centrality, signature)
       VALUES (?, ?, ?, ?, ?, 'typescript', ?, ?, 0, 0, 0, ?, ?)`,
    )
    .run(
      id,
      opts.kind ?? 'function',
      opts.name,
      opts.name,
      opts.filePath,
      opts.startLine ?? 1,
      (opts.startLine ?? 1) + 10,
      opts.centrality !== undefined ? opts.centrality : null,
      opts.signature ?? null,
    );
  return id;
}

/**
 * Insert a summary for a symbol node. Returns the content_hash used.
 */
function insertSummary(qb: QueryBuilder, nodeId: string, summary: string, contentHash: string): void {
  qb.db
    .prepare(
      `INSERT OR REPLACE INTO symbol_summaries (node_id, summary, model, content_hash, generated_at)
       VALUES (?, ?, 'test-model', ?, 0)`,
    )
    .run(nodeId, summary, contentHash);
}

// ---------------------------------------------------------------------------
// describe('file-grain.computeCombinedHash')
// ---------------------------------------------------------------------------

describe('file-grain.computeCombinedHash', () => {
  it('same inputs produce same hash (determinism)', () => {
    const h1 = computeCombinedHash('abc', ['x', 'y', 'z']);
    const h2 = computeCombinedHash('abc', ['x', 'y', 'z']);
    expect(h1).toBe(h2);
  });

  it('different file content hash → different output', () => {
    const h1 = computeCombinedHash('hash-A', ['x', 'y']);
    const h2 = computeCombinedHash('hash-B', ['x', 'y']);
    expect(h1).not.toBe(h2);
  });

  it('different summary hash set → different output', () => {
    const h1 = computeCombinedHash('content', ['a', 'b']);
    const h2 = computeCombinedHash('content', ['a', 'c']);
    expect(h1).not.toBe(h2);
  });

  it('hash is order-insensitive (input ["a","b"] === ["b","a"])', () => {
    const h1 = computeCombinedHash('content', ['a', 'b']);
    const h2 = computeCombinedHash('content', ['b', 'a']);
    expect(h1).toBe(h2);
  });

  it('produces a 64-character hex string (sha256)', () => {
    const h = computeCombinedHash('content', ['a']);
    expect(h).toMatch(/^[0-9a-f]{64}$/);
  });
});

// ---------------------------------------------------------------------------
// describe('file-grain.buildFileEmbedText')
// ---------------------------------------------------------------------------

describe('file-grain.buildFileEmbedText', () => {
  function makeCandidate(symbols: FileGrainSymbol[]): FileGrainCandidate {
    return {
      fileNodeId: 'file:test.ts',
      filePath: 'src/test.ts',
      fileContentHash: 'hash',
      symbols,
      combinedHash: 'combined-hash',
    };
  }

  it('has the file path header', () => {
    const c = makeCandidate([{ name: 'foo', signature: null, summary: null, summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('# src/test.ts');
  });

  it('prefers summary over signature', () => {
    const c = makeCandidate([
      { name: 'foo', signature: 'foo(a: string): void', summary: 'The summary text', summaryHash: '' },
    ]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('foo: The summary text');
    expect(text).not.toContain('foo(a: string): void');
  });

  it('falls back to signature when summary is null', () => {
    const c = makeCandidate([{ name: 'bar', signature: 'bar(x: number): string', summary: null, summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('bar: bar(x: number): string');
  });

  it('falls back to name-only when both summary and signature are null', () => {
    const c = makeCandidate([{ name: 'baz', signature: null, summary: null, summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    // The last symbol line has no trailing newline (join('\n') produces no trailing newline)
    expect(text).toContain('- baz');
    expect(text).not.toContain('baz:');
  });

  it('skips empty/null summary AND falls through to signature', () => {
    const c = makeCandidate([{ name: 'qux', signature: 'qux(): void', summary: '', summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('qux: qux(): void');
  });

  it('skips empty/null signature AND falls through to name-only', () => {
    const c = makeCandidate([{ name: 'quux', signature: '', summary: null, summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    // empty signature → name-only
    expect(text).toContain('- quux');
    expect(text).not.toContain('quux:');
  });

  it('whitespace in summary is trimmed', () => {
    const c = makeCandidate([{ name: 'fn', signature: null, summary: '  trimmed summary  ', summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('fn: trimmed summary');
    expect(text).not.toContain('  trimmed summary  ');
  });

  it('whitespace in signature is trimmed', () => {
    const c = makeCandidate([{ name: 'fn', signature: '  sig(a: number): void  ', summary: null, summaryHash: '' }]);
    const text = buildFileEmbedText(c);
    expect(text).toContain('fn: sig(a: number): void');
  });
});

// ---------------------------------------------------------------------------
// describe('file-grain.getFileGrainCandidates')
// ---------------------------------------------------------------------------

describe('file-grain.getFileGrainCandidates', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('returns one candidate per file with at least 1 indexed symbol', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/a.ts', 'hash-a');
    insertSymbolNode(qb, { name: 'foo', filePath: 'src/a.ts' });

    insertFileNode(qb, 'src/b.ts', 'hash-b');
    insertSymbolNode(qb, { name: 'bar', filePath: 'src/b.ts' });

    const candidates = getFileGrainCandidates(qb);
    expect(candidates).toHaveLength(2);
    const paths = candidates.map((c) => c.filePath).sort();
    expect(paths).toEqual(['src/a.ts', 'src/b.ts']);
  });

  it('skips files with zero indexed symbols', () => {
    const { qb } = setup;
    // File with no non-file/import/export symbols
    insertFileNode(qb, 'src/empty.ts', 'hash-empty');

    // File with a symbol
    insertFileNode(qb, 'src/nonempty.ts', 'hash-nonempty');
    insertSymbolNode(qb, { name: 'realFn', filePath: 'src/nonempty.ts' });

    const candidates = getFileGrainCandidates(qb);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.filePath).toBe('src/nonempty.ts');
  });

  it('respects topK limit (file with 30 symbols + topK=5 → 5 symbols on the candidate)', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/big.ts', 'hash-big');
    for (let i = 0; i < 30; i++) {
      insertSymbolNode(qb, {
        name: `fn${i}`,
        filePath: 'src/big.ts',
        startLine: i + 1,
        centrality: i / 30,
      });
    }

    const candidates = getFileGrainCandidates(qb, 5);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.symbols).toHaveLength(5);
  });

  it('orders symbols by centrality DESC then start_line ASC', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/order.ts', 'hash-order');

    // Insert symbols with varying centrality and line numbers
    // High centrality, late line
    insertSymbolNode(qb, { name: 'highCentral', filePath: 'src/order.ts', startLine: 50, centrality: 1.0 });
    // Low centrality, early line
    insertSymbolNode(qb, { name: 'lowCentral', filePath: 'src/order.ts', startLine: 5, centrality: 0.1 });
    // Medium centrality, early line
    insertSymbolNode(qb, { name: 'medCentralEarly', filePath: 'src/order.ts', startLine: 10, centrality: 0.5 });
    // Medium centrality, late line (tiebreaker: should come after medCentralEarly)
    insertSymbolNode(qb, { name: 'medCentralLate', filePath: 'src/order.ts', startLine: 30, centrality: 0.5 });

    const candidates = getFileGrainCandidates(qb, 20);
    expect(candidates).toHaveLength(1);
    const names = candidates[0]!.symbols.map((s) => s.name);
    expect(names[0]).toBe('highCentral'); // centrality 1.0
    expect(names[1]).toBe('medCentralEarly'); // centrality 0.5, line 10
    expect(names[2]).toBe('medCentralLate'); // centrality 0.5, line 30
    expect(names[3]).toBe('lowCentral'); // centrality 0.1
  });

  it('includes FILE_GRAIN_TOP_K constant equal to 20', () => {
    expect(FILE_GRAIN_TOP_K).toBe(20);
  });

  it('uses FILE_GRAIN_TOP_K by default when no topK argument given', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/default.ts', 'hash-def');
    for (let i = 0; i < 25; i++) {
      insertSymbolNode(qb, { name: `fn${i}`, filePath: 'src/default.ts', startLine: i + 1 });
    }
    const candidates = getFileGrainCandidates(qb); // no topK
    expect(candidates[0]!.symbols).toHaveLength(FILE_GRAIN_TOP_K);
  });

  it('skips file/import/export kind nodes when building symbol list', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/kinds.ts', 'hash-kinds');
    // These should be excluded
    insertSymbolNode(qb, { name: 'importNode', filePath: 'src/kinds.ts', kind: 'import', startLine: 1 });
    insertSymbolNode(qb, { name: 'exportNode', filePath: 'src/kinds.ts', kind: 'export', startLine: 2 });
    // This should be included
    insertSymbolNode(qb, { name: 'realFn', filePath: 'src/kinds.ts', kind: 'function', startLine: 3 });

    const candidates = getFileGrainCandidates(qb);
    // Only the function node should appear
    expect(candidates).toHaveLength(1);
    const symNames = candidates[0]!.symbols.map((s) => s.name);
    expect(symNames).not.toContain('importNode');
    expect(symNames).not.toContain('exportNode');
    expect(symNames).toContain('realFn');
  });
});

// ---------------------------------------------------------------------------
// describe('file-grain.upsertFileEmbedding + isFileGrainStale')
// ---------------------------------------------------------------------------

describe('file-grain.upsertFileEmbedding + isFileGrainStale', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  function makeCandidate(
    fileNodeId: string,
    filePath: string,
    fileContentHash: string,
    combinedHash: string,
    symbols: FileGrainSymbol[] = [],
  ): FileGrainCandidate {
    return { fileNodeId, filePath, fileContentHash, symbols, combinedHash };
  }

  it('fresh insert: returns true; isFileGrainStale → false on candidate with matching hashes', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/x.ts', 'hash-x', 'fnode-x');

    const c = makeCandidate('fnode-x', 'src/x.ts', 'hash-x', 'combined-x');
    const embedding = makeRandomNormalisedBuffer(32);

    const wrote = upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-x',
      embedding,
      model: 'test-model',
      fileContentHash: 'hash-x',
      combinedHash: 'combined-x',
    });
    expect(wrote).toBe(true);

    const stale = isFileGrainStale(qb, c, 'test-model');
    expect(stale).toBe(false);
  });

  it('missing fileNodeId: returns false', () => {
    const { qb } = setup;
    const embedding = makeRandomNormalisedBuffer(32);

    // 'nonexistent-node' does not exist in nodes table
    const wrote = upsertFileEmbedding({
      qb,
      fileNodeId: 'nonexistent-node',
      embedding,
      model: 'test-model',
      fileContentHash: 'hash',
      combinedHash: 'combined',
    });
    expect(wrote).toBe(false);
  });

  it('re-upsert with new combinedHash: row updated; isFileGrainStale → false on updated candidate', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/y.ts', 'hash-y', 'fnode-y');
    const embedding = makeRandomNormalisedBuffer(32);

    // Initial insert
    upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-y',
      embedding,
      model: 'test-model',
      fileContentHash: 'hash-y',
      combinedHash: 'combined-v1',
    });

    // Re-upsert with new combinedHash
    const newEmbedding = makeRandomNormalisedBuffer(32);
    const wrote = upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-y',
      embedding: newEmbedding,
      model: 'test-model',
      fileContentHash: 'hash-y',
      combinedHash: 'combined-v2',
    });
    expect(wrote).toBe(true);

    // Now candidate with new combinedHash should not be stale
    const updatedCandidate = makeCandidate('fnode-y', 'src/y.ts', 'hash-y', 'combined-v2');
    expect(isFileGrainStale(qb, updatedCandidate, 'test-model')).toBe(false);

    // The OLD combinedHash candidate would still be stale
    const oldCandidate = makeCandidate('fnode-y', 'src/y.ts', 'hash-y', 'combined-v1');
    expect(isFileGrainStale(qb, oldCandidate, 'test-model')).toBe(true);
  });

  it('isFileGrainStale → true when no row exists for that fileNodeId', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/z.ts', 'hash-z', 'fnode-z');
    const c = makeCandidate('fnode-z', 'src/z.ts', 'hash-z', 'combined-z');

    // No embedding row exists yet
    expect(isFileGrainStale(qb, c, 'test-model')).toBe(true);
  });

  it('isFileGrainStale → true when embedding_model differs', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/m.ts', 'hash-m', 'fnode-m');
    const embedding = makeRandomNormalisedBuffer(32);

    upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-m',
      embedding,
      model: 'model-A',
      fileContentHash: 'hash-m',
      combinedHash: 'combined-m',
    });

    const c = makeCandidate('fnode-m', 'src/m.ts', 'hash-m', 'combined-m');
    // Different model → stale
    expect(isFileGrainStale(qb, c, 'model-B')).toBe(true);
    // Same model → fresh
    expect(isFileGrainStale(qb, c, 'model-A')).toBe(false);
  });

  it('isFileGrainStale → true when source_content_hash differs', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/c.ts', 'hash-v1', 'fnode-c');
    const embedding = makeRandomNormalisedBuffer(32);

    upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-c',
      embedding,
      model: 'test-model',
      fileContentHash: 'hash-v1',
      combinedHash: 'combined-c',
    });

    // Candidate with new file content hash
    const c = makeCandidate('fnode-c', 'src/c.ts', 'hash-v2', 'combined-c');
    expect(isFileGrainStale(qb, c, 'test-model')).toBe(true);
  });

  it('isFileGrainStale → true when summary_hash_at_embed differs', () => {
    const { qb } = setup;
    insertFileNode(qb, 'src/s.ts', 'hash-s', 'fnode-s');
    const embedding = makeRandomNormalisedBuffer(32);

    upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-s',
      embedding,
      model: 'test-model',
      fileContentHash: 'hash-s',
      combinedHash: 'combined-v1',
    });

    // Candidate with new combinedHash (summary changed)
    const c = makeCandidate('fnode-s', 'src/s.ts', 'hash-s', 'combined-v2');
    expect(isFileGrainStale(qb, c, 'test-model')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// describe('file-grain.embedFilesAggregated')
// ---------------------------------------------------------------------------

describe('file-grain.embedFilesAggregated', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('empty repo: candidates=0, generated=0, errors=0', async () => {
    const { qb } = setup;
    const client = makeStubEmbedClient();

    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
    });

    expect(result.candidates).toBe(0);
    expect(result.generated).toBe(0);
    expect(result.errors).toBe(0);
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('3 files all stale, all succeed: candidates=3, generated=3, errors=0', async () => {
    const { qb } = setup;
    for (let i = 0; i < 3; i++) {
      const filePath = `src/file${i}.ts`;
      insertFileNode(qb, filePath, `hash-${i}`, `fnode-${i}`);
      insertSymbolNode(qb, { name: `fn${i}`, filePath, startLine: 1 });
    }

    const client = makeStubEmbedClient();
    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
    });

    expect(result.candidates).toBe(3);
    expect(result.generated).toBe(3);
    expect(result.cacheHits).toBe(0);
    expect(result.errors).toBe(0);
  });

  it('3 files, 1 already up-to-date: candidates=3, generated=2, cacheHits=1', async () => {
    const { qb } = setup;

    for (let i = 0; i < 3; i++) {
      const filePath = `src/file${i}.ts`;
      insertFileNode(qb, filePath, `hash-${i}`, `fnode-${i}`);
      insertSymbolNode(qb, { name: `fn${i}`, filePath, startLine: 1 });
    }

    // Pre-embed file 0 so it's up-to-date
    // We need to know what combinedHash getFileGrainCandidates would produce for file 0.
    // Because there's no summary, summaryHash = ''. So combinedHash = computeCombinedHash('hash-0', [''])
    const { computeCombinedHash: ccHash } = await import('../src/embeddings/file-grain.js');
    const preComputedHash = ccHash('hash-0', ['']);
    upsertFileEmbedding({
      qb,
      fileNodeId: 'fnode-0',
      embedding: makeRandomNormalisedBuffer(32),
      model: 'stub-model',
      fileContentHash: 'hash-0',
      combinedHash: preComputedHash,
    });

    const client = makeStubEmbedClient();
    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
    });

    expect(result.candidates).toBe(3);
    expect(result.generated).toBe(2);
    expect(result.cacheHits).toBe(1);
    expect(result.errors).toBe(0);
  });

  it('stub client throws on batch: errors increments by batch size; generated unaffected', async () => {
    const { qb } = setup;

    for (let i = 0; i < 3; i++) {
      const filePath = `src/errfile${i}.ts`;
      insertFileNode(qb, filePath, `hash-err${i}`, `efnode-${i}`);
      insertSymbolNode(qb, { name: `errfn${i}`, filePath, startLine: 1 });
    }

    const client = makeErrorEmbedClient();
    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
    });

    // All 3 in the batch error; generated stays 0
    expect(result.errors).toBe(3);
    expect(result.generated).toBe(0);
    expect(result.candidates).toBe(3);
  });

  it('signal aborted mid-loop: generated < candidates', async () => {
    const { qb } = setup;

    // Create 20 files (more than one batch of 16) so we have a chance to abort
    for (let i = 0; i < 20; i++) {
      const filePath = `src/abortfile${i}.ts`;
      insertFileNode(qb, filePath, `hash-abort${i}`, `afnode-${i}`);
      insertSymbolNode(qb, { name: `abortfn${i}`, filePath, startLine: 1 });
    }

    // Abort immediately
    const controller = new AbortController();
    controller.abort();

    const client = makeStubEmbedClient();
    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
      signal: controller.signal,
    });

    // With immediate abort, generated < 20 (possibly 0 if first batch skipped)
    expect(result.generated).toBeLessThan(20);
    expect(result.candidates).toBe(20);
  });

  it('stub client returns wrong-length result: errors increments by batch size; generated unaffected', async () => {
    const { qb } = setup;

    for (let i = 0; i < 3; i++) {
      const filePath = `src/wlfile${i}.ts`;
      insertFileNode(qb, filePath, `hash-wl${i}`, `wlfnode-${i}`);
      insertSymbolNode(qb, { name: `wlfn${i}`, filePath, startLine: 1 });
    }

    const client = makeWrongLengthClient();
    const result = await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
    });

    // Wrong-length result: batch of 3 produces 1 vector → all 3 are errors
    expect(result.errors).toBe(3);
    expect(result.generated).toBe(0);
  });

  it('onProgress callback is called with progress updates', async () => {
    const { qb } = setup;

    for (let i = 0; i < 3; i++) {
      const filePath = `src/prog${i}.ts`;
      insertFileNode(qb, filePath, `hash-prog${i}`, `pfnode-${i}`);
      insertSymbolNode(qb, { name: `progfn${i}`, filePath, startLine: 1 });
    }

    const progressCalls: Array<{ done: number; total: number }> = [];
    const client = makeStubEmbedClient();
    await embedFilesAggregated({
      qb,
      client,
      embeddingModel: 'stub-model',
      onProgress: (done, total) => progressCalls.push({ done, total }),
    });

    // At least one progress call should have been made
    expect(progressCalls.length).toBeGreaterThan(0);
    // Final progress call should have done === total
    const last = progressCalls[progressCalls.length - 1]!;
    expect(last.done).toBe(last.total);
  });

  it('durationMs is non-negative', async () => {
    const { qb } = setup;
    const client = makeStubEmbedClient();
    const result = await embedFilesAggregated({ qb, client, embeddingModel: 'stub-model' });
    expect(result.durationMs).toBeGreaterThanOrEqual(0);
  });

  it('symbol summaries are included in the candidate combinedHash', async () => {
    const { qb } = setup;
    const filePath = 'src/summ.ts';
    insertFileNode(qb, filePath, 'hash-summ', 'fnode-summ');
    const symId = insertSymbolNode(qb, { name: 'summFn', filePath, startLine: 1 });
    insertSummary(qb, symId, 'A useful function', 'summary-hash-v1');

    const client = makeStubEmbedClient();
    const result = await embedFilesAggregated({ qb, client, embeddingModel: 'stub-model' });
    expect(result.generated).toBe(1);

    // Now the combinedHash stored should reflect the summary hash
    const row = qb.db
      .prepare(`SELECT summary_hash_at_embed FROM symbol_embeddings WHERE node_id = ? AND grain = 'file'`)
      .get('fnode-summ') as { summary_hash_at_embed: string } | undefined;
    expect(row).toBeDefined();

    // The stored combined hash should NOT be the raw summary hash — it's
    // the sha256 of content+summary hashes
    const expectedHash = computeCombinedHash('hash-summ', ['summary-hash-v1']);
    expect(row!.summary_hash_at_embed).toBe(expectedHash);
  });
});
