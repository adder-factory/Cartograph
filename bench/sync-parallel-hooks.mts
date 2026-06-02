/**
 * G9 bench — measures the parallelism wins from Phase 1+2A AND 2C.
 *
 * Three sections, each measured on the same synthetic corpus:
 *
 * 1. **cold indexAll** — total wall-clock for the first full
 *    pass (parse + extract + cross-file resolve + Group A→B→C
 *    hook phase). Establishes the "fresh repo" baseline.
 *
 * 2. **warm sync x3** — wall-clock for three back-to-back no-op
 *    syncs after the cold indexAll. Exercises the hook-phase
 *    cost when nothing changed; useful for spotting hook-side
 *    overhead.
 *
 * 3. **biomarker re-analysis (Phase 2C target)** — direct
 *    `analyseProject` invocation, repeated N times. This bypasses
 *    the indexAll fork → IPC layer so we measure ONLY the
 *    biomarker pass, including the per-file scan and the 6
 *    cross-file rules (god_class / unused_export / feature_envy
 *    / illegal_import / low_coverage / duplicate_code) that Phase
 *    2C parallelises via worker_threads.
 *
 * Pre-Phase-2C the 6 cross-file rules ran serially on the host
 * connection — wall-clock = `sum(per-rule cost)`. Post-Phase-2C
 * each rule runs in its own ephemeral `node:worker_threads`
 * worker with a per-worker read-only `bun:sqlite` handle, so
 * wall-clock = `~spawn_cost + max(per-rule cost)`. The biomarker
 * pass timing section below isolates that change.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { getRegisteredHooks } from '../src/index-hooks/registry.js';
import { analyseProject } from '../src/biomarkers/index.js';

// Override via env: BENCH_FILE_COUNT=1000 bun bench/sync-parallel-hooks.mts.
// 200 covers the "small project" stress case; bumping to ~1k–2k mirrors
// the cartograph-shaped corpus where Phase 2C's per-rule cost amortises
// the worker spawn overhead.
const FILE_COUNT = Number(process.env['BENCH_FILE_COUNT'] ?? 200);
const COMMITS_PER_FILE = 3;

interface PhaseTiming {
  phase: 'A' | 'B' | 'C';
  hookName: string;
  durationMs: number;
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
    const file = path.join('src', `mod${i}.ts`);
    fs.writeFileSync(path.join(dir, file), `export function fn${i}() { return ${i}; }\n`);
  }
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'feat: initial commit');

  // Per-file modifications spread across commits so churn / cochange have signal.
  for (let c = 0; c < COMMITS_PER_FILE; c++) {
    for (let i = 0; i < FILE_COUNT; i++) {
      const file = path.join('src', `mod${i}.ts`);
      fs.writeFileSync(path.join(dir, file), `// rev ${c}\nexport function fn${i}() { return ${i + c}; }\n`);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', `chore: rev ${c}`);
  }

  // One `Fixes #N` commit so issue-history miner has at least one diff to walk.
  fs.writeFileSync(path.join(dir, 'src', 'mod0.ts'), `// final\nexport function fn0() { return 42; }\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'fix: bug. Fixes #1');
}

interface PassTiming {
  wallMs: number;
  findings: number;
}

/**
 * Section 3 of the bench — A/B-times the biomarker pass via
 * `analyseProject` in both serial and worker-pool modes. Reports
 * speedup (or slowdown) + a findings-invariance check.
 */
async function runBiomarkerBenchAt(dir: string, _opts: { withTimings: boolean }): Promise<void> {
  console.log('\nbiomarker re-analysis (analyseProject):');
  const serial = await timeBiomarkerPasses(dir, { serial: true, passes: 5 });
  const parallel = await timeBiomarkerPasses(dir, { serial: false, passes: 5 });
  reportPasses('  serial path     ', serial);
  reportPasses('  worker pool path', parallel);

  const allFindings = [...serial.map((p) => p.findings), ...parallel.map((p) => p.findings)];
  const findingsMin = Math.min(...allFindings);
  const findingsMax = Math.max(...allFindings);
  const findingsAgree = findingsMin === findingsMax;
  if (findingsAgree) {
    console.log(`  findings invariance: ✓ (${findingsMin} every pass, serial + parallel)`);
  } else {
    console.log(
      `  ⚠ findings DIVERGED across modes: ${findingsMin} vs ${findingsMax}\n` +
        '    Expected on BENCH_PROJECT_DIR pointed at a project whose MCP server is\n' +
        "    live (the server's own post-hook child writes findings concurrently,\n" +
        "    racing the bench's `clearFindingsByKind` + `appendFindings`). The\n" +
        '    invariance check is reliable on the synthetic seed (no concurrent\n' +
        '    writer) — start there for correctness signal; use real-project mode\n' +
        '    for the speedup number, not for invariance.',
    );
  }

  const serialMedian = median(serial.map((p) => p.wallMs));
  const parallelMedian = median(parallel.map((p) => p.wallMs));
  const speedup = serialMedian / parallelMedian;
  console.log(
    `\nspeedup (serial / parallel): ${speedup.toFixed(2)}× — serial median ${serialMedian}ms, parallel median ${parallelMedian}ms`,
  );
  console.log(
    'Worker spawn ~50-200ms / heaviest rule (duplicate_code) carries the long pole. Speedup grows with corpus size as the rule costs dominate spawn overhead.',
  );
}

