import fs from 'fs';
import path from 'path';
import { z } from 'zod';
import { projectPathField, batchedSymbols, BATCHED_SYMBOLS_MAX } from './_common-fields.js';
import { getFileByPath } from '../../db/queries-files.js';
import { getFileSummary } from '../../db/queries-file-summaries.js';
import { getIssuesForNode } from '../../db/queries-history.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getFindingsForNode } from '../../db/queries-findings.js';
import {
  bumpNestedFnHitCount,
  lookupNestedFnsByName,
  type NestedFnLookupRow,
} from '../../db/queries-nested-functions.js';
import { codeHealthScore } from '../../biomarkers/index.js';
import type Cartograph from '../../index.js';
import type { Edge, Node } from '../../types.js';
import { isFileStale } from '../../freshness.js';
import { identifierBoundaryRegex } from '../../utils.js';
import {
  fileNodeIdFor,
  freshnessHintForEmptyResult,
  textResult,
  TYPE_LIKE_KINDS,
  TYPE_USAGE_EDGE_KINDS,
  validateStringOutcome,
} from './shared.js';
import { renderToolResponse } from './_response.js';
import {
  findSymbol,
  isUnresolvedUid,
  notFoundMessage,
  staleUidMessage,
  symbolNotFound,
  withDisambiguationBanner,
} from './symbol-resolver.js';
import { expandTestFileCallers } from './_callers.js';
import { defineTool } from './_define-tool.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/**
 * Bodies at or below this many lines are always rendered in full —
 * the cost of preview mode (extra logic, tail marker) buys nothing
 * on a 30-line function. Tuned to match the agentic-backlog spec
 * (item #2): "default brief for nodes >40 LOC; full for smaller ones
 * (no benefit)."
 */
const PREVIEW_LINE_THRESHOLD = 40;
/**
 * When preview kicks in, emit this many lines (30) of the body before
 * the tail marker. Smaller than the threshold so the agent actually
 * sees a saving — emitting 39 lines of a 41-line body is silly.
 */
const PREVIEW_LINE_LIMIT = 30;

/**
 * Hard cap on the multi-symbol input for the `symbols` parameter. Output
 * truncation handles payload size, but the cap defends against a runaway loop
 * when the agent passes a 1000-name list by mistake — N findSymbol calls + N
 * inline-expansion sub-queries would otherwise blow the per-tool budget before
 * truncateOutput catches it. Matched to the tool signature limit in the MCP.
 */
/**
 * Local alias of {@link BATCHED_SYMBOLS_MAX} — node.ts predates the
 * shared field and its name is embedded in JSDoc references the
 * structural refactor doesn't want to churn. Always equal to the
 * shared constant so a future tune lands in one place.
 */
const MAX_SYMBOLS = BATCHED_SYMBOLS_MAX;

/** Per-section caps for inline expansions. Each is a token-saving
 *  default — agents that need more should call the dedicated tool. */
const MAX_INLINE_CALLERS = 10;
const MAX_INLINE_CALLEES = 10;
const MAX_INLINE_FINDINGS = 5;
const MAX_INLINE_TEST_FILES = 5;

// TYPE_LIKE_KINDS and TYPE_USAGE_EDGE_KINDS now live in shared.ts so
// node.ts and callers.ts can't drift on which kinds carry type-usage
// edges.

type DetailMode = 'preview' | 'full';

interface IncludeFlags {
  callers: boolean;
  callees: boolean;
  biomarkers: boolean;
  tests: boolean;
  /** G23: surface `nodes.betweenness` as a "Structural bridge" row in the
   *  per-symbol header when the column has data. Opt-in to keep baseline
   *  output cost zero on the common path; only useful when the
   *  betweenness hook is enabled (`config.enableBetweenness = true`). */
  betweenness: boolean;
}

/** Per-node line count from the indexed range, when both endpoints are known. */
function locFromRange(node: Node): number | null {
  if (typeof node.startLine !== 'number' || typeof node.endLine !== 'number') return null;
  if (node.endLine < node.startLine) return null;
  return node.endLine - node.startLine + 1;
}

/**
 * Truncate a fenced source body to PREVIEW_LINE_LIMIT lines + a tail
 * marker. Returns the original code untouched when its line count is
 * at or below PREVIEW_LINE_THRESHOLD — the saving wouldn't be worth
 * the noise on a small body.
 */
function previewCode(code: string): { code: string; truncated: boolean; total: number } {
  const allLines = code.split('\n');
  const total = allLines.length;
  if (total <= PREVIEW_LINE_THRESHOLD) {
    return { code, truncated: false, total };
  }
  const head = allLines.slice(0, PREVIEW_LINE_LIMIT).join('\n');
  return { code: head, truncated: true, total };
}

/**
 * Render a markdown card for one node: title, location, signature,
 * issue history (if any), short docstring, line count, optional code
 * block (full or preview-truncated).
 */
interface FormatNodeDetailsArgs {
  node: Node;
  code: string | null;
  detail: DetailMode;
  /**
   * When the file's on-disk content differs from the indexed snapshot,
   * the body is still rendered (it's the indexed snapshot) but this
   * warning prefixes the code block so the agent knows line numbers
   * may not match the live file. Null when fresh.
   */
  staleWarning?: string | null;
  issues?: Array<{
    issueNumber: number;
    kind: 'modified' | 'added' | 'removed';
    commitSha: string;
  }>;
  testAssertions?: TestAssertionResult;
  /** Forwarded to {@link formatNodeCardHeader} — surfaces the
   *  betweenness header row when true AND `node.betweenness` is set. */
  showBetweenness?: boolean;
}

/** A single mined test assertion (`it/test/describe` description) row. */
interface TestAssertion {
  filePath: string;
  line: number;
  description: string;
}

/**
 * Result of {@link fetchTestAssertionsForFile}. `rows` are the
 * assertions kept after symbol-relevance filtering of the file-level
 * `tests` fallback. `fileLevelOnly` is true when the only `tests`
 * linkage is FILE-LEVEL (no per-symbol edge) — in that case an empty
 * `rows` means the renderer should emit an honest "no per-symbol
 * coverage" line rather than nothing. `testFile` names the test file
 * the file-level edge points from (for the honest line).
 */
interface TestAssertionResult {
  rows: TestAssertion[];
  fileLevelOnly: boolean;
  testFile: string | null;
}

/** Build the title + location + signature + line-count header lines for a node card. */
function formatNodeCardHeader(
  node: Node,
  opts?: { showBetweenness?: boolean },
): { lines: string[]; loc: number | null } {
  const location = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [`## ${node.name} (${node.kind})`, '', `**Location:** ${node.filePath}${location}`];
  if (node.signature) lines.push(`**Signature:** \`${node.signature}\``);
  // Always surface line count when the indexed range is known — cheap signal
  // that lets the agent skip a `code: true` round-trip for tiny helpers AND
  // know upfront when preview will engage on a big body. Costs ~15 chars per response.
  const loc = locFromRange(node);
  if (loc !== null) lines.push(`**Lines:** ${loc}`);
  // G23: surface sampled Brandes betweenness as a structural-bridge
  // warning when the agent opted in AND the column is populated. NULL
  // when the betweenness hook hasn't run yet (default config) — row
  // suppressed in that case so the agent isn't misled by a missing
  // signal.
  if (opts?.showBetweenness === true && typeof node.betweenness === 'number') {
    lines.push(`**Structural bridge:** ${node.betweenness.toFixed(4)} _(sampled Brandes betweenness)_`);
  }
  return { lines, loc };
}

/** Append the issues line + optional short docstring to the lines accumulator. */
function appendIssuesAndDocstring(
  lines: string[],
  node: Node,
  issues: Array<{ issueNumber: number; kind: 'modified' | 'added' | 'removed'; commitSha: string }>,
): void {
  const issuesLine = formatIssuesLine(issues);
  if (issuesLine) lines.push(issuesLine);
  // Only include docstring if it's short and useful
  if (node.docstring && node.docstring.length < 200) {
    lines.push('', node.docstring);
  }
}

/** Append the "Tested as" block (mined test assertions) to the lines accumulator. */
function appendTestAssertionsBlock(lines: string[], node: Node, testAssertions: TestAssertionResult): void {
  const { rows, fileLevelOnly, testFile } = testAssertions;
  if (rows.length === 0) {
    // File-level `tests` edge exists but no mined description / body in
    // the linked test file mentions this symbol by name. Surfacing the
    // first 5 arbitrary headers would be pure noise (friction FRICTION-B),
    // so emit an honest line instead.
    if (fileLevelOnly && testFile) {
      lines.push(
        '',
        `**Tested as** — _No per-symbol test coverage found. \`${node.filePath}\` has a file-level test edge to \`${testFile}\` but no test there references \`${node.name}\` by name._`,
      );
    }
    return;
  }
  // Derive the file scope from the rows actually shown — the FRICTION-4
  // direct-caller supplement can pull assertions from a test file other
  // than the `tests`-edge `testFile`, so naming a single file in the
  // header would contradict the multi-file list below it.
  const distinctFiles = new Set(rows.map((r) => r.filePath));
  const scope =
    distinctFiles.size === 1
      ? `tests in \`${[...distinctFiles][0]}\``
      : `tests across ${distinctFiles.size} test files`;
  lines.push('', `**Tested as** _(${scope} that reference \`${node.name}\` by name)_`);
  const shown = rows.slice(0, 5);
  for (const t of shown) {
    lines.push(`- \`${t.filePath}:${t.line}\` — "${t.description}"`);
  }
  if (rows.length > shown.length) {
    lines.push(`- _…and ${rows.length - shown.length} more_`);
  }
}

function formatNodeDetails(args: FormatNodeDetailsArgs): string {
  const {
    node,
    code,
    detail,
    staleWarning = null,
    issues = [],
    testAssertions = { rows: [], fileLevelOnly: false, testFile: null },
    showBetweenness = false,
  } = args;
  const { lines, loc } = formatNodeCardHeader(node, { showBetweenness });
  appendIssuesAndDocstring(lines, node, issues);
  appendTestAssertionsBlock(lines, node, testAssertions);
  if (code) {
    if (staleWarning) lines.push('', `> ⚠ ${staleWarning}`);
    appendCodeBlock({ lines, node, code, detail, loc });
  }
  return lines.join('\n');
}

/**
 * Build a case-sensitive identifier-token regex so a substring match
 * (`getChanged` inside `getChangedFilesList`) doesn't count. Uses the
 * shared `$`-safe boundary builder: a plain `\b…\b` mis-matches names
 * ending in `$` (RxJS `data$`), and an unescaped name would break
 * outright on the `$`.
 */
function wordRegexFor(identifier: string): RegExp {
  return identifierBoundaryRegex(identifier);
}

/**
 * Decide whether a mined test assertion plausibly exercises `symbol`.
 * Priority: (1) the it/describe title names the symbol as a word, or
 * (2) the it-block BODY (source span from this line to the next test
 * header in `headerLines`) references the symbol as a word. Returns
 * false when neither holds — that row is file-level-fallback noise.
 */
function assertionReferencesSymbol(args: {
  description: string;
  line: number;
  symbolRe: RegExp;
  srcLines: string[] | null;
  headerLines: number[];
}): boolean {
  const { description, line, symbolRe, srcLines, headerLines } = args;
  // (1) high-signal: identifier appears in the test title.
  if (symbolRe.test(description)) return true;
  // (2) body scan: lines [line, nextHeaderLine).
  if (srcLines === null) return false;
  let end = srcLines.length;
  for (const h of headerLines) {
    if (h > line) {
      end = Math.min(end, h - 1);
      break;
    }
  }
  // test_names lines are 1-based; srcLines is 0-based.
  const body = srcLines.slice(line - 1, end).join('\n');
  return symbolRe.test(body);
}

interface CollectDirectTestCallerPathsArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  nodeId: string;
  excludeFiles: ReadonlySet<string>;
  maxFiles: number;
}

