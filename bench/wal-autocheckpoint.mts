/**
 * G21 bench — sweep `PRAGMA wal_autocheckpoint` across candidate
 * values to pick the one that minimises full-index wall on a
 * write-heavy synthetic corpus.
 *
 * Why this is a sweep, not a fixed value: bun:sqlite's default
 * `wal_autocheckpoint` is already 1000 pages (verified — both
 * `PRAGMA wal_autocheckpoint` and `… = 1000 ; PRAGMA …` read back
 * 1000), so the brief's recommended-value-1000 is a literal no-op.
 * Picking the right value requires measurement on a corpus whose
 * write pattern matches cartograph's actual hook-phase load.
 *
 * The seed: BENCH_FILE_COUNT (default 2000) .ts files, each
 * importing 3 others (round-robin neighbours) so cross-file
 * resolve + the edge-emitter hooks have realistic work to do.
 * Each file has 6 call expressions to its imports + a body that
 * tickles `value-ref-edges` / `references`. Total writes per full
 * index land in the 50K–150K-edge range for FILE_COUNT=2000 —
 * enough WAL growth to make checkpoint cadence matter.
 *
 * Per value: wipe `.cartograph/`, set
 * `CARTOGRAPH_WAL_AUTOCHECKPOINT=<value>` (bench-only knob in
 * `dbApplyPragmas`), full `indexAll()`, record wall + final DB
 * size + final WAL size. Result table at the end ranks values by
 * wall.
 *
 * Default candidates [1000, 5000, 10000, 20000, 40000, 0=disabled]
 * reproduce the production-pick table cited in
 * `src/db/index.ts`'s `dbApplyPragmas` comment, so a no-env-override
 * re-run returns a directly comparable result. Override with e.g.
 * BENCH_AUTOCHECKPOINT_VALUES='200,500,2500' to confirm the
 * "smaller = slower" tail historically.
 *
 * Run: `bun bench/wal-autocheckpoint.mts`
 * Bigger corpus: `BENCH_FILE_COUNT=5000 bun bench/wal-autocheckpoint.mts`
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { Cartograph } from '../src/index.js';

const FILE_COUNT = Number(process.env['BENCH_FILE_COUNT'] ?? 2000);
const N_RUNS = Number(process.env['BENCH_N_RUNS'] ?? 3);
// Defaults match the set that produced the table in
// `src/db/index.ts`'s `dbApplyPragmas` comment — re-running this
// bench with no env overrides should reproduce that table (with
// machine-dependent ms variance). Add 200/500/2500 back if you
// want to confirm the "smaller = slower" tail; the production
// value lives above the knee, so the small-end of the curve is
// historically interesting rather than load-bearing.
const VALUES_RAW = process.env['BENCH_AUTOCHECKPOINT_VALUES'] ?? '1000,5000,10000,20000,40000,0';
const VALUES = VALUES_RAW.split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isFinite(n) && n >= 0);

interface RunResult {
  value: number;
  wallMs: number;
  dbBytes: number;
  walBytes: number;
}

interface ValueSummary {
  value: number;
  walls: number[];
  medianWallMs: number;
  minWallMs: number;
  maxWallMs: number;
  dbBytes: number;
  walBytes: number;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0 ? Math.round((sorted[mid - 1]! + sorted[mid]!) / 2) : sorted[mid]!;
}

function git(dir: string, ...args: string[]): void {
  execFileSync('git', args, { cwd: dir, stdio: 'pipe' });
}

function seedRepo(dir: string): void {
  fs.mkdirSync(path.join(dir, 'src'));
  git(dir, 'init', '-q', '-b', 'main');
  git(dir, 'config', 'user.email', 'bench@example.com');
  git(dir, 'config', 'user.name', 'bench');
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
      `  fn${j}(); fn${k}(); fn${l}();\n` +
      `  return ${i};\n` +
      `}\n`;
    fs.writeFileSync(path.join(dir, 'src', `mod${i}.ts`), body);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'init');
}

async function runOne(dir: string, value: number): Promise<RunResult> {
  // Wipe .cartograph/ between runs so each value gets a clean cold-start.
  const cgDir = path.join(dir, '.cartograph');
  if (fs.existsSync(cgDir)) fs.rmSync(cgDir, { recursive: true, force: true });

  process.env['CARTOGRAPH_WAL_AUTOCHECKPOINT'] = String(value);

  await Cartograph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });
  const cg = await Cartograph.open(dir, { autoMigrate: false });
  const start = Date.now();
  await cg.indexAll();
  const wallMs = Date.now() - start;

  const dbPath = path.join(cgDir, 'cartograph.db');
  const walPath = `${dbPath}-wal`;
  const dbBytes = fs.existsSync(dbPath) ? fs.statSync(dbPath).size : 0;
  const walBytes = fs.existsSync(walPath) ? fs.statSync(walPath).size : 0;
  cg.destroy();

  return { value, wallMs, dbBytes, walBytes };
}

function fmtKb(bytes: number): string {
  return `${(bytes / 1024).toFixed(0)} KB`;
}

function labelFor(value: number): string {
  return value === 0 ? '0 (off)' : String(value);
}

async function main(): Promise<void> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'wal-autocheckpoint-bench-'));
  console.log(`seeding ${FILE_COUNT} files at ${dir} (${N_RUNS} runs per value)`);
  try {
    seedRepo(dir);
    const summaries: ValueSummary[] = [];
    for (const value of VALUES) {
      console.log(`\nvalue: wal_autocheckpoint = ${labelFor(value)}`);
      const walls: number[] = [];
      let lastDbBytes = 0;
      let lastWalBytes = 0;
      for (let run = 0; run < N_RUNS; run++) {
        const r = await runOne(dir, value);
        walls.push(r.wallMs);
        lastDbBytes = r.dbBytes;
        lastWalBytes = r.walBytes;
        console.log(`  run ${run + 1}: ${r.wallMs}ms / db ${fmtKb(r.dbBytes)} / wal ${fmtKb(r.walBytes)}`);
      }
      summaries.push({
        value,
        walls,
        medianWallMs: median(walls),
        minWallMs: Math.min(...walls),
        maxWallMs: Math.max(...walls),
        dbBytes: lastDbBytes,
        walBytes: lastWalBytes,
      });
    }

    console.log('\n| autocheckpoint | median wall (ms) | min | max | db (KB) | wal (KB) |');
    console.log('|---:|---:|---:|---:|---:|---:|');
    for (const s of summaries) {
      console.log(
        `| ${labelFor(s.value)} | ${s.medianWallMs} | ${s.minWallMs} | ${s.maxWallMs} | ${(s.dbBytes / 1024).toFixed(0)} | ${(s.walBytes / 1024).toFixed(0)} |`,
      );
    }

    const ranked = [...summaries].sort((a, b) => a.medianWallMs - b.medianWallMs);
    const fastest = ranked[0]!;
    const slowest = ranked[ranked.length - 1]!;
    const spreadPct = ((slowest.medianWallMs / fastest.medianWallMs - 1) * 100).toFixed(1);
    console.log(`\nfastest median: ${labelFor(fastest.value)} @ ${fastest.medianWallMs}ms`);
    console.log(`slowest median: ${labelFor(slowest.value)} @ ${slowest.medianWallMs}ms`);
    console.log(`spread (median-median): ${spreadPct}%`);
  } finally {
    delete process.env['CARTOGRAPH_WAL_AUTOCHECKPOINT'];
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
