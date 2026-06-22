/**
 * Bench: string-imports hook overhead and read-side latency.
 *
 * Runs against the cartograph repo itself (~300 TS/JS files) and
 * measures:
 *   1. Cold indexAll WITHOUT the string-imports hook (baseline).
 *   2. Cold indexAll WITH the hook on default config.
 *   3. Sync delta when one file changes, with and without the hook.
 *   4. Read-side latency for `getStringImports({})` and the MCP
 *      `cartograph_imports({source: 'literal'})` formatter.
 *   5. DB-size delta of the new `string_imports` table.
 *   6. Pure extractor cost on a sample of files (regex+lexer only).
 *
 *   bun scripts/bench-string-imports.ts
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { fileURLToPath } from 'node:url';
import { performance } from 'node:perf_hooks';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { scanStringImports } from '../src/string-imports/index.js';

const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function fmt(ms: number): string {
  if (ms < 1) return `${(ms * 1000).toFixed(0)}µs`;
  if (ms < 10) return `${ms.toFixed(2)}ms`;
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  return `${(ms / 1000).toFixed(2)}s`;
}

function dirSize(p: string): number {
  let total = 0;
  try {
    for (const e of fs.readdirSync(p, { withFileTypes: true })) {
      const full = path.join(p, e.name);
      if (e.isDirectory()) total += dirSize(full);
      else total += fs.statSync(full).size;
    }
  } catch {
    /* ignore */
  }
  return total;
}

async function copyRepoTo(dst: string): Promise<void> {
  // Snapshot the repo into a temp working tree (without node_modules /
  // dist / .cartograph / .git), giving us a clean target where indexAll
  // can run without contention with the live .cartograph/ in REPO_ROOT.
  const skip = new Set(['node_modules', 'dist', '.cartograph', '.git', 'coverage', 'logs']);
  function walk(rel: string) {
    const src = path.join(REPO_ROOT, rel);
    const out = path.join(dst, rel);
    const stat = fs.statSync(src);
    if (stat.isDirectory()) {
      const base = path.basename(src);
      if (skip.has(base)) return;
      fs.mkdirSync(out, { recursive: true });
      for (const e of fs.readdirSync(src)) walk(path.join(rel, e));
    } else {
      fs.copyFileSync(src, out);
    }
  }
  walk('');
}

async function indexClean(opts: { enableStringImports: boolean }): Promise<{
  durMs: number;
  fileCount: number;
  nodeCount: number;
  stringImportRowCount: number;
  dbSize: number;
  workingDir: string;
}> {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bench-si-'));
  await copyRepoTo(tmp);

  const cg = await Cartograph.init(tmp, {
    config: {
      llm: { endpoint: '' },
      enableStringImports: opts.enableStringImports,
    },
  });

  const t0 = performance.now();
  const r = await cg.indexAll({ summarize: false });
  const dur = performance.now() - t0;

  const stats = cg.getStats();
  const stringRows = opts.enableStringImports ? cg.getStringImports({ limit: 100000 }).length : 0;
  const dbSize = dirSize(path.join(tmp, '.cartograph'));

  cg.close();
  return {
    durMs: dur,
    fileCount: r.filesIndexed,
    nodeCount: stats.nodeCount,
    stringImportRowCount: stringRows,
    dbSize,
    workingDir: tmp,
  };
}

async function syncOneFile(workingDir: string, withHook: boolean): Promise<number> {
  // Open existing project, perturb one TS file, time sync.
  const cg = await Cartograph.open(workingDir);
  // Force a no-op write so mtime + content hash bump.
  const target = path.join(workingDir, 'src', 'errors.ts');
  const before = fs.readFileSync(target, 'utf8');
  fs.writeFileSync(target, before + `\n// bench-sync touch ${Date.now()}\n`);

  // Toggle the hook by editing config on disk.
  const cfgPath = path.join(workingDir, '.cartograph', 'config.json');
  const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
  cfg.enableStringImports = withHook;
  fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2));

  cg.close();
  const cg2 = await Cartograph.open(workingDir);

  const t0 = performance.now();
  await cg2.sync();
  const dur = performance.now() - t0;

  // Restore the file so a follow-up sync doesn't double-touch.
  fs.writeFileSync(target, before);
  cg2.close();
  return dur;
}

