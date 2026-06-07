/**
 * `cartograph_tests_for({symbol|files})` — find test files that
 * exercise a given source symbol OR a set of changed files. Backlog
 * #9 (symbol mode) + merge of the former `cartograph_affected` tool
 * (files mode, this session).
 *
 * Two input shapes — exactly ONE must be supplied:
 *
 *  - `symbol: string` — resolves to a node, finds files importing it
 *    (direct + one transitive hop) plus test files linked by a direct
 *    `calls`/`references` edge to the symbol. For each surviving test file,
 *    lists test-shaped symbols inside (functions named `test*` /
 *    `it_*` / `*Test` / similar) so the agent can jump to a specific
 *    test. When the symbol is a NON-EXPORTED helper with no incoming
 *    edge of its own, a same-file fallback surfaces tests that cover
 *    ANY symbol defined in the helper's file (lower confidence — the
 *    tests provably cover the FILE, not provably the symbol). Output:
 *    markdown grouped by Direct vs Transitive importers (plus the
 *    same-file bucket when the primary passes are empty).
 *
 *  - `files: string[]` — BFS the dependency graph from each file,
 *    returning every test file that transitively imports any of
 *    them (depth-bounded). Optional `filter` glob narrows what
 *    counts as a "test file" (default: `is_test` flag from the
 *    files table). Output: flat markdown list of affected tests.
 *
 * Both shapes converge on "what tests should I run for X?" — the
 * difference is just the input granularity (one symbol vs a file
 * set). Same downstream logic (walk imports backwards, filter to
 * test files); kept in one tool because the mode is just the input.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getAllFiles, getFileByPath } from '../../db/queries-files.js';
import type Cartograph from '../../index.js';
import type { Node } from '../../types.js';
import { escapeRegExp } from '../../utils.js';
import {
  DEFAULT_FILES_MODE_DEPTH,
  MAX_FILES_MODE_DEPTH,
  TESTS_FOR_NO_RESULTS_NOTE,
  buildTestRow,
  buildTestsForBucketSpec,
  buildTestsForDescribeNameExplainer,
  buildTestsForDescribeNameSpec,
  buildTestsForDispatchSpec,
  buildTestsForSameFileExplainer,
  collectSymbolTestDescriptions,
  runTestsForFilesMode,
  scopeRowsToSymbol,
  type TestRow,
} from '../../features/tests-for/index.js';
export {
  TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX,
  TESTS_FOR_NO_RESULTS_NOTE,
  TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX,
  buildTestsForBucketSpec,
  buildTestsForDescribeNameExplainer,
  buildTestsForDescribeNameSpec,
  buildTestsForDispatchSpec,
  buildTestsForSameFileExplainer,
} from '../../features/tests-for/index.js';
export type { TestsForBucketKind } from '../../features/tests-for/index.js';
import { fileNodeIdFor, textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownBulletList } from './_result-spec.js';
import { findSymbol, notFoundMessage, withDisambiguationBanner } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/**
 * Zod schema for `cartograph_tests_for`.
 *
 * `symbol` and `files` are both `.optional()` — exactly one must be
 * supplied, enforced in {@link handleTestsFor} (the discriminator is
 * the input shape, not a schema-level required). `depth` is
 * `.int().min(1).max(50)`: an out-of-range value is REJECTED at the
 * dispatch boundary (locked reject-out-of-range decision), so the old
 * `clamp(numArg(...), 1, 50)` is gone.
 */
const testsForSchema = z.object({
  symbol: z
    .string()
    .optional()
    .describe('(symbol mode) Source symbol name to find tests for. Mutually exclusive with `files`.'),
  files: z
    .array(z.string())
    .optional()
    .describe('(files mode) Project-relative changed-file paths to trace. Mutually exclusive with `symbol`.'),
  depth: z
    .number()
    .int()
    .min(1)
    .max(MAX_FILES_MODE_DEPTH)
    .default(DEFAULT_FILES_MODE_DEPTH)
    .describe('(files mode) Max dependency-traversal depth (default 5).'),
  filter: z
    .string()
    .optional()
    .describe('(files mode) Glob for which paths count as test files. Default: the `is_test` flag.'),
  projectPath: projectPathField,
});

