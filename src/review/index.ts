/**
 * Review Context Builder
 *
 * Takes a unified diff and returns the structured context an LLM-driven
 * code reviewer needs to evaluate it: per-symbol callers / callees /
 * tests / impact, plus historical co-change warnings (files that
 * historically change together but were NOT both touched in this PR).
 *
 * Designed to be the substrate under PR-review tooling (Greptile,
 * CodeRabbit, custom Claude Code agents). Not a reviewer itself —
 * synthesis stays with the LLM consumer.
 */

import type { Node, NodeKind } from '../types.js';
import type { QueryBuilder } from '../db/queries.js';
import { getIncomingEdges } from '../db/queries-edges.js';
import { getCoChangedFiles } from '../db/queries-history.js';
import type { GraphTraverser } from '../graph/traversal.js';
import { parseDiff, symbolsTouchedByHunks, type DiffFile, type FileStatus } from './diff-parser.js';
import { compact } from '../utils.js';
import { expandTestFileCallersWithQueries } from '../mcp/tools/_callers.js';

export { parseDiff, type DiffFile, type Hunk, type FileStatus } from './diff-parser.js';

interface ReviewContextOptions {
  /**
   * Per-symbol caller / callee fan-out cap. Reviewer only needs a handful
   * to decide "is this a hot-path function or an internal helper", not
   * every reference.
   */
  maxCallersPerSymbol?: number;
  maxCalleesPerSymbol?: number;

  /**
   * For each changed file, surface up to N co-changers that historically
   * change together but are NOT in this PR. Set 0 to disable.
   */
  maxCoChangeWarnings?: number;

  /**
   * Minimum Jaccard for a co-change warning to be reported. 0.4 catches
   * meaningfully-coupled pairs without flooding the result with weak
   * historical co-occurrence. OR-gated with `minCoChangeAnchorRatio`.
   */
  minCoChangeJaccard?: number;

  /**
   * Minimum anchor coverage (count / anchor commits) for a co-change
   * warning. Catches the asymmetric case symmetric Jaccard misses: a
   * partner that appears in 30%+ of the anchor's commits is meaningful
   * even when the partner itself is a high-churn hub whose union swamps
   * Jaccard. Default 0.3.
   */
  minCoChangeAnchorRatio?: number;

  /**
   * Minimum diff magnitude (total +/- lines summed across every hunk in
   * the diff) for co-change warnings to fire at all. Friction-29: tiny
   * text-only diffs (doc-comment tweak, typo fix, single-line JSDoc
   * adjust) historically surface 2-3 co-change warnings driven by
   * structural-pattern commits (CLI mirror, dispatch table, "added a
   * new tool"). Those warnings are noise for a text-only edit. Default
   * 10 lines — below this, no co-change warnings are emitted regardless
   * of Jaccard / anchor-ratio. Pass 0 to disable the gate entirely
   * (legacy behaviour: always emit when above Jaccard / anchor-ratio).
   */
  minDiffMagnitude?: number;
}

interface SymbolRef {
  name: string;
  filePath: string;
  line?: number;
}

interface AffectedSymbol {
  symbolId: string;
  name: string;
  kind: NodeKind;
  qualifiedName: string;
  startLine: number;
  endLine: number;
  signature?: string;
  docstring?: string;
  /** Direct callers (incoming `calls`/`references`/`imports` edges). */
  callers: SymbolRef[];
  /** Direct callees (outgoing `calls`/`references` edges). `imports` edges
   * are excluded — they represent module-level dependencies, not function
   * calls a reviewer needs to assess. */
  callees: SymbolRef[];
  /** Number of nodes in the impact radius (depth 2). */
  impactCount: number;
  /**
   * Set when the affected entry is a module-level-edit fallback — the
   * hunks didn't overlap any non-file/non-import symbol body, so the
   * file-kind node is surfaced instead with a list of nearest-by-line
   * sibling symbols (e.g. "edit between import line 1 and first
   * function at line 12") to give the reviewer a foothold.
   */
  moduleLevelEditNote?: string;
}

interface ReviewedFile {
  path: string;
  status: FileStatus;
  oldPath?: string;
  /** Symbols whose line ranges overlap the diff hunks. */
  affectedSymbols: AffectedSymbol[];
  /** Test files that cover this source file (via PR #106 `tests` edges). */
  tests: string[];
  /** Note when status == 'deleted' — incoming edges to symbols that vanish. */
  brokenIncomingRefs?: SymbolRef[];
}

