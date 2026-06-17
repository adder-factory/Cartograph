import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import Cartograph from '../src/index.js';
import { buildSimilarToEdges } from '../src/embeddings/similar-edges.js';

describe('similarity edges', () => {
  let tempDir: string;
  let projectPath: string;
  let cg: InstanceType<typeof Cartograph>;

  beforeEach(async () => {
    tempDir = mkdtempSync(join('/tmp', 'cartograph-test-'));
    projectPath = join(tempDir, 'project');
    cg = await Cartograph.init(projectPath, { index: false });
  });

  afterEach(() => {
    cg?.close();
    rmSync(tempDir, { recursive: true, force: true });
  });

  it('returns 0/0 counts on an empty embedding table', async () => {
    const result = await buildSimilarToEdges(cg, { k: 5, minScore: 0.6 });

    expect(result.written).toBe(0);
    expect(result.processed).toBe(0);
  });

  it('is idempotent — running twice yields same result', async () => {
    const result1 = await buildSimilarToEdges(cg, { k: 5, minScore: 0.6 });
    const result2 = await buildSimilarToEdges(cg, { k: 5, minScore: 0.6 });

    expect(result1.written).toBe(result2.written);
    expect(result1.processed).toBe(result2.processed);
    expect(result1.reason).toBe(result2.reason);
  });

  it('accepts optional k and minScore parameters', async () => {
    // Verify that the function accepts the optional parameters without error
    const result1 = await buildSimilarToEdges(cg, { k: 1, minScore: 0.9 });
    const result2 = await buildSimilarToEdges(cg, { k: 10, minScore: 0.1 });

    // Both should return gracefully with 0 edges
    expect(result1).toBeDefined();
    expect(result2).toBeDefined();
    expect(result1.written).toBe(0);
    expect(result2.written).toBe(0);
  });

  it('reports contention instead of racing when the index lock is held by another writer', async () => {
    // Simulate a concurrent re-extract holding the cross-process file lock.
    cg.lock.file.acquire();
    try {
      const result = await buildSimilarToEdges(cg, { k: 5, minScore: 0.6 });
      expect(result.written).toBe(0);
      expect(result.processed).toBe(0);
      expect(result.reason).toMatch(/index busy/i);
    } finally {
      cg.lock.file.release();
    }
  });
});
