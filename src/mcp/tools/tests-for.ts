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

import * as fs from 'fs';
import * as path from 'path';
import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import { getIncomingEdges } from '../../db/queries-edges.js';
import { getAllFiles, getFileByPath } from '../../db/queries-files.js';
import { getEnclosingTestName } from '../../db/queries-test-names.js';
import type Cartograph from '../../index.js';
import type { Node } from '../../types.js';
import {
  escapeRegExp,
  globToSafeRegex,
  identifierBoundaryRegex,
  isTestPath,
  stripCommentsForRegex,
} from '../../utils.js';
import { detectLanguage } from '../../extraction/grammars.js';
import { callSiteLinesFromEdge } from './_callers.js';
import { fileNodeIdFor, textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import { renderMarkdownBulletList, type MarkdownBulletListSpec } from './_result-spec.js';
import { findSymbol, notFoundMessage, withDisambiguationBanner } from './symbol-resolver.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/** Default + max files-mode dependency-traversal depth. */
const DEFAULT_FILES_MODE_DEPTH = 5;
const MAX_FILES_MODE_DEPTH = 50;

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

/** Cap on test files rendered by files-mode — a barrel-file seed can
 *  fan out to most of the suite; the tail is summarised, not dropped. */
const FILES_MODE_RENDER_CAP = 40;

/**
 * Path basenames treated as public-API barrels. A files-mode traversal
 * that passes through one of these has reached the project's whole
 * public surface — the blast radius is "most of the suite" and a
 * file-level affected-tests answer stops being actionable. Mirrors
 * `BARREL_BASENAMES` in `affected-core.ts` (kept in sync by hand — the
 * set is tiny and stable, and replicating it avoids a cross-module
 * export just for the basename check).
 */
const BARREL_BASENAMES: ReadonlySet<string> = new Set([
  'index.ts',
  'index.js',
  'index.mjs',
  'index.cjs',
  'index.mts',
  'index.cts',
]);

/** True when `filePath` is a public-API barrel (`index.*` re-export hub). */
function isBarrelFile(filePath: string): boolean {
  const slash = filePath.lastIndexOf('/');
  const base = slash >= 0 ? filePath.slice(slash + 1) : filePath;
  return BARREL_BASENAMES.has(base);
}

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
 * Maximum number of test descriptions shown inline per test file.
 * Keeps the output readable without truncating context — a file
 * with more than this many descriptions gets a "…and N more" trailer.
 */
const MAX_TEST_DESCRIPTIONS_SHOWN = 8;

/** Node kinds whose names can plausibly identify a test
 *  function/method. Filters out type defs / imports / etc. */
const TEST_SYMBOL_KINDS: ReadonlySet<string> = new Set(['function', 'method']);

/**
 * Heuristic: does this symbol name look like a test? Loose enough to
 * match the conventions of the major frameworks indexed by cartograph
 * (vitest/jest `it_*` / `test_*` / `describe_*`, Go `TestX`, Python
 * `test_*`, JUnit `*Test`).
 */
function looksLikeTestName(name: string): boolean {
  const lower = name.toLowerCase();
  return (
    lower.startsWith('test') ||
    lower.startsWith('it_') ||
    lower === 'it' ||
    lower.startsWith('describe') ||
    lower.endsWith('test') ||
    lower.endsWith('_test') ||
    lower.endsWith('spec')
  );
}

interface TestRow {
  /** Test-file path, relative to project root. */
  filePath: string;
  /** Test-shaped function/method names found in that file. */
  testSymbols: string[];
  /** Mined `it/test/describe(...)` descriptions for this file (sorted by line). */
  testDescriptions: Array<{ line: number; description: string }>;
  /** Distance from the source symbol's file (1 = direct, 2 = transitive). */
  hops: number;
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
  const handlePattern = new RegExp(`\\bhandle\\s*:\\s*${escapeRegExp(fnName)}(?![\\w$])`);
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
  return '"' + raw.replace(/"/g, '""') + '"';
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
    if (file.isTest) directTests.push(buildRow(cg, importerFile, 1));
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

/**
 * BFS from `seedFile` along file-dependent edges (depth-bounded),
 * adding any test-file leaf to `affected` and any public-API barrel
 * the walk passes through to `barrelsReached`. Returns the count of
 * dependent files visited. Pulled out of handleFilesMode so the per-
 * seed loop stays at depth 1 instead of nesting `for/while/for/if`
 * four levels deep.
 */
interface BfsTestImpactArgs {
  cg: Cartograph;
  seedFile: string;
  maxDepth: number;
  isTest: (filePath: string) => boolean;
  affected: Set<string>;
  /** Accumulator for public-API barrel files the traversal touched. */
  barrelsReached: Set<string>;
}

function bfsTestImpactFromFile(args: BfsTestImpactArgs): number {
  const { cg, seedFile, maxDepth, isTest, affected, barrelsReached } = args;
  let dependentsVisited = 0;
  const queue: Array<{ file: string; depth: number }> = [{ file: seedFile, depth: 0 }];
  const visited = new Set<string>([seedFile]);
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur.depth >= maxDepth) continue;
    for (const dep of cg.internals.graphManager.getFileDependents(cur.file)) {
      if (visited.has(dep)) continue;
      visited.add(dep);
      dependentsVisited++;
      if (isBarrelFile(dep)) barrelsReached.add(dep);
      if (isTest(dep)) affected.add(dep);
      else queue.push({ file: dep, depth: cur.depth + 1 });
    }
  }
  return dependentsVisited;
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
    out.push(buildRow(cg, importerFile, 2));
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
      out.push(buildRow(cg, source.filePath, 1));
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
    out.push(buildRow(cg, importerFile, 1));
  }
  return out;
}

