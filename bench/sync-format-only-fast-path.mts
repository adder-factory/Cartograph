/**
 * G7 bench: confirms the format-only sync fast path collapses
 * minutes-of-work into seconds when a mass formatter pass touches
 * inter-symbol whitespace.
 *
 * Setup: 220 trivial TypeScript files in a tmp project, each
 * exporting a single function. Index them once (cold sync — full
 * extract path), then mutate every file's INTER-symbol whitespace
 * (blank lines / final newline) without touching the function body.
 * Re-sync. With stable node ids + struct_hash matching, every file
 * routes through the format-only fast path: in-place UPDATE of line
 * ranges and skip of the cascade-evict + edge re-emit.
 *
 * Gate metric: post-G7 wall clock < 30s for the 220-file resync.
 * Pre-G7 baseline on the same hardware is ~60-90s (cascade-evict
 * dominates). The bench prints actual elapsed time so the trend
 * is visible across runs even without a hard threshold.
 *
 * Note on biome's real-world formatter: this bench specifically
 * exercises the inter-symbol-whitespace case where bodyHash stays
 * stable. Biome's typical pass also reformats inside function
 * bodies (indentation, line wrapping), which changes bodyHash and
 * defeats the format-only path. That's correct — body content
 * changed, real re-extract is appropriate. The bench measures the
 * achievable upper bound on the win, not the field-typical case.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { Cartograph } from '../src/index.js';

const FILE_COUNT = 220;
const GATE_MS = 30_000;

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-format-only-bench-'));
  const srcDir = path.join(dir, 'src');
  fs.mkdirSync(srcDir);
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(srcDir, `mod${i}.ts`), `export function fn${i}() {\n  return ${i};\n}\n`);
  }

  const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
  const coldStart = Date.now();
  await cg.indexAll();
  const coldMs = Date.now() - coldStart;
  console.log(`cold indexAll: ${coldMs}ms  (${FILE_COUNT} files, baseline)`);

  // Mutate inter-symbol whitespace only. Bodies and signatures
  // unchanged → body_hash unchanged → struct_hash matches → format-
  // only fast path fires for every file.
  for (let i = 0; i < FILE_COUNT; i++) {
    fs.writeFileSync(path.join(srcDir, `mod${i}.ts`), `\n\nexport function fn${i}() {\n  return ${i};\n}\n\n\n`);
  }

  const warmStart = Date.now();
  const result = await cg.sync();
  const warmMs = Date.now() - warmStart;
  console.log(`format-only sync: ${warmMs}ms  (${result.filesModified ?? 0} files marked modified)`);

  const ratio = coldMs > 0 ? (warmMs / coldMs).toFixed(2) : 'n/a';
  const verdict = warmMs <= GATE_MS ? 'PASS' : 'FAIL';
  console.log(`ratio (warm / cold): ${ratio}  |  gate ≤${GATE_MS}ms  |  ${verdict}`);

  // Sanity: every file's symbols are still in the DB under the same
  // ids (stable-id guarantee). Spot-check the first and last.
  const n0 = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'fn0'`).get() as { id: string } | undefined;
  const nLast = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = ?`).get(`fn${FILE_COUNT - 1}`) as
    | { id: string }
    | undefined;
  console.log(
    `sanity: fn0=${n0?.id?.slice(0, 12) ?? 'MISSING'}  fn${FILE_COUNT - 1}=${nLast?.id?.slice(0, 12) ?? 'MISSING'}`,
  );

  cg.destroy();
  fs.rmSync(dir, { recursive: true, force: true });

  if (verdict === 'FAIL') process.exit(1);
}

main().catch((err) => {
  console.error(err);
  process.exit(2);
});
