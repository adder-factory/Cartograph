/**
 * G23 betweenness bench — measures the sampled-Brandes pass against
 * a real project's `.cartograph/` (BENCH_PROJECT_DIR) OR a synthetic
 * cross-imports seed of N files. Reports serial vs parallel walls,
 * the implied speedup, and the actual sampleCount.
 *
 * Brief target: "betweenness pass on TS finishes in <60s (sampled
 * K=200)" — that's the parallel-path goal on the
 * microsoft/TypeScript repo. Smaller corpora finish in seconds.
 *
 * Two modes:
 *
 * 1. **Synthetic** (default): seeds a tmp `.cartograph` with
 *    BENCH_FILE_COUNT (default 5000) cross-importing TS files, runs
 *    the bench against it. Pure compute signal; no extractor noise.
 *
 * 2. **External**: `BENCH_PROJECT_DIR=/path/to/repo bun
 *    bench/betweenness.mts`. Opens the project's existing
 *    `.cartograph/` (read-only enough that bun:sqlite WAL lets it
 *    coexist with the live MCP). Runs serial + parallel against the
 *    real graph. Use to validate the brief's <60s gate on TS.
 *
 * In both modes: BENCH_K (default 200) sets sample count.
 * CARTOGRAPH_BETWEENNESS_SERIAL=1 forces the serial path so the
 * bench can A/B-time both modes.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { runBetweennessPass } from '../src/centrality/betweenness-pass.js';

const FILE_COUNT = Number(process.env['BENCH_FILE_COUNT'] ?? 5000);
const K = Number(process.env['BENCH_K'] ?? 200);

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

function seedRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'b@b');
  git(dir, 'config', 'user.name', 'b');
  git(dir, 'config', 'commit.gpgsign', 'false');
  for (let i = 0; i < FILE_COUNT; i++) {
    const j = (i + 1) % FILE_COUNT;
    const k = (i + 2) % FILE_COUNT;
    const l = (i + 3) % FILE_COUNT;
    const body =
      `import { fn${j} } from './mod${j}.js';\n` +
      `import { fn${k} } from './mod${k}.js';\n` +
      `import { fn${l} } from './mod${l}.js';\n` +
      `\n` +
      `export function fn${i}(): number {\n` +
      `  fn${j}(); fn${k}(); fn${l}();\n` +
      `  return ${i};\n` +
      `}\n`;
    fs.writeFileSync(path.join(dir, 'src', `mod${i}.ts`), body);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function runOne(
  projectDir: string,
  mode: 'serial' | 'parallel',
): Promise<{ wallMs: number; sampleCount: number; nodesScored: number; edgeCount: number; parallel: boolean }> {
  if (mode === 'serial') process.env['CARTOGRAPH_BETWEENNESS_SERIAL'] = '1';
  else delete process.env['CARTOGRAPH_BETWEENNESS_SERIAL'];
  const cg = await Cartograph.open(projectDir, { autoMigrate: false });
  try {
    const start = Date.now();
    const r = await runBetweennessPass(cg.queries, { k: K, normalize: false });
    const wallMs = Date.now() - start;
    return {
      wallMs,
      sampleCount: r.sampleCount,
      nodesScored: r.nodesScored,
      edgeCount: r.edgeCount,
      parallel: r.parallel,
    };
  } finally {
    cg.close();
    delete process.env['CARTOGRAPH_BETWEENNESS_SERIAL'];
  }
}

async function main(): Promise<void> {
  const external = process.env['BENCH_PROJECT_DIR'];
  let projectDir: string;
  let cleanup: (() => void) | null = null;
  if (external) {
    console.log(`benching against external project: ${external}`);
    projectDir = external;
  } else {
    projectDir = fs.mkdtempSync(path.join(os.tmpdir(), 'betweenness-bench-'));
    cleanup = () => fs.rmSync(projectDir, { recursive: true, force: true });
    try {
      console.log(`seeding ${FILE_COUNT} files at ${projectDir}`);
      seedRepo(projectDir);
      await Cartograph.init(projectDir, { config: { include: ['**/*.ts'], exclude: [], enableBetweenness: false } });
      const cg = await Cartograph.open(projectDir, { autoMigrate: false });
      console.log('cold index for synthetic corpus…');
      await cg.indexAll();
      cg.close();
    } catch (err) {
      cleanup();
      throw err;
    }
  }

  try {
    console.log(`\nbetweenness pass (K=${K}):`);
    const parallel = await runOne(projectDir, 'parallel');
    console.log(
      `  parallel: ${parallel.wallMs}ms — ${parallel.nodesScored} nodes, ${parallel.edgeCount} edges, ${parallel.sampleCount} samples${parallel.parallel ? '' : ' (note: routing gate kept it serial — bumped below threshold)'}`,
    );
    const serial = await runOne(projectDir, 'serial');
    console.log(`  serial:   ${serial.wallMs}ms`);
    const speedup = serial.wallMs / parallel.wallMs;
    console.log(`\nspeedup (serial / parallel): ${speedup.toFixed(2)}×`);
    if (parallel.wallMs > 60_000) {
      console.log(`\n⚠  parallel wall ${parallel.wallMs}ms exceeds the brief's 60s gate.`);
    } else {
      console.log(`✓ parallel wall ${parallel.wallMs}ms is under the brief's 60s gate.`);
    }
  } finally {
    cleanup?.();
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