/** Pull test-shaped symbols out of a file via its indexed nodes. */
function buildRow(cg: Cartograph, filePath: string, hops: number): TestRow {
  const symbols: string[] = [];
  for (const n of cg.queries.getNodesByFile(filePath)) {
    if (!TEST_SYMBOL_KINDS.has(n.kind)) continue;
    if (looksLikeTestName(n.name)) symbols.push(n.name);
  }
  const testDescriptions = fetchTestDescriptionsForFile(cg, filePath);
  return { filePath, testSymbols: symbols, testDescriptions, hops };
}

/** Pull mined `it/test/describe(...)` descriptions for a file from
 *  the `test_names` table. Empty array when test-names mining hasn't
 *  populated the file (pre-039 schema or non-TS/JS test file). */
function fetchTestDescriptionsForFile(cg: Cartograph, filePath: string): Array<{ line: number; description: string }> {
  try {
    const rows = cg.db
      .getDb()
      .prepare('SELECT line, description FROM test_names WHERE file_path = ? ORDER BY line LIMIT 50')
      .all(filePath) as Array<{ line: number; description: string }>;
    return rows;
  } catch {
    // Table may not exist on older indexes — fail silent, the symbol
    // bucket still renders.
    return [];
  }
}

/**
 * Source-scan fallback for the symbol-scoped description set.
 *
 * The edge-based pass below relies on `metadata.extraLines` to carry
 * every call site of a symbol within a file. The extractor collapses
 * repeated calls within one scope (e.g. all 15 `findDuplicateCode(...)`
 * calls across a test file's `it` blocks) into a SINGLE `calls` edge
 * anchored at the FIRST site, and does not always populate
 * `extraLines`. When that happens the edge-based pass resolves exactly
 * one enclosing `it` — under-reporting coverage ~16:1 for a test file
 * that exercises the symbol in nearly every block.
 *
 * This pass recovers the true site set by reading the test file and
 * scanning for word-boundary occurrences of the symbol identifier,
 * comment-stripped so doc-comment / commented-out mentions don't
 * count. Each surviving line is resolved to its enclosing
 * `it/describe` descriptor. The import statement that brings the
 * symbol into scope still matches the identifier, but it sits above
 * the first test block so `getEnclosingTestName` returns the
 * top-level `describe` (or null) for it — harmless: the describe is a
 * legitimate covering block, and a null drops out.
 *
 * Returns the set of `(line, description)` enclosing descriptors. Best
 * effort: a read error or a non-TS/JS path yields an empty set and the
 * caller falls back to the edge-based result alone.
 */
function scanSymbolTestDescriptions(cg: Cartograph, filePath: string, symbolName: string): Map<number, string> {
  const found = new Map<number, string>();
  if (!/^[A-Za-z_$][\w$]*$/.test(symbolName)) return found;
  const projectRoot = cg.projectRoot;
  const absPath = path.isAbsolute(filePath) ? filePath : path.join(projectRoot, filePath);
  let src: string;
  try {
    src = fs.readFileSync(absPath, 'utf8');
  } catch {
    return found;
  }
  // Strip comments so a regex scan can't match a doc-comment example
  // or commented-out call. `stripCommentsForRegex` is length- and
  // newline-preserving, so 1-indexed line numbers stay exact. Derive
  // the language from the path so a non-JS/TS test file gets its own
  // comment syntax stripped rather than `//`-style by assumption.
  const stripped = stripCommentsForRegex(src, detectLanguage(filePath));
  // `$`-safe boundary: the guard above admits `$` in identifiers (RxJS
  // `data$` etc.), where a plain `\b…\b` never matches `data$.subscribe()`.
  const identRe = identifierBoundaryRegex(symbolName);
  const lines = stripped.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (!identRe.test(lines[i]!)) continue;
    const test = getEnclosingTestName(cg.queries, { filePath, line: i + 1 });
    if (!test) continue;
    found.set(test.line, test.description);
  }
  return found;
}

