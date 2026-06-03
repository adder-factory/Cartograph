import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

const TOKEN_CHAR_ESTIMATE = 4;
const PERCENT_SCALE = 100;
const HANDLE_FIND_WINDOW_LINES = 44;
const DEFAULT_FALLBACK_LINE = 1;
const FIND_TOOL_FILE = 'src/mcp/tools/find.ts';
const HANDLE_FIND_NEEDLE = 'async function handleFind';
const FIND_DISPATCH_REGEX = 'cartograph_find|handleFind|findSchema|forwardNameArgs';
const FIND_SYMBOL_REGEX = 'handleFind|applyFindLowTokens|forwardNameArgs|findSchema';
const IMPORT_REGEX = '\\b(import|from|require\\()\\b';
const NODE_SYMBOLS = [
  'handleFind',
  'applyFindLowTokens',
  'forwardNameArgs',
  'forwardContentArgs',
  'forwardRefsArgs',
  'lowTokenLimitForAxis',
  'findSchema',
  'FIND_TOOL',
  'handleFindByName',
  'handleFindByContent',
];

interface BenchmarkCase {
  label: string;
  tool: string;
  regularArgs: Record<string, unknown>;
  lowArgs: Record<string, unknown>;
  baseline?: () => string | null;
}

interface BenchmarkRow {
  label: string;
  regularTokens: number;
  lowTokens: number;
  baselineTokens: number | null;
}

interface LineLookupArgs {
  projectRoot: string;
  filePath: string;
  needle: string;
  extraLines: number;
}

function approxTokens(text: string): number {
  return Math.ceil(text.length / TOKEN_CHAR_ESTIMATE);
}

function formatTokens(tokens: number | null): string {
  if (tokens === null) return 'no fair grep equivalent';
  return `~${tokens.toLocaleString('en-US')}`;
}

function formatComparison(before: number | null, after: number): string | null {
  if (before === null || before <= 0) return null;
  const percent = Math.round((1 - after / before) * PERCENT_SCALE);
  if (percent >= 0) return `~${percent}% less`;
  return `~${Math.abs(percent)}% more`;
}

function runRg(projectRoot: string, args: string[]): string | null {
  try {
    return execFileSync('rg', args, { cwd: projectRoot, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
  } catch {
    return null;
  }
}

function readLineLookup(args: LineLookupArgs): string[] {
  return readFileSync(join(args.projectRoot, args.filePath), 'utf8').split('\n');
}

function lineWindow(args: LineLookupArgs): string {
  const lines = readLineLookup(args);
  const index = lines.findIndex((line) => line.includes(args.needle));
  if (index < 0) return '';
  const start = index;
  const end = Math.min(lines.length, index + args.extraLines + 1);
  return lines
    .slice(start, end)
    .map((line, offset) => `${start + offset + 1}:${line}`)
    .join('\n');
}

function lineRange(args: LineLookupArgs): { start: number; end: number } {
  const lines = readLineLookup(args);
  const index = lines.findIndex((line) => line.includes(args.needle));
  if (index < 0) return { start: DEFAULT_FALLBACK_LINE, end: DEFAULT_FALLBACK_LINE };
  const start = index + 1;
  return { start, end: Math.min(lines.length, start + args.extraLines) };
}

function benchmarkLineLookup(projectRoot: string): LineLookupArgs {
  return {
    projectRoot,
    filePath: FIND_TOOL_FILE,
    needle: HANDLE_FIND_NEEDLE,
    extraLines: HANDLE_FIND_WINDOW_LINES,
  };
}

function findCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`find handleFind`',
    tool: 'cartograph_find',
    regularArgs: { by: 'name', query: 'handleFind' },
    lowArgs: { by: 'name', query: 'handleFind', lowTokens: true },
    baseline: () => runRg(projectRoot, ['-n', 'handleFind', 'src', '__tests__']),
  };
}

function graphCase(): BenchmarkCase {
  return {
    label: '`graph callers handleFind`',
    tool: 'cartograph_graph',
    regularArgs: { direction: 'callers', start: 'handleFind' },
    lowArgs: { direction: 'callers', start: 'handleFind', lowTokens: true },
  };
}

function contextCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`context` for `cartograph_find` dispatch',
    tool: 'cartograph_context',
    regularArgs: { task: 'cartograph_find dispatch handleFind' },
    lowArgs: { task: 'cartograph_find dispatch handleFind', lowTokens: true },
    baseline: () => runRg(projectRoot, ['-n', FIND_DISPATCH_REGEX, 'src/mcp', 'src/db']),
  };
}

function exploreCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`explore handleFind/findSchema/forwardNameArgs`',
    tool: 'cartograph_explore',
    regularArgs: { query: 'handleFind findSchema forwardNameArgs' },
    lowArgs: { query: 'handleFind findSchema forwardNameArgs', lowTokens: true },
    baseline: () => runRg(projectRoot, ['-n', FIND_DISPATCH_REGEX, 'src/mcp', 'src/db']),
  };
}

