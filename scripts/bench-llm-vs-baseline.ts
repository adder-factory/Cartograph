/**
 * Bench: cartograph indexing + search WITH vs WITHOUT LLM enrichment.
 *
 * Uses the cartograph repo itself as the sample codebase. Indexes once
 * (summaries disabled), captures baseline metrics + sample searches,
 * then runs the LLM summarisation pass with a wall-clock cap and
 * re-runs the same searches to show how the output changes.
 *
 *   bun scripts/bench-llm-vs-baseline.ts [--cap-seconds 90]
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { performance } from 'node:perf_hooks';
import { Cartograph } from '../src';

const PROJECT_ROOT = path.resolve(__dirname, '..');
const CAP_SECONDS = Number(process.argv.find((a) => a.startsWith('--cap-seconds='))?.split('=')[1] ?? '120');

const SAMPLE_QUERIES = [
  'FileWatcher',
  'summarize symbol',
  'detect ollama',
  'background pass',
  'content hash cache',
  'reachability',
  'search nodes',
  'mcp tool format',
];

const PROBE_NODES = ['startBackgroundSummarization', 'detectLocalLlm', 'summarizeAll', 'FileWatcher'];

interface PhaseTiming {
  label: string;
  durationMs: number;
}

const timings: PhaseTiming[] = [];

function header(text: string): void {
  console.log('\n' + '='.repeat(80));
  console.log('  ' + text);
  console.log('='.repeat(80));
}

function subheader(text: string): void {
  console.log('\n' + '-'.repeat(60));
  console.log('  ' + text);
  console.log('-'.repeat(60));
}

function fmtMs(ms: number): string {
  if (ms < 1000) return `${ms.toFixed(0)}ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(1)}s`;
  const m = Math.floor(ms / 60_000);
  const s = ((ms % 60_000) / 1000).toFixed(0);
  return `${m}m ${s}s`;
}

function copyRecursive(src: string, dst: string): void {
  const skip = new Set(['node_modules', '.git', '.cartograph', 'dist', 'coverage']);
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    if (skip.has(entry.name)) continue;
    const sp = path.join(src, entry.name);
    const dp = path.join(dst, entry.name);
    if (entry.isDirectory()) {
      fs.mkdirSync(dp, { recursive: true });
      copyRecursive(sp, dp);
    } else if (entry.isFile()) {
      fs.copyFileSync(sp, dp);
    }
  }
}

type BenchCartograph = Awaited<ReturnType<typeof Cartograph.init>>;

async function initAndIndex(tmpDir: string): Promise<{ cg: BenchCartograph; initMs: number; indexMs: number }> {
  header('Phase 1: index with summaries DISABLED');
  let phaseStart = performance.now();
  const cg = await Cartograph.init(tmpDir);
  const initMs = performance.now() - phaseStart;

  phaseStart = performance.now();
  const indexResult = await cg.indexAll({ summarize: false });
  const indexMs = performance.now() - phaseStart;
  timings.push({ label: 'Init', durationMs: initMs }, { label: 'indexAll (no summaries)', durationMs: indexMs });

  const stats = cg.getStats();
  console.log('\n  Index complete:');
  console.log(`    Files indexed:  ${indexResult.filesIndexed}`);
  console.log(`    Files errored:  ${indexResult.filesErrored}`);
  console.log(`    Nodes:          ${stats.nodeCount}`);
  console.log(`    Edges:          ${stats.edgeCount}`);
  console.log(`    Init time:      ${fmtMs(initMs)}`);
  console.log(`    Index time:     ${fmtMs(indexMs)}`);
  return { cg, initMs, indexMs };
}

function printSearchSamples(cg: BenchCartograph, title: string, includeSummaries: boolean): void {
  subheader(title);
  for (const q of SAMPLE_QUERIES) {
    const results = cg.searchNodes(q, { limit: 3 });
    const summaries = includeSummaries ? cg.getSymbolSummaries(results.map((r) => r.node.id)) : undefined;
    console.log(`\n  Q: "${q}" → ${results.length} hits`);
    for (const r of results) {
      const sig = r.node.signature ? ` ${r.node.signature.slice(0, 80)}` : '';
      console.log(`    • ${r.node.name} (${r.node.kind}) — ${r.node.filePath}:${r.node.startLine}${sig}`);
      const summary = summaries?.get(r.node.id);
      if (summary) console.log(`      ↳ ${summary}`);
    }
  }
}

async function runSummarizationPass(cg: BenchCartograph, chatModel: string): Promise<void> {
  header('Phase 2: LLM summarisation pass');
  console.log(`\n  Model: ${chatModel}`);
  console.log(`  Cap:   ${CAP_SECONDS}s\n`);

  const controller = new AbortController();
  const cap = setTimeout(() => {
    console.log(`\n  ⏱  Wall-clock cap (${CAP_SECONDS}s) reached — aborting...`);
    controller.abort();
  }, CAP_SECONDS * 1000);

  let lastReport = 0;
  let lastDone = 0;
  const runStart = performance.now();
  let summaryResult: Awaited<ReturnType<typeof cg.summarizeAll>> | null = null;
  try {
    summaryResult = await cg.summarizeAll({
      signal: controller.signal,
      concurrency: 2,
      onProgress: (done, total) => {
        const now = performance.now();
        if (now - lastReport < 5_000 && done !== total) return;
        const elapsed = (now - runStart) / 1000;
        const rate = done > 0 ? (done / elapsed).toFixed(2) : '0';
        const recent = done - lastDone;
        process.stdout.write(
          `  ${done}/${total} symbols   ${rate}/s overall   +${recent} since last tick   ${fmtMs(elapsed * 1000)}\n`,
        );
        lastReport = now;
        lastDone = done;
      },
    });
  } catch (err) {
    console.log(`  summarizeAll threw: ${err instanceof Error ? err.message : String(err)}`);
  } finally {
    clearTimeout(cap);
  }

  const sumWallMs = performance.now() - runStart;
  timings.push({ label: 'summarizeAll', durationMs: sumWallMs });
  printSummaryPassResult(cg, summaryResult, sumWallMs);
}

function printSummaryPassResult(
  cg: BenchCartograph,
  summaryResult: Awaited<ReturnType<BenchCartograph['summarizeAll']>> | null,
  sumWallMs: number,
): void {
  const coverage = cg.getSummaryCoverage();
  const pct = coverage.total > 0 ? Math.round((coverage.summarised / coverage.total) * 100) : 0;

  console.log('\n  Pass complete:');
  console.log(`    Wall time:           ${fmtMs(sumWallMs)}`);
  if (summaryResult) {
    console.log(`    Candidates:          ${summaryResult.candidates}`);
    console.log(`    Generated:           ${summaryResult.generated}`);
    console.log(`    Cache hits:          ${summaryResult.cacheHits}`);
    console.log(`    Errors:              ${summaryResult.errors}`);
    if (summaryResult.generated > 0) {
      console.log(`    Avg per generation:  ${fmtMs(sumWallMs / summaryResult.generated)}`);
    }
  } else {
    console.log('    (aborted before completion)');
  }
  console.log(`    Coverage:            ${coverage.summarised}/${coverage.total} (${pct}% of summarisable kinds)`);
}

function printDetailSpotChecks(cg: BenchCartograph): void {
  subheader('Detail spot-checks (cartograph_node parity)');
  for (const name of PROBE_NODES) {
    const hit = cg.searchNodes(name, { limit: 1 })[0];
    if (!hit) {
      console.log(`\n  • ${name}: not found`);
      continue;
    }
    const s = cg.getSymbolSummaries([hit.node.id]).get(hit.node.id);
    console.log(`\n  • ${hit.node.name} (${hit.node.kind})`);
    console.log(`      ${hit.node.filePath}:${hit.node.startLine}`);
    if (hit.node.signature) console.log(`      sig: ${hit.node.signature.slice(0, 100)}`);
    console.log(`      summary: ${s ?? '(none — not yet summarised or skipped)'}`);
  }
}

async function main() {
  header('Cartograph: WITH LLM vs WITHOUT LLM bench');
  console.log(`  Sample codebase: ${PROJECT_ROOT}`);
  console.log(`  Summary cap:     ${CAP_SECONDS}s`);

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-bench-'));
  console.log(`  Working copy:    ${tmpDir}`);

  const phaseStart = performance.now();
  copyRecursive(PROJECT_ROOT, tmpDir);
  timings.push({ label: 'Copy source tree', durationMs: performance.now() - phaseStart });

  const { cg } = await initAndIndex(tmpDir);

  // Surface what auto-detection sees on this machine.
  const llmConfig = await cg.getEffectiveLlmConfig();
  console.log('\n  Auto-detect probe:');
  if (llmConfig) {
    console.log(`    Endpoint:       ${llmConfig.endpoint}`);
    console.log(`    Chat model:     ${llmConfig.chatModel}`);
    console.log(`    Embedding:      ${llmConfig.embeddingModel ?? '(none)'}`);
  } else {
    console.log('    No local LLM detected — bench will skip Phase 2.');
    cg.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    return;
  }

  // -----------------------------------------------------------------
  // Sample searches WITHOUT summaries
  // -----------------------------------------------------------------
  printSearchSamples(cg, 'Searches BEFORE summarisation', false);

  // -----------------------------------------------------------------
  // Phase 2: LLM summarisation pass with wall-clock cap
  // -----------------------------------------------------------------
  await runSummarizationPass(cg, llmConfig.chatModel);

  // -----------------------------------------------------------------
  // Sample searches WITH summaries
  // -----------------------------------------------------------------
  printSearchSamples(cg, 'Searches AFTER summarisation', true);

  // -----------------------------------------------------------------
  // Spot-check specific symbols (cartograph_node-style detail view)
  // -----------------------------------------------------------------
  printDetailSpotChecks(cg);

  // -----------------------------------------------------------------
  // Final timing summary
  // -----------------------------------------------------------------
  header('Timing summary');
  for (const t of timings) {
    console.log(`  ${t.label.padEnd(32)} ${fmtMs(t.durationMs)}`);
  }

  cg.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
}

try {
  await main();
} catch (err) {
  console.error('Bench failed:', err);
  process.exit(1);
}