type TestsForArgs = z.infer<typeof testsForSchema>;

/** Cap on test files surfaced via MCP dispatch search to avoid overwhelming the agent. */
const MAX_MCP_DISPATCH_TESTS = 10;

/** Cap on test files surfaced via describe-name FTS match. */
const MAX_DESCRIBE_NAME_TESTS = 10;

/**
 * Minimum length (4 chars) for the describe-name fallback identifier.
 * Names shorter than 4 chars (`it`, `get`, `set`, `is`) are too common
 * as English words and produce mostly noise. The threshold is paired
 * with a mixed-case / digit / underscore check (see
 * {@link looksLikeProgrammaticIdentifier}).
 */
const DESCRIBE_NAME_MIN_LENGTH = 4;

/**
 * Identifier looks programmatic enough (mixed-case, digit, or underscore)
 * that matching it as a word in a test description is high-signal.
 * Plain lowercase short words like `getall` or `delete` would still slip
 * through this gate, so the call site also requires
 * {@link DESCRIBE_NAME_MIN_LENGTH}.
 */
function looksLikeProgrammaticIdentifier(name: string): boolean {
  if (name.length < DESCRIBE_NAME_MIN_LENGTH) return false;
  // Mixed-case (any uppercase letter): camelCase or PascalCase.
  if (/[A-Z]/.test(name) && /[a-z]/.test(name)) return true;
  // Contains a digit or underscore: snake_case or contains a number.
  if (/[0-9_]/.test(name)) return true;
  return false;
}

/**
 * If the given node is the `handle` function of a ToolModule literal
 * (i.e. appears as `handle: <nodeName>` in an object exported as a
 * ToolModule), returns the MCP tool name (e.g. `'cartograph_history'`).
 * Returns `null` when the node is not a ToolModule handle.
 *
 * Detection strategy: read the source file's raw text and scan for an
 * object literal that contains both `handle: <nodeName>` and a
 * `name: '<toolName>'` string under a `definition` key. This covers
 * the canonical pattern `{ definition: { name: 'cartograph_X' }, handle: handleX }`.
 */
function findMcpToolNameForHandle(node: Node, projectRoot: string): string | null {
  const { filePath, name: fnName } = node;
  let src: string;
  try {
    // filePath is stored relative to the project root; resolve it there.
    const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return null;
  }

  // Match `handle: <fnName>` (the function is assigned as the handle field).
  // The function name must appear as a standalone identifier — escape it
  // and bound the trailing edge with an identifier-char lookahead (a `\b`
  // mis-fires when `fnName` ends in `$`).
  const handlePattern = new RegExp(String.raw`\bhandle\s*:\s*${escapeRegExp(fnName)}(?![\w$])`);
  if (!handlePattern.test(src)) return null;

  // Extract the MCP tool name from `name: 'cartograph_X'` or `name: "cartograph_X"`.
  // This is a best-effort regex scan; the pattern covers the canonical
  // ToolModule shape used throughout src/mcp/tools/*.ts.
  const namePattern = /\bname\s*:\s*['"](\bcartograph_[^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = namePattern.exec(src)) !== null) {
    if (m[1]) return m[1];
  }
  return null;
}

/**
 * Grep all test-flagged files in the index for a string-literal
 * occurrence of the MCP tool name (e.g. `'cartograph_history'` or
 * `"cartograph_history"`). Returns at most {@link MAX_MCP_DISPATCH_TESTS}
 * results.
 *
 * We look for the tool name surrounded by quotes to avoid false
 * positives from comments or partial name matches (e.g. a variable
 * `toolName` that happens to contain the substring).
 */
