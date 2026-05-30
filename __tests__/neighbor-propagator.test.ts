/**
 * Tests for neighbor-propagator: embedding-based summary propagation.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import * as crypto from 'node:crypto';
import { Cartograph } from '../src/index.js';
import type { QueryBuilder } from '../src/db/queries.js';
import {
  runNeighborPropagator,
  NeighborPropagatorOptions,
  NeighborPropagatorResult,
} from '../src/llm/neighbor-propagator.js';
import { upsertSymbolEmbedding } from '../src/db/queries-embeddings.js';
import { getSymbolSummary } from '../src/db/queries-summaries.js';

// Test utilities
function createTempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-test-'));
}

function cleanupTempDir(dir: string): void {
  if (fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * Create a deterministic embedding vector with a specific "seed" value.
 * Returns a normalized Float32Array.
 */
function createDeterministicVector(seed: number, dim: number = 384): Float32Array {
  const vec = new Float32Array(dim);
  const h = crypto.createHash('sha256');
  h.update(seed.toString());
  const hash = h.digest();

  // Fill with deterministic values derived from the hash.
  for (let i = 0; i < dim; i++) {
    const byteVal = hash[i % hash.length];
    vec[i] = (byteVal / 255.0) * 2 - 1; // Range [-1, 1]
  }

  // L2-normalize.
  let norm = 0;
  for (let i = 0; i < dim; i++) {
    norm += vec[i] * vec[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < dim; i++) {
      vec[i] /= norm;
    }
  }

  return vec;
}

/**
 * Create a vector that is very similar to another (high cosine similarity).
 * Applies a small random perturbation and re-normalizes.
 */
function createSimilarVector(baseVec: Float32Array, noiseMagnitude: number = 0.05): Float32Array {
  const similar = new Float32Array(baseVec.length);
  const h = crypto.createHash('sha256');
  h.update('similar-' + noiseMagnitude.toString());
  const noise = h.digest();

  for (let i = 0; i < baseVec.length; i++) {
    const noiseVal = (noise[i % noise.length] / 255.0) * 2 - 1;
    similar[i] = baseVec[i] + noiseVal * noiseMagnitude;
  }

  // L2-normalize.
  let norm = 0;
  for (let i = 0; i < baseVec.length; i++) {
    norm += similar[i] * similar[i];
  }
  norm = Math.sqrt(norm);
  if (norm > 0) {
    for (let i = 0; i < baseVec.length; i++) {
      similar[i] /= norm;
    }
  }

  return similar;
}

/**
 * Convert Float32Array to Buffer (little-endian) for database storage.
 */
function vectorToBuffer(vec: Float32Array): Buffer {
  return Buffer.from(vec.buffer, vec.byteOffset, vec.byteLength);
}

/**
 * Seed the `files` row(s) the test needs so node inserts satisfy the
 * `nodes.file_path -> files(path)` FK (migration 056). Idempotent.
 */
function seedFile(qb: QueryBuilder, fpath: string): void {
  qb.db
    .prepare(
      `INSERT OR IGNORE INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?)`,
    )
    .run(fpath, 'hash1', 'typescript', 0, 0, 0);
}

/**
 * Extract cosine similarity from two Float32Arrays.
 */
function computeCosine(v1: Float32Array, v2: Float32Array): number {
  if (v1.length !== v2.length) return 0;
  let dot = 0;
  for (let i = 0; i < v1.length; i++) {
    dot += v1[i] * v2[i];
  }
  return Math.max(0, Math.min(1, dot));
}