/**
 * Symbol mode: map each test file that calls / references the queried
 * symbol to the `it/describe(...)` descriptors that enclose a real use
 * of the symbol — keyed by file path.
 *
 * `fetchTestDescriptionsForFile` dumps EVERY test block in a file, so a
 * test file that exercises many symbols would list blocks unrelated to
 * the queried one under "Tests covering <symbol>". This scopes the
 * descriptions two ways and unions them:
 *
 *  1. Edge-based — `callSiteLinesFromEdge` (the edge's `metadata.extraLines`)
 *     + `getEnclosingTestName`. High confidence but UNDER-counts when the
 *     extractor collapses repeated calls into one edge without `extraLines`.
 *  2. Source-scan — {@link scanSymbolTestDescriptions} reads the test file
 *     and resolves every comment-stripped identifier occurrence to its
 *     enclosing `it`. Recovers the true covering-block count when the edge
 *     metadata is incomplete (the common case for a test file that calls
 *     the symbol in nearly every block).
 *
 * An import-statement `references` edge sits above the first test block,
 * so it resolves to no descriptor (or to the top-level `describe`) and
 * doesn't pollute the per-`it` count.
 */
function collectSymbolTestDescriptions(
  cg: Cartograph,
  symbolNodeId: string,
  symbolName: string,
): Map<string, Array<{ line: number; description: string }>> {
  const perFile = new Map<string, Map<number, string>>();
  for (const edge of getIncomingEdges(cg.queries, symbolNodeId, ['calls', 'references'])) {
    const source = cg.queries.getNodeById(edge.source);
    if (!source?.filePath || !isTestPath(source.filePath)) continue;
    let descs = perFile.get(source.filePath);
    if (!descs) {
      descs = new Map();
      perFile.set(source.filePath, descs);
    }
    for (const line of callSiteLinesFromEdge(edge)) {
      const test = getEnclosingTestName(cg.queries, { filePath: source.filePath, line });
      if (!test) continue;
      descs.set(test.line, test.description);
    }
  }
  // Union in the source-scan pass per file — recovers `it` blocks the
  // edge metadata collapsed away (the extractor anchors all repeated
  // call sites on one edge and may omit `extraLines`).
  for (const [filePath, descs] of perFile) {
    for (const [line, description] of scanSymbolTestDescriptions(cg, filePath, symbolName)) {
      descs.set(line, description);
    }
  }
  const out = new Map<string, Array<{ line: number; description: string }>>();
  for (const [file, descs] of perFile) {
    out.set(
      file,
      [...descs.entries()].map(([line, description]) => ({ line, description })).sort((a, b) => a.line - b.line),
    );
  }
  return out;
}

/**
 * Replace each row's file-wide description dump with the symbol-scoped
 * descriptors from {@link collectSymbolTestDescriptions}. A row with no
 * resolvable site (transitive importer, or a call outside any mined
 * `it/describe` block) keeps an empty list — the file path and any
 * test-shaped symbols still render, but no misleading descriptions do.
 */
function scopeRowsToSymbol(
  rows: readonly TestRow[],
  scoped: Map<string, Array<{ line: number; description: string }>>,
): TestRow[] {
  return rows.map((r) => ({ ...r, testDescriptions: scoped.get(r.filePath) ?? [] }));
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
  const lines: string[] = [
    `## Tests covering ${symbol} (${node.kind}) — ${node.filePath}${node.startLine ? `:${node.startLine}` : ''}`,
    '',
  ];
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
    lines.push(renderMarkdownBulletList(buildTestsForBucketSpec('sameFile', sameFileTests!)));
    lines.push(buildTestsForSameFileExplainer(node));
    lines.push('');
  }
  if (hasDispatchTests && mcpToolName) {
    lines.push(renderMarkdownBulletList(buildTestsForDispatchSpec(mcpToolName, dispatchTests!)));
  }
  if (hasDescribeNameTests) {
    lines.push(renderMarkdownBulletList(buildTestsForDescribeNameSpec(describeNameTests!)));
    lines.push(buildTestsForDescribeNameExplainer(node));
  }
  return lines.join('\n');
}