interface CoChangeWarning {
  changedFile: string;
  expectedToChange: string;
  jaccard: number;
  /** Asymmetric: count / changedFile.commit_count. Surfaced so a reviewer
   * can see "this partner appears in 44% of the anchor's commits" when
   * symmetric Jaccard is low because the partner is a high-churn hub.
   * Optional for backwards compatibility — pre-N3-fix consumers don't
   * supply this field. Read it as 0 when absent. */
  anchorRatio?: number;
  historicalCount: number;
  note: string;
}

interface ReviewContext {
  summary: {
    filesAdded: number;
    filesModified: number;
    filesDeleted: number;
    filesRenamed: number;
    symbolsAffected: number;
    coChangeWarnings: number;
  };
  files: ReviewedFile[];
  coChangeWarnings: CoChangeWarning[];
}

const DEFAULTS: Required<ReviewContextOptions> = {
  maxCallersPerSymbol: 5,
  maxCalleesPerSymbol: 5,
  maxCoChangeWarnings: 3,
  minCoChangeJaccard: 0.4,
  minCoChangeAnchorRatio: 0.3,
  minDiffMagnitude: 10,
};

/**
 * Sum every added + removed line across every hunk in the diff. Friction-29
 * gate input — when this total is below `minDiffMagnitude` the diff is
 * "text-only enough" that surfacing structural co-change warnings (CLI
 * mirror partners, dispatch-table siblings) is pure noise.
 *
 * Counts only the `+`/`-` body lines (`hunk.addedLines + hunk.removedLines`)
 * — NOT the hunk span (`oldCount`/`newCount`), which includes unchanged
 * context lines. A 4-line edit with git's default 3 lines of context has
 * an 11-line span but a magnitude of 8; counting the span made any tiny
 * edit clear the default-10 gate, so co-change warnings effectively never
 * got suppressed. This matches the `minDiffMagnitude` schema text:
 * "the diff is below this total line count (added + removed across all
 * hunks)".
 */
function totalDiffMagnitude(diffFiles: ReadonlyArray<DiffFile>): number {
  let total = 0;
  for (const df of diffFiles) {
    for (const h of df.hunks) {
      total += h.addedLines + h.removedLines;
    }
  }
  return total;
}

/** Shared DB + traversal deps threaded through review helpers. */
interface ReviewRunCtx {
  queries: QueryBuilder;
  traverser: GraphTraverser;
}

/** Mutable accumulator for broken incoming refs on a deleted symbol. */
interface BrokenRefAccumulator {
  seen: Set<string>;
  broken: SymbolRef[];
}

/**
 * Build a review-context bundle from a unified diff. Pure data — the
 * caller (typically an LLM) decides what to do with it.
 */
/**
 * Merge DEFAULTS with provided options, treating `undefined` as "use
 * the default". A plain spread would let `{maxCoChangeWarnings: undefined}`
 * override the default with undefined and silently disable the loop guard.
 */
function resolveReviewOptions(options: ReviewContextOptions): Required<ReviewContextOptions> {
  const opts: Required<ReviewContextOptions> = { ...DEFAULTS };
  for (const [k, v] of Object.entries(options)) {
    if (v !== undefined) (opts as Record<string, unknown>)[k] = v;
  }
  return opts;
}

/**
 * Walk the diff files (skipping deletions) collecting co-change
 * warnings — historical co-changers that were NOT touched in this PR.
 */
interface CollectAllCoChangeWarningsArgs {
  diffFiles: ReadonlyArray<DiffFile>;
  runCtx: ReviewRunCtx;
  opts: Required<ReviewContextOptions>;
  changedPaths: Set<string>;
}

function collectAllCoChangeWarnings(args: CollectAllCoChangeWarningsArgs): CoChangeWarning[] {
  const { diffFiles, runCtx, opts, changedPaths } = args;
  const out: CoChangeWarning[] = [];
  const maxCoChangeWarnings = opts.maxCoChangeWarnings ?? 0;
  if (maxCoChangeWarnings <= 0) return out;
  // Friction-29 gate: tiny text-only diffs don't earn structural
  // co-change warnings. Skip the whole pass when the diff is small.
  // `minDiffMagnitude: 0` disables the gate (legacy behaviour).
  if (opts.minDiffMagnitude > 0 && totalDiffMagnitude(diffFiles) < opts.minDiffMagnitude) {
    return out;
  }
  for (const df of diffFiles) {
    if (df.status === 'deleted') continue;
    collectCoChangeWarningsForFile({
      out,
      df,
      queries: runCtx.queries,
      opts,
      changedPaths,
      maxCoChangeWarnings,
    });
  }
  return out;
}

