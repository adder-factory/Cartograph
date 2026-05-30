/**
 * Handoff #10 — silent edge-loss bug class.
 *
 * `insertEdges` drops edges whose source/target node doesn't exist
 * via `filterEdgesWithExistingEndpoints` (so the surrounding txn
 * doesn't FK-abort). Before the fix, the resolver still called
 * `deleteSpecificResolvedReferences` on every "resolved" ref —
 * including those whose edges were silently dropped. Result: both
 * the ref AND the edge vanished, with no error reported. The
 * cumulative effect under a full-project re-extract was the
 * "edges → 0, unresolved_refs → 31k" stranded state 8be2fd2 worked
 * around with a safety net.
 *
 * After the fix, `insertEdges` returns the survivor set, and the
 * resolver only deletes refs whose corresponding edge actually
 * survived the endpoint check. Refs whose edge was dropped stay in
 * `unresolved_refs` — they're either dead-permanently (FK CASCADE
 * eventually cleans them) or will resolve on a future sync.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';

describe('Resolution — silent edge-loss bug (handoff #10)', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-orphan-survival-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    // Real cross-file scenario: A.caller() invokes B.helper(). After
    // indexing both files an `unresolved_refs` row briefly exists
    // for that call before resolution promotes it to a `calls` edge.
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function helper(): number { return 42; }\n`);
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      `import { helper } from './b.js';\nexport function caller(): number { return helper(); }\n`,
    );
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'orphan-fixture', version: '0.0.0' }));
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('happy path: a resolvable ref produces an edge AND clears its unresolved_refs row', async () => {
    // Re-extraction during a sync reconstructs cross-file refs.
    // Touch a.ts so a sync re-extracts it; the new unresolved_ref
    // should resolve cleanly into a `calls` edge and the row clears.
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      `import { helper } from './b.js';\nexport function caller(): number { return helper() + 1; }\n`,
    );
    await cg.sync();

    const callsEdges = cg.queries.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'calls'`).get() as {
      c: number;
    };
    expect(callsEdges.c).toBeGreaterThan(0);

    const survivingRefs = cg.queries.db
      .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name = 'helper'`)
      .get() as { c: number };
    // The 'helper' ref resolved cleanly, so its row is gone.
    expect(survivingRefs.c).toBe(0);
  });

  it('resolveAndPersistBatched terminates and preserves the orphan row (no infinite loop)', async () => {
    // Reviewer caught this: `resolveAndPersistBatched`'s break
    // condition is `resolved.length === 0 && unresolved.length === batch.length`.
    // Post-fix, orphan refs land in `resolved` (passed name-match) but
    // never decrement the unresolved_refs table — without the
    // `deletedCount === 0` guard the loop would spin forever on a
    // batch of pure orphans.

    // Inject the synthetic orphan ref the same way as the next test.
    cg.queries.db.exec('PRAGMA foreign_keys = OFF');
    try {
      cg.queries.db
        .prepare(
          `INSERT INTO unresolved_refs
           (from_node_id, reference_name, reference_kind, line, col, file_path, language)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('n_dead_for_batched', 'helper', 'calls', 99, 0, 'src/a.ts', 'typescript');
    } finally {
      cg.queries.db.exec('PRAGMA foreign_keys = ON');
    }

    // Call resolveAndPersistBatched directly with a short timeout so an
    // infinite loop fails the test promptly instead of hanging.
    const resolver = (
      cg as unknown as { internals: { resolver: { resolveAndPersistBatched: () => Promise<unknown> } } }
    ).internals.resolver;
    const completed = await Promise.race([
      resolver.resolveAndPersistBatched().then(() => 'done'),
      new Promise<string>((resolve) => setTimeout(() => resolve('timeout'), 5_000)),
    ]);
    expect(completed).toBe('done');

    // Orphan row should still be there (fix #10's preservation contract).
    const orphan = (
      cg.queries.db
        .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE from_node_id = 'n_dead_for_batched'`)
        .get() as { c: number }
    ).c;
    expect(orphan).toBe(1);
  }, 10_000);

  it('preserves the unresolved_ref row when its edge would FK-fail at insert', async () => {
    // Simulate the silent-loss scenario: an `unresolved_refs` row
    // whose `from_node_id` points at a node that doesn't exist
    // (the cascade race / orphan-from-prior-partial-sync class).
    // Pre-fix: resolver matched 'helper' by name, built an Edge
    // with source=DEAD_ID + target=helper_id, insertEdges silently
    // dropped it (filterEdgesWithExistingEndpoints), then
    // deleteSpecificResolvedReferences removed the orphan anyway.
    // Result: both ref + edge gone, no trace. Post-fix: the row
    // survives because no edge actually inserted.

    // 1. Bypass FK to inject a synthetic orphan ref (mirrors the
    //    real-world failure mode where a node was deleted but its
    //    referrer rows didn't cascade-clean for some reason).
    cg.queries.db.exec('PRAGMA foreign_keys = OFF');
    try {
      cg.queries.db
        .prepare(
          `INSERT INTO unresolved_refs
           (from_node_id, reference_name, reference_kind, line, col, file_path, language)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        )
        .run('n_dead_orphan_id', 'helper', 'calls', 99, 0, 'src/a.ts', 'typescript');
    } finally {
      cg.queries.db.exec('PRAGMA foreign_keys = ON');
    }

    const beforeCount = (
      cg.queries.db
        .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE from_node_id = 'n_dead_orphan_id'`)
        .get() as { c: number }
    ).c;
    expect(beforeCount).toBe(1);

    // 2. Touch a real file so a sync triggers resolution (the resolver
    //    only re-runs Pass A/B when files moved). The synthetic orphan
    //    will be in the Pass A unresolved-refs query result (its
    //    file_path = 'src/a.ts' is in changedFilePaths).
    fs.writeFileSync(
      path.join(testDir, 'src', 'a.ts'),
      `import { helper } from './b.js';\nexport function caller(): number { return helper() + 2; }\n`,
    );
    await cg.sync();

    // 3. POST-fix invariant: the orphan ref STILL EXISTS in
    //    unresolved_refs because its corresponding edge was dropped
    //    by the endpoint check (source 'n_dead_orphan_id' doesn't
    //    exist in nodes). Pre-fix: this would be 0 (silently deleted).
    const afterCount = (
      cg.queries.db
        .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE from_node_id = 'n_dead_orphan_id'`)
        .get() as { c: number }
    ).c;
    expect(afterCount).toBe(1);

    // 4. AND: no spurious edge was emitted with the dead source.
    const spuriousEdge = (
      cg.queries.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE source = 'n_dead_orphan_id'`).get() as { c: number }
    ).c;
    expect(spuriousEdge).toBe(0);
  });
});