/**
 * Collect test file paths that have direct `calls`, `references`, or
 * `imports` edges to `nodeId`. This catches the FRICTION-4 pattern where a test
 * names-imports a symbol (`references` edge on the import line) and
 * calls it (`calls` edge at the call site) but the `tests`-edge
 * convention only links a DIFFERENT test file (e.g. `freshness.test.ts`)
 * because it shares the filename stem.
 *
 * Returns de-duplicated file paths (not node ids) limited by `maxFiles`.
 * Only returns paths whose `files.is_test = 1`.
 */
function collectDirectTestCallerPaths(args: CollectDirectTestCallerPathsArgs): string[] {
  const { cg, nodeId, excludeFiles, maxFiles } = args;
  const out: string[] = [];
  const seen = new Set<string>(excludeFiles);
  for (const edge of getIncomingEdges(cg.queries, nodeId, ['calls', 'references', 'imports'])) {
    if (out.length >= maxFiles) break;
    const src = cg.queries.getNodeById(edge.source);
    if (!src?.filePath || seen.has(src.filePath)) continue;
    seen.add(src.filePath);
    const file = getFileByPath(cg.queries, src.filePath);
    if (!file?.isTest) continue;
    out.push(src.filePath);
  }
  return out;
}

/**
 * Apply the symbol-relevance filter (title word-match or body-scan) to
 * all `test_names` rows of a given test file. Returns kept rows.
 * Pulled out so both the `tests`-edge path and the direct-caller path
 * can share the same filter logic.
 */
function filterAssertionsForTestFile(args: {
  cg: ReturnType<ToolCtx['getCartograph']>;
  testFilePath: string;
  symbolRe: RegExp;
}): TestAssertion[] {
  const { cg, testFilePath, symbolRe } = args;
  const rows = cg.db
    .getDb()
    .prepare(
      'SELECT file_path AS filePath, line, description FROM test_names WHERE file_path = ? ORDER BY line LIMIT 200',
    )
    .all(testFilePath) as TestAssertion[];
  if (rows.length === 0) return [];
  const headerLines = rows.map((r) => r.line).sort((a, b) => a - b);
  let srcLines: string[] | null = null;
  try {
    const abs = path.isAbsolute(testFilePath) ? testFilePath : path.join(cg.projectRoot, testFilePath);
    srcLines = fs.readFileSync(abs, 'utf8').split('\n');
  } catch {
    srcLines = null;
  }
  const kept: TestAssertion[] = [];
  for (const r of rows) {
    if (assertionReferencesSymbol({ description: r.description, line: r.line, symbolRe, srcLines, headerLines })) {
      kept.push(r);
    }
  }
  return kept;
}

/**
 * Query the `edges` → `test_names` join for all test-assertion rows
 * linked to `node.filePath` via a file-level `tests` edge. Returns the
 * raw rows (unfiltered) and the first test-file path found.
 */