async function timeBiomarkerPasses(dir: string, opts: { serial: boolean; passes: number }): Promise<PassTiming[]> {
  // Env toggle has to be set BEFORE the analyseProject call — the
  // worker pool reads it at dispatch time.
  if (opts.serial) process.env['CARTOGRAPH_BIOMARKER_SERIAL'] = '1';
  else delete process.env['CARTOGRAPH_BIOMARKER_SERIAL'];
  const cg = await Cartograph.open(dir, { autoMigrate: false });
  const timings: PassTiming[] = [];
  try {
    for (let i = 0; i < opts.passes; i++) {
      const start = Date.now();
      const r = await analyseProject(cg.queries, dir);
      timings.push({ wallMs: Date.now() - start, findings: r.findingsEmitted });
    }
  } finally {
    cg.close();
    delete process.env['CARTOGRAPH_BIOMARKER_SERIAL'];
  }
  return timings;
}

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

function reportPasses(label: string, timings: PassTiming[]): void {
  const sorted = [...timings].sort((a, b) => a.wallMs - b.wallMs);
  const min = sorted[0]!.wallMs;
  const max = sorted.at(-1)!.wallMs;
  const med = median(timings.map((t) => t.wallMs));
  const raw = timings.map((t) => `${t.wallMs}ms (${t.findings})`).join(' / ');
  const findings = timings.map((t) => t.findings);
  const findingsLabel =
    new Set(findings).size === 1
      ? `${findings[0]} findings`
      : `findings ${Math.min(...findings)}…${Math.max(...findings)}`;
  console.log(`${label}: ${raw}  →  min ${min}ms / median ${med}ms / max ${max}ms / ${findingsLabel}`);
}

async function timeIndexAll(dir: string): Promise<{ wallMs: number; hookOutcomes: PhaseTiming[] }> {
  const cg = await Cartograph.open(dir, { autoMigrate: true });
  const start = Date.now();
  await cg.indexAll();
  const wallMs = Date.now() - start;

  // Hook outcomes — names cross-referenced with HOOK_GROUPS in
  // src/index-hooks/registry.ts. The hook child writes per-hook
  // durations via logDebug; without a stderr/stdout capture
  // pipeline here, we report only the wall clock + verify the
  // registered hook ordering.
  const hookOutcomes: PhaseTiming[] = [];
  for (const h of getRegisteredHooks()) {
    // Best-effort tagging — the registered-hook order follows
    // HOOK_GROUPS' flat union, so the first 4 are Group A, the
    // next 10 are Group B, the last 2 are Group C.
    const i = hookOutcomes.length;
    let phase: 'A' | 'B' | 'C' = 'C';
    if (i < 4) {
      phase = 'A';
    } else if (i < 14) {
      phase = 'B';
    }
    hookOutcomes.push({ phase, hookName: h.name, durationMs: 0 });
  }

  cg.close();
  return { wallMs, hookOutcomes };
}

async function main(): Promise<void> {
  // BENCH_PROJECT_DIR=/path/to/cartograph-repo lets the bench run against
  // an already-indexed real-world project instead of seeding a synthetic.
  // Use this to measure Phase 2C on a corpus with non-trivial cross-file
  // rule cost (rule work > worker spawn overhead). Read-only access via
  // Cartograph.open(autoMigrate:false) — bun:sqlite WAL mode lets the
  // bench coexist with the live MCP server reading the same DB.
  const externalProject = process.env['BENCH_PROJECT_DIR'];
  if (externalProject) {
    console.log(`benching against external project: ${externalProject}`);
    await runBiomarkerBenchAt(externalProject, { withTimings: false });
    return;
  }

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'g9-parallel-hooks-bench-'));
  try {
    console.log(`seeding repo at ${dir} (${FILE_COUNT} files, ${COMMITS_PER_FILE + 2} commits)…`);
    seedRepo(dir);

    // Init cartograph in the same dir.
    await Cartograph.init(dir, { config: { include: ['**/*.ts'], exclude: [] } });

    console.log('\ncold indexAll (extract + resolve + all hook groups):');
    const cold = await timeIndexAll(dir);
    console.log(`  wall: ${cold.wallMs}ms`);

    console.log('\nwarm sync x3 (resolve + all hook groups; extract no-op):');
    const cg = await Cartograph.open(dir, { autoMigrate: false });
    const warmTimings: number[] = [];
    for (let i = 0; i < 3; i++) {
      const s = Date.now();
      await cg.sync();
      warmTimings.push(Date.now() - s);
    }
    cg.close();
    const warmSyncRuns = warmTimings.map((m) => `${m}ms`).join(' / ');
    console.log(`  warm sync runs: ${warmSyncRuns}`);
    const avgWarm = warmTimings.reduce((a, b) => a + b, 0) / warmTimings.length;
    console.log(`  warm avg: ${avgWarm.toFixed(0)}ms`);

    console.log('\nhook ordering (Group A → B → C):');
    for (const t of cold.hookOutcomes) {
      console.log(`  [${t.phase}] ${t.hookName}`);
    }
    console.log(
      '\nGroup A hooks (role-restore + 3 git miners) now run via Promise.all',
      '— their git subprocesses overlap on the event loop instead of blocking serially.',
    );

    // Section 3 — biomarker re-analysis (G9 Phase 2C target). Direct
    // analyseProject invocation isolates the biomarker pass from the
    // indexAll fork + IPC overhead, so the timing here is the actual
    // per-file scan + 6 cross-file rule cost. Phase 2C parallelises
    // the cross-file rules across one worker_thread per kind; the
    // wall-clock shape changes from sum(per-rule) to ~spawn +
    // max(per-rule). A/B-times serial vs parallel against the same
    // corpus by toggling CARTOGRAPH_BIOMARKER_SERIAL — both modes
    // produce the same `findingsEmitted` (findings invariance check).
    await runBiomarkerBenchAt(dir, { withTimings: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