/** Pre-bucket note shown when none of the static, same-file, dispatch
 *  or describe-name passes returned anything. Centralised so the
 *  wording-lint can walk the same string the handler emits. */
export const TESTS_FOR_NO_RESULTS_NOTE =
  "_No tests found that import this symbol or its file. The symbol may be exercised via reflective dispatch (DI containers, framework hooks) — those don't appear as static `imports` edges._";

/** Bucket-kind discriminator for {@link buildTestsForBucketSpec}.
 *  Each value maps to a fixed H3 label + the same per-row
 *  `appendTestRow` formatter (file + test symbols + description
 *  preview). */
export type TestsForBucketKind = 'direct' | 'transitive' | 'sameFile';

/** User-facing label for each per-bucket H3 — owned ON the typed
 *  spec so the wording-alignment lint walks them. */
const TESTS_FOR_BUCKET_LABELS: Record<TestsForBucketKind, string> = {
  direct: 'Direct importers (high confidence)',
  transitive: 'Transitive importers (one hop)',
  sameFile: 'Tests covering this file (symbol exercised indirectly)',
};

/**
 * Build the typed bullet-list spec for one of the three primary
 * tests-for buckets (direct / transitive / sameFile). Each row is a
 * `TestRow` — the {@link formatRowAsLines} call returns `string[]`
 * because each test row may carry inline `  - Lline: "desc"`
 * sub-bullets the `MarkdownBulletListSpec` natively supports.
 */
export function buildTestsForBucketSpec(
  kind: TestsForBucketKind,
  rows: readonly TestRow[],
): MarkdownBulletListSpec<TestRow> {
  return {
    title: `${TESTS_FOR_BUCKET_LABELS[kind]} (${rows.length})`,
    headingLevel: 3,
    rows,
    formatRow: (r) => testRowAsLines(r),
    // emptyState is never rendered (the composing handler short-
    // circuits on rows.length === 0 above), but the lint walks it so
    // include a coherent placeholder that names the bucket vocab.
    emptyState: `No ${TESTS_FOR_BUCKET_LABELS[kind].toLowerCase()}.`,
  };
}

/**
 * Build the dispatch-tests spec — the MCP `handler.execute(...)`
 * path. Plain bullet list of file paths; no per-row sub-bullets.
 */
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

/**
 * Build the describe-name-match spec — inferred tests that mention
 * the symbol name in a `describe`/`it`/`test` title without any
 * static `imports` edge.
 */
export function buildTestsForDescribeNameSpec(files: readonly string[]): MarkdownBulletListSpec<string> {
  return {
    title: `INFERRED (describe-name match) (${files.length})`,
    headingLevel: 3,
    rows: files,
    formatRow: (filePath) => `- \`${filePath}\``,
    emptyState: 'No describe-name matches.',
  };
}

/** Same-file fallback's trailing explainer. Lives outside any spec
 *  because it interpolates the symbol's live `node.name` /
 *  `node.filePath`; the wording-lint walks the static prefix via
 *  {@link TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX} below. */
export function buildTestsForSameFileExplainer(node: Node): string {
  return `_No test file imports or calls \`${node.name}\` directly. The test files above cover other symbols in \`${node.filePath}\`, so they likely exercise \`${node.name}\` transitively. Confidence: file-level (covers the file, not provably the symbol)._`;
}

/** Describe-name match trailing explainer. */
export function buildTestsForDescribeNameExplainer(node: Node): string {
  return `_No static \`imports\` edge points at this symbol from any test, but the test files above mention \`${node.name}\` in a \`describe\`/\`it\`/\`test\` title — they likely exercise it via class-instance dispatch, DI, or a reflective call path. Confidence: inferred (name-match heuristic)._`;
}

/** Static-prefix vocabulary anchors for the two live-data
 *  explainers above — the wording-lint matches on these prefixes so
 *  a rename of "covers the file, not provably the symbol" or
 *  "name-match heuristic" is caught. */
export const TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX = 'covers the file, not provably the symbol';
export const TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX = 'name-match heuristic';

/** Per-row formatter that converts a TestRow into one or more
 *  bullet lines. Extracted from `appendTestRow` so the bullet-spec
 *  `formatRow` callback can return `string[]` directly. */