function queryTestEdgeAssertions(
  cg: ReturnType<ToolCtx['getCartograph']>,
  filePath: string,
): { raw: TestAssertion[]; testFile: string | null } {
  const raw = cg.db
    .getDb()
    .prepare(
      `SELECT tn.file_path AS filePath, tn.line, tn.description
         FROM edges e
         JOIN test_names tn ON tn.file_path = SUBSTR(e.source, 6)
        WHERE e.kind = 'tests'
          AND e.target = ?
        ORDER BY tn.file_path, tn.line
        LIMIT 200`,
    )
    .all(`file:${filePath}`) as TestAssertion[];
  return { raw, testFile: raw[0]?.filePath ?? null };
}

/**
 * Filter raw `tests`-edge assertion rows by symbol relevance. Groups
 * rows by test file (so each file is read once), then keeps only rows
 * whose title or body reference the symbol. Also records the set of
 * test-file paths seen so the caller can skip them in the
 * direct-caller supplemental pass.
 */
function filterTestEdgeAssertions(
  cg: ReturnType<ToolCtx['getCartograph']>,
  raw: TestAssertion[],
  symbolRe: RegExp,
): { kept: TestAssertion[]; seenByTestsEdge: Set<string> } {
  const seenByTestsEdge = new Set<string>();
  const byFile = new Map<string, TestAssertion[]>();
  for (const r of raw) {
    seenByTestsEdge.add(r.filePath);
    const arr = byFile.get(r.filePath) ?? [];
    arr.push(r);
    byFile.set(r.filePath, arr);
  }
  const kept: TestAssertion[] = [];
  for (const [tf, rows] of byFile) {
    const headerLines = rows.map((r) => r.line).sort((a, b) => a - b);
    let srcLines: string[] | null = null;
    try {
      const abs = path.isAbsolute(tf) ? tf : path.join(cg.projectRoot, tf);
      srcLines = fs.readFileSync(abs, 'utf8').split('\n');
    } catch {
      srcLines = null;
    }
    for (const r of rows) {
      if (assertionReferencesSymbol({ description: r.description, line: r.line, symbolRe, srcLines, headerLines })) {
        kept.push(r);
      }
    }
  }
  return { kept, seenByTestsEdge };
}

/**
 * Sort comparator for `TestAssertion` rows: file path ascending, then
 * line number ascending within each file. Named so the inline
 * `kept.sort(...)` stays readable and the conditional chain is
 * outside `fetchTestAssertionsForFile`'s own complexity budget.
 */
function compareAssertionOrder(a: TestAssertion, b: TestAssertion): number {
  if (a.filePath !== b.filePath) return a.filePath < b.filePath ? -1 : 1;
  return a.line - b.line;
}

/**
 * Pull mined test assertions from any test file linked to `node`'s
 * file via a (file-level) `tests` edge, then KEEP only the rows that
 * plausibly exercise THIS symbol — either the it/describe title or the
 * it-block body references the symbol identifier as a word. The raw
 * file-level fallback dumps the first headers of the whole test file,
 * which are orthogonal noise for any symbol that isn't the file's
 * headline subject (friction FRICTION-B).
 *
 * FRICTION-4 fix: when the `tests`-edge path yields no matching
 * assertions, also scan test files that have direct `calls` /
 * `references` / `imports` edges to the symbol node. These cover the
 * pattern where a test imports and calls the symbol but the `tests`
 * filename-convention edge only links a DIFFERENT test file.
 *
 * Returns a {@link TestAssertionResult}: `rows` are the kept
 * assertions; `fileLevelOnly` flags that the linkage was file-level
 * (so an empty `rows` should render the honest "no per-symbol
 * coverage" line); `testFile` names the linked test file.
 */
function fetchTestAssertionsForFile(cg: ReturnType<ToolCtx['getCartograph']>, node: Node): TestAssertionResult {
  const empty: TestAssertionResult = { rows: [], fileLevelOnly: false, testFile: null };
  try {
    const symbolRe = wordRegexFor(node.name);

    const { raw, testFile } = queryTestEdgeAssertions(cg, node.filePath);
    const { kept, seenByTestsEdge } = filterTestEdgeAssertions(cg, raw, symbolRe);

    // FRICTION-4 fix: supplement with test files that have direct
    // `calls`/`references`/`imports` edges to the symbol node. These
    // aren't connected by the `tests` filename-convention edge, but they
    // statically import and call the symbol — equal confidence.
    const directCallerPaths = collectDirectTestCallerPaths({
      cg,
      nodeId: node.id,
      excludeFiles: seenByTestsEdge,
      maxFiles: 5,
    });
    for (const tf of directCallerPaths) {
      kept.push(...filterAssertionsForTestFile({ cg, testFilePath: tf, symbolRe }));
    }

    const hasNoResults = kept.length === 0 && testFile === null && directCallerPaths.length === 0;
    if (hasNoResults) return empty;

    kept.sort(compareAssertionOrder);

    // Prefer the directly-importing test file as the primary label when
    // the `tests`-edge file had no matching assertions but the direct
    // caller does.
    const primaryTestFile = testFile ?? directCallerPaths[0] ?? null;

    return { rows: kept.slice(0, 8), fileLevelOnly: testFile !== null, testFile: primaryTestFile };
  } catch {
    return empty;
  }
}

/** Group issues by kind, sort numerically, and format as `#1, #2 (modified) — #3 (added)`. */
function formatIssuesLine(
  issues: Array<{ issueNumber: number; kind: 'modified' | 'added' | 'removed'; commitSha: string }>,
): string | null {
  if (issues.length === 0) return null;
  const byKind: Record<'modified' | 'added' | 'removed', Set<number>> = {
    modified: new Set(),
    added: new Set(),
    removed: new Set(),
  };
  for (const i of issues) byKind[i.kind].add(i.issueNumber);
  const parts: string[] = [];
  for (const k of ['modified', 'added', 'removed'] as const) {
    const set = byKind[k];
    if (set.size === 0) continue;
    const sorted = [...set].sort((a, b) => a - b);
    parts.push(`#${sorted.join(', #')} (${k})`);
  }
  return parts.length > 0 ? `**Issues:** ${parts.join(' — ')}` : null;
}

/** Append the fenced code block (preview-truncated or full) to the lines accumulator. */
function appendCodeBlock(args: {
  lines: string[];
  node: Node;
  code: string;
  detail: DetailMode;
  loc: number | null;
}): void {
  const { lines, node, code, detail, loc } = args;
  if (detail !== 'preview') {
    lines.push('', '```' + node.language, code, '```');
    return;
  }
  const { code: shown, truncated, total } = previewCode(code);
  lines.push('', '```' + node.language, shown, '```');
  if (!truncated) return;
  // Prefer the indexed range count when it's available so the
  // tail marker agrees with the **Lines:** field above. Fall
  // back to the body's own line count when the range is
  // unknown (rare — only when extractor didn't stamp endLine).
  const reportedTotal = loc ?? total;
  lines.push(
    '',
    `> Showing first ${PREVIEW_LINE_LIMIT} of ${reportedTotal} lines. ` +
      'Pass `detail: "full"` to see the whole body.',
  );
}

interface FetchNodeCodeResult {
  code: string | null;
  staleWarning: string | null;
}

/**
 * Fetch source for a node from the indexed snapshot. When the file's
 * on-disk content_hash differs from the indexed version, the body is
 * STILL returned (the indexed snapshot is the agent's reference for
 * what was extracted) but `staleWarning` is set so the caller can
 * surface "line numbers may not match the current file" above the
 * body. Pre-2026-05-14 this branch dropped the body entirely, forcing
 * a redundant `Read` fallback when the symbol contents were the point
 * of the query.
 */