export function buildReviewContext(
  diff: string,
  runCtx: ReviewRunCtx,
  options: ReviewContextOptions = {},
): ReviewContext {
  const opts = resolveReviewOptions(options);
  const diffFiles = parseDiff(diff);
  const changedPaths = new Set(diffFiles.map((f) => f.path));

  const reviewedFiles: ReviewedFile[] = [];
  let totalSymbols = 0;
  for (const df of diffFiles) {
    const reviewed = reviewFile(df, runCtx, opts);
    totalSymbols += reviewed.affectedSymbols.length;
    reviewedFiles.push(reviewed);
  }

  const coChangeWarnings = collectAllCoChangeWarnings({ diffFiles, runCtx, opts, changedPaths });

  const counts = reviewedFiles.reduce(
    (acc, f) => {
      bumpStatusCount(acc, f.status);
      return acc;
    },
    { added: 0, modified: 0, deleted: 0, renamed: 0 },
  );

  return {
    summary: {
      filesAdded: counts.added,
      filesModified: counts.modified,
      filesDeleted: counts.deleted,
      filesRenamed: counts.renamed,
      symbolsAffected: totalSymbols,
      coChangeWarnings: coChangeWarnings.length,
    },
    files: reviewedFiles,
    coChangeWarnings,
  };
}

interface StatusCounts {
  added: number;
  modified: number;
  deleted: number;
  renamed: number;
}

/** Single-status increment dispatch. Pulled out of the reduce
 *  callback so the else-if cascade (which parses as nested
 *  if_statement) doesn't contribute 4 levels of nesting to
 *  buildReviewContext via the inline arrow's body. */
function bumpStatusCount(acc: StatusCounts, status: string): void {
  switch (status) {
    case 'added':
      acc.added++;
      return;
    case 'modified':
      acc.modified++;
      return;
    case 'deleted':
      acc.deleted++;
      return;
    case 'renamed':
      acc.renamed++;
      return;
  }
}

interface CollectCoChangeArgs {
  out: CoChangeWarning[];
  df: DiffFile;
  queries: QueryBuilder;
  opts: Required<ReviewContextOptions>;
  changedPaths: Set<string>;
  maxCoChangeWarnings: number;
}

/** Per-file co-change query + warning emission. Pulled out of
 *  buildReviewContext so the for-loop over diffFiles stays at depth
 *  3 instead of nesting `for/safeGet/.filter/for-of-missing` four
 *  levels deep. */
function collectCoChangeWarningsForFile(args: CollectCoChangeArgs): void {
  const { out, df, queries, opts, changedPaths, maxCoChangeWarnings } = args;
  const partners = safeGetCoChangedFiles(queries, df.path, {
    limit: maxCoChangeWarnings * 3,
    minCount: 2,
    minJaccard: opts.minCoChangeJaccard,
    minAnchorRatio: opts.minCoChangeAnchorRatio,
  });
  const missing = partners.filter((p) => !changedPaths.has(p.path)).slice(0, maxCoChangeWarnings);
  for (const m of missing) {
    out.push({
      changedFile: df.path,
      expectedToChange: m.path,
      jaccard: round2(m.jaccard),
      anchorRatio: round2(m.anchorRatio),
      historicalCount: m.count,
      note: 'Historically changes together with the changed file but is not included in this PR. Verify whether it should be updated.',
    });
  }
}

/**
 * Deleted-file branch: every vanishing symbol becomes an empty
 * AffectedSymbol entry, with a deduped union of every incoming
 * reference recorded as `brokenIncomingRefs` for "what just broke".
 */
function buildDeletedFileReview(
  reviewed: ReviewedFile,
  fileSymbols: ReadonlyArray<Node>,
  queries: QueryBuilder,
): ReviewedFile {
  const acc: BrokenRefAccumulator = { seen: new Set<string>(), broken: [] };
  for (const sym of fileSymbols) {
    collectBrokenIncomingForDeletedSymbol(queries, sym, acc);
    // Skip the per-symbol details for deleted files — affected lists
    // would all be empty since the symbol's gone.
    reviewed.affectedSymbols.push(toAffected(sym, { callers: [], callees: [], impactCount: 0 }));
  }
  if (acc.broken.length > 0) reviewed.brokenIncomingRefs = acc.broken;
  return reviewed;
}

/** @internal Bundle for {@link buildAffectedSymbol} — keeps the signature below the long_parameter_list threshold. */
interface BuildAffectedSymbolArgs {
  sym: Node;
  traverser: GraphTraverser;
  queries: QueryBuilder;
  opts: Required<ReviewContextOptions>;
}

/**
 * Build the AffectedSymbol entry for one touched symbol: capped
 * callers + callees (filtering out `imports` edges that represent
 * module imports, not real call relationships) + impact count.
 */
