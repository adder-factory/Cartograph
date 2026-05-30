/**
 * Tests for Stage 5 C.2 — multi-vector chunking + persistence.
 *
 * Covers:
 *   chunkSymbol:
 *     - empty body → no chunks
 *     - single-line body → no chunks
 *     - exactly LARGE_SYMBOL_LOC_THRESHOLD - 1 lines → no chunks
 *     - exactly LARGE_SYMBOL_LOC_THRESHOLD lines → chunks fire
 *     - 800-line body → correct number of chunks with overlap
 *     - 1000-line body → correct chunk count and boundary math
 *     - chunk_idx starts at 1
 *     - overlap: chunk N's startLine = chunk N-1's endLine - CHUNK_OVERLAP + 1
 *     - every chunk's startLine >= symbol's startLine
 *     - last chunk's endLine == symbol's endLine
 *
 *   queries-chunk-embeddings (upsert / read / clear / count):
 *     - upsertChunkEmbedding: insert a row
 *     - upsertChunkEmbedding: conflict-update overwrites values
 *     - upsertChunkEmbedding: FK rejection on missing node
 *     - getChunkEmbeddingsByNode: returns rows in chunk_idx order
 *     - getChunkEmbeddingsByNode: returns empty array for unknown node
 *     - clearChunkEmbeddings: deletes all rows for node, leaves others
 *     - countChunkEmbeddings: accurate after insert/clear
 *
 * Uses a lightweight DatabaseConnection + QueryBuilder setup (no full
 * Cartograph round-trip) for the persistence tests.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import {
  chunkSymbol,
  LARGE_SYMBOL_LOC_THRESHOLD,
  CHUNK_LOC,
  CHUNK_OVERLAP,
  type ChunkSymbolInput,
} from '../src/embeddings/multi-vec.js';
import {
  upsertChunkEmbedding,
  getChunkEmbeddingsByNode,
  clearChunkEmbeddings,
  countChunkEmbeddings,
} from '../src/db/queries-chunk-embeddings.js';

// ---------------------------------------------------------------------------
// Utility helpers
// ---------------------------------------------------------------------------

/** Build a body string of exactly `lineCount` lines. */
function makeBody(lineCount: number): string {
  return Array.from({ length: lineCount }, (_, i) => `line ${i + 1}`).join('\n');
}

/** Build a normalised 32-dim embedding Buffer. */
function makeEmbeddingBuffer(dim = 32): Buffer {
  const arr = new Float32Array(dim);
  let sum = 0;
  for (let i = 0; i < dim; i++) {
    arr[i] = (i + 1) * 0.01;
    sum += arr[i]! * arr[i]!;
  }
  const norm = Math.sqrt(sum) || 1;
  for (let i = 0; i < dim; i++) arr[i] = arr[i]! / norm;
  return Buffer.from(arr.buffer, arr.byteOffset, arr.byteLength);
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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-multivec-'));
  const dbPath = path.join(dir, 'test.db');
  const conn = DatabaseConnection.initialize(dbPath);
  const qb = new QueryBuilder(conn.getDb(), conn.hasVecExtension());
  return { dir, conn, qb };
}

function teardownDb(setup: DbSetup): void {
  setup.conn.close();
  fs.rmSync(setup.dir, { recursive: true, force: true });
}

/** Seed a row in `files` so FK from `nodes.file_path` resolves (migration 056). */
function seedFile(qb: QueryBuilder, fpath: string): void {
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at)
       VALUES (?, 'h', 'typescript', 0, 0, 0)`,
    )
    .run(fpath);
}

/** Insert a minimal symbol node so FK constraints on chunk inserts succeed. */
function insertNode(qb: QueryBuilder, nodeId: string, startLine = 1, endLine = 10): void {
  seedFile(qb, '/src/test.ts');
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO nodes
         (id, kind, name, qualified_name, file_path, language,
          start_line, end_line, start_column, end_column, updated_at)
       VALUES (?, 'function', ?, ?, '/src/test.ts', 'typescript', ?, ?, 0, 0, 0)`,
    )
    .run(nodeId, nodeId, nodeId, startLine, endLine);
}

// ===========================================================================
// describe('chunkSymbol — boundary cases')
// ===========================================================================