async function fetchNodeCode(
  cg: ReturnType<ToolCtx['getCartograph']>,
  nodeId: string,
  filePath: string,
): Promise<FetchNodeCodeResult> {
  const fileRec = getFileByPath(cg.queries, filePath);
  const stale = fileRec ? isFileStale(cg.projectRoot, fileRec) : false;
  const code = await cg.internals.contextBuilder.getCode(nodeId);
  if (stale) {
    return {
      code,
      staleWarning:
        `source from indexed snapshot — \`${filePath}\` modified since last index, ` +
        'so line numbers below may not match the current file. ' +
        'Run `cartograph admin sync` to refresh.',
    };
  }
  return { code, staleWarning: null };
}

/**
 * Resolve which symbols the caller wants. Accepts EITHER a single
 * `symbol: string` OR a `symbols: string[]` array — but not both.
 * Returns a string list on success or a `ToolOutcome` `err` arm.
 *
 * The `symbols` array's per-entry non-empty-string shape and the
 * 20-entry cap are now enforced by the Zod schema at the dispatch
 * boundary; this function only owns the cross-field rules Zod can't
 * express — mutual exclusion and the empty-array reject.
 */
function parseSymbolList(args: NodeArgs): string[] | ToolOutcome {
  const symbolsArg = args.symbols;
  const symbolArg = args.symbol;
  const symbolsProvided = Array.isArray(symbolsArg);
  const symbolProvided = symbolArg !== undefined;
  if (symbolsProvided && symbolProvided) {
    return err('Pass either `symbol` (single) or `symbols` (array), not both.');
  }
  if (symbolsProvided) {
    if (symbolsArg.length === 0) {
      return err('`symbols` must be a non-empty array of strings.');
    }
    for (const item of symbolsArg) {
      if (item.length === 0) {
        return err('`symbols` entries must be non-empty strings.');
      }
    }
    return symbolsArg;
  }
  // Fall through to the single-symbol shape (also covers the
  // missing-input case — validateStringOutcome surfaces the right error).
  // Labelled `symbols` (plural) so the empty-input error matches the
  // CLI's variadic `<symbols...>` positional.
  const single = validateStringOutcome({ value: symbolArg, name: 'symbols' });
  if (typeof single !== 'string') return single;
  return [single];
}

/** Read the four `includeXxx` boolean flags from the parsed args.
 *  Strict `=== true` so an explicit `false` (or omitted) doesn't
 *  trigger an expansion (saves the agent from token surprises). */
function parseIncludeFlags(args: NodeArgs): IncludeFlags {
  return {
    callers: args.includeCallers === true,
    callees: args.includeCallees === true,
    biomarkers: args.includeBiomarkers === true,
    tests: args.includeTests === true,
    betweenness: args.includeBetweenness === true,
  };
}

/** Truthy when at least one inline-expansion flag is set. Lets the
 *  per-symbol renderer skip the section header when no flags fire. */
function anyIncludeFlag(flags: IncludeFlags): boolean {
  return flags.callers || flags.callees || flags.biomarkers || flags.tests;
}

/**
 * One entry in the merged callers list with the edge kind(s) annotated so
 * the agent can distinguish "instantiated by" from "imported by". When the
 * same source has multiple incoming edges (e.g. both `calls` AND
 * `references`), all kinds are listed so the agent sees one row per unique
 * caller — matching the dedup pass `cartograph_graph` (via `_callers.ts`)
 * applies. Friction F-M (2026-05-11): pre-fix the function-node branch
 * returned every edge row verbatim, so a caller with `calls` + `references`
 * appeared TWICE — inflating the count and disagreeing with `cartograph_graph`.
 */
interface CallerEntry {
  node: Node;
  edgeKinds: ReadonlyArray<Edge['kind']>;
}

/**
 * Group a list of caller candidates by `node.id`, collapsing multi-edge
 * same-source rows into one entry with all edge kinds listed. Preserves
 * first-seen order of unique sources AND first-seen order of edge kinds
 * within each source so output is deterministic across calls. Each caller
 * source appears exactly once in the returned list.
 */
function dedupCallersBySource(rows: ReadonlyArray<{ node: Node; edgeKind: Edge['kind'] }>): CallerEntry[] {
  const order: string[] = [];
  const byId = new Map<string, { node: Node; edgeKinds: Edge['kind'][] }>();
  for (const r of rows) {
    const existing = byId.get(r.node.id);
    if (existing) {
      if (!existing.edgeKinds.includes(r.edgeKind)) existing.edgeKinds.push(r.edgeKind);
      continue;
    }
    order.push(r.node.id);
    byId.set(r.node.id, { node: r.node, edgeKinds: [r.edgeKind] });
  }
  return order.map((id) => {
    const e = byId.get(id)!;
    return { node: e.node, edgeKinds: e.edgeKinds };
  });
}

/**
 * For type-like nodes (class / interface / etc.) merge type-usage incoming
 * edges (instantiates / type_of / returns / extends / implements) with plain
 * call-predecessor rows. Type-usage edges win on dedup so construction sites
 * are not hidden. Returns a plain call-predecessor list for non-type-like nodes.
 *
 * Within each branch, the caller list is deduped by `node.id` via
 * {@link dedupCallersBySource} — when a source has multiple incoming edges
 * (e.g. `calls` + `references`), the row collapses into one with both kinds
 * listed inline. Matches the dedup pass `cartograph_graph` applies in
 * `_callers.ts::collectCallers`, so caller counts agree between the two tools
 * (friction F-M, 2026-05-11).
 */
function mergeCallerEntries(
  cg: Cartograph,
  node: Node,
  callRows: ReturnType<Cartograph['internals']['traverser']['getCallers']>,
): CallerEntry[] {
  // FRICTION-5 fix (2026-05-15): expand test-file file-row callers into
  // per-call-site rows (anchored on the enclosing `it/describe` block via
  // `test_names`) BEFORE the dedup pass. The expanded rows carry synthetic
  // ids (`node.id#site:N`) so they survive dedup individually. This matches
  // the behavior of `cartograph_graph({direction:'callers'})` which already
  // applied this expansion via `expandTestFileCallers` in `_callers.ts`.
  const expandedCallRows = expandTestFileCallers(
    cg,
    callRows.map((c) => ({ node: c.node, edge: c.edge })),
  );

  if (!TYPE_LIKE_KINDS.has(node.kind)) {
    return dedupCallersBySource(expandedCallRows.map((c) => ({ node: c.node, edgeKind: c.edge.kind })));
  }

  // Fetch type-usage edges first — they win on dedup.
  const typeUsageRows = getIncomingEdges(cg.queries, node.id, TYPE_USAGE_EDGE_KINDS as Edge['kind'][]);
  const typeRowsRaw: Array<{ node: Node; edgeKind: Edge['kind'] }> = [];
  for (const e of typeUsageRows) {
    const src = cg.queries.getNodeById(e.source);
    if (src) typeRowsRaw.push({ node: src, edgeKind: e.kind });
  }
  const typeEntries = dedupCallersBySource(typeRowsRaw);
  const typeSeenIds = new Set<string>(typeEntries.map((e) => e.node.id));

  // Append call-predecessor rows not already covered by a type-usage edge.
  // Use the expanded rows (test file rows already fanned out) so the test
  // fan-out applies equally in the type-like branch.
  const callRowsRaw: Array<{ node: Node; edgeKind: Edge['kind'] }> = [];
  for (const c of expandedCallRows) {
    if (!typeSeenIds.has(c.node.id)) {
      callRowsRaw.push({ node: c.node, edgeKind: c.edge.kind });
    }
  }
  const callEntries = dedupCallersBySource(callRowsRaw);

  // Prioritise type-usage over call predecessors so the cap doesn't
  // accidentally hide all construction sites.
  return [...typeEntries, ...callEntries];
}

