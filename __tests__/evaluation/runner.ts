import { execSync } from 'node:child_process';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Cartograph } from '../../src/index.js';
import { llmFindSimilar, llmFindImplementations } from '../../src/cartograph-llm-service.js';
import { searchNodes } from '../../src/db/queries-search.js';
import { hasSymbolEmbedding } from '../../src/db/queries-embeddings.js';
import { getEmbeddingModel } from '../../src/llm/provider.js';
import { scoreSearchNodes, scoreFindRelevantContext, scoreSemanticSearch } from './scoring.js';
import { testCases } from './test-cases.js';
import { selfTestCases } from './cases-self.js';
import { largeTestCases } from './cases-large.js';
import { compareReports, formatComparison } from './compare.js';
import type { EvalReport, EvalResult, EvalTestCase } from './types.js';

/**
 * Parse the runner's argv. Supports positional `<codebase>` plus
 * `--cases <self|elasticsearch>` and `--compare <baseline.json>`.
 * Env vars (`EVAL_CODEBASE`, `EVAL_CASES`, `EVAL_COMPARE`) are
 * honoured as fallbacks so CI / npm-script wrappers don't have to
 * forward through the flag layer.
 */
type CasesMode = 'self' | 'elasticsearch' | 'large';

function parseArgs(argv: string[]): { codebase: string | null; cases: CasesMode; comparePath: string | null } {
  let codebase: string | null = process.env['EVAL_CODEBASE'] ?? null;
  let cases: CasesMode = (process.env['EVAL_CASES'] as CasesMode | undefined) ?? 'elasticsearch';
  let comparePath: string | null = process.env['EVAL_COMPARE'] ?? null;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--cases') {
      const v = argv[++i];
      if (v !== 'self' && v !== 'elasticsearch' && v !== 'large') {
        console.error(`--cases must be "self", "elasticsearch", or "large", got: ${v}`);
        process.exit(2);
      }
      cases = v;
    } else if (arg === '--compare') {
      const v = argv[++i];
      if (!v || v.startsWith('-')) {
        console.error('--compare requires a path argument (got missing or another flag).');
        process.exit(2);
      }
      comparePath = v;
    } else if (arg && !arg.startsWith('-') && !codebase) {
      codebase = arg;
    }
  }
  return { codebase, cases, comparePath };
}

const { codebase: codebasePath, cases: casesMode, comparePath } = parseArgs(process.argv.slice(2));
if (!codebasePath) {
  console.error(
    'Usage: EVAL_CODEBASE=/path/to/codebase bun __tests__/evaluation/runner.ts [--cases self|elasticsearch] [--compare baseline.json]',
  );
  console.error('   or: bun __tests__/evaluation/runner.ts /path/to/codebase [flags]');
  process.exit(1);
}
const activeCases: EvalTestCase[] =
  casesMode === 'self' ? selfTestCases : casesMode === 'large' ? largeTestCases : testCases;

const resolvedPath = path.resolve(codebasePath);
if (!fs.existsSync(path.join(resolvedPath, '.cartograph', 'cartograph.db'))) {
  console.error(`No .cartograph/cartograph.db found at ${resolvedPath}`);
  process.exit(1);
}

let cartographSha = 'unknown';
try {
  cartographSha = execSync('git rev-parse --short HEAD', { encoding: 'utf-8' }).trim();
} catch {}

console.log(`\nCartograph Eval — ${path.basename(resolvedPath)}`);
console.log(`Codebase: ${resolvedPath}`);
console.log(`Commit:   ${cartographSha}`);
console.log(`Cases:    ${activeCases.length} (${casesMode})`);
if (comparePath) console.log(`Baseline: ${comparePath}`);
console.log('');