function findDispatchTestFiles(cg: Cartograph, toolName: string): string[] {
  const projectRoot = cg.projectRoot;
  const pattern = new RegExp(`['"]${escapeRegExp(toolName)}['"]`);
  const found: string[] = [];

  for (const file of getAllFiles(cg.queries)) {
    if (!file.isTest) continue;
    if (found.length >= MAX_MCP_DISPATCH_TESTS) break;

    const absPath = path.isAbsolute(file.path) ? file.path : path.join(projectRoot, file.path);
    let src: string;
    try {
      src = fs.readFileSync(absPath, 'utf8');
    } catch {
      continue;
    }
    if (pattern.test(src)) {
      found.push(file.path);
    }
  }
  return found;
}

/**
 * Escape a raw identifier for use as an FTS5 phrase query. Wraps in
 * double-quotes and doubles any embedded double-quotes so that FTS5
 * operators / punctuation inside the identifier can't break the
 * MATCH expression. Mirrors the helper in `queries-summaries.ts`.
 */
function escapeFts5Phrase(raw: string): string {
  return '"' + raw.replaceAll('"', '""') + '"';
}

/**
 * Search the mined `it/test/describe(...)` corpus for test files whose
 * description contains `identifier` as a tokenized word. Used as a
 * third-tier fallback when the symbol has no static `imports` edges
 * from any test file (direct OR one transitive hop). Catches class-
 * instance dispatch: `describe('getChangedFiles()', () => { ...
 * orchestrator.getChangedFiles() })` — the test never imports the
 * method, but the describe title names it.
 *
 * Returns at most {@link MAX_DESCRIBE_NAME_TESTS} test file paths,
 * excluding any already in `seen` (so this bucket doesn't repeat
 * files already surfaced by static-imports or MCP-dispatch passes).
 *
 * Empty result on:
 *  - identifier shorter than {@link DESCRIBE_NAME_MIN_LENGTH} chars
 *  - identifier looks like a plain English word (lowercase, no
 *    digit / underscore — see {@link looksLikeProgrammaticIdentifier})
 *  - `test_names_fts` table missing (pre-039 schema) — caller falls
 *    through to the existing empty-state message.
 */
function findDescribeNameMatchTests(cg: Cartograph, identifier: string, seen: ReadonlySet<string>): string[] {
  if (!looksLikeProgrammaticIdentifier(identifier)) return [];
  try {
    const rows = cg.db
      .getDb()
      .prepare(
        `SELECT DISTINCT tn.file_path
           FROM test_names_fts
           JOIN test_names tn ON tn.id = test_names_fts.rowid
           JOIN files f ON f.path = tn.file_path
          WHERE test_names_fts MATCH ?
            AND f.is_test = 1
          ORDER BY bm25(test_names_fts)
          LIMIT ?`,
      )
      .all(escapeFts5Phrase(identifier), MAX_DESCRIBE_NAME_TESTS * 4) as Array<{ file_path: string }>;
    const out: string[] = [];
    for (const r of rows) {
      if (seen.has(r.file_path)) continue;
      out.push(r.file_path);
      if (out.length >= MAX_DESCRIBE_NAME_TESTS) break;
    }
    return out;
  } catch {
    // FTS5 table missing or MATCH parse error — fail silent; the
    // empty-state hint downstream still renders.
    return [];
  }
}

async function handleTestsFor(ctx: ToolCtx, args: TestsForArgs): Promise<ToolOutcome> {
  // Discriminator: `symbol` vs `files`. Exactly one required —
  // both-set is ambiguous (different downstream logic), neither-set
  // is an error worth surfacing rather than silently returning empty.
  const hasSymbol = typeof args.symbol === 'string' && args.symbol.length > 0;
  const hasFiles = Array.isArray(args.files) && args.files.length > 0;
  if (hasSymbol && hasFiles) {
    return err('Pass either `symbol` (single source symbol) or `files` (changed-file array), not both.');
  }
  if (!hasSymbol && !hasFiles) {
    return err(
      'Missing input — pass `symbol: string` (find tests for one symbol) or `files: string[]` (find tests affected by changed files).',
    );
  }
  if (hasFiles) return handleFilesMode(ctx, args);
  return handleSymbolMode(ctx, args);
}

