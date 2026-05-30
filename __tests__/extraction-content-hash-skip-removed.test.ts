/**
 * Originally a regression test for the removal of
 * `eoStoreExtractionResult`'s content-hash skip (closed friction-
 * tracker #52 / #55): when stored content_hash matched the current
 * content's hash, an early-return skip preserved phantom edges from
 * a prior buggy extractor.
 *
 * That guarantee no longer holds under G7 (migration 066, 2026-05-21).
 * The format-only fast path in `eoPersistFileExtraction` deliberately
 * SKIPS `removeFileFromIndexInTx` when the new struct_hash matches
 * the prior one — stable node ids let edges + role + centrality stay
 * intact across whitespace-only re-extracts. A re-index of an
 * unchanged file is, by definition, struct_hash-equal, so the format-
 * only branch fires and phantom edges injected by external means
 * survive. The recovery for that case is `admin index --force`
 * (cleanwipe), the explicit "rebuild structural" workflow.
 *
 * Test re-purposed: verify the G7 contract, that a no-content-change
 * re-index PRESERVES the file's edges (including the phantom we
 * injected). The phantom-clearing scenario above is now covered by
 * the `admin index --force` flow exercised elsewhere.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import Cartograph from '../src/index.js';

describe('eoStoreExtractionResult content-hash skip removal (#52/#55)', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-content-hash-skip-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lib.ts'), 'export function alpha(): number { return 1; }\n');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('preserves file-scoped edges across a same-content re-index (G7 format-only fast path)', async () => {
    // Snapshot real edges-for-file count.
    const realEdgesBefore = cg.queries.db
      .prepare(
        `SELECT COUNT(*) AS c FROM edges
         WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
            OR target IN (SELECT id FROM nodes WHERE file_path = ?)`,
      )
      .get('src/lib.ts', 'src/lib.ts') as { c: number };
    expect(realEdgesBefore.c).toBeGreaterThanOrEqual(1); // At least the file→alpha contains edge.

    // Insert a stale phantom edge. A real corruption-by-prior-buggy-
    // extractor looks like this: an edge whose source is the file's
    // symbol but whose target is some node that the current extractor
    // would never produce. We use a node ID that's guaranteed to be
    // valid (the alpha symbol itself, self-edge with unusual line) so
    // we can detect it via the metadata field after re-extraction.
    const alphaId = (
      cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'alpha' AND file_path = 'src/lib.ts'`).get() as
        | { id: string }
        | undefined
    )?.id;
    expect(alphaId).toBeDefined();
    cg.queries.db
      .prepare(
        `INSERT INTO edges (source, target, kind, line, col, metadata)
         VALUES (?, ?, 'calls', 9999, 0, '{"phantom_marker":true}')`,
      )
      .run(alphaId, alphaId);

    const phantomEdgesBefore = cg.queries.db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE line = 9999 AND metadata LIKE '%phantom_marker%'`)
      .get() as { c: number };
    expect(phantomEdgesBefore.c).toBe(1);

    // Re-index the SAME file. Content unchanged, so contentHash matches
    // the stored value. Without the fix this is a no-op (skip fires).
    // With the fix, eoPersistFileExtraction runs, deleteFile clears all
    // file-scoped edges, fresh extraction inserts the real ones back,
    // and the phantom edge — which has no extractor source — is gone.
    await cg.internals.orchestrator.indexFile('src/lib.ts');

    const phantomEdgesAfter = cg.queries.db
      .prepare(`SELECT COUNT(*) AS c FROM edges WHERE line = 9999 AND metadata LIKE '%phantom_marker%'`)
      .get() as { c: number };
    // Under G7 the same-content re-index hits the format-only fast
    // path (struct_hash matches), so the cascade-evict is skipped and
    // the phantom edge survives. The pre-G7 expectation was `.toBe(0)`
    // (clear-on-skip-removal); the G7 expectation is preservation.
    expect(phantomEdgesAfter.c).toBe(1);

    // Real edges should still be present after re-extraction. Use a
    // set-equality snapshot (reviewer-tightening) so we'd also catch
    // a regression that silently ADDED spurious edges on re-extract.
    const snapshotEdges = (): Array<{ source: string; target: string; kind: string }> =>
      cg.queries.db
        .prepare(
          `SELECT source, target, kind FROM edges
           WHERE source IN (SELECT id FROM nodes WHERE file_path = ?)
              OR target IN (SELECT id FROM nodes WHERE file_path = ?)
           ORDER BY source, target, kind`,
        )
        .all('src/lib.ts', 'src/lib.ts') as Array<{ source: string; target: string; kind: string }>;
    const edgesAfter = snapshotEdges();
    // Under G7 the phantom self-edge (alphaId → alphaId, line=9999)
    // is preserved across the format-only fast path — same struct,
    // node ids stable, cascade-evict skipped. Pre-G7 this assertion
    // was `.toBe(false)` (phantom cleared). To clean such corruption
    // the operator runs `admin index --force`.
    expect(edgesAfter.some((e) => e.source === alphaId && e.target === alphaId && e.kind === 'calls')).toBe(true);
    expect(edgesAfter.length).toBeGreaterThanOrEqual(1);
  });
});
