/**
 * Emulation scorer — compares per-tool query results against a
 * ground-truth question catalog and prints a markdown comparison
 * table with precision / recall / F1, plus normalised cost (tokens
 * and wall-clock per unit of correctness).
 *
 * Closes friction #30 (methodology gap from the 2026-05-09
 * cartograph-vs-grep emulation report). See
 * `docs/EMULATION-METHODOLOGY.md` for the recipe + question catalog
 * schema.
 *
 * Usage:
 *
 *   bun scripts/score-emulation.ts \
 *     docs/emulation-questions.example.json \
 *     results-cartograph.json \
 *     results-grep.json
 *
 * The first argument is the question catalog. Each subsequent
 * argument is a per-tool result file (see schema in the
 * methodology doc).
 *
 * Exit code: 0 always (this is a reporter, not a gate). Pipe to a
 * file or grep for a specific tool to extract numbers.
 */

import * as fs from 'fs';

interface Question {
  id: string;
  label: string;
  kind: 'set' | 'topK' | 'binary';
  tolerance: 'exact' | 'subset' | 'topK';
  topK?: number;
  expected: string[];
  groundTruthMethod: string;
  tools?: string[];
}

interface QuestionCatalog {
  questions: Question[];
}

interface ToolResultEntry {
  returned: string[];
  wallMs: number;
  tokenCost: number;
  shots: number;
}

interface ToolResultFile {
  tool: string;
  results: Record<string, ToolResultEntry>;
}

interface Score {
  precision: number;
  recall: number;
  f1: number;
  /** Whether `correct` should be reported as a binary 0/1 instead
   *  of the F1 number — true for `exact` tolerance. */
  binary: boolean;
}

function scoreSetExact(returned: string[], expected: string[]): Score {
  const r = new Set(returned);
  const e = new Set(expected);
  if (r.size !== e.size) return { precision: 0, recall: 0, f1: 0, binary: true };
  for (const v of e) if (!r.has(v)) return { precision: 0, recall: 0, f1: 0, binary: true };
  return { precision: 1, recall: 1, f1: 1, binary: true };
}

function scoreSetSubset(returned: string[], expected: string[]): Score {
  if (returned.length === 0 && expected.length === 0) {
    return { precision: 1, recall: 1, f1: 1, binary: false };
  }
  // Deduplicate both sides before computing precision so a tool that
  // returns the same answer twice (e.g. grep emitting two lines per
  // file) doesn't silently deflate its precision score by inflating
  // the denominator. The scoring contract is "what unique items did
  // you return" — repeated outputs aren't a precision penalty.
  const r = new Set(returned);
  const e = new Set(expected);
  let hits = 0;
  for (const v of e) if (r.has(v)) hits++;
  const precision = r.size === 0 ? 0 : hits / r.size;
  const recall = e.size === 0 ? 0 : hits / e.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, binary: false };
}

function scoreTopK(returned: string[], expected: string[], k: number): Score {
  // Precision@K, where the expected set is treated as ground-truth
  // unordered. (NDCG variant left as a future extension once a real
  // emulation needs ranked-relevance numbers.) Dedup the slice
  // consistent with scoreSetSubset's contract — a tool that emits
  // the same hit twice within the top-K window doesn't get double
  // credit; only unique relevant items count.
  const slice = Array.from(new Set(returned.slice(0, k)));
  const e = new Set(expected);
  let hits = 0;
  for (const v of slice) if (e.has(v)) hits++;
  const precision = k === 0 ? 0 : hits / k;
  const recall = e.size === 0 ? 0 : hits / e.size;
  const f1 = precision + recall === 0 ? 0 : (2 * precision * recall) / (precision + recall);
  return { precision, recall, f1, binary: false };
}

/** Test-only export. Not part of the CLI surface. */
export const _testHooks = {
  scoreSetExact,
  scoreSetSubset,
  scoreTopK,
};