/**
 * @internal Partition the direct importers of a symbol into test rows and
 * non-test intermediate files. Mutates `seen` to track visited paths.
 */
interface PartitionedImporters {
  directTests: TestRow[];
  indirectImporters: string[];
}

function partitionDirectImporters(
  cg: Cartograph,
  importerFiles: readonly string[],
  seen: Set<string>,
): PartitionedImporters {
  const directTests: TestRow[] = [];
  const indirectImporters: string[] = [];
  for (const importerFile of importerFiles) {
    if (seen.has(importerFile)) continue;
    seen.add(importerFile);
    const file = getFileByPath(cg.queries, importerFile);
    if (!file) continue;
    if (file.isTest) directTests.push(buildTestRow(cg, importerFile, 1));
    else indirectImporters.push(importerFile);
  }
  return { directTests, indirectImporters };
}

/** @internal Walk one transitive hop from each indirect importer and collect test rows. */
function collectTransitiveTests(cg: Cartograph, indirectImporters: readonly string[], seen: Set<string>): TestRow[] {
  const out: TestRow[] = [];
  for (const intermediate of indirectImporters) {
    pushTransitiveTestImporters({ cg, intermediate, seen, out });
  }
  return out;
}

async function handleSymbolMode(ctx: ToolCtx, args: TestsForArgs): Promise<ToolOutcome> {
  // `handleTestsFor` only routes here when `symbol` is a non-empty string.
  const symbol = args.symbol!;
  const cg = ctx.getCartograph(args.projectPath);

  const match = findSymbol(cg, symbol, ctx.refIds);
  if (!match) return ok(textResult(notFoundMessage(cg, symbol)));

  const sourceFile = match.node.filePath;
  const seen = new Set<string>([sourceFile]);
  const targetIds = [match.node.id, fileNodeIdFor(cg, sourceFile)].filter((x): x is string => !!x);
  const directImporters = collectImporters(cg, targetIds);
  const { directTests, indirectImporters } = partitionDirectImporters(cg, directImporters, seen);

  // FRICTION-4 fix: also surface test files that have `calls` or `references`
  // edges directly to the symbol (without an `imports` edge landing on the
  // symbol node). These are tests that named-import the symbol — the import
  // statement is indexed as a `references` edge on the symbol, and the actual
  // call as a `calls` edge, but neither is an `imports` edge on the node id,
  // so the `collectImporters` walk above misses them entirely.
  const directCallTests = collectDirectTestCallers(cg, targetIds, seen);

  // One transitive hop: tests that import a non-test file that imports our symbol.
  const transitiveTests = collectTransitiveTests(cg, indirectImporters, seen);

  // MCP-dispatch pass: if the queried function is the `handle` field of
  // a ToolModule, surface test files that exercise it via the reflective
  // `handler.execute('cartograph_X', ...)` call path.
  const mcpToolName = findMcpToolNameForHandle(match.node, cg.projectRoot);
  const dispatchTests = mcpToolName ? findDispatchTestFiles(cg, mcpToolName) : [];

  // Merge calls/references-discovered test files into the direct bucket.
  // They have equal confidence to import-discovered ones — both have a
  // static edge from the test file to the symbol.
  const allDirectTests = [...directTests, ...directCallTests];

  const primaryPassesEmpty = allDirectTests.length === 0 && transitiveTests.length === 0 && dispatchTests.length === 0;

  // FRICTION-4 same-file fallback: only when the primary passes are
  // empty. For a NON-EXPORTED helper the symbol node has no incoming
  // edge and the file node's `imports` edge is keyed to the file, not
  // the helper — so the primary passes whiff even when the file is
  // directly tested via an exported sibling. This pass surfaces tests
  // that cover ANY same-file node, clearly labelled as lower confidence.
  const sameFileTests = primaryPassesEmpty ? collectSameFileTests(cg, sourceFile, seen) : [];

  // Describe-name fallback: only when nothing else turned up. The
  // mined `it/test/describe(...)` corpus often contains the method name
  // verbatim ("describe('getChangedFiles()', ...)") for tests that
  // exercise the symbol through a class-instance dispatch — no static
  // `imports` edge from the test to the method exists. Gated by an
  // identifier-shape heuristic to avoid noise on short / common-word
  // names like `it`, `get`, `set`.
  const describeNameTests =
    primaryPassesEmpty && sameFileTests.length === 0 ? findDescribeNameMatchTests(cg, match.node.name, seen) : [];

  // Scope each direct/transitive row's `it/describe` descriptions to the
  // blocks that actually exercise the queried symbol — otherwise a test
  // file covering many symbols lists unrelated blocks under "Tests
  // covering <symbol>". sameFileTests stays file-wide on purpose: that
  // bucket is explicitly "covers the file, not provably the symbol".
  const scopedDescriptions = collectSymbolTestDescriptions(cg, match.node.id, match.node.name);
  // Banner-at-top convention (structural fix #30): the disambiguation
  // note belongs ABOVE the report body, not in the freshness footer
  // — an agent reading "which tests cover symbol X" needs to know up
  // front when X resolved to one of N homonyms (the wrong-test-suite
  // pick is the bug class). Pre-#30 the note went into
  // `freshness.text` where it could be visually disconnected from the
  // result on a wide test-file list.
  const reportBody = formatReport({
    symbol,
    node: match.node,
    direct: scopeRowsToSymbol(allDirectTests, scopedDescriptions),
    transitive: scopeRowsToSymbol(transitiveTests, scopedDescriptions),
    sameFileTests,
    mcpToolName,
    dispatchTests,
    describeNameTests,
  });
  return ok(
    renderToolResponse({
      body: withDisambiguationBanner(match.note, reportBody),
    }),
  );
}

