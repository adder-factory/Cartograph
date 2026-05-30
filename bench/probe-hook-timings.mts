/**
 * Per-hook indexAll timing probe — invokes `runAfterIndexAll` against
 * an already-indexed project (no extract/resolve cost) and reports
 * each hook's wall time, ranked by descending duration.
 *
 * Use to identify the actual long pole(s) in the post-indexAll hook
 * phase. The bench/sync-parallel-hooks.mts script gives a total wall;
 * this one gives the per-hook breakdown.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path/to/project bun bench/probe-hook-timings.mts
 *
 * Caveats:
 *   - Runs against the LIVE DB. Hooks that mutate state (most of
 *     them — they emit edges / write metrics) will write to the
 *     project's DB. Don't run against your live working project.
 *   - First-pass timings are warm-cache (the DB was touched recently
 *     by the migration / open). Cold-cache timings are higher.
 */

import * as path from 'path';
import { Cartograph } from '../src/index.js';
import { runAfterIndexAll } from '../src/index-hooks/registry.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';
import { loadConfig } from '../src/config.js';

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing per-hook indexAll timings against: ${projectRoot}\n`);

  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    const ctx: IndexHookContext = {
      projectRoot,
      config: loadConfig(projectRoot),
      queries: cg.queries,
      db: cg.queries.db as unknown as import('../src/db/index.js').DatabaseConnection,
    };

    const t0 = Date.now();
    const outcomes = await runAfterIndexAll(ctx);
    const totalMs = Date.now() - t0;

    const ranked = [...outcomes].sort((a, b) => b.durationMs - a.durationMs);
    console.log(`per-hook timings (ms, descending):`);
    console.log(`  ${'hook'.padEnd(28)} ${'durationMs'.padStart(10)}   notes`);
    for (const o of ranked) {
      const note = o.error ? `error: ${o.error.message}` : '';
      console.log(`  ${o.name.padEnd(28)} ${String(o.durationMs).padStart(10)}   ${note}`);
    }
    const top = ranked[0];
    if (top) {
      const pct = ((top.durationMs / totalMs) * 100).toFixed(1);
      console.log(
        `\ntotal: ${totalMs}ms across ${outcomes.length} hooks. Long pole: ${top.name} (${top.durationMs}ms = ${pct}% of total).`,
      );
      const top3 = ranked.slice(0, 3);
      const top3Sum = top3.reduce((s, h) => s + h.durationMs, 0);
      const top3Pct = ((top3Sum / totalMs) * 100).toFixed(1);
      console.log(`Top 3 hooks: ${top3.map((h) => h.name).join(', ')} = ${top3Sum}ms (${top3Pct}% of total).`);
    }
  } finally {
    cg.destroy();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