function testRowAsLines(r: TestRow): string[] {
  const out: string[] = [];
  if (r.testSymbols.length === 0 && r.testDescriptions.length === 0) {
    out.push(`- \`${r.filePath}\` _(no test-shaped symbols matched the heuristic)_`);
    return out;
  }
  const symPart = r.testSymbols.length > 0 ? ` — ${r.testSymbols.map((s) => `\`${s}\``).join(', ')}` : '';
  const countPart =
    r.testDescriptions.length > 0
      ? ` _(${r.testDescriptions.length} covering test block${r.testDescriptions.length === 1 ? '' : 's'})_`
      : '';
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

/* `appendTestRow` + `appendBucket` removed — superseded by
 * `testRowAsLines` (the per-row formatter passed to the spec's
 * `formatRow`) and `buildTestsForBucketSpec` (the typed bullet-list
 * spec rendered by `renderMarkdownBulletList`). */

/**
 * @internal Build a test-path predicate from an optional filter glob.
 * Always returns `{ predicate, err? }` — `predicate` is always set
 * (falls back to `isTestPath` when the glob is missing or unsafe);
 * `err` is set when the glob is unsafe and omitted on success.
 */
function buildIsTestPredicate(filterGlob: string | undefined): { predicate: (p: string) => boolean; err?: string } {
  if (!filterGlob) return { predicate: isTestPath };
  const regexBody = globToSafeRegex(filterGlob);
  if (regexBody === null) {
    return {
      predicate: isTestPath,
      err: `Filter glob is not supported (unsafe quantifier or unsupported syntax): \`${filterGlob}\`. Try a simpler pattern like "**/*.test.ts".`,
    };
  }
  const re = new RegExp(regexBody);
  return { predicate: (p: string) => re.test(p) };
}

/** @internal Render the affected-test-file list body with inline descriptions. */
function formatAffectedTestLines(cg: Cartograph, sorted: readonly string[]): string[] {
  const lines: string[] = [];
  for (const t of sorted) {
    lines.push(`- \`${t}\``);
    const descs = fetchTestDescriptionsForFile(cg, t);
    const shown = descs.slice(0, MAX_TEST_DESCRIPTIONS_SHOWN);
    for (const d of shown) lines.push(`  - L${d.line}: "${d.description}"`);
    if (descs.length > shown.length) {
      lines.push(`  - _…and ${descs.length - shown.length} more assertions_`);
    }
  }
  return lines;
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
  const files = args.files!;
  // `depth` is already an integer in [1, 50] — Zod's `.int().min().max()`
  // rejected anything else at the dispatch boundary. No clamp needed.
  const depth = args.depth;
  // `predErr` (not `err`) so the local binding can't shadow the `err`
  // outcome constructor imported from `_outcome.js`.
  const { predicate: isTest, err: predErr } = buildIsTestPredicate(args.filter);
  if (predErr) return err(predErr);

  // Surface input paths that match no indexed file — otherwise a typo'd
  // or stale path is silently dropped and the caller reads a misleading
  // "0 affected tests" with no clue that the input itself didn't land.
  // Mirrors `cartograph_affected`'s unmatched-paths reporting.
  const indexedPaths = new Set(getAllFiles(cg.queries).map((f) => f.path));
  const unmatchedInputs = files.filter((f) => !indexedPaths.has(f));
  if (unmatchedInputs.length === files.length && files.length > 0) {
    return err(
      `None of the ${files.length} input file${files.length === 1 ? '' : 's'} match indexed paths: ${unmatchedInputs.map((f) => `\`${f}\``).join(', ')}. Check spelling, or run \`cartograph_admin({action: 'sync'})\` if the files are new.`,
    );
  }

  const affected = new Set<string>();
  // Track input-barrels and BFS-reached-barrels separately so the
  // footer can distinguish "the file YOU passed is itself a barrel"
  // from "BFS walked through a barrel" — handoff #8: previously both
  // collapsed into one set and emitted the same misleading wording
  // ("Traversal reached the public-API barrel" with `Traversed 0
  // dependent files` was contradictory).
  const inputBarrels = new Set<string>();
  const bfsBarrels = new Set<string>();
  let totalDependents = 0;
  for (const f of files) {
    // A seed file that is itself a public-API barrel fans out to the
    // whole public surface — flag it directly. `bfsTestImpactFromFile`
    // only inspects DEPENDENTS, so without this an `index.*` seed
    // never trips the barrel warning even though it is the worst case.
    if (isBarrelFile(f)) inputBarrels.add(f);
    if (isTest(f)) {
      affected.add(f);
      continue;
    }
    totalDependents += bfsTestImpactFromFile({
      cg,
      seedFile: f,
      maxDepth: depth,
      isTest,
      affected,
      barrelsReached: bfsBarrels,
    });
  }
  const sorted = [...affected].sort();
  // The footers carry the load-bearing signals — the "showing first N
  // of M" cap notice and the barrel-blast-radius warning. The
  // chokepoint truncates the BODY first and appends the footers AFTER,
  // so a wide inline-description list can never chop the cap / barrel
  // notice off the end.
  const footers = buildFilesModeFooters({ sorted, totalDependents, inputBarrels, bfsBarrels, unmatchedInputs });
  const header = `## Affected test files (${sorted.length})`;
  let bodyLines: string[];
  if (sorted.length === 0) {
    bodyLines = ['- _None._'];
  } else {
    // Cap the rendered list — a barrel-file seed can fan out to most
    // of the suite. Mirrors cartograph_affected's "showing first N".
    const shown = sorted.slice(0, FILES_MODE_RENDER_CAP);
    bodyLines = formatAffectedTestLines(cg, shown);
  }
  return ok(renderToolResponse({ body: `${header}\n${bodyLines.join('\n')}`, footers }));
}