function buildAffectedSymbol({
  sym,
  traverser,
  queries,
  opts,
}: BuildAffectedSymbolArgs): ReturnType<typeof toAffected> {
  // FRICTION-5 fix (2026-05-15): expand test-file file-row callers into
  // per-call-site rows anchored on the enclosing it/describe block before
  // slicing. Previously a test file caller showed as "freshness-severity.test.ts:1"
  // (the file row) instead of the enclosing test description.
  const rawCallers = traverser.getCallers(sym.id, 1);
  const expandedCallers = expandTestFileCallersWithQueries(
    queries,
    rawCallers.map((r) => ({ node: r.node, edge: r.edge })),
  );
  const callers = expandedCallers
    .slice(0, opts.maxCallersPerSymbol)
    .map((r) => compact({ name: r.node.name, filePath: r.node.filePath, line: r.edge.line }));

  // Drop `imports` edges from the callees list. They represent module
  // imports (file → file), not function calls — surfacing them showed
  // 20+ raw `import` statements as the file-symbol's callees, noise
  // for a reviewer.
  const callees = traverser
    .getCallees(sym.id, 1)
    .filter((r) => r.edge.kind !== 'imports')
    .slice(0, opts.maxCalleesPerSymbol)
    .map((r) => compact({ name: r.node.name, filePath: r.node.filePath, line: r.edge.line }));

  const impactCount = traverser.getImpactRadius(sym.id, 2).nodes.size;
  return toAffected(sym, { callers, callees, impactCount });
}

function reviewFile(df: DiffFile, runCtx: ReviewRunCtx, opts: Required<ReviewContextOptions>): ReviewedFile {
  const { queries, traverser } = runCtx;
  const reviewed: ReviewedFile = {
    path: df.path,
    status: df.status,
    affectedSymbols: [],
    tests: safeGetTestsForFile(queries, df.path),
  };
  if (df.oldPath) reviewed.oldPath = df.oldPath;

  const fileSymbols = queries.getNodesByFile(df.path);

  if (df.status === 'deleted') {
    return buildDeletedFileReview(reviewed, fileSymbols, queries);
  }

  // For added files: every top-level symbol is "affected" (newly created).
  // For modified files: symbols whose line range overlaps a hunk.
  // Drop `import` and `file` nodes — a hunk that only touched import
  // lines would otherwise surface every import statement as an
  // "affected symbol", burying the real risk signal.
  const touchedRaw = df.status === 'added' ? fileSymbols : symbolsTouchedByHunks(df.hunks, fileSymbols);
  const touched = touchedRaw.filter((sym) => sym.kind !== 'import' && sym.kind !== 'file');

  for (const sym of touched) {
    reviewed.affectedSymbols.push(buildAffectedSymbol({ sym, traverser, queries, opts }));
  }

  // Module-level-edit fallback (bug #18): hunks landed between top-level
  // symbol bodies (e.g. a `console.log` injected above the first
  // function, an edit to module-scope `const x = …`, or a comment-only
  // change at the file head). Pre-fallback this returned "0 symbols
  // affected — hunks fall outside any indexed symbol body", silently
  // dropping the file from the affected-symbols count and from PR
  // review entirely. Surface the file-kind node instead, with a list of
  // nearest-by-line sibling symbols so the reviewer has a foothold.
  // Skipped on added files — every symbol in an added file is already
  // "touched" by the `df.status === 'added'` branch above, so an empty
  // `touched` list there means an empty file, not a module-level edit.
  if (touched.length === 0 && df.status === 'modified' && fileSymbols.length > 0 && df.hunks.length > 0) {
    const fallback = buildModuleLevelFallback({ df, fileSymbols, runCtx, opts });
    if (fallback) reviewed.affectedSymbols.push(fallback);
  }

  return reviewed;
}

/** Max nearest-sibling symbols cited in a module-level fallback note. */
const MODULE_LEVEL_FALLBACK_SIBLING_COUNT = 3;

/**
 * Module-level-edit fallback for {@link reviewFile}. Returns a synthetic
 * `AffectedSymbol` anchored on the file-kind node (so the file shows
 * up under "affected" instead of being invisible) with a
 * `moduleLevelEditNote` listing the nearest-by-line sibling symbols.
 *
 * Returns `null` when the file has no file-kind node (legacy index
 * without per-file nodes — keep the historical empty behavior).
 */
interface BuildModuleLevelFallbackArgs {
  df: DiffFile;
  fileSymbols: ReadonlyArray<Node>;
  runCtx: ReviewRunCtx;
  opts: Required<ReviewContextOptions>;
}