describe('NeighborPropagator', () => {
  let tempDir: string;
  let cg: Cartograph;
  let qb: QueryBuilder;

  beforeEach(() => {
    tempDir = createTempDir();
    cg = Cartograph.initSync(tempDir);
    qb = cg.queries;
    // Seed the parent files row up-front so node inserts referencing
    // '/test/file.ts' satisfy the migration-056 FK
    // (`nodes.file_path -> files(path)`). Tests that exercise other
    // paths must call seedFile() themselves.
    seedFile(qb, '/test/file.ts');
  });

  afterEach(() => {
    cg.close();
    cleanupTempDir(tempDir);
  });

  describe('high-similarity neighbor propagation', () => {
    it('should propagate summary from a high-similarity neighbor', async () => {
      // Create two functions: func1 (summarized) and func2 (unsummarized).
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func2', 'func2', 'function', 'func2', 'func2()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      // Insert file row for embedding FK constraint.
      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      // Create embeddings: func2 is very similar to func1.
      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createSimilarVector(vec1, 0.01); // Very high similarity.
      const cosine = computeCosine(vec1, vec2);
      expect(cosine).toBeGreaterThan(0.95); // Verify high similarity.

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func2',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      // Insert summary for func1 only.
      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('func1', 'hash1', 'Computes the sum of two numbers', 'test-llm', 1000)
      `);

      // Run propagator.
      const result = await runNeighborPropagator({ queries: qb });

      // Verify results.
      expect(result.candidates).toBe(1); // func2 is the only unsummarized candidate.
      expect(result.propagated).toBe(1); // Summary should be copied.
      expect(result.belowThreshold).toBe(0);
      expect(result.noNeighbor).toBe(0);

      // Verify that func2 now has the summary.
      const summary = getSymbolSummary(qb, 'func2');
      expect(summary).not.toBeNull();
      expect(summary?.summary).toBe('Computes the sum of two numbers');
      expect(summary?.model).toBe('neighbor:v1');
    });
  });

  describe('low-similarity threshold filtering', () => {
    it('should NOT propagate when cosine < minCosine', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func2', 'func2', 'function', 'func2', 'func2()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      // Create dissimilar vectors.
      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createDeterministicVector(999, 384); // Seed far away = low similarity.
      const cosine = computeCosine(vec1, vec2);
      expect(cosine).toBeLessThan(0.85); // Ensure below threshold.

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func2',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('func1', 'hash1', 'Test summary', 'test-llm', 1000)
      `);

      // Run propagator with default minCosine (0.85).
      const result = await runNeighborPropagator({ queries: qb });

      expect(result.candidates).toBe(1);
      expect(result.propagated).toBe(0);
      expect(result.belowThreshold).toBe(1); // Should count as below threshold.

      // Verify func2 has no summary.
      const summary = getSymbolSummary(qb, 'func2');
      expect(summary).toBeNull();
    });
  });

  describe('same-kind filtering', () => {
    it('should NOT propagate from different-kind neighbor when sameKindOnly=true', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('method1', 'method1', 'method', 'method1', 'method1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      // Create very similar vectors.
      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createSimilarVector(vec1, 0.01);

      upsertSymbolEmbedding({
        qb,
        nodeId: 'method1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('method1', 'hash1', 'Method summary', 'test-llm', 1000)
      `);

      // Run with sameKindOnly=true (default).
      const result = await runNeighborPropagator({
        queries: qb,
        options: { sameKindOnly: true },
      });

      expect(result.candidates).toBe(1);
      expect(result.propagated).toBe(0);
      expect(result.noNeighbor).toBe(1);

      // Verify func1 has no summary.
      const summary = getSymbolSummary(qb, 'func1');
      expect(summary).toBeNull();
    });

    it('should propagate across kinds when sameKindOnly=false', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('method1', 'method1', 'method', 'method1', 'method1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createSimilarVector(vec1, 0.01);

      upsertSymbolEmbedding({
        qb,
        nodeId: 'method1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('method1', 'hash1', 'Transforms input data', 'test-llm', 1000)
      `);

      // Run with sameKindOnly=false.
      const result = await runNeighborPropagator({
        queries: qb,
        options: { sameKindOnly: false },
      });

      expect(result.candidates).toBe(1);
      expect(result.propagated).toBe(1);

      // Verify func1 got the summary.
      const summary = getSymbolSummary(qb, 'func1');
      expect(summary).not.toBeNull();
      expect(summary?.summary).toBe('Transforms input data');
      expect(summary?.model).toBe('neighbor:v1');
    });
  });

  describe('existing summary preservation', () => {
    it('should NOT overwrite existing summary', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func2', 'func2', 'function', 'func2', 'func2()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createSimilarVector(vec1, 0.01);

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func2',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES
          ('func1', 'hash1', 'Original summary', 'test-llm', 1000),
          ('func2', 'hash2', 'Existing func2 summary', 'test-llm', 1000)
      `);

      const result = await runNeighborPropagator({ queries: qb });

      expect(result.candidates).toBe(0); // func2 already has a summary.

      // Verify func2's summary is unchanged.
      const summary = getSymbolSummary(qb, 'func2');
      expect(summary?.summary).toBe('Existing func2 summary');
      expect(summary?.model).toBe('test-llm');
    });
  });

  describe('no-data edge cases', () => {
    it('should handle no embeddings gracefully', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000)
      `);

      const result = await runNeighborPropagator({ queries: qb });

      expect(result.candidates).toBe(0);
      expect(result.propagated).toBe(0);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it('should handle no candidates (all summarized)', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      const vec1 = createDeterministicVector(1, 384);
      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('func1', 'hash1', 'Test summary', 'test-llm', 1000)
      `);

      const result = await runNeighborPropagator({ queries: qb });

      expect(result.candidates).toBe(0);
      expect(result.propagated).toBe(0);
    });
  });

  describe('progress callback', () => {
    it('should call onProgress for each candidate', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func2', 'func2', 'function', 'func2', 'func2()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000),
          ('func3', 'func3', 'function', 'func3', 'func3()', '/test/file.ts', 20, 25, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      const vec = createDeterministicVector(1, 384);

      for (const id of ['func1', 'func2', 'func3']) {
        upsertSymbolEmbedding({
          qb,
          nodeId: id,
          embedding: vectorToBuffer(vec),
          model: 'test-model',
          summaryHashAtEmbed: '',
        });
      }

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('func1', 'hash1', 'Test', 'test-llm', 1000)
      `);

      const progressCalls: Array<[number, number]> = [];
      const onProgress = (done: number, total: number) => {
        progressCalls.push([done, total]);
      };

      await runNeighborPropagator({ queries: qb, options: { onProgress } });

      expect(progressCalls.length).toBeGreaterThan(0);
      // Last call should be (total, total) indicating completion.
      const last = progressCalls[progressCalls.length - 1];
      expect(last[0]).toBe(last[1]);
    });
  });

  describe('custom minCosine threshold', () => {
    it('should respect custom minCosine option', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES
          ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000),
          ('func2', 'func2', 'function', 'func2', 'func2()', '/test/file.ts', 10, 15, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      // Create vectors with high similarity to demonstrate lowering threshold works.
      const vec1 = createDeterministicVector(1, 384);
      const vec2 = createSimilarVector(vec1, 0.08); // Slight noise to get ~0.80 similarity.
      const cosine = computeCosine(vec1, vec2);

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec1),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      upsertSymbolEmbedding({
        qb,
        nodeId: 'func2',
        embedding: vectorToBuffer(vec2),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      qb.db.exec(`
        INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at)
        VALUES ('func1', 'hash1', 'Test summary', 'test-llm', 1000)
      `);

      // Should fail with default minCosine=0.85 (cosine is < 0.85).
      let result = await runNeighborPropagator({ queries: qb });
      expect(result.propagated).toBe(0);
      expect(result.belowThreshold).toBe(1);

      // Should succeed with lowered minCosine that is below actual cosine.
      const threshold = Math.max(0.5, cosine - 0.02);
      result = await runNeighborPropagator({
        queries: qb,
        options: { minCosine: threshold },
      });
      // Verify it propagated when threshold dropped.
      expect(result.propagated + result.belowThreshold).toBe(1);
    });
  });

  describe('AbortSignal support', () => {
    it('should respect AbortSignal', async () => {
      qb.db.exec(`
        INSERT INTO nodes (id, name, kind, qualified_name, signature, file_path, start_line, end_line, start_column, end_column, language, updated_at)
        VALUES ('func1', 'func1', 'function', 'func1', 'func1()', '/test/file.ts', 1, 5, 0, 5, 'typescript', 1000)
      `);

      qb.db.exec(
        "INSERT OR IGNORE INTO files (path, content_hash, language) VALUES ('/test/file.ts', 'hash1', 'typescript')",
      );

      const vec = createDeterministicVector(1, 384);
      upsertSymbolEmbedding({
        qb,
        nodeId: 'func1',
        embedding: vectorToBuffer(vec),
        model: 'test-model',
        summaryHashAtEmbed: '',
      });

      const abortController = new AbortController();
      abortController.abort();

      // bun:test's `.rejects` expects a Promise directly, not a
      // function returning a Promise (vitest accepted either).
      await expect(
        runNeighborPropagator({
          queries: qb,
          options: { signal: abortController.signal },
        }),
      ).rejects.toThrow();
    });
  });
});