describe('chunkSymbol — boundary cases', () => {
  it('empty body → no chunks (below threshold)', () => {
    const input: ChunkSymbolInput = { startLine: 1, endLine: 1, body: '' };
    expect(chunkSymbol(input)).toEqual([]);
  });

  it('single-line body → no chunks', () => {
    const input: ChunkSymbolInput = { startLine: 5, endLine: 5, body: 'const x = 1;' };
    expect(chunkSymbol(input)).toEqual([]);
  });

  it(`body with ${LARGE_SYMBOL_LOC_THRESHOLD - 1} lines → no chunks (just below threshold)`, () => {
    const lineCount = LARGE_SYMBOL_LOC_THRESHOLD - 1;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    expect(chunkSymbol(input)).toEqual([]);
  });

  it(`body with exactly ${LARGE_SYMBOL_LOC_THRESHOLD} lines → chunks fire`, () => {
    const lineCount = LARGE_SYMBOL_LOC_THRESHOLD;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    const chunks = chunkSymbol(input);
    expect(chunks.length).toBeGreaterThan(0);
  });

  it('chunk_idx starts at 1', () => {
    const lineCount = LARGE_SYMBOL_LOC_THRESHOLD;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    const chunks = chunkSymbol(input);
    expect(chunks[0]?.idx).toBe(1);
  });

  it('all chunk idx values are sequential starting from 1', () => {
    const lineCount = 800;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    const chunks = chunkSymbol(input);
    chunks.forEach((c, i) => {
      expect(c.idx).toBe(i + 1);
    });
  });

  it('every chunk startLine >= symbol startLine', () => {
    const lineCount = 800;
    const symbolStart = 100;
    const input: ChunkSymbolInput = {
      startLine: symbolStart,
      endLine: symbolStart + lineCount - 1,
      body: makeBody(lineCount),
    };
    const chunks = chunkSymbol(input);
    for (const c of chunks) {
      expect(c.startLine).toBeGreaterThanOrEqual(symbolStart);
    }
  });

  it('last chunk endLine equals symbol endLine', () => {
    const lineCount = 800;
    const symbolEnd = 800;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: symbolEnd,
      body: makeBody(lineCount),
    };
    const chunks = chunkSymbol(input);
    expect(chunks[chunks.length - 1]?.endLine).toBe(symbolEnd);
  });
});

// ===========================================================================
// describe('chunkSymbol — 800-line symbol overlap math')
// ===========================================================================

describe('chunkSymbol — 800-line symbol overlap math', () => {
  // With startLine=1, endLine=800, CHUNK_LOC=200, CHUNK_OVERLAP=50, step=150:
  //   Chunk 1: 1–200
  //   Chunk 2: 151–350
  //   Chunk 3: 301–500
  //   Chunk 4: 451–650
  //   Chunk 5: 601–800
  const step = CHUNK_LOC - CHUNK_OVERLAP;

  let chunks: ReturnType<typeof chunkSymbol>;

  beforeEach(() => {
    const lineCount = 800;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    chunks = chunkSymbol(input);
  });

  it('produces 5 chunks for an 800-line symbol', () => {
    expect(chunks).toHaveLength(5);
  });

  it('first chunk starts at symbol startLine', () => {
    expect(chunks[0]?.startLine).toBe(1);
  });

  it('first chunk ends at startLine + CHUNK_LOC - 1', () => {
    expect(chunks[0]?.endLine).toBe(CHUNK_LOC);
  });

  it('consecutive chunks overlap by CHUNK_OVERLAP lines', () => {
    // chunk[N].startLine should be chunk[N-1].startLine + step
    for (let i = 1; i < chunks.length; i++) {
      const expectedStart = chunks[i - 1]!.startLine + step;
      expect(chunks[i]!.startLine).toBe(expectedStart);
    }
  });

  it('overlap size between consecutive chunks = CHUNK_OVERLAP', () => {
    for (let i = 1; i < chunks.length; i++) {
      const overlapLines = chunks[i - 1]!.endLine - chunks[i]!.startLine + 1;
      expect(overlapLines).toBe(CHUNK_OVERLAP);
    }
  });

  it('each non-last chunk spans exactly CHUNK_LOC lines', () => {
    for (let i = 0; i < chunks.length - 1; i++) {
      const loc = chunks[i]!.endLine - chunks[i]!.startLine + 1;
      expect(loc).toBe(CHUNK_LOC);
    }
  });

  it('last chunk spans up to endLine (may be < CHUNK_LOC)', () => {
    const last = chunks[chunks.length - 1]!;
    expect(last.endLine).toBe(800);
    expect(last.endLine - last.startLine + 1).toBeLessThanOrEqual(CHUNK_LOC);
  });

  it('chunk text matches the expected line slice', () => {
    const allLines = makeBody(800).split('\n');
    for (const c of chunks) {
      const expectedLines = allLines.slice(c.startLine - 1, c.endLine);
      expect(c.text).toBe(expectedLines.join('\n'));
    }
  });
});

