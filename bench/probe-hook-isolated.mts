/**
 * Per-hook isolated bench — runs ONE hook at a time against an
 * already-indexed project and reports its standalone wall (no
 * Promise.all wait on sibling Group B hooks).
 *
 * Use to A/B a hook before/after a perf change and to confirm
 * whether a hook's `probe-hook-timings.mts` duration was actually
 * inherent cost vs. event-loop wait on a long pole peer.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path bun bench/probe-hook-isolated.mts <hook-name>
 *   BENCH_PROJECT_DIR=/path bun bench/probe-hook-isolated.mts re-export-edges,dynamic-import-edges
 */

import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getRegisteredHooks } from '../src/index-hooks/registry.js';
import type { IndexHookContext } from '../src/index-hooks/types.js';
import { loadConfig } from '../src/config.js';

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: BENCH_PROJECT_DIR=/path bun bench/probe-hook-isolated.mts <hook-name>[,<hook-name>...]');
    process.exit(1);
  }
  const hookNames = arg.split(',').map((s) => s.trim());

  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing isolated hook timings against: ${projectRoot}`);
  console.log(`hooks: ${hookNames.join(', ')}\n`);

  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    const ctx: IndexHookContext = {
      projectRoot,
      config: loadConfig(projectRoot),
      queries: cg.queries,
      db: cg.queries.db as unknown as import('../src/db/index.js').DatabaseConnection,
    };

    const all = getRegisteredHooks();
    for (const hookName of hookNames) {
      const hook = all.find((h) => h.name === hookName);
      if (!hook) {
        console.error(`  ✗ no registered hook named '${hookName}' — available: ${all.map((h) => h.name).join(', ')}`);
        continue;
      }
      if (!hook.afterIndexAll) {
        console.log(`  ${hookName}: no afterIndexAll handler — skipping`);
        continue;
      }
      const start = Date.now();
      try {
        await hook.afterIndexAll(ctx);
        const ms = Date.now() - start;
        console.log(`  ${hookName.padEnd(28)} ${String(ms).padStart(7)}ms`);
      } catch (err) {
        console.log(`  ${hookName.padEnd(28)} ERROR: ${err instanceof Error ? err.message : String(err)}`);
      }
    }
  } finally {
    cg.close();
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