/** One-hop walk from an indirect importer back to the test files
 *  that import IT. Pushed rows have `hops=2` to distinguish from the
 *  direct-importer case. Skips already-`seen` files so the merge
 *  doesn't double-count. Pulled out so handleSymbolMode's transitive
 *  block stays at depth 3 instead of 5. */
interface PushTransitiveTestImportersArgs {
  cg: Cartograph;
  intermediate: string;
  seen: Set<string>;
  out: TestRow[];
}

function pushTransitiveTestImporters(args: PushTransitiveTestImportersArgs): void {
  const { cg, intermediate, seen, out } = args;
  const intermediateFileNodeId = fileNodeIdFor(cg, intermediate);
  if (!intermediateFileNodeId) return;
  for (const importerFile of collectImporters(cg, [intermediateFileNodeId])) {
    if (seen.has(importerFile)) continue;
    seen.add(importerFile);
    const file = getFileByPath(cg.queries, importerFile);
    if (!file?.isTest) continue;
    out.push(buildTestRow(cg, importerFile, 2));
  }
}

/**
 * Collect distinct importing-file paths from incoming `imports`
 * edges on any of `targetIds`. Edges in this codebase land with
 * source = the importing scope (file or module-level symbol);
 * we resolve back to the file via the source node's filePath.
 */
function collectImporters(cg: Cartograph, targetIds: readonly string[]): string[] {
  const importers = new Set<string>();
  for (const tid of targetIds) {
    for (const edge of getIncomingEdges(cg.queries, tid, ['imports'])) {
      const source = cg.queries.getNodeById(edge.source);
      if (source?.filePath) importers.add(source.filePath);
    }
  }
  return [...importers];
}

