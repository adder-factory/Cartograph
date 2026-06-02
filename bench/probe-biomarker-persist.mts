/**
 * Isolated bench of the biomarker persist phase. The standard
 * `analyseProject` bench misses persist cost on warm runs because
 * cache-hits skip the per-file compute + persist entirely.
 *
 * This bench:
 *   1. Clears the biomarker cache metadata to force every file to
 *      recompute on next analyse.
 *   2. Runs `analyseProject` once (cold — full per-file compute +
 *      persist + cross-file rules).
 *   3. Reports the cold wall.
 *   4. Runs `analyseProject` a second time (warm — cache hits on
 *      every file; only cross-file rules run).
 *   5. The DIFFERENCE (cold - warm) is the per-file compute + persist
 *      wall — i.e. what B35/B36 batch-persist would optimise.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path/to/project bun bench/probe-biomarker-persist.mts
 */

import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { analyseProject } from '../src/biomarkers/index.js';
import { setMetadata, getMetadata, type MetadataKey } from '../src/db/queries-metadata.js';

const BIOMARKER_CACHE_KEY_PREFIX = 'biomarker_file_state_';

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing biomarker persist phase against: ${projectRoot}\n`);

  // Clear the biomarker cache metadata key(s). The actual key includes
  // a hash suffix (biomarker_file_state_{biomarker-hash}_{extraction-hash}),
  // so we look it up via the live engine first.
  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    // Find all biomarker_file_state_* keys + drop them.
    const keys = cg.queries.db
      .prepare<{ key: string }, []>(`SELECT key FROM project_metadata WHERE key LIKE '${BIOMARKER_CACHE_KEY_PREFIX}%'`)
      .all() as Array<{ key: string }>;
    console.log(`clearing ${keys.length} biomarker cache key(s)…`);
    for (const { key } of keys) {
      setMetadata(cg.queries, key as MetadataKey, JSON.stringify({}));
    }

    // Cold pass — every file recomputes + persists.
    console.log('cold pass (cache wiped, every file recomputes + persists)…');
    const t0 = Date.now();
    const cold = await analyseProject(cg.queries, projectRoot);
    const coldMs = Date.now() - t0;
    console.log(
      `  cold: ${coldMs}ms — ${cold.filesScanned} files scanned, ${cold.symbolsAnalysed} symbols, ${cold.findingsEmitted} findings emitted, ${cold.filesSkippedByCache} cache hits`,
    );

    // Warm pass — every file cache-hits; only cross-file rules + walk.
    console.log('\nwarm pass (cache populated, every file short-circuits)…');
    const t1 = Date.now();
    const warm = await analyseProject(cg.queries, projectRoot);
    const warmMs = Date.now() - t1;
    console.log(
      `  warm: ${warmMs}ms — ${warm.filesScanned} files scanned, ${warm.symbolsAnalysed} symbols, ${warm.findingsEmitted} findings emitted, ${warm.filesSkippedByCache} cache hits`,
    );

    const perFilePhaseMs = coldMs - warmMs;
    console.log(`\nper-file compute + persist phase ≈ ${perFilePhaseMs}ms (cold ${coldMs} − warm ${warmMs}).`);
    console.log(
      `That's the wall B35/B36 batch-persist would optimise. If small (<500ms on this corpus), batching is not worth the writer-signature refactor.`,
    );

    // Sanity: persist cache key write should NOT have changed the file count.
    const stored = keys[0]?.key ? getMetadata(cg.queries, keys[0].key as MetadataKey) : null;
    if (stored) {
      try {
        const parsed = JSON.parse(stored) as Record<string, unknown>;
        console.log(`  (cache repopulated: ${Object.keys(parsed).length} file entries)`);
      } catch {
        /* ignore */
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