function buildModuleLevelFallback(args: BuildModuleLevelFallbackArgs): AffectedSymbol | null {
  const { df, fileSymbols, runCtx, opts } = args;
  const fileNode = fileSymbols.find((s) => s.kind === 'file');
  if (!fileNode) return null;

  // Pick the file's top-level non-file/non-import symbols and sort by
  // distance from the first hunk's anchor line. The first hunk's
  // `newStart` is the closest landing point a reviewer would scan
  // toward; ties are broken by raw line number so the rendering is
  // deterministic.
  const anchorLine = df.hunks[0]?.newStart ?? 1;
  const siblingCandidates = fileSymbols
    .filter((s) => s.kind !== 'file' && s.kind !== 'import')
    .map((s) => ({ s, distance: Math.abs(s.startLine - anchorLine) }))
    .sort((a, b) => a.distance - b.distance || a.s.startLine - b.s.startLine)
    .slice(0, MODULE_LEVEL_FALLBACK_SIBLING_COUNT)
    .map(({ s }) => s);

  const siblingNote =
    siblingCandidates.length > 0
      ? `; nearest siblings: ${siblingCandidates.map((s) => `${s.name} (${s.kind}) at line ${s.startLine}`).join(', ')}`
      : '';
  const note = `module-level edit (no enclosing symbol body)${siblingNote}`;

  const affected = buildAffectedSymbol({ sym: fileNode, traverser: runCtx.traverser, queries: runCtx.queries, opts });
  affected.moduleLevelEditNote = note;
  return affected;
}

/**
 * For a deleted-file symbol, walk every incoming caller / referencer
 * / importer / extends / implements edge and append a deduped
 * SymbolRef per source. Pulled out so reviewFile's deleted-file
 * branch stays at depth 3 instead of nesting `for/for/if/if` four
 * levels deep.
 */
function collectBrokenIncomingForDeletedSymbol(queries: QueryBuilder, sym: Node, acc: BrokenRefAccumulator): void {
  const incoming = getIncomingEdges(queries, sym.id, ['calls', 'references', 'imports', 'extends', 'implements']);
  for (const edge of incoming) {
    const sourceNode = queries.getNodeById(edge.source);
    if (!sourceNode) continue;
    const key = `${sourceNode.filePath}|${sourceNode.name}|${edge.line ?? ''}`;
    if (acc.seen.has(key)) continue;
    acc.seen.add(key);
    acc.broken.push(
      compact({
        name: sourceNode.name,
        filePath: sourceNode.filePath,
        line: edge.line,
      }),
    );
  }
}

interface AffectedData {
  callers: SymbolRef[];
  callees: SymbolRef[];
  impactCount: number;
}

function toAffected(sym: Node, data: AffectedData): AffectedSymbol {
  const { callers, callees, impactCount } = data;
  const out: AffectedSymbol = {
    symbolId: sym.id,
    name: sym.name,
    kind: sym.kind,
    qualifiedName: sym.qualifiedName,
    startLine: sym.startLine,
    endLine: sym.endLine,
    callers,
    callees,
    impactCount,
  };
  if (sym.signature) out.signature = sym.signature;
  if (sym.docstring) out.docstring = sym.docstring;
  return out;
}

/**
 * Co-change query — graceful degradation if PR #105's co_changes table
 * isn't present. Returns [] without throwing, so the review context
 * still works on a pre-#105 install.
 */
function safeGetCoChangedFiles(
  queries: QueryBuilder,
  filePath: string,
  options: { limit: number; minCount: number; minJaccard: number | undefined; minAnchorRatio: number | undefined },
): Array<{ path: string; count: number; jaccard: number; anchorRatio: number }> {
  try {
    // Default minJaccard to 0 when not provided — the underlying impl
    // requires it. Caller treats undefined as "no filter."
    const rows = getCoChangedFiles(
      queries,
      filePath,
      compact({
        ...options,
        minJaccard: options.minJaccard ?? 0,
      }),
    );
    return rows.map((r) => ({ ...r, anchorRatio: r.anchorRatio ?? 0 }));
  } catch {
    return [];
  }
}

/**
 * Tests-edges query — graceful degradation if PR #106's `tests` edges
 * aren't present. Falls back to a direct edges-table query so we don't
 * need the public API surface to exist yet.
 */
function safeGetTestsForFile(queries: QueryBuilder, filePath: string): string[] {
  try {
    const incoming = getIncomingEdges(queries, `file:${filePath}`, ['tests' as never]);
    return incoming
      .map((e) => e.source)
      .filter((id) => id.startsWith('file:'))
      .map((id) => id.slice('file:'.length));
  } catch {
    return [];
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