async function run() {
  const cg = Cartograph.openSync(resolvedPath);
  const results: EvalResult[] = [];

  for (const tc of activeCases) {
    const start = performance.now();

    if (tc.api === 'searchNodes') {
      const searchResults = searchNodes(cg.queries, tc.query, {
        limit: 10,
        kinds: tc.kinds,
        ...(tc.options as Record<string, unknown>),
      });
      const latency = performance.now() - start;
      const result = scoreSearchNodes(tc.id, tc.expectedSymbols, searchResults, latency);
      results.push(result);
    } else if (tc.api === 'searchSemantic') {
      // B9: semantic mode uses the LLM-bridge surface (concept query
      // → findImplementations, peer mode → findSimilar). Skip cleanly
      // when no embedding model is configured OR when the source
      // symbol has no embedding row — those are environmental gaps,
      // not regressions, and activate the case automatically once
      // `cartograph embed` populates the vec0 table.
      const llmConfig = await cg.llm.getEffectiveLlmConfig();
      const embModel = getEmbeddingModel(llmConfig);
      if (!embModel) {
        results.push(scoreSemanticSearch(tc.id, tc.expectedSymbols, [], performance.now() - start, 'no-embeddings'));
        continue;
      }
      if (tc.symbolName) {
        const sourceMatches = searchNodes(cg.queries, tc.symbolName, { limit: 1 });
        const sourceNode = sourceMatches[0]?.node;
        if (!sourceNode || !hasSymbolEmbedding(cg.queries, sourceNode.id, embModel)) {
          results.push(
            scoreSemanticSearch(tc.id, tc.expectedSymbols, [], performance.now() - start, 'no-source-embedding'),
          );
          continue;
        }
        const peers = await llmFindSimilar(cg.llm, sourceNode.id, {
          limit: 10,
          ...(tc.options as Record<string, unknown>),
        });
        results.push(scoreSemanticSearch(tc.id, tc.expectedSymbols, peers, performance.now() - start));
      } else {
        const peers = await llmFindImplementations(cg.llm, tc.query, {
          limit: 10,
          ...(tc.options as Record<string, unknown>),
        });
        results.push(scoreSemanticSearch(tc.id, tc.expectedSymbols, peers, performance.now() - start));
      }
    } else {
      const subgraph = await cg.internals.contextBuilder.findRelevantContext(tc.query, {
        searchLimit: 8,
        traversalDepth: 3,
        maxNodes: 80,
        minScore: 0.2,
        ...(tc.options as Record<string, unknown>),
      });
      const latency = performance.now() - start;
      const result = scoreFindRelevantContext(tc.id, tc.expectedSymbols, subgraph, latency);
      results.push(result);
    }
  }

  cg.close();

  // Print results table
  const maxIdLen = Math.max(...results.map((r) => r.caseId.length));

  // Per-api absolute latency budgets (B7). Cases that exceed get a
  // ⚠ note in the per-row display — separate from the pass/fail gate
  // so a slow-but-correct case doesn't poison the count, but the
  // operator sees the regression. Numbers chosen for the 1k-file
  // large fixture: any plausible production-size lookup should
  // finish well under these on a modern machine.
  const LATENCY_BUDGET_MS: Record<string, number> = {
    searchNodes: 200,
    searchSemantic: 200,
    findRelevantContext: 1500,
  };

  for (const r of results) {
    // SKIP display takes priority — a skipped case isn't really a
    // PASS, but counts as one in the gate so the operator can see at
    // a glance which cases are dormant due to environment.
    const status = r.skipped ? '\x1b[33mSKIP\x1b[0m' : r.pass ? '\x1b[32mPASS\x1b[0m' : '\x1b[31mFAIL\x1b[0m';
    const id = r.caseId.padEnd(maxIdLen);
    const recall = `recall=${r.recall.toFixed(2)}`;
    const extra = r.edgeDensity === undefined ? `mrr=${r.mrr.toFixed(2)}` : `density=${r.edgeDensity.toFixed(2)}`;
    const latency = `${Math.round(r.latencyMs)}ms`;
    const skipNote = r.skipped ? `  (${r.skipped})` : '';
    // Latency-budget warning: look up the case definition's api so
    // the budget is api-aware (explore has more headroom than search).
    const tc = activeCases.find((c) => c.id === r.caseId);
    const budget = tc ? LATENCY_BUDGET_MS[tc.api] : undefined;
    const slowNote =
      budget !== undefined && r.latencyMs > budget && !r.skipped
        ? `  \x1b[33m⚠ ${Math.round(r.latencyMs)}ms > ${budget}ms budget\x1b[0m`
        : '';

    console.log(`  ${id}  ${status}  ${recall}  ${extra}  ${latency}${skipNote}${slowNote}`);

    if (r.missedSymbols.length > 0 && !r.skipped) {
      console.log(`  ${' '.repeat(maxIdLen)}        missed: ${r.missedSymbols.join(', ')}`);
    }
  }

  // Summary
  const passed = results.filter((r) => r.pass).length;
  const failed = results.length - passed;
  // Exclude skipped cases from meanRecall — they're recall=0 by
  // construction (the case can't run) and would artificially drag
  // the headline down. Counted separately for visibility.
  const scored = results.filter((r) => !r.skipped);
  const skippedCount = results.length - scored.length;
  const meanRecall = scored.length > 0 ? scored.reduce((s, r) => s + r.recall, 0) / scored.length : 0;
  // Include any case whose ID contains the `-search-` segment OR
  // already has a non-zero MRR. The original `startsWith('search-')`
  // missed `self-search-*` self-codebase IDs and silently diluted
  // meanMRR for the self suite with zeros from exploration cases.
  // Skipped cases also excluded so a dormant semantic case doesn't
  // pin meanMRR to 0.
  const mrrResults = scored.filter((r) => r.mrr > 0 || r.caseId.includes('-search-') || r.caseId.startsWith('search-'));
  const meanMRR = mrrResults.length > 0 ? mrrResults.reduce((s, r) => s + r.mrr, 0) / mrrResults.length : 0;

  console.log('');
  const summaryColor = failed === 0 ? '\x1b[32m' : '\x1b[33m';
  const skipNote = skippedCount > 0 ? ` | skipped=${skippedCount}` : '';
  console.log(
    `${summaryColor}SUMMARY: ${passed}/${results.length} passed | recall=${meanRecall.toFixed(2)} | mrr=${meanMRR.toFixed(2)}${skipNote}\x1b[0m`,
  );

  // Save JSON report
  const report: EvalReport = {
    timestamp: new Date().toISOString(),
    codebasePath: resolvedPath,
    cartographSha,
    summary: { total: results.length, passed, failed, meanRecall, meanMRR },
    results,
  };

  const resultsDir = path.join(import.meta.dirname, 'results');
  fs.mkdirSync(resultsDir, { recursive: true });
  const reportFile = path.join(resultsDir, `${new Date().toISOString().replaceAll(/[:.]/g, '-')}.json`);
  fs.writeFileSync(reportFile, JSON.stringify(report, null, 2));
  console.log(`\nReport saved: ${reportFile}`);

  let regressionExit = 0;
  if (comparePath) {
    try {
      const baselineRaw = fs.readFileSync(path.resolve(comparePath), 'utf-8');
      const baseline = JSON.parse(baselineRaw) as EvalReport;
      const cmp = compareReports(baseline, report);
      console.log('');
      console.log(formatComparison(baseline, report, cmp));
      if (!cmp.withinBudget) regressionExit = 1;
    } catch (err) {
      console.error(`\n--compare failed to load ${comparePath}: ${String(err)}`);
      regressionExit = 2;
    }
  }

  process.exit(failed > 0 || regressionExit > 0 ? Math.max(regressionExit, 1) : 0);
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