// ===========================================================================
// describe('chunkSymbol — 1000-line symbol')
// ===========================================================================

describe('chunkSymbol — 1000-line symbol', () => {
  // With endLine=1000, step=150:
  //   Chunk 1:   1–200
  //   Chunk 2: 151–350
  //   Chunk 3: 301–500
  //   Chunk 4: 451–650
  //   Chunk 5: 601–800
  //   Chunk 6: 751–950
  //   Chunk 7: 901–1000  (clamped to endLine)

  let chunks: ReturnType<typeof chunkSymbol>;

  beforeEach(() => {
    const lineCount = 1000;
    const input: ChunkSymbolInput = {
      startLine: 1,
      endLine: lineCount,
      body: makeBody(lineCount),
    };
    chunks = chunkSymbol(input);
  });

  it('produces 7 chunks for a 1000-line symbol', () => {
    expect(chunks).toHaveLength(7);
  });

  it('first chunk startLine = 1', () => {
    expect(chunks[0]?.startLine).toBe(1);
  });

  it('last chunk endLine = 1000', () => {
    expect(chunks[chunks.length - 1]?.endLine).toBe(1000);
  });

  it('chunk_idx values run 1..7', () => {
    const idxs = chunks.map((c) => c.idx);
    expect(idxs).toEqual([1, 2, 3, 4, 5, 6, 7]);
  });
});

// ===========================================================================
// describe('queries-chunk-embeddings — upsertChunkEmbedding')
// ===========================================================================

describe('queries-chunk-embeddings — upsertChunkEmbedding', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('inserts a new chunk row', () => {
    insertNode(setup.qb, 'node-1');

    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-1',
      chunkIdx: 1,
      embedding: makeEmbeddingBuffer(),
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });

    const rows = getChunkEmbeddingsByNode(setup.qb, 'node-1');
    expect(rows).toHaveLength(1);
    expect(rows[0]?.chunkIdx).toBe(1);
    expect(rows[0]?.startLine).toBe(1);
    expect(rows[0]?.endLine).toBe(200);
  });

  it('conflict-update overwrites embedding and line range', () => {
    insertNode(setup.qb, 'node-1');

    const firstEmbed = makeEmbeddingBuffer(32);
    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-1',
      chunkIdx: 1,
      embedding: firstEmbed,
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });

    const secondEmbed = makeEmbeddingBuffer(32);
    // Flip all bytes to make it distinguishable
    for (let i = 0; i < secondEmbed.length; i++) secondEmbed[i] = 255 - secondEmbed[i]!;

    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-1',
      chunkIdx: 1,
      embedding: secondEmbed,
      embeddingModel: 'nomic-embed-text-v2',
      startLine: 10,
      endLine: 210,
      summaryHashAtEmbed: 'abc123',
    });

    const rows = getChunkEmbeddingsByNode(setup.qb, 'node-1');
    // Still only one row
    expect(rows).toHaveLength(1);
    // Values from the second upsert
    expect(rows[0]?.startLine).toBe(10);
    expect(rows[0]?.endLine).toBe(210);
    expect(Buffer.from(rows[0]!.embedding).equals(secondEmbed)).toBe(true);
  });

  it('throws on FK violation when node does not exist', () => {
    expect(() => {
      upsertChunkEmbedding(setup.qb, {
        nodeId: 'does-not-exist',
        chunkIdx: 1,
        embedding: makeEmbeddingBuffer(),
        embeddingModel: 'nomic-embed-text',
        startLine: 1,
        endLine: 200,
      });
    }).toThrow();
  });
});

// ===========================================================================
// describe('queries-chunk-embeddings — getChunkEmbeddingsByNode')
// ===========================================================================