/**
 * Build the files-mode footers — cap notice + traversal count + barrel
 * warning. Returned as a `footers` array; {@link renderToolResponse}
 * places them after body truncation so these signals always survive.
 */
function buildFilesModeFooters(args: {
  sorted: readonly string[];
  totalDependents: number;
  /** Input files that are themselves public-API barrels. Different
   *  wording than {@link bfsBarrels} — "the file you passed IS the
   *  barrel" vs "BFS walked through one". Handoff #8. */
  inputBarrels: ReadonlySet<string>;
  /** Barrels reached during BFS traversal of dependents. */
  bfsBarrels: ReadonlySet<string>;
  /** Input paths that matched no indexed file (subset — the all-unmatched
   *  case is rejected upstream with an error). */
  unmatchedInputs: readonly string[];
}): string[] {
  const { sorted, totalDependents, inputBarrels, bfsBarrels, unmatchedInputs } = args;
  const footers: string[] = [];
  if (unmatchedInputs.length > 0) {
    footers.push(
      `> ⚠ ${unmatchedInputs.length} input path${unmatchedInputs.length === 1 ? '' : 's'} matched no indexed file and ${unmatchedInputs.length === 1 ? 'was' : 'were'} skipped: ${unmatchedInputs.map((f) => `\`${f}\``).join(', ')}. Check spelling, or \`cartograph_admin({action: 'sync'})\` if the files are new.`,
    );
  }
  if (sorted.length > FILES_MODE_RENDER_CAP) {
    footers.push(
      `_Showing first ${FILES_MODE_RENDER_CAP} of ${sorted.length} — narrow with \`filter\`, or use \`symbol\` mode for symbol-level test discovery._`,
    );
  }
  footers.push(`_Traversed ${totalDependents} dependent file${totalDependents === 1 ? '' : 's'}._`);
  // Barrel hints — two distinct phrasings depending on how the barrel
  // entered the result set. An input file that IS itself a barrel never
  // had a traversal to "reach", so the prior single-message wording
  // ("Traversal reached the public-API barrel") was contradictory next
  // to "Traversed 0 dependent files" (handoff #8). Both can fire on
  // the same call when one input is a barrel AND BFS reaches another.
  if (inputBarrels.size > 0) {
    const barrelList = [...inputBarrels]
      .sort()
      .map((b) => `\`${b}\``)
      .join(', ');
    const isPlural = inputBarrels.size > 1;
    footers.push(
      `> ⚠ Input file${isPlural ? 's are themselves' : ' is itself a'} public-API barrel${isPlural ? 's' : ''} (${barrelList}) — every test that imports the barrel's re-exports is "affected". ` +
        `For an actionable answer pass \`symbol\` instead of \`files\` for symbol-level test discovery.`,
    );
  }
  if (bfsBarrels.size > 0) {
    const barrelList = [...bfsBarrels]
      .sort()
      .map((b) => `\`${b}\``)
      .join(', ');
    footers.push(
      `> ⚠ Traversal reached the public-API barrel (${barrelList}) — the blast radius is most of the suite. ` +
        `For an actionable answer pass \`symbol\` instead of \`files\` for symbol-level test discovery.`,
    );
  }
  return footers;
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
});