function atRangeCase(projectRoot: string): BenchmarkCase {
  const lookup = benchmarkLineLookup(projectRoot);
  const atRange = lineRange(lookup);
  return {
    label: '`at_range` on `find.ts` dispatch lines',
    tool: 'cartograph_at_range',
    regularArgs: { file: FIND_TOOL_FILE, startLine: atRange.start, endLine: atRange.end },
    lowArgs: { file: FIND_TOOL_FILE, startLine: atRange.start, endLine: atRange.end, lowTokens: true },
    baseline: () => lineWindow(lookup),
  };
}

function nodeCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`node` batch for find-tool symbols',
    tool: 'cartograph_node',
    regularArgs: { symbols: NODE_SYMBOLS },
    lowArgs: { symbols: NODE_SYMBOLS, lowTokens: true },
    baseline: () => runRg(projectRoot, ['-n', FIND_SYMBOL_REGEX, FIND_TOOL_FILE]),
  };
}

function filesCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`files` project overview',
    tool: 'cartograph_files',
    regularArgs: {},
    lowArgs: { lowTokens: true },
    baseline: () => runRg(projectRoot, ['--files']),
  };
}

function importsCase(projectRoot: string): BenchmarkCase {
  return {
    label: '`imports` project audit',
    tool: 'cartograph_imports',
    regularArgs: {},
    lowArgs: { lowTokens: true },
    baseline: () => runRg(projectRoot, ['-n', IMPORT_REGEX, 'src', 'scripts', '__tests__']),
  };
}

function benchmarkCases(projectRoot: string): BenchmarkCase[] {
  return [
    findCase(projectRoot),
    graphCase(),
    contextCase(projectRoot),
    exploreCase(projectRoot),
    atRangeCase(projectRoot),
    nodeCase(projectRoot),
    filesCase(projectRoot),
    importsCase(projectRoot),
  ];
}

function markdownTable(rows: BenchmarkRow[]): string {
  const lines = [
    '| Case | Regular Cartograph | `lowTokens: true` | `rg` / grep-style baseline | Savings |',
    '|---|---:|---:|---:|---|',
  ];
  for (const row of rows) {
    const vsRegular = formatComparison(row.regularTokens, row.lowTokens);
    const vsBaseline = formatComparison(row.baselineTokens, row.lowTokens);
    const savings = [vsRegular ? `${vsRegular} vs regular` : null, vsBaseline ? `${vsBaseline} vs baseline` : null]
      .filter((part): part is string => part !== null)
      .join(', ');
    lines.push(
      `| ${row.label} | ${formatTokens(row.regularTokens)} | ${formatTokens(row.lowTokens)} | ${formatTokens(
        row.baselineTokens,
      )} | ${savings || 'n/a'} |`,
    );
  }
  return lines.join('\n');
}

async function toolText(handler: ToolHandler, tool: string, args: Record<string, unknown>): Promise<string> {
  const result = await handler.execute(tool, { ...args, allowStale: true });
  return result.content[0]?.text ?? '';
}

async function runBenchmarkCase(handler: ToolHandler, item: BenchmarkCase): Promise<BenchmarkRow> {
  const regular = await toolText(handler, item.tool, item.regularArgs);
  const low = await toolText(handler, item.tool, item.lowArgs);
  const baseline = item.baseline?.() ?? null;
  return {
    label: item.label,
    regularTokens: approxTokens(regular),
    lowTokens: approxTokens(low),
    baselineTokens: baseline === null ? null : approxTokens(baseline),
  };
}

async function runBenchmarkRows(handler: ToolHandler, cases: BenchmarkCase[]): Promise<BenchmarkRow[]> {
  const rows: BenchmarkRow[] = [];
  for (let index = 0; index < cases.length; index++) {
    rows.push(await runBenchmarkCase(handler, cases[index]!));
  }
  return rows;
}

function averageSavings(rows: BenchmarkRow[]): number {
  const total = rows.reduce((sum, row) => sum + (1 - row.lowTokens / row.regularTokens), 0);
  return Math.round((total / rows.length) * PERCENT_SCALE);
}

function report(projectRoot: string, rows: BenchmarkRow[]): string {
  return [
    `Measured on ${projectRoot}`,
    'Token counts are estimated as characters / 4.',
    '',
    markdownTable(rows),
    '',
    `Average savings vs regular Cartograph across these cases: ~${averageSavings(rows)}%.`,
    '',
  ].join('\n');
}

function resolveProjectRoot(argv: string[]): string {
  const projectRoot = resolve(argv[2] ?? process.cwd());
  if (!existsSync(join(projectRoot, '.cartograph'))) {
    throw new Error(`Cartograph is not initialized in ${projectRoot}. Run \`cartograph index\` first.`);
  }
  return projectRoot;
}

async function run(projectRoot: string): Promise<void> {
  const cg = await Cartograph.open(projectRoot);
  const handler = new ToolHandler(cg);
  try {
    const rows = await runBenchmarkRows(handler, benchmarkCases(projectRoot));
    process.stdout.write(report(projectRoot, rows));
  } finally {
    handler.closeAll();
    cg.close();
  }
}

const projectRoot = resolveProjectRoot(process.argv);
run(projectRoot).catch((err) => {
  process.stderr.write(`${err instanceof Error ? err.message : String(err)}\n`);
  process.exitCode = 1;
});