async function readBench(workingDir: string): Promise<{
  publicApiMs: number;
  mcpFormatterMs: number;
  rowCount: number;
}> {
  const cg = await Cartograph.open(workingDir);

  const t1 = performance.now();
  const rows = cg.getStringImports({ limit: 5000 });
  const publicApi = performance.now() - t1;

  const handler = new ToolHandler(cg);
  const t2 = performance.now();
  await handler.execute('cartograph_imports', { source: 'literal' });
  const mcp = performance.now() - t2;
  handler.closeAll();

  cg.close();
  return { publicApiMs: publicApi, mcpFormatterMs: mcp, rowCount: rows.length };
}

function pureExtractorBench(): { iterations: number; totalMs: number; perFileMs: number; rowCount: number } {
  // Pick the 10 largest TS files in src/ as a representative sample.
  const srcRoot = path.join(REPO_ROOT, 'src');
  function listTs(dir: string, acc: string[] = []): string[] {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, e.name);
      if (e.isDirectory()) listTs(full, acc);
      else if (e.name.endsWith('.ts')) acc.push(full);
    }
    return acc;
  }
  const all = listTs(srcRoot)
    .map((p) => ({ p, sz: fs.statSync(p).size }))
    .sort((a, b) => b.sz - a.sz)
    .slice(0, 10);

  // Warm up.
  for (const { p } of all) scanStringImports(p, fs.readFileSync(p, 'utf8'));

  const ITER = 5;
  let total = 0;
  let rowCount = 0;
  for (let k = 0; k < ITER; k++) {
    const t0 = performance.now();
    for (const { p } of all) {
      const src = fs.readFileSync(p, 'utf8');
      rowCount += scanStringImports(p, src).length;
    }
    total += performance.now() - t0;
  }
  return {
    iterations: ITER,
    totalMs: total,
    perFileMs: total / (ITER * all.length),
    rowCount: rowCount / ITER,
  };
}

