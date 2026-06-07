import type { MarkdownBulletListSpec } from '../../rendering/result-spec.js';
import type { Node } from '../../types.js';

/**
 * Maximum number of test descriptions shown inline per test file.
 * Keeps output readable without truncating context completely.
 */
export const MAX_TEST_DESCRIPTIONS_SHOWN = 8;

export interface TestRow {
  /** Test-file path, relative to project root. */
  filePath: string;
  /** Test-shaped function/method names found in that file. */
  testSymbols: string[];
  /** Mined `it/test/describe(...)` descriptions for this file, sorted by line. */
  testDescriptions: Array<{ line: number; description: string }>;
  /** Distance from the source symbol's file: 1 = direct, 2 = transitive. */
  hops: number;
}

/** Pre-bucket note shown when no tests-for pass returns anything. */
export const TESTS_FOR_NO_RESULTS_NOTE =
  "_No tests found that import this symbol or its file. The symbol may be exercised via reflective dispatch (DI containers, framework hooks) — those don't appear as static `imports` edges._";

export type TestsForBucketKind = 'direct' | 'transitive' | 'sameFile';

const TESTS_FOR_BUCKET_LABELS: Record<TestsForBucketKind, string> = {
  direct: 'Direct importers (high confidence)',
  transitive: 'Transitive importers (one hop)',
  sameFile: 'Tests covering this file (symbol exercised indirectly)',
};

export function buildTestsForBucketSpec(
  kind: TestsForBucketKind,
  rows: readonly TestRow[],
): MarkdownBulletListSpec<TestRow> {
  return {
    title: `${TESTS_FOR_BUCKET_LABELS[kind]} (${rows.length})`,
    headingLevel: 3,
    rows,
    formatRow: (r) => testRowAsLines(r),
    emptyState: `No ${TESTS_FOR_BUCKET_LABELS[kind].toLowerCase()}.`,
  };
}

export function buildTestsForDispatchSpec(
  mcpToolName: string,
  files: readonly string[],
): MarkdownBulletListSpec<string> {
  return {
    title: `Tests via MCP tool dispatch (${mcpToolName}) (${files.length})`,
    headingLevel: 3,
    rows: files,
    formatRow: (filePath) => `- \`${filePath}\``,
    emptyState: 'No tests dispatch this handler via the MCP tool.',
  };
}

export function buildTestsForDescribeNameSpec(files: readonly string[]): MarkdownBulletListSpec<string> {
  return {
    title: `INFERRED (describe-name match) (${files.length})`,
    headingLevel: 3,
    rows: files,
    formatRow: (filePath) => `- \`${filePath}\``,
    emptyState: 'No describe-name matches.',
  };
}

export function buildTestsForSameFileExplainer(node: Node): string {
  return `_No test file imports or calls \`${node.name}\` directly. The test files above cover other symbols in \`${node.filePath}\`, so they likely exercise \`${node.name}\` transitively. Confidence: file-level (covers the file, not provably the symbol)._`;
}

export function buildTestsForDescribeNameExplainer(node: Node): string {
  return `_No static \`imports\` edge points at this symbol from any test, but the test files above mention \`${node.name}\` in a \`describe\`/\`it\`/\`test\` title — they likely exercise it via class-instance dispatch, DI, or a reflective call path. Confidence: inferred (name-match heuristic)._`;
}

export const TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX = 'covers the file, not provably the symbol';
export const TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX = 'name-match heuristic';

function testRowAsLines(r: TestRow): string[] {
  const out: string[] = [];
  if (r.testSymbols.length === 0 && r.testDescriptions.length === 0) {
    out.push(`- \`${r.filePath}\` _(no test-shaped symbols matched the heuristic)_`);
    return out;
  }
  const testSymbols = r.testSymbols.map((s) => `\`${s}\``).join(', ');
  const symPart = r.testSymbols.length > 0 ? ` — ${testSymbols}` : '';
  let countPart = '';
  if (r.testDescriptions.length > 0) {
    countPart = ` _(${r.testDescriptions.length} covering test block${r.testDescriptions.length === 1 ? '' : 's'})_`;
  }
  out.push(`- \`${r.filePath}\`${symPart}${countPart}`);
  if (r.testDescriptions.length === 0) return out;
  const shown = r.testDescriptions.slice(0, MAX_TEST_DESCRIPTIONS_SHOWN);
  for (const d of shown) {
    out.push(`  - L${d.line}: "${d.description}"`);
  }
  if (r.testDescriptions.length > shown.length) {
    out.push(`  - _…and ${r.testDescriptions.length - shown.length} more covering blocks_`);
  }
  return out;
}