/**
 * Collect test-file paths that have direct `calls` or `references`
 * edges to any of `targetIds` but are NOT already surfaced via the
 * `imports` walk in {@link collectImporters}. Covers the common
 * pattern where a named import is indexed as a `references` edge
 * (L23 `import { classifyFreshness }`) and the actual call site as a
 * `calls` edge (L74 `classifyFreshness(...)`), with no `imports` edge
 * landing on the symbol node directly — leaving the test invisible to
 * the `imports`-only walk.
 *
 * Only returns paths where `files.is_test = 1` so non-test callers
 * (production code that also calls the symbol) don't pollute the list.
 * Mutates `seen` to record the newly-found paths.
 */
function collectDirectTestCallers(cg: Cartograph, targetIds: readonly string[], seen: Set<string>): TestRow[] {
  const out: TestRow[] = [];
  for (const tid of targetIds) {
    for (const edge of getIncomingEdges(cg.queries, tid, ['calls', 'references'])) {
      const source = cg.queries.getNodeById(edge.source);
      if (!source?.filePath) continue;
      if (seen.has(source.filePath)) continue;
      const file = getFileByPath(cg.queries, source.filePath);
      if (!file?.isTest) continue;
      seen.add(source.filePath);
      out.push(buildTestRow(cg, source.filePath, 1));
    }
  }
  return out;
}

/**
 * FRICTION-4 same-file fallback. When the direct + transitive + dispatch
 * passes all turn up empty, surface test files that have a `calls` /
 * `references` / `imports` edge to ANY node defined in `sourceFile` — not
 * just the queried symbol. Catches the common case of a NON-EXPORTED
 * helper: a named import (`import { siblingExport } from './file.js'`)
 * lands a `references` edge on the EXPORTED sibling and an `imports` edge
 * on the FILE node, but never on the private helper's node — so the
 * primary `collectImporters`/`collectDirectTestCallers` passes (keyed on
 * the symbol + file node ids) miss it entirely.
 *
 * Confidence is deliberately lower than the Direct bucket: these tests
 * provably exercise the FILE, not provably the queried symbol. Bounded:
 * iterates the file's own node set once and reuses `seen` to dedupe
 * against files already surfaced by the primary passes.
 */
function collectSameFileTests(cg: Cartograph, sourceFile: string, seen: Set<string>): TestRow[] {
  const sameFileIds: string[] = [];
  for (const n of cg.queries.getNodesByFile(sourceFile)) {
    sameFileIds.push(n.id);
  }
  if (sameFileIds.length === 0) return [];
  // `collectDirectTestCallers` mutates `seen` and only keeps `is_test`
  // files; reuse it over the full same-file id set.
  const out = collectDirectTestCallers(cg, sameFileIds, seen);
  // Also fold in pure `imports`-edge test files on the same id set
  // (a test that imports an exported sibling but never calls it).
  for (const importerFile of collectImporters(cg, sameFileIds)) {
    if (seen.has(importerFile)) continue;
    seen.add(importerFile);
    const file = getFileByPath(cg.queries, importerFile);
    if (!file?.isTest) continue;
    out.push(buildTestRow(cg, importerFile, 1));
  }
  return out;
}

interface FormatTestReportArgs {
  symbol: string;
  node: Node;
  direct: readonly TestRow[];
  transitive: readonly TestRow[];
  /** FRICTION-4 same-file fallback: tests covering the symbol's FILE
   *  (not provably the symbol). Populated only when the primary passes
   *  are empty — e.g. for a non-exported helper, but also for an
   *  exported symbol whose callers are all non-test code. */
  sameFileTests?: readonly TestRow[];
  /** MCP tool name when the symbol is a ToolModule `handle` function, else undefined. */
  mcpToolName?: string | null;
  /** Test file paths that exercise this handler via `handler.execute('cartograph_X', ...)`. */
  dispatchTests?: readonly string[];
  /** Test file paths whose mined describe/it title contains the symbol identifier as a word. */
  describeNameTests?: readonly string[];
}