async function main() {
  console.log('# string-imports bench\n');
  console.log(`Repo: ${REPO_ROOT}`);
  console.log(`Node: ${process.version}, platform: ${process.platform}\n`);

  console.log('## (1) Cold indexAll: baseline (hook OFF) vs default (hook ON)');
  console.log(
    'Each variant indexed twice with order alternated; reporting the warm (2nd) run for both to neutralise OS page-cache bias on the source tree.\n',
  );

  // Warm up the OS page cache with a throwaway run, then run each
  // variant twice (alternating order) and take the median.
  const warm = await indexClean({ enableStringImports: false });
  fs.rmSync(warm.workingDir, { recursive: true, force: true });

  const off1 = await indexClean({ enableStringImports: false });
  const on1 = await indexClean({ enableStringImports: true });
  const on2 = await indexClean({ enableStringImports: true });
  const off2 = await indexClean({ enableStringImports: false });

  // Discard the cold (1st) of each pair; use the warm (2nd) run's wall
  // time so the comparison reflects steady-state index cost not first-
  // touch I/O. Keep the ON-side metadata from one of the on-runs.
  fs.rmSync(off1.workingDir, { recursive: true, force: true });
  fs.rmSync(on1.workingDir, { recursive: true, force: true });
  const off = { ...off2, durMs: off2.durMs };
  const on = { ...on2, durMs: on2.durMs };

  console.log(`| metric                | hook OFF        | hook ON         | delta          |`);
  console.log(`|-----------------------|-----------------|-----------------|----------------|`);
  console.log(
    `| indexAll wall time    | ${fmt(off.durMs).padEnd(15)} | ${fmt(on.durMs).padEnd(15)} | +${fmt(on.durMs - off.durMs)} (${((on.durMs / off.durMs - 1) * 100).toFixed(1)}%) |`,
  );
  console.log(
    `| files indexed         | ${String(off.fileCount).padEnd(15)} | ${String(on.fileCount).padEnd(15)} |                |`,
  );
  console.log(
    `| graph nodes           | ${String(off.nodeCount).padEnd(15)} | ${String(on.nodeCount).padEnd(15)} | (unaffected)   |`,
  );
  console.log(
    `| string_imports rows   | ${String(0).padEnd(15)} | ${String(on.stringImportRowCount).padEnd(15)} | +${on.stringImportRowCount}        |`,
  );
  console.log(
    `| .cartograph dir size   | ${(off.dbSize / 1024 / 1024).toFixed(2).padEnd(11)} MiB | ${(on.dbSize / 1024 / 1024).toFixed(2).padEnd(11)} MiB | +${((on.dbSize - off.dbSize) / 1024).toFixed(0)} KiB    |`,
  );

  console.log('\n## (2) Incremental sync (one TS file modified)');
  const syncOff = await syncOneFile(off.workingDir, false);
  const syncOn = await syncOneFile(on.workingDir, true);
  console.log(`| sync delta            | hook OFF        | hook ON         | delta          |`);
  console.log(`|-----------------------|-----------------|-----------------|----------------|`);
  console.log(
    `| sync wall time        | ${fmt(syncOff).padEnd(15)} | ${fmt(syncOn).padEnd(15)} | +${fmt(syncOn - syncOff)} (${((syncOn / syncOff - 1) * 100).toFixed(1)}%) |`,
  );

  console.log('\n## (3) Where the 84 rows live');
  {
    const cgr = await Cartograph.open(on.workingDir);
    const rows = cgr.getStringImports({ limit: 5000 });
    const byTopDir = new Map<string, number>();
    const byKind = { template_string: 0, string_literal: 0 };
    for (const r of rows) {
      const top = r.filePath.split('/').slice(0, 2).join('/');
      byTopDir.set(top, (byTopDir.get(top) ?? 0) + 1);
      byKind[r.containerKind]++;
    }
    console.log(`| top-2-dir prefix      | rows |`);
    console.log(`|-----------------------|-----:|`);
    for (const [dir, n] of [...byTopDir.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`| ${dir.padEnd(21)} | ${String(n).padStart(4)} |`);
    }
    console.log(`\n| container_kind   | rows |`);
    console.log(`|------------------|-----:|`);
    console.log(`| template_string  | ${String(byKind.template_string).padStart(4)} |`);
    console.log(`| string_literal   | ${String(byKind.string_literal).padStart(4)} |`);
    cgr.close();
  }

  console.log('\n## (4) Read-side latency (hook ON)');
  const reads = await readBench(on.workingDir);
  console.log(`| metric                          | value           |`);
  console.log(`|---------------------------------|-----------------|`);
  console.log(`| getStringImports() (5000 cap)   | ${fmt(reads.publicApiMs).padEnd(15)} |`);
  console.log(`| cartograph_imports source=literal | ${fmt(reads.mcpFormatterMs).padEnd(15)} |`);
  console.log(`| rows returned                   | ${String(reads.rowCount).padEnd(15)} |`);

  console.log('\n## (4) Pure extractor microbench (10 largest src/*.ts files, 5 iterations)');
  const ext = pureExtractorBench();
  console.log(`| metric                  | value          |`);
  console.log(`|-------------------------|----------------|`);
  console.log(`| total scan time         | ${fmt(ext.totalMs).padEnd(14)} |`);
  console.log(`| per-file mean           | ${fmt(ext.perFileMs).padEnd(14)} |`);
  console.log(`| rows extracted (mean)   | ${ext.rowCount.toFixed(0).padEnd(14)} |`);

  // Cleanup.
  fs.rmSync(off.workingDir, { recursive: true, force: true });
  fs.rmSync(on.workingDir, { recursive: true, force: true });

  console.log('\n## Summary');
  console.log(
    `- indexAll overhead:       +${fmt(on.durMs - off.durMs)} (${((on.durMs / off.durMs - 1) * 100).toFixed(1)}%) for ${on.stringImportRowCount} rows surfaced.`,
  );
  console.log(`- sync overhead:           +${fmt(syncOn - syncOff)} per single-file change.`);
  console.log(`- read-side amortised:     ${fmt(reads.mcpFormatterMs)} for ${reads.rowCount} rows via MCP formatter.`);
  console.log(`- per-file extractor:      ${fmt(ext.perFileMs)} on the 10 largest TS files in src/.`);
  console.log(`- DB footprint:            +${((on.dbSize - off.dbSize) / 1024).toFixed(0)} KiB on disk.`);
}

try {
  await main();
} catch (err) {
  console.error(err);
  process.exit(1);
}