/** Build the header line for a capped callers list. */
function buildCallersHeader(total: number, shown: number): string {
  const isTruncated = total > shown;
  return isTruncated ? `**Callers** (${total} total, showing top ${shown}):` : `**Callers** (${total}):`;
}

/** Format a capped list of caller entries as a markdown block. When a row
 *  has multiple edge kinds (e.g. `calls` + `references` from the same
 *  source), they render inline as `via calls, references` so the agent sees
 *  every relationship without inflating the row count. */
function formatCallersList(merged: CallerEntry[]): string {
  if (merged.length === 0) return '**Callers:** _none._';
  const shown = merged.slice(0, MAX_INLINE_CALLERS);
  const isTruncated = merged.length > shown.length;
  const lines: string[] = [buildCallersHeader(merged.length, shown.length)];
  for (const c of shown) {
    const cloc = c.node.startLine ? `:${c.node.startLine}` : '';
    lines.push(`- ${c.node.name} (${c.node.kind}) — ${c.node.filePath}${cloc} via ${c.edgeKinds.join(', ')}`);
  }
  if (isTruncated) {
    lines.push(
      `- _…and ${merged.length - shown.length} more — call \`cartograph_graph({direction: 'callers'})\` for the full list._`,
    );
  }
  return lines.join('\n');
}

/**
 * Inline-expansion: top callers of the node. Capped at
 * MAX_INLINE_CALLERS so a heavy hub doesn't dump its full caller
 * list into a card. Pointer to the full tool is in the overflow tail.
 *
 * For class / interface / type_alias / struct / enum / trait / protocol /
 * component / module kinds the function additionally fetches `instantiates`,
 * `type_of`, `returns`, `extends`, and `implements` incoming edges and merges
 * them into the list. This ensures construction sites (`new Foo(...)`)
 * surface here instead of being silently hidden behind file-level `imports`
 * edges — matching the behaviour of the standalone `cartograph_callers` tool.
 *
 * When both sets together exceed MAX_INLINE_CALLERS, instantiates/type-usage
 * rows are prioritised over plain call-predecessor rows (constructors are
 * more useful for "who uses this class" intent than file-level imports).
 *
 * For function / method / route and other non-type-like kinds, behaviour is
 * unchanged from before — only `traverser.getCallers` results are shown.
 *
 * Test-file callers are filtered OUT here: the "Tested as" block and the
 * `includeTests` "Tests" section already enumerate every test that
 * exercises the symbol, so leaving them in **Callers** double-lists the
 * same files. A one-line pointer replaces them when any are dropped.
 */
function renderCallersSection(cg: Cartograph, node: Node): string {
  const callRows = cg.internals.traverser.getCallers(node.id);
  const merged = mergeCallerEntries(cg, node, callRows);
  const nonTest = merged.filter((c) => {
    if (!c.node.filePath) return true;
    return getFileByPath(cg.queries, c.node.filePath)?.isTest !== true;
  });
  const testCallersDropped = merged.length - nonTest.length;
  const list = formatCallersList(nonTest);
  return testCallersDropped > 0
    ? `${list}\n- _(${testCallersDropped} test-file caller${testCallersDropped === 1 ? '' : 's'} omitted — see the "Tested as" / "Tests" section)_`
    : list;
}

/** Build the header line for a capped callees list. */
function buildCalleesHeader(total: number, shown: number): string {
  const isTruncated = total > shown;
  return isTruncated ? `**Callees** (${total} total, showing top ${shown}):` : `**Callees** (${total}):`;
}

/** Inline-expansion: top callees of the node. Symmetric to
 *  {@link renderCallersSection}; same cap, same overflow shape. */
function renderCalleesSection(cg: Cartograph, node: Node): string {
  const callees = cg.internals.traverser.getCallees(node.id);
  if (callees.length === 0) return '**Callees:** _none._';
  const shown = callees.slice(0, MAX_INLINE_CALLEES);
  const isTruncated = callees.length > shown.length;
  const lines: string[] = [buildCalleesHeader(callees.length, shown.length)];
  for (const c of shown) {
    const cloc = c.node.startLine ? `:${c.node.startLine}` : '';
    lines.push(`- ${c.node.name} (${c.node.kind}) — ${c.node.filePath}${cloc}`);
  }
  if (isTruncated) {
    lines.push(
      `- _…and ${callees.length - shown.length} more — call \`cartograph_graph({direction: 'callees'})\` for the full list._`,
    );
  }
  return lines.join('\n');
}

/** Inline-expansion: Code Health score + top findings. Findings are
 *  ordered worst-severity first by `getFindingsForNode`, so slicing
 *  preserves the actionable rows. */
function renderBiomarkersSection(cg: Cartograph, node: Node): string {
  const findings = getFindingsForNode(cg.queries, node.id);
  if (findings.length === 0) {
    return '**Biomarkers:** _Code Health 10/10 — no findings._';
  }
  const score = codeHealthScore(findings);
  const lines: string[] = [
    `**Biomarkers:** Code Health ${score}/10 (${findings.length} finding${findings.length === 1 ? '' : 's'})`,
  ];
  const shown = findings.slice(0, MAX_INLINE_FINDINGS);
  for (const f of shown) {
    lines.push(`- ${f.biomarker} (${f.severity}, metric ${f.metric})`);
  }
  if (findings.length > shown.length) {
    lines.push(
      `- _…and ${findings.length - shown.length} more — call \`cartograph_biomarkers mode=symbol\` for the full list._`,
    );
  }
  return lines.join('\n');
}

/**
 * Inline-expansion: test files that directly import, call, or
 * reference this node — or import its file. Walking `calls` /
 * `references` (not just `imports`) catches the FRICTION-4 pattern
 * where a test names-imports a symbol (the `references` edge sits on
 * the import line) and exercises it, but has no bare `imports` edge
 * to the symbol itself — the common case for a class a test does
 * `new Foo()` on. Matches the edge set `collectDirectTestCallerPaths`
 * uses for the "Tested as" block, so the two test sections agree.
 * One-hop direct only — the dedicated `cartograph_tests_for` tool
 * still does the +1 transitive walk and per-test assertion mining.
 */
function renderTestsSection(cg: Cartograph, node: Node): string {
  const targets = [node.id, fileNodeIdFor(cg, node.filePath)].filter((x): x is string => !!x);
  const seen = new Set<string>();
  const tests: string[] = [];
  for (const tid of targets) {
    for (const edge of getIncomingEdges(cg.queries, tid, ['calls', 'references', 'imports'])) {
      const src = cg.queries.getNodeById(edge.source);
      if (!src?.filePath || seen.has(src.filePath)) continue;
      seen.add(src.filePath);
      const file = getFileByPath(cg.queries, src.filePath);
      if (!file?.isTest) continue;
      tests.push(src.filePath);
    }
  }
  if (tests.length === 0) {
    return '**Tests:** _no direct test callers or importers (may be exercised reflectively)._';
  }
  const shown = tests.slice(0, MAX_INLINE_TEST_FILES);
  const lines: string[] = [`**Tests** (direct callers / importers, ${tests.length} total):`];
  for (const t of shown) lines.push(`- \`${t}\``);
  if (tests.length > shown.length) {
    lines.push(
      `- _…and ${tests.length - shown.length} more — call \`cartograph_tests_for\` for the full list including transitive importers._`,
    );
  }
  return lines.join('\n');
}