function formatReport(args: FormatTestReportArgs): string {
  const { symbol, node, direct, transitive, sameFileTests, mcpToolName, dispatchTests, describeNameTests } = args;
  const lineSuffix = node.startLine ? `:${node.startLine}` : '';
  const lines: string[] = [`## Tests covering ${symbol} (${node.kind}) — ${node.filePath}${lineSuffix}`, ''];
  const hasStaticTests = direct.length > 0 || transitive.length > 0;
  const hasSameFileTests = sameFileTests != null && sameFileTests.length > 0;
  const hasDispatchTests = dispatchTests != null && dispatchTests.length > 0;
  const hasDescribeNameTests = describeNameTests != null && describeNameTests.length > 0;
  if (!hasStaticTests && !hasSameFileTests && !hasDispatchTests && !hasDescribeNameTests) {
    lines.push(TESTS_FOR_NO_RESULTS_NOTE);
    return lines.join('\n');
  }
  // Primary buckets: direct + transitive importers. Sections render
  // only when they have rows (matching the pre-migration emit-or-skip
  // behavior of `appendBucket`).
  if (direct.length > 0) lines.push(renderMarkdownBulletList(buildTestsForBucketSpec('direct', direct)));
  if (transitive.length > 0) lines.push(renderMarkdownBulletList(buildTestsForBucketSpec('transitive', transitive)));
  if (hasSameFileTests) {
    lines.push(
      renderMarkdownBulletList(buildTestsForBucketSpec('sameFile', sameFileTests)),
      buildTestsForSameFileExplainer(node),
      '',
    );
  }
  if (hasDispatchTests && mcpToolName) {
    lines.push(renderMarkdownBulletList(buildTestsForDispatchSpec(mcpToolName, dispatchTests)));
  }
  if (hasDescribeNameTests) {
    lines.push(
      renderMarkdownBulletList(buildTestsForDescribeNameSpec(describeNameTests)),
      buildTestsForDescribeNameExplainer(node),
    );
  }
  return lines.join('\n');
}

/**
 * Files-mode handler — BFS the dependency graph from each given
 * file, returning test files that transitively import any of them.
 * Folded in from the former `cartograph_affected` tool. Same depth
 * + filter knobs; same "is_test flag OR custom glob" semantics.
 */
async function handleFilesMode(ctx: ToolCtx, args: TestsForArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  // `handleTestsFor` only routes here when `files` is a non-empty array.
  const result = runTestsForFilesMode(cg, {
    files: args.files!,
    depth: args.depth,
    filter: args.filter,
  });
  if (!result.ok) return err(result.message);
  return ok(renderToolResponse({ body: result.body, footers: result.footers }));
}

export const TESTS_FOR_TOOL = defineTool({
  name: 'cartograph_tests_for',
  description:
    'Test discovery — "what tests cover this function/class?". Pass `symbol` (primary) or `files`.\n\n' +
    "Symbol mode walks incoming `imports` from the symbol's file (direct + one transitive hop) AND incoming `calls`/`references` edges to the symbol, filtered to `is_test=1`. " +
    'Files mode BFS-walks dependents to `depth` (needs `is_test` populated). ' +
    'MCP tool-handler symbols also get a dispatch-tests section. ' +
    'Fallbacks when nothing imports/calls the symbol directly: a lower-confidence "Tests covering this file" bucket (file-level, not provably the symbol), then a `describe`-name match over the mined test corpus for methods exercised via instance dispatch. ' +
    'Returns empty for reflectively-invoked code.',
  schema: testsForSchema,
  handle: handleTestsFor,
  requiresFreshIndex: true,
});