describe('queries-chunk-embeddings — getChunkEmbeddingsByNode', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('returns empty array for a node with no chunks', () => {
    insertNode(setup.qb, 'node-empty');
    const rows = getChunkEmbeddingsByNode(setup.qb, 'node-empty');
    expect(rows).toEqual([]);
  });

  it('returns empty array for an unknown nodeId', () => {
    const rows = getChunkEmbeddingsByNode(setup.qb, 'no-such-node');
    expect(rows).toEqual([]);
  });

  it('returns rows in chunk_idx ascending order', () => {
    insertNode(setup.qb, 'node-ordered');

    // Insert in reverse order to confirm ORDER BY works.
    for (const chunkIdx of [3, 1, 2]) {
      upsertChunkEmbedding(setup.qb, {
        nodeId: 'node-ordered',
        chunkIdx,
        embedding: makeEmbeddingBuffer(),
        embeddingModel: 'nomic-embed-text',
        startLine: chunkIdx * 150 - 149,
        endLine: chunkIdx * 150,
      });
    }

    const rows = getChunkEmbeddingsByNode(setup.qb, 'node-ordered');
    expect(rows).toHaveLength(3);
    expect(rows.map((r) => r.chunkIdx)).toEqual([1, 2, 3]);
  });

  it('embedding bytes round-trip correctly', () => {
    insertNode(setup.qb, 'node-bytes');
    const embed = makeEmbeddingBuffer(16);

    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-bytes',
      chunkIdx: 1,
      embedding: embed,
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });

    const rows = getChunkEmbeddingsByNode(setup.qb, 'node-bytes');
    expect(Buffer.from(rows[0]!.embedding).equals(embed)).toBe(true);
  });
});

// ===========================================================================
// describe('queries-chunk-embeddings — clearChunkEmbeddings')
// ===========================================================================

describe('queries-chunk-embeddings — clearChunkEmbeddings', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('deletes all chunks for the target node', () => {
    insertNode(setup.qb, 'node-clear');
    for (const idx of [1, 2, 3]) {
      upsertChunkEmbedding(setup.qb, {
        nodeId: 'node-clear',
        chunkIdx: idx,
        embedding: makeEmbeddingBuffer(),
        embeddingModel: 'nomic-embed-text',
        startLine: idx * 150 - 149,
        endLine: idx * 150,
      });
    }

    clearChunkEmbeddings(setup.qb, 'node-clear');
    expect(getChunkEmbeddingsByNode(setup.qb, 'node-clear')).toEqual([]);
  });

  it('leaves other nodes unaffected', () => {
    insertNode(setup.qb, 'node-a');
    insertNode(setup.qb, 'node-b');

    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-a',
      chunkIdx: 1,
      embedding: makeEmbeddingBuffer(),
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });
    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-b',
      chunkIdx: 1,
      embedding: makeEmbeddingBuffer(),
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });

    clearChunkEmbeddings(setup.qb, 'node-a');

    expect(getChunkEmbeddingsByNode(setup.qb, 'node-a')).toEqual([]);
    expect(getChunkEmbeddingsByNode(setup.qb, 'node-b')).toHaveLength(1);
  });

  it('is a no-op for a node with no chunks', () => {
    insertNode(setup.qb, 'node-no-chunks');
    // Should not throw
    clearChunkEmbeddings(setup.qb, 'node-no-chunks');
    expect(getChunkEmbeddingsByNode(setup.qb, 'node-no-chunks')).toEqual([]);
  });
});

// ===========================================================================
// describe('queries-chunk-embeddings — countChunkEmbeddings')
// ===========================================================================

describe('queries-chunk-embeddings — countChunkEmbeddings', () => {
  let setup: DbSetup;

  beforeEach(() => {
    setup = setupDb();
  });

  afterEach(() => {
    teardownDb(setup);
  });

  it('returns 0 on an empty table', () => {
    expect(countChunkEmbeddings(setup.qb)).toBe(0);
  });

  it('counts rows across multiple nodes', () => {
    insertNode(setup.qb, 'node-x');
    insertNode(setup.qb, 'node-y');

    for (const idx of [1, 2]) {
      upsertChunkEmbedding(setup.qb, {
        nodeId: 'node-x',
        chunkIdx: idx,
        embedding: makeEmbeddingBuffer(),
        embeddingModel: 'nomic-embed-text',
        startLine: idx,
        endLine: idx + 10,
      });
    }
    upsertChunkEmbedding(setup.qb, {
      nodeId: 'node-y',
      chunkIdx: 1,
      embedding: makeEmbeddingBuffer(),
      embeddingModel: 'nomic-embed-text',
      startLine: 1,
      endLine: 200,
    });

    expect(countChunkEmbeddings(setup.qb)).toBe(3);
  });

  it('decreases after clearChunkEmbeddings', () => {
    insertNode(setup.qb, 'node-z');
    for (const idx of [1, 2, 3]) {
      upsertChunkEmbedding(setup.qb, {
        nodeId: 'node-z',
        chunkIdx: idx,
        embedding: makeEmbeddingBuffer(),
        embeddingModel: 'nomic-embed-text',
        startLine: idx,
        endLine: idx + 10,
      });
    }

    expect(countChunkEmbeddings(setup.qb)).toBe(3);
    clearChunkEmbeddings(setup.qb, 'node-z');
    expect(countChunkEmbeddings(setup.qb)).toBe(0);
  });
});