/**
 * Build the header line for multi-symbol output, with counts of
 * resolved, not-found, and duplicate-merged entries.
 */
function buildMultiSymbolHeader(nodesShown: number, notFound: number, dedupCount: number): string {
  const parts: string[] = [];
  parts.push(`# ${nodesShown} symbol${nodesShown === 1 ? '' : 's'} resolved`);
  if (notFound > 0) {
    parts.push(` (${notFound} not found)`);
  }
  if (dedupCount > 0) {
    const plural = dedupCount === 1 ? '' : 's';
    parts.push(` (${dedupCount} duplicate input${plural} merged)`);
  }
  return parts.join('');
}

interface ProcessSymbolArgs {
  ctx: ToolCtx;
  cg: ReturnType<ToolCtx['getCartograph']>;
  includeCode: boolean;
  detail: DetailMode;
  flags: IncludeFlags;
  /** F#12 slice 2: when set, fall back to the nested-function manifest
   *  if findSymbol misses. Off by default — callers explicitly opt in
   *  via the `deep:true` MCP arg. */
  deep: boolean;
}

/**
 * F#12 slice 2/3: render a deep view for a nested function that lives
 * in a mega-file (manifest mode). Three paths, branching on the
 * manifest row state:
 *
 *   1. Already promoted (`promoted_node_id IS NOT NULL`) — slice 3
 *      fast path: route through `findSymbol`/`renderOneNode` using the
 *      promoted id so the symbol behaves like any other graph node
 *      (cross-file callers resolved, biomarkers + centrality apply,
 *      inline expansions all work). Returns the standard card shape.
 *   2. Below the promotion threshold — slice 2 ad-hoc view: source
 *      slice read live off disk + parent header + the manifest-mode
 *      footer. Bumps `hit_count` atomically (slice 3) so popularity
 *      accumulates toward promotion.
 *   3. No manifest row → returns `null`; caller falls through to the
 *      standard "symbol not found" message.
 *
 * `flags` threads through for the promoted-fast-path `renderOneNode`
 * call (slice 2 didn't need flags because the ad-hoc view doesn't
 * render callers/callees/biomarkers/tests — only the promoted path
 * does). Async because the promoted-path renderer is async.
 */
async function tryRenderManifestDeepView(args: {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  includeCode: boolean;
  detail: DetailMode;
  flags: IncludeFlags;
}): Promise<string | null> {
  const { cg, symbol, includeCode, detail, flags } = args;
  // Manifest names are bare identifiers; reject anything that wouldn't
  // be a single name token. Matches the same gate the find-empty
  // probe applies — keeps `kind:foo` and similar shapes from hitting
  // the manifest lookup.
  const trimmed = symbol.trim();
  if (!/^[\p{L}_$][\p{L}\p{N}_$]*$/u.test(trimmed)) return null;
  const rows = lookupNestedFnsByName(cg.queries, trimmed, MAX_MANIFEST_DEEP_VIEW_ROWS);
  if (rows.length === 0) return null;

  // F#12 slice 3 fast path — primary row already promoted. The
  // promoted Node row in `nodes` is the authoritative source; render
  // through the standard pipeline so the agent sees the same surface
  // they'd get from a non-manifest symbol. No hit-count bump on this
  // path — once promoted, the manifest's hit_count is a frozen
  // historical artifact (popularity table still tracks live signal).
  const primary = rows[0]!;
  if (primary.promotedNodeId !== null) {
    const promotedNode = cg.queries.getNodeById(primary.promotedNodeId);
    if (promotedNode) {
      const card = await renderOneNode({
        cg,
        symbol: trimmed,
        match: { node: promotedNode, note: '' },
        includeCode,
        detail,
        flags,
      });
      return `${card}\n\n> ✓ Promoted from F#12 manifest (was a nested fn in \`${primary.parentName ?? '?'}\`).`;
    }
    // Promoted node id pointed at a vanished row (cascade-evict race).
    // Fall through to the manifest-mode render so the user still sees
    // something useful.
  }

  // F#12 slice 3 — bump hit_count + mirror popularity atomically. The
  // post-bump count drives the manifest card's "hit N" annotation;
  // when N crosses `nestedPromotionThreshold` the next sync's
  // `promoteNestedFnHook` materialises a real node and the deep view
  // routes through the fast path above on the subsequent call.
  const newHitCount = bumpNestedFnHitCount(cg.queries, {
    filePath: primary.filePath,
    name: primary.name,
    startLine: primary.startLine,
  });
  return renderManifestRows({ cg, symbol: trimmed, rows, includeCode, detail, hitCount: newHitCount });
}

/** Bundled args for {@link renderManifestRows} — bundles the five-arg
 *  surface into a single object so the renderer's signature stays
 *  under `long_parameter_list`. */
interface RenderManifestRowsArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  rows: ReadonlyArray<NestedFnLookupRow>;
  includeCode: boolean;
  detail: DetailMode;
  /** Post-bump hit count for the primary row — surfaced in the card
   *  header so the agent can see the manifest's tracked popularity
   *  accumulate (slice 3). Pre-bump row count is in `rows[0].hitCount`. */
  hitCount: number;
}

/** Render a set of manifest rows for a single symbol. Picks the first
 *  row as the canonical view; lists the rest as disambiguation footers
 *  when N > 1 (same shape as the multi-match banner pattern used by
 *  `findSymbol`'s disambiguation policies). */
function renderManifestRows(args: RenderManifestRowsArgs): string {
  const { cg, symbol, rows, includeCode, detail, hitCount } = args;
  const primary = rows[0]!;
  const parts: string[] = [];
  parts.push(`## ${symbol} _(manifest, hit ${hitCount})_`);
  const parentLine = primary.parentName ? `inside \`${primary.parentName}\`` : 'inside (unknown parent)';
  parts.push(`\`function\` — ${parentLine}  \n${primary.filePath}:${primary.startLine}`);
  if (primary.signature) parts.push(`\`\`\`\n${primary.signature}\n\`\`\``);

  if (includeCode) {
    const body = readManifestBodyOrNull(cg.projectRoot, primary);
    if (body !== null) {
      const lang = inferFenceLanguage(primary.filePath);
      const { code, truncated, total } =
        detail === 'full' ? { code: body, truncated: false, total: body.split('\n').length } : previewCode(body);
      parts.push(`\`\`\`${lang}\n${code}\n\`\`\``);
      if (truncated) {
        parts.push(
          `> Showing first ${PREVIEW_LINE_LIMIT} of ${total} lines. ` +
            `Pass \`detail: 'full'\` for the complete body.`,
        );
      }
    } else {
      parts.push(`_(body unavailable — could not read \`${primary.filePath}\`)_`);
    }
  }

  if (rows.length > 1) {
    const extras = rows
      .slice(1)
      .map((r) => `- ${r.filePath}:${r.startLine} (inside \`${r.parentName ?? '?'}\`)`)
      .join('\n');
    parts.push(`> ${rows.length - 1} other manifest hit${rows.length === 1 ? '' : 's'}:\n${extras}`);
  }

  parts.push(
    `> Manifest-mode symbol: this nested function lives in a mega-file ` +
      `(body > \`largeFunctionThreshold\`, default 500 LOC) and is NOT a ` +
      `first-class graph node. Cross-file callers / callees can't be ` +
      `resolved for it — fall back to \`cartograph_find by:'content'\` for ` +
      `regex-anchored discovery.`,
  );

  return parts.join('\n\n');
}