function scoreOne(q: Question, entry: ToolResultEntry): Score {
  if (q.tolerance === 'exact') return scoreSetExact(entry.returned, q.expected);
  if (q.tolerance === 'subset') return scoreSetSubset(entry.returned, q.expected);
  if (q.tolerance === 'topK') {
    const k = q.topK ?? entry.returned.length;
    return scoreTopK(entry.returned, q.expected, k);
  }
  throw new Error(`Unknown tolerance: ${q.tolerance}`);
}

function fmt(n: number, digits = 2): string {
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(digits);
}

function main(): void {
  const args = process.argv.slice(2);
  if (args.length < 2) {
    console.error('Usage: bun score-emulation.ts <catalog.json> <toolA-results.json> [toolB ...]');
    process.exit(1);
  }
  const [catalogPath, ...resultPaths] = args;
  const catalog = JSON.parse(fs.readFileSync(catalogPath!, 'utf8')) as QuestionCatalog;
  const tools = resultPaths.map((p) => JSON.parse(fs.readFileSync(p, 'utf8')) as ToolResultFile);

  const lines: string[] = [];
  lines.push(`# Emulation score report`);
  lines.push('');
  lines.push(`Catalog: \`${catalogPath}\` — ${catalog.questions.length} questions, ${tools.length} tool(s).`);
  lines.push('');

  // Per-question table
  lines.push('## Per-question scores');
  lines.push('');
  const header = ['Question', 'Tolerance', ...tools.flatMap((t) => [`${t.tool} F1`, `${t.tool} cost`])];
  lines.push('| ' + header.join(' | ') + ' |');
  lines.push('|' + header.map(() => '---').join('|') + '|');

  const aggregates: Map<string, { f1Sum: number; n: number; tokenSum: number; wallSum: number }> = new Map();
  for (const t of tools) aggregates.set(t.tool, { f1Sum: 0, n: 0, tokenSum: 0, wallSum: 0 });

  for (const q of catalog.questions) {
    const row: string[] = [q.label, q.tolerance];
    for (const t of tools) {
      const entry = t.results[q.id];
      if (!entry) {
        row.push('(no result)', '—');
        continue;
      }
      const s = scoreOne(q, entry);
      const agg = aggregates.get(t.tool)!;
      agg.f1Sum += s.f1;
      agg.n++;
      agg.tokenSum += entry.tokenCost;
      agg.wallSum += entry.wallMs;
      row.push(s.binary ? `${s.f1}` : fmt(s.f1), `${entry.tokenCost}t / ${entry.wallMs}ms`);
    }
    lines.push('| ' + row.join(' | ') + ' |');
  }

  // Aggregate row
  lines.push('');
  lines.push('## Aggregate');
  lines.push('');
  lines.push('| Tool | Mean F1 | Total tokens | Total wall ms | Token / F1 | Wall / F1 |');
  lines.push('|---|---|---|---|---|---|');
  for (const t of tools) {
    const agg = aggregates.get(t.tool)!;
    const meanF1 = agg.n === 0 ? 0 : agg.f1Sum / agg.n;
    const tokensPerF1 = meanF1 === 0 ? Infinity : agg.tokenSum / agg.n / meanF1;
    const wallPerF1 = meanF1 === 0 ? Infinity : agg.wallSum / agg.n / meanF1;
    lines.push(
      `| ${t.tool} | ${fmt(meanF1)} | ${agg.tokenSum} | ${agg.wallSum} | ${fmt(tokensPerF1, 0)} | ${fmt(wallPerF1, 0)} |`,
    );
  }

  lines.push('');
  lines.push('Reading the table:');
  lines.push('- F1 closer to 1.0 is better.');
  lines.push('- Token / F1 is the average tokens spent per unit of correctness — lower is better.');
  lines.push('- Wall / F1 same shape, in milliseconds.');
  lines.push('- A tool that returns nothing fast is correctly penalised: F1 = 0 → infinite cost-per-correctness.');

  console.log(lines.join('\n'));
}

// Run as CLI only when executed directly (not when imported by tests).
// Vitest imports the module to access the test hooks; calling `main()`
// unconditionally would `process.exit(1)` on usage-message printing.
if (import.meta.url === `file://${process.argv[1]}`) {
  main();
}