/** Default cap on manifest-hit rendering — five disambiguation footers
 *  is the upper bound before the agent should re-query with a file
 *  hint. */
const MAX_MANIFEST_DEEP_VIEW_ROWS = 5;

/** Slice the function body out of the file on disk using the manifest
 *  row's 1-indexed start/end lines. Returns null on read failure. */
function readManifestBodyOrNull(projectRoot: string, row: NestedFnLookupRow): string | null {
  try {
    const abs = path.isAbsolute(row.filePath) ? row.filePath : path.join(projectRoot, row.filePath);
    const lines = fs.readFileSync(abs, 'utf8').split('\n');
    return lines.slice(row.startLine - 1, row.endLine).join('\n');
  } catch {
    return null;
  }
}

/** Map a file extension to the fenced-block language tag. Covers the
 *  JS-family extensions slice-1 already supports plus the common
 *  declaration shapes. Unknown extensions render as a plain fence. */
function inferFenceLanguage(filePath: string): string {
  const ext = path.extname(filePath).slice(1).toLowerCase();
  switch (ext) {
    case 'ts':
    case 'tsx':
    case 'mts':
    case 'cts':
      return ext;
    case 'js':
    case 'jsx':
    case 'mjs':
    case 'cjs':
      return ext;
    default:
      return '';
  }
}

/**
 * Process a single symbol request. Returns a ToolOutcome (either success or error).
 * Preserves the legacy "no separator, no header" output for backward compatibility.
 */
async function processSingleSymbol(args: ProcessSymbolArgs & { symbol: string }): Promise<ToolOutcome> {
  const { ctx, cg, symbol, includeCode, detail, flags, deep } = args;
  const match = findSymbol(cg, symbol, ctx.refIds);
  if (!match) {
    // A `n_` UID the current process can't resolve is a cache miss,
    // not a genuine absence — emit a UID-specific message without the
    // misleading "true negative" freshness footer (audit-4 #1).
    if (isUnresolvedUid(symbol, ctx.refIds)) {
      return err(staleUidMessage(symbol));
    }
    // F#12 slice 2/3: with `deep:true` the agent opts in to the
    // manifest fallback. Renders an ad-hoc deep view for un-promoted
    // rows (bumping the hit_count + popularity mirror), or routes
    // through `renderOneNode` for rows whose threshold-crossed
    // `promoted_node_id` already materialised a real graph node.
    // Without `deep` the standard "not found" message wins so the
    // default surface stays unchanged.
    if (deep) {
      const manifest = await tryRenderManifestDeepView({ cg, symbol, includeCode, detail, flags });
      if (manifest !== null) return ok(textResult(manifest));
    }
    return ok(textResult(symbolNotFound(cg, symbol)));
  }
  const rendered = await renderOneNode({ cg, symbol, match, includeCode, detail, flags });
  // The per-result stale-files note routes through the chokepoint's
  // `freshness` slot — it truncates the card body first, then appends
  // the note, so a long body can't push the stale warning off-budget.
  return ok(
    renderToolResponse({
      body: rendered,
      freshness: { cg, nodes: [match.node] },
    }),
  );
}

/**
 * Build the call-scoped freshness footer for a batched response.
 *
 * Empty string when nothing missed. Otherwise the
 * `freshnessHintForEmptyResult` text is re-wrapped under a `---` rule
 * and a bold "Batch note" lead-in so an agent reads it as a note about
 * the WHOLE call, not as an explanation appended to the last (not-found)
 * card. Without the rule + lead-in the `> ⚠ Uncommitted changes…`
 * banner renders flush under the final "Did you mean" block and looks
 * like it explains why that one symbol missed (friction #15).
 */
function buildBatchFreshnessFooter(cg: Cartograph, notFound: number): string {
  if (notFound === 0) return '';
  // `freshnessHintForEmptyResult` prefixes its line with `\n\n` — strip it
  // so the rule + lead-in control the spacing instead.
  const hint = freshnessHintForEmptyResult(cg).replace(/^\n+/, '');
  if (hint === '') return '';
  return `\n\n---\n\n**Batch note** (applies to the whole call, not just the last symbol):\n\n${hint}`;
}

/**
 * Process a multi-symbol request. Returns a ToolOutcome with all cards rendered
 * and merged, deduplicated by node ID, with a header summarizing the results.
 */
async function processMultipleSymbols(args: ProcessSymbolArgs & { symbolList: string[] }): Promise<ToolOutcome> {
  const { ctx, cg, symbolList, includeCode, detail, flags, deep } = args;
  const seenIds = new Set<string>();
  const nodesShown: Node[] = [];
  const cards: string[] = [];
  let notFound = 0;
  for (const symbol of symbolList) {
    const match = findSymbol(cg, symbol, ctx.refIds);
    if (!match) {
      // F#12 slice 2/3: per-symbol manifest fallback under `deep:true`.
      // A manifest hit counts as a "found" symbol for the batch (no
      // increment of `notFound`); the card joins the batch under the
      // same `---` separator as graph-node cards. Slice 3 also bumps
      // hit_count + popularity inside `tryRenderManifestDeepView`.
      if (deep && !isUnresolvedUid(symbol, ctx.refIds)) {
        const manifest = await tryRenderManifestDeepView({ cg, symbol, includeCode, detail, flags });
        if (manifest !== null) {
          cards.push(manifest);
          continue;
        }
      }
      // Stale / cross-process UID — a cache miss, not a real absence
      // (audit-4 #1). Render a UID-specific card line; the batch
      // freshness footer's "true negative" claim still applies to any
      // genuine name miss in the batch, so it is left untouched.
      const missMsg = isUnresolvedUid(symbol, ctx.refIds) ? staleUidMessage(symbol) : notFoundMessage(cg, symbol);
      cards.push(`## ${symbol}\n\n_${missMsg}_`);
      notFound++;
      continue;
    }
    // Dedup: when two input names resolve to the same node (e.g.
    // qualified + unqualified spelling), render the card once.
    if (seenIds.has(match.node.id)) continue;
    seenIds.add(match.node.id);
    nodesShown.push(match.node);
    cards.push(await renderOneNode({ cg, symbol, match, includeCode, detail, flags }));
  }

  const dedupCount = symbolList.length - notFound - seenIds.size;
  const header = buildMultiSymbolHeader(nodesShown.length, notFound, dedupCount);
  const body = cards.join('\n\n---\n\n');
  // One freshness hint for the whole batch when anything missed —
  // per-card it would be noise; the single-symbol path gets it via
  // `symbolNotFound`. The hint is wrapped under a `---` rule + an
  // explicit "Batch note" lead-in so it doesn't read as an explanation
  // for the LAST card (which is itself a not-found block) — the hint is
  // call-scoped, not symbol-scoped (friction #15, audit group 1 #4).
  // `buildBatchFreshnessFooter` returns text already prefixed with its
  // own `\n\n---`, so it folds straight into the chokepoint's footer
  // slot, which truncates the cards first, then appends footer +
  // freshness in that fixed order.
  const freshnessNote = buildBatchFreshnessFooter(cg, notFound);
  return ok(
    renderToolResponse({
      body: `${header}\n\n${body}`,
      footers: [freshnessNote],
      freshness: { cg, nodes: nodesShown },
    }),
  );
}

/** Concatenate any active inline-expansion sections under a single
 *  "Inline expansions" heading. Header is omitted when no flag fires. */
function renderInlineExpansions(cg: Cartograph, node: Node, flags: IncludeFlags): string {
  if (!anyIncludeFlag(flags)) return '';
  const sections: string[] = [];
  if (flags.callers) sections.push(renderCallersSection(cg, node));
  if (flags.callees) sections.push(renderCalleesSection(cg, node));
  if (flags.biomarkers) sections.push(renderBiomarkersSection(cg, node));
  if (flags.tests) sections.push(renderTestsSection(cg, node));
  return '\n\n' + sections.join('\n\n');
}

interface RenderOneNodeArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  symbol: string;
  match: NonNullable<ReturnType<typeof findSymbol>>;
  includeCode: boolean;
  detail: DetailMode;
  flags: IncludeFlags;
}

/** Build the markdown card for one resolved match — header + details
 *  + optional code body + optional inline expansions + match note +
 *  code-omitted note. Pure renderer; the caller handles dedup, stale
 *  appendix, and final truncation. */
async function renderOneNode(args: RenderOneNodeArgs): Promise<string> {
  const { cg, match, includeCode, detail, flags } = args;
  let code: string | null = null;
  let staleWarning: string | null = null;
  if (includeCode) {
    const fetched = await fetchNodeCode(cg, match.node.id, match.node.filePath);
    code = fetched.code;
    staleWarning = fetched.staleWarning;
  }
  const issues = getIssuesForNode(cg.queries, match.node.id);
  const testAssertions = fetchTestAssertionsForFile(cg, match.node);
  const card = formatNodeDetails({
    node: match.node,
    code,
    detail,
    staleWarning,
    issues,
    testAssertions,
    showBetweenness: flags.betweenness,
  });

  // For file-kind nodes, append the cached LLM file summary when one
  // exists. File nodes store the file path in `filePath` — the same
  // column (`file_path`) used as the FK in `file_summaries`.
  // When no summary is cached yet, render nothing (no noisy placeholder).
  let fileSummaryBlock = '';
  if (match.node.kind === 'file') {
    const fileSummaryRow = getFileSummary(cg.queries, match.node.filePath);
    if (fileSummaryRow) {
      fileSummaryBlock = `\n\n**Summary:** ${fileSummaryRow.summary}`;
    }
  }

  const expansions = renderInlineExpansions(cg, match.node, flags);
  // Banner-at-top convention (structural fix #30): the disambiguation
  // note is the headline an agent reads BEFORE acting on the symbol
  // card. Pre-#30 this was appended after the body where it was easy
  // to scroll past.
  return withDisambiguationBanner(match.note, card + fileSummaryBlock + expansions);
}

/**
 * Zod schema for `cartograph_node`.
 *
 * `symbols` is `.array(z.string()).max(20)` — a list over the
 * {@link MAX_SYMBOLS} cap is REJECTED at the dispatch boundary, so the
 * old in-handler cap check in `parseSymbolList` is gone. `symbol` and
 * `symbols` are both `.optional()`; their mutual exclusion is a
 * cross-field rule `parseSymbolList` still owns.
 *
 * `detail` is `z.enum(['preview', 'full'])` so an unknown value is
 * rejected rather than silently falling back to `preview`.
 */
const nodeSchema = z.object({
  symbol: z
    .string()
    .optional()
    .describe(
      'Name of the symbol to get details for, or a short `n_xxxxxxxx` UID from a prior result. ' +
        'Mutually exclusive with `symbols`.',
    ),
  symbols: batchedSymbols
    .optional()
    .describe(
      `Multi-symbol form (mutually exclusive with \`symbol\`). Up to ${MAX_SYMBOLS} names or \`n_xxxxxxxx\` UIDs; ` +
        'duplicates resolving to the same node are merged.',
    ),
  code: z
    .boolean()
    .default(false)
    .describe('Include source body (default: false). Use `detail` to control how a long body is rendered.'),
  detail: z
    .enum(['preview', 'full'])
    .default('preview')
    .describe(
      'Source-body rendering when `code: true`. ' +
        '`preview` (default): full body when ≤' +
        PREVIEW_LINE_THRESHOLD +
        ' lines, else first ' +
        PREVIEW_LINE_LIMIT +
        ' lines + tail marker. `full`: complete body verbatim.',
    ),
  includeCallers: z
    .boolean()
    .default(false)
    .describe(`Inline up to ${MAX_INLINE_CALLERS} top callers under each symbol. Default: false.`),
  includeCallees: z
    .boolean()
    .default(false)
    .describe(`Inline up to ${MAX_INLINE_CALLEES} top callees under each symbol. Default: false.`),
  includeBiomarkers: z
    .boolean()
    .default(false)
    .describe(`Inline Code Health score + top ${MAX_INLINE_FINDINGS} findings. Default: false.`),
  includeTests: z
    .boolean()
    .default(false)
    .describe(`Inline up to ${MAX_INLINE_TEST_FILES} direct test-file importers (one-hop only). Default: false.`),
  includeBetweenness: z
    .boolean()
    .default(false)
    .describe(
      "Surface sampled Brandes betweenness as a 'Structural bridge' header row — flags nodes on the only path between subsystems (refactor-impact warning). Requires `enableBetweenness: true` in config; suppressed when the column is NULL. Default: false.",
    ),
  deep: z
    .boolean()
    .default(false)
    .describe(
      'When the symbol is not found as a graph node, render an ad-hoc deep view (source slice + parent header) for ' +
        'nested functions inside mega-files (body > `largeFunctionThreshold`, default 500 LOC). Default: false.',
    ),
  projectPath: projectPathField,
});

type NodeArgs = z.infer<typeof nodeSchema>;

async function handleNode(ctx: ToolCtx, args: NodeArgs): Promise<ToolOutcome> {
  const symbolList = parseSymbolList(args);
  if (!Array.isArray(symbolList)) return symbolList;

  const cg = ctx.getCartograph(args.projectPath);
  const includeCode = args.code;
  const detail: DetailMode = args.detail;
  const flags = parseIncludeFlags(args);
  const deep = args.deep === true;

  // Single-symbol path — preserves the legacy "no separator, no
  // header" output exactly so existing tests / consumers see no
  // change. Multi-symbol path renders one card per resolved node
  // separated by horizontal rules.
  const sharedArgs = { ctx, cg, includeCode, detail, flags, deep };
  if (symbolList.length === 1) {
    return processSingleSymbol({ ...sharedArgs, symbol: symbolList[0]! });
  }

  return processMultipleSymbols({ ...sharedArgs, symbolList });
}

export const NODE_TOOL = defineTool({
  name: 'cartograph_node',
  description:
    'Symbol details — name, signature, docstring, summary, location, line count.\n\n' +
    'Batched: `symbols: [...]` up to ' +
    MAX_SYMBOLS +
    ". `code: true` adds body (`detail: 'preview'` truncates long bodies; `'full'` is verbatim). " +
    '`includeCallers`/`includeCallees`/`includeBiomarkers`/`includeTests` fold neighbor data in. ' +
    "A `kind:'file'` node renders that file's cached LLM summary.",
  schema: nodeSchema,
  handle: handleNode,
});
