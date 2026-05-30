/**
 * compareToRef — structural delta of the working tree vs a git ref.
 *
 * Closes the agent's edit loop: after a series of edits, calling this
 * returns the cumulative `+/-/~` symbol diff against `HEAD` (or any
 * other ref). It works by:
 *   1. Listing files changed since the ref via git.
 *   2. For each changed file, extracting the baseline source from the
 *      ref blob (via `git show ref:path`) AND the current source
 *      from disk, both run through the same stateless `extractFromSource`.
 *   3. Diffing the two node sets by `(qualifiedName, kind)`.
 *
 * Pure read-only — never touches the persisted graph. The persisted
 * graph drives biomarker findings on the result, but not the symbol
 * diff itself; that way a stale index doesn't poison the report.
 *
 * Pairs with the planned `cartograph_diff <branch>` (BACKLOG B #17) —
 * same machinery, different ref pair.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execFileSync } from 'node:child_process';
import type Cartograph from '../index.js';
import type { Edge, EdgeKind, Language, Node, NodeKind } from '../types.js';
import { extractFromSource } from '../extraction/tree-sitter.js';
import { detectLanguage, initGrammars, isLanguageSupported, loadGrammarsForLanguages } from '../extraction/grammars.js';
import { getFileAtRef, listChangedFilesSince } from '../git-utils.js';
import { getFindingsForNode } from '../db/queries-findings.js';
import {
  ANALYSABLE_KINDS,
  ANALYSABLE_MIN_LOC,
  astBodyNodeRangeMismatch,
  computeMetrics,
  evaluateRules,
  findNodeInTree,
  parseSource,
} from '../biomarkers/index.js';
import type { Finding } from '../biomarkers/types.js';

/**
 * Symbol kinds that represent meaningful structural changes for an
 * agent self-report. `file` / `module` / `namespace` rotate every
 * non-trivial edit (their line range tracks the whole file), so they
 * become noise. `import` / `export` (the node kinds, not the modifiers)
 * are derived from individual statements — every line shift surfaces a
 * "modified" entry that the agent already sees in their own diff.
 * Variables / constants / parameters are skipped for the same reason —
 * the call-graph signal is captured by the function/method edits.
 */
const INTERESTING_KINDS: ReadonlySet<NodeKind> = new Set([
  'function',
  'method',
  'class',
  'struct',
  'interface',
  'trait',
  'protocol',
  'type_alias',
  'enum',
  'enum_member',
  'property',
  'field',
  'route',
  'component',
  'table',
  'resource',
]);

interface CompareOptions {
  /** Git ref to compare against. Defaults to HEAD. */
  ref?: string;
  /**
   * When set, compare TWO git refs: `ref` (base) vs `head` (head), instead
   * of comparing the working tree against `ref`. Both must be rev-parse-able.
   * Useful for PR review without requiring a local checkout of the branch.
   */
  head?: string;
  /** Restrict the comparison to paths starting with this prefix. */
  pathFilter?: string;
  /**
   * Include current biomarker findings on each touched node id. Adds
   * one `getFindingsForNode` call per added/modified symbol; cheap
   * but noisy — off by default.
   *
   * Reads the persisted graph; results reflect the last successful
   * sync. Call `cg.sync()` first if you need findings on edits made
   * after the previous indexing pass — the MCP path's freshness gate
   * does this automatically, library callers must do it themselves.
   */
  includeBiomarkers?: boolean;
  /**
   * Compute per-file biomarker delta — added findings (introduced
   * since the ref), cleared findings (refactored away), and carried
   * findings (still present on the same symbol). Runs the per-file
   * biomarker engine in-memory on both baseline and current ASTs;
   * does NOT touch the persisted graph, so results are correct even
   * when the index hasn't been re-synced. Only per-file biomarkers
   * are considered — cross-file rules (`unused_export`, `god_class`,
   * `feature_envy`) need the whole graph and are out of scope here.
   */
  findingsDelta?: boolean;
  /**
   * Compute per-file edge delta — added/removed intra-file edges
   * (calls, references, field_access, etc.). Edge identity uses
   * the stable `(srcQualifiedName, tgtQualifiedName, edgeKind)`
   * triple so line shifts inside a function body don't surface as
   * spurious changes. Cross-file edges target unresolved-name
   * candidates produced by the extractor; out-of-file resolution
   * runs against the persisted graph and is out of scope here.
   * Off by default — typical PRs change many more edges than nodes,
   * so the noise/signal trade-off is opt-in.
   */
  includeEdges?: boolean;
  /**
   * Per-symbol suppression of pure-renumber noise. Any modified symbol whose
   * only reason is `['line range changed']` (no signature change, no modifier
   * flip) is removed from `modified` and tallied into `lineRangeOnlyCount`,
   * which the formatter renders as a single roll-up line. Real modifications
   * in the same file still surface individually. Added and removed symbols
   * are never suppressed.
   *
   * **Defaults to `true`** (2026-05-14). Renumber rows are noise 99% of the
   * time — only useful when a caller wants every single renumbered symbol
   * (rare; mostly for tests or detail audits). Pass `false` to opt out.
   *
   * Pre-2026-05-14 behaviour was per-FILE: a file ONLY collapsed when every
   * modified symbol was a pure renumber. That left noise on every mixed file
   * (e.g. 3 real changes + 37 renumbered → 37 noise rows surfaced). The new
   * per-symbol policy keeps real changes visible while rolling up the rest.
   */
  suppressLineRangeOnly?: boolean;
}

export interface SymbolDelta {
  filePath: string;
  qualifiedName: string;
  name: string;
  kind: string;
  /** Present for added/modified — null for removed (no current node). */
  startLine?: number;
  endLine?: number;
  /** Why we marked it modified. Empty when not modified. */
  modifiedReasons?: string[];
  /** Filled when includeBiomarkers and a current persisted node id matches. */
  findings?: Array<{ biomarker: string; severity: 'info' | 'warning' | 'error'; metric: number }>;
}

interface FindingDelta {
  qualifiedName: string;
  name: string;
  kind: string;
  biomarker: string;
  severity: 'info' | 'warning' | 'error';
  metric: number;
}

interface FindingsDelta {
  added: FindingDelta[];
  cleared: FindingDelta[];
  carried: FindingDelta[];
}

export interface EdgeDelta {
  /** Raw source node id — opaque hash; prefer `sourceName` for display. */
  source: string;
  /** Raw target node id — opaque hash; prefer `targetName` for display. */
  target: string;
  /**
   * Resolved qualified name of the source endpoint. Present when the
   * endpoint node was in the per-file node list (the normal case);
   * absent only for the rare edge whose endpoint dropped out between
   * key-building and rendering. Renderers should fall back to `source`.
   */
  sourceName?: string;
  /** Resolved qualified name of the target endpoint — see `sourceName`. */
  targetName?: string;
  kind: EdgeKind;
  /** Source-side line number when known — present for added; absent for removed when baseline node has no line. */
  line?: number;
}

export interface EdgesDelta {
  added: EdgeDelta[];
  removed: EdgeDelta[];
}

export interface FileDelta {
  filePath: string;
  /** Baseline blob read OK? false → file was new (didn't exist at ref). */
  hadBaseline: boolean;
  /** Current source read OK? false → file deleted in working tree. */
  hadCurrent: boolean;
  language: string;
  added: SymbolDelta[];
  removed: SymbolDelta[];
  modified: SymbolDelta[];
  /**
   * Set when `suppressLineRangeOnly=true` and every modified symbol in
   * this file had reasons of exactly `['line range changed']`. The count
   * records how many symbols were collapsed so the formatter can emit a
   * single roll-up line (`N symbols renumbered — no content change`).
   * When 0 or absent the file had no pure-renumber modifications.
   */
  lineRangeOnlyCount?: number;
  /** Filled when findingsDelta=true. Per-file biomarkers only. */
  findingsDelta?: FindingsDelta;
  /** Filled when includeEdges=true. Intra-file edges only. */
  edgesDelta?: EdgesDelta;
  /** Files we couldn't analyse (unsupported language, parse failure). */
  skipReason?: string;
}

export interface CompareResult {
  ref: string;
  filesScanned: number;
  filesChanged: number;
  /**
   * Number of files git reported changed but that cartograph could not
   * structurally diff — unsupported language, binary, or other extraction
   * failure. These appear in `files` with a `skipReason` set but no
   * symbol-level entries. Formatter emits one informational line when > 0;
   * omits the line entirely when 0 to keep clean diffs noise-free.
   *
   * @todo Surface per-file detail via `--include-skipped` expansion flag.
   */
  filesSkipped: number;
  totals: {
    added: number;
    removed: number;
    modified: number;
    /** Filled when includeEdges=true. */
    edgesAdded?: number;
    edgesRemoved?: number;
  };
  files: FileDelta[];
  /** Set when git is unavailable or the ref is bad. */
  error?: string;
  /**
   * Set when a `pathFilter` was supplied. Records the path-filter
   * outcome so the renderer can distinguish "nothing changed at all"
   * from "files DID change but the filter excluded them all". Without
   * this, an empty `filesScanned` after a non-matching filter renders
   * the misleading "No files differ from <ref>." — implying the tree
   * is clean when it isn't.
   */
  pathFilter?: {
    /** The filter prefix that was applied. */
    value: string;
    /** Total files git reported changed, BEFORE the path filter. */
    changedBeforeFilter: number;
    /** Files surviving the path filter (== `filesScanned`). */
    matched: number;
  };
}

/**
 * Two symbols share identity (same `(filePath, qualifiedName, kind)`)
 * but their current-vs-baseline shape differs in a way that should
 * surface to the agent. Returns a list of human-readable reasons —
 * empty when the symbol is unchanged.
 *
 * Body-changed-but-shape-identical edits (rename a local, change a
 * literal) typically still shift `endLine` because tree-sitter line
 * numbers track the source. When they don't, the symbol is reported
 * as unchanged — that's a known false-negative we accept here; full
 * AST diffing is out of scope for the MVP.
 */
function symbolModificationReasons(before: Node, after: Node): string[] {
  const reasons: string[] = [];
  if ((before.signature ?? '') !== (after.signature ?? '')) {
    reasons.push('signature changed');
  }
  if (before.startLine !== after.startLine || before.endLine !== after.endLine) {
    reasons.push('line range changed');
  }
  if (Boolean(before.isAsync) !== Boolean(after.isAsync)) reasons.push('async modifier changed');
  if (Boolean(before.isStatic) !== Boolean(after.isStatic)) reasons.push('static modifier changed');
  if (Boolean(before.isExported) !== Boolean(after.isExported)) reasons.push('export visibility changed');
  return reasons;
}

function nodeKey(n: Node): string {
  return `${n.filePath}::${n.qualifiedName}::${n.kind}`;
}

function toSymbolDelta(n: Node, modifiedReasons?: string[]): SymbolDelta {
  return {
    filePath: n.filePath,
    qualifiedName: n.qualifiedName,
    name: n.name,
    kind: n.kind,
    startLine: n.startLine,
    endLine: n.endLine,
    ...(modifiedReasons && modifiedReasons.length > 0 ? { modifiedReasons } : {}),
  };
}

function buildNodeKeyMap(nodes: Node[]): Map<string, Node> {
  return new Map(nodes.map((n) => [nodeKey(n), n]));
}

function diffAddedAndModified(
  beforeByKey: Map<string, Node>,
  afterByKey: Map<string, Node>,
): { added: SymbolDelta[]; modified: SymbolDelta[] } {
  const added: SymbolDelta[] = [];
  const modified: SymbolDelta[] = [];
  for (const [key, afterNode] of afterByKey) {
    const beforeNode = beforeByKey.get(key);
    if (!beforeNode) {
      added.push(toSymbolDelta(afterNode));
      continue;
    }
    const reasons = symbolModificationReasons(beforeNode, afterNode);
    if (reasons.length > 0) modified.push(toSymbolDelta(afterNode, reasons));
  }
  return { added, modified };
}

function diffRemoved(beforeByKey: Map<string, Node>, afterByKey: Map<string, Node>): SymbolDelta[] {
  const removed: SymbolDelta[] = [];
  for (const [key, beforeNode] of beforeByKey) {
    if (!afterByKey.has(key)) removed.push(toSymbolDelta(beforeNode));
  }
  return removed;
}

/**
 * Diff two extracted node lists for a single file. Same key → check
 * for modification; only-in-before → removed; only-in-after → added.
 */
function diffNodeLists(
  before: Node[],
  after: Node[],
): {
  added: SymbolDelta[];
  removed: SymbolDelta[];
  modified: SymbolDelta[];
} {
  const beforeByKey = buildNodeKeyMap(before);
  const afterByKey = buildNodeKeyMap(after);
  const { added, modified } = diffAddedAndModified(beforeByKey, afterByKey);
  const removed = diffRemoved(beforeByKey, afterByKey);
  return { added, removed, modified };
}

interface DiffEdgeListsArgs {
  beforeNodes: Node[];
  beforeEdges: Edge[];
  afterNodes: Node[];
  afterEdges: Edge[];
}

function buildNodeIdIndex(nodes: Node[]): Map<string, { qn: string; kind: NodeKind }> {
  const m = new Map<string, { qn: string; kind: NodeKind }>();
  for (const n of nodes) m.set(n.id, { qn: n.qualifiedName, kind: n.kind });
  return m;
}

function edgeStableKey(e: Edge, idx: Map<string, { qn: string; kind: NodeKind }>): string | null {
  const s = idx.get(e.source);
  const t = idx.get(e.target);
  if (!s || !t) return null;
  return `${s.qn}::${s.kind}=>${t.qn}::${t.kind}::${e.kind}`;
}

function buildEdgeKeyMap(edges: Edge[], index: Map<string, { qn: string; kind: NodeKind }>): Map<string, Edge> {
  const m = new Map<string, Edge>();
  for (const e of edges) {
    const k = edgeStableKey(e, index);
    if (k) m.set(k, e);
  }
  return m;
}

function edgeToEdgeDelta(e: Edge, idx: Map<string, { qn: string; kind: NodeKind }>): EdgeDelta {
  const sourceName = idx.get(e.source)?.qn;
  const targetName = idx.get(e.target)?.qn;
  return {
    source: e.source,
    target: e.target,
    ...(sourceName !== undefined ? { sourceName } : {}),
    ...(targetName !== undefined ? { targetName } : {}),
    kind: e.kind,
    ...(e.line !== undefined ? { line: e.line } : {}),
  };
}

/**
 * Stable edge identity across line shifts. Maps edge source/target
 * node IDs to their `(qualifiedName, kind)` so a function-body edit
 * that shifts line numbers but doesn't change call structure produces
 * an empty edge delta. Edges whose endpoints don't appear in the node
 * list (cross-file targets resolved at the graph level) are dropped —
 * compareToRef is per-file and can't reason about those reliably.
 */
function diffEdgeLists({ beforeNodes, beforeEdges, afterNodes, afterEdges }: DiffEdgeListsArgs): EdgesDelta {
  const beforeIndex = buildNodeIdIndex(beforeNodes);
  const afterIndex = buildNodeIdIndex(afterNodes);
  const beforeByKey = buildEdgeKeyMap(beforeEdges, beforeIndex);
  const afterByKey = buildEdgeKeyMap(afterEdges, afterIndex);

  const added: EdgeDelta[] = [];
  const removed: EdgeDelta[] = [];
  for (const [k, e] of afterByKey) if (!beforeByKey.has(k)) added.push(edgeToEdgeDelta(e, afterIndex));
  for (const [k, e] of beforeByKey) if (!afterByKey.has(k)) removed.push(edgeToEdgeDelta(e, beforeIndex));
  return { added, removed };
}

/**
 * List paths that differ between two git refs. Used when `head` is set
 * in `CompareOptions` — this is ref-to-ref mode rather than
 * ref-to-working-tree. Returns null when git fails (bad ref, no repo).
 *
 * NOTE on `...` vs `..`: this uses `git diff base..head` (TWO dots),
 * which diffs `base` directly against `head`. This deliberately matches
 * the per-file delta path (`fileDeltaForOnePath` reads each file at
 * `ref` and at `head` directly — also two-dot semantics). The file LIST
 * and the per-file CONTENT diff must agree on direction, or the result
 * is silently wrong in two ways:
 *   - a reverse-direction compare (`head` an ancestor of `base`) under
 *     three-dot `base...head` has merge-base == head, so `git diff`
 *     reports ZERO changed files even though the refs genuinely differ
 *     — the caller gets an empty result with no error (the original
 *     bug this comment replaces);
 *   - a file changed only on `base` after the fork would be dropped
 *     from the three-dot list but still show as a removal in the
 *     per-file delta if it were included.
 * Two-dot is the only direction consistent with the per-file path.
 *
 * Unlike `listChangedFilesSince`, this does NOT add untracked files because
 * both sides are fully committed refs.
 *
 * `--no-renames` mirrors the behaviour of `listChangedFilesSince` so a
 * `git mv` surfaces as D+A just as in the working-tree diff path.
 */
function listChangedFilesBetween(rootDir: string, base: string, head: string): string[] | null {
  try {
    const out = execFileSync('git', ['diff', '--name-only', '--no-renames', `${base}..${head}`], {
      encoding: 'utf-8',
      timeout: 5000,
      stdio: ['pipe', 'pipe', 'pipe'],
      cwd: rootDir,
    });
    return out
      .split('\n')
      .map((l) => l.trim())
      .filter(Boolean);
  } catch {
    return null;
  }
}

function readCurrentSource(rootDir: string, relPath: string): string | null {
  try {
    return fs.readFileSync(path.join(rootDir, relPath), 'utf-8');
  } catch {
    return null;
  }
}

interface FileDeltaForOnePathArgs {
  rootDir: string;
  ref: string;
  relPath: string;
  withFindingsDelta: boolean;
  withEdgesDelta: boolean;
  /** When set, use this ref as the "current" source instead of reading from disk. */
  head?: string;
}

function fileDeltaForOnePath(args: FileDeltaForOnePathArgs): FileDelta {
  const { rootDir, ref, relPath, withFindingsDelta, withEdgesDelta, head } = args;
  const currentSource = head !== undefined ? getFileAtRef(rootDir, head, relPath) : readCurrentSource(rootDir, relPath);
  const baselineSource = getFileAtRef(rootDir, ref, relPath);
  const language = detectLanguage(relPath, currentSource ?? baselineSource ?? undefined);
  const base: FileDelta = {
    filePath: relPath,
    hadBaseline: baselineSource !== null,
    hadCurrent: currentSource !== null,
    language,
    added: [],
    removed: [],
    modified: [],
  };
  if (!isLanguageSupported(language)) {
    return { ...base, skipReason: `unsupported language: ${language}` };
  }
  const filterKinds = (ns: Node[]): Node[] => ns.filter((n) => INTERESTING_KINDS.has(n.kind));
  // Tree-sitter WASM parsers throw synchronous "memory access out of bounds"
  // when fed certain inputs (huge files, malformed UTF-8, parser-state
  // corruption from concurrent use). Without this guard a single bad file
  // crashes the entire compareToRef call. Skip the offending file with a
  // diagnostic skipReason and continue with the rest of the changeset.
  let beforeExtraction: { nodes: Node[]; edges: Edge[] };
  let afterExtraction: { nodes: Node[]; edges: Edge[] };
  try {
    beforeExtraction = baselineSource
      ? extractFromSource(relPath, baselineSource, language)
      : { nodes: [] as Node[], edges: [] as Edge[] };
    afterExtraction = currentSource
      ? extractFromSource(relPath, currentSource, language)
      : { nodes: [] as Node[], edges: [] as Edge[] };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ...base, skipReason: `parser error: ${msg.slice(0, 200)}` };
  }
  const beforeAllNodes = beforeExtraction.nodes;
  const afterAllNodes = afterExtraction.nodes;
  const beforeNodes = filterKinds(beforeAllNodes);
  const afterNodes = filterKinds(afterAllNodes);
  const out: FileDelta = { ...base, ...diffNodeLists(beforeNodes, afterNodes) };
  if (withFindingsDelta) {
    out.findingsDelta = computeFindingsDelta(
      { source: baselineSource, nodes: beforeAllNodes },
      { source: currentSource, nodes: afterAllNodes },
      language,
    );
  }
  if (withEdgesDelta) {
    out.edgesDelta = diffEdgeLists({
      beforeNodes: beforeAllNodes,
      beforeEdges: beforeExtraction.edges,
      afterNodes: afterAllNodes,
      afterEdges: afterExtraction.edges,
    });
  }
  return out;
}

/**
 * Per-symbol findings key for cross-version matching. The biomarker
 * itself is part of the key so two findings on the same symbol with
 * different rule names (e.g. `large_method` vs `complex_method`) sort
 * into separate buckets — one cleared and one carried, rather than a
 * single mush.
 */
function findingKey(qualifiedName: string, kind: string, biomarker: string): string {
  return `${qualifiedName}::${kind}::${biomarker}`;
}

/**
 * Run the per-file biomarker engine in-memory on a parsed source and
 * the extracted node list. Returns one map entry per finding keyed by
 * `(qualifiedName, kind, biomarker)`; the value carries the symbol
 * surface needed for the delta report. Source/nodes empty → empty map
 * (the new-file or deleted-file case).
 */
function evaluateFileFindings(source: string | null, language: Language, nodes: Node[]): Map<string, FindingDelta> {
  const out = new Map<string, FindingDelta>();
  if (!source) return out;
  const tree = parseSource(source, language);
  if (!tree) return out;
  for (const n of nodes) {
    evaluateOneNodeFindings({ tree, n, language, out });
  }
  return out;
}

/**
 * Evaluate biomarker rules for one analysable node. Skip non-analysable kinds
 * and tiny bodies; swallow per-node tree-sitter or rule-evaluation errors so
 * one bad node doesn't sink the whole file's delta.
 */
interface EvaluateOneNodeFindingsArgs {
  tree: NonNullable<ReturnType<typeof parseSource>>;
  n: Node;
  language: Language;
  out: Map<string, FindingDelta>;
}

function evaluateOneNodeFindings(args: EvaluateOneNodeFindingsArgs): void {
  const { tree, n, language, out } = args;
  if (!ANALYSABLE_KINDS.has(n.kind)) return;
  if (n.endLine - n.startLine + 1 < ANALYSABLE_MIN_LOC) return;

  let astNode: ReturnType<typeof findNodeInTree> | undefined;
  try {
    astNode = findNodeInTree(tree, n.startLine, n.startColumn);
  } catch {
    return;
  }
  if (!astNode) return;

  // Same defensive guard as the persistent biomarker pass — drop the
  // symbol when the AST node spans a region wildly larger than what
  // the DB recorded. Friction #20 shape is the same here even though
  // compareToRef output is ephemeral; an inflated cyclomatic in the
  // diff still misleads the agent.
  if (
    astBodyNodeRangeMismatch({
      dbStartLine: n.startLine,
      dbEndLine: n.endLine,
      astStartRow: astNode.startPosition.row,
      astEndRow: astNode.endPosition.row,
    })
  ) {
    return;
  }

  let findings: Finding[];
  try {
    const metrics = computeMetrics({ bodyNode: astNode, language, startLine: n.startLine, endLine: n.endLine });
    findings = evaluateRules({ nodeId: n.id, language, metrics });
  } catch {
    return;
  }

  for (const f of findings) {
    out.set(findingKey(n.qualifiedName, n.kind, f.biomarker), {
      qualifiedName: n.qualifiedName,
      name: n.name,
      kind: n.kind,
      biomarker: f.biomarker,
      severity: f.severity,
      metric: f.metric,
    });
  }
}

interface FileSnapshot {
  source: string | null;
  nodes: Node[];
}

/**
 * Diff the two finding maps by `(qualifiedName, kind, biomarker)`.
 * Only-in-current → added (regression introduced by the edit). Only-
 * in-baseline → cleared (the edit fixed it). Both → carried, reported
 * with the CURRENT side's metric so the agent sees the live number.
 */
function computeFindingsDelta(before: FileSnapshot, after: FileSnapshot, language: Language): FindingsDelta {
  const beforeFindings = evaluateFileFindings(before.source, language, before.nodes);
  const afterFindings = evaluateFileFindings(after.source, language, after.nodes);
  const added: FindingDelta[] = [];
  const cleared: FindingDelta[] = [];
  const carried: FindingDelta[] = [];
  for (const [key, fd] of afterFindings) {
    if (beforeFindings.has(key)) carried.push(fd);
    else added.push(fd);
  }
  for (const [key, fd] of beforeFindings) {
    if (!afterFindings.has(key)) cleared.push(fd);
  }
  return { added, cleared, carried };
}

/**
 * extractFromSource needs the tree-sitter grammar for each language to
 * be loaded. The MCP server boots them lazily; the CLI shim and direct
 * library callers may not have. Loading is idempotent, so calling here
 * is a no-op when the host already prepared the grammar set.
 */
async function ensureGrammarsForFiles(rootDir: string, filePaths: ReadonlyArray<string>): Promise<void> {
  await initGrammars();
  const langs = new Set<Language>();
  for (const p of filePaths) {
    // Use the current source if readable; otherwise the path-based
    // detection still gives a usable answer for ext-mapped languages.
    const src = readCurrentSource(rootDir, p);
    const lang = detectLanguage(p, src ?? undefined);
    if (lang !== 'unknown' && isLanguageSupported(lang)) langs.add(lang);
  }
  if (langs.size > 0) await loadGrammarsForLanguages([...langs]);
}

/**
 * Attach current biomarker findings to each added/modified symbol.
 * Uses the persisted graph: matches on `(qualifiedName, filePath, kind)`
 * to find the node id, then reads its findings. Removed symbols don't
 * get findings (the node is gone from the index).
 */
function annotateBiomarkers(cg: Cartograph, files: FileDelta[]): void {
  for (const f of files) {
    const all = [...f.added, ...f.modified];
    if (all.length === 0) continue;
    const fileNodes = cg.queries.getNodesByFile(f.filePath);
    const byKey = new Map(fileNodes.map((n) => [`${n.qualifiedName}::${n.kind}`, n.id]));
    for (const sym of all) {
      const id = byKey.get(`${sym.qualifiedName}::${sym.kind}`);
      if (!id) continue;
      const findings = getFindingsForNode(cg.queries, id);
      if (findings.length === 0) continue;
      sym.findings = findings.map((x) => ({
        biomarker: x.biomarker,
        severity: x.severity,
        metric: x.metric,
      }));
    }
  }
}

/** Returns true if a file delta has any meaningful symbol or edge changes. */
function fileHasChanges(f: FileDelta): boolean {
  const hasSymbolChanges =
    f.added.length > 0 || f.removed.length > 0 || f.modified.length > 0 || (f.lineRangeOnlyCount ?? 0) > 0;
  const hasEdgeChanges =
    f.edgesDelta !== undefined && (f.edgesDelta.added.length > 0 || f.edgesDelta.removed.length > 0);
  return hasSymbolChanges || hasEdgeChanges;
}

/** Accumulates per-file deltas into aggregate totals. */
function accumulateTotals(files: FileDelta[], includeEdges: boolean): CompareResult['totals'] {
  const raw = files.reduce(
    (acc, f) => ({
      added: acc.added + f.added.length,
      removed: acc.removed + f.removed.length,
      modified: acc.modified + f.modified.length,
      edgesAdded: acc.edgesAdded + (f.edgesDelta?.added.length ?? 0),
      edgesRemoved: acc.edgesRemoved + (f.edgesDelta?.removed.length ?? 0),
    }),
    { added: 0, removed: 0, modified: 0, edgesAdded: 0, edgesRemoved: 0 },
  );
  return includeEdges ? raw : { added: raw.added, removed: raw.removed, modified: raw.modified };
}

interface BuildFileDeltasArgs {
  root: string;
  ref: string;
  filtered: string[];
  options: CompareOptions;
}

/** Builds per-file deltas for each changed path. */
function buildFileDeltas(args: BuildFileDeltasArgs): FileDelta[] {
  const { root, ref, filtered, options } = args;
  return filtered.map((p) =>
    fileDeltaForOnePath({
      rootDir: root,
      ref,
      relPath: p,
      withFindingsDelta: options.findingsDelta === true,
      withEdgesDelta: options.includeEdges === true,
      ...(options.head !== undefined ? { head: options.head } : {}),
    }),
  );
}

/**
 * Compare current state against a git ref (or between two refs when `head` is set).
 *
 * Degenerate `head === ref` case (e.g. caller explicitly passes `head: 'HEAD'`
 * while the default `ref` is also `'HEAD'`): the diff resolves to `ref..ref`,
 * which `listChangedFilesBetween` evaluates to an empty file list. The result
 * `ref` label collapses to the single ref (no `"HEAD..HEAD"` rendered) and
 * `filesChanged` is 0 — coherent, just empty. Pass a different `head` for a
 * meaningful branch-vs-branch diff.
 */
export async function compareToRef(cg: Cartograph, options: CompareOptions = {}): Promise<CompareResult> {
  const ref = options.ref ?? 'HEAD';
  const head = options.head;
  const root = cg.projectRoot;
  // When `head` is set, compare two refs; otherwise compare ref vs working tree.
  const allChanged = listChangedPaths(root, ref, head);
  // Label shown in the result: "base..head" for ref-to-ref, or just the ref for working-tree mode.
  // Degenerate case (ref === head) collapses to the single-ref label — see formatRefLabel.
  const refLabel = formatRefLabel(ref, head);
  if (allChanged === null) {
    return {
      ref: refLabel,
      filesScanned: 0,
      filesChanged: 0,
      filesSkipped: 0,
      totals: { added: 0, removed: 0, modified: 0 },
      files: [],
      error: gitFailureError(ref, head),
    };
  }
  const filtered = options.pathFilter ? allChanged.filter((p) => p.startsWith(options.pathFilter!)) : allChanged;
  await ensureGrammarsForFiles(root, filtered);
  // F#12 slice 1: compareToRef calls extractFromSource directly (not
  // via the orchestrator's parse phase), so the env-var channel that
  // carries config.largeFunctionThreshold to the extractor must be
  // primed here too — otherwise the diff display would extract a
  // different nested-fn set than the index when the user has overridden
  // the threshold. Mirrors `eoApplyExtractionEnvFromConfig` in
  // `src/extraction/extraction-phases.ts`.
  const threshold = cg.config.largeFunctionThreshold ?? 500;
  process.env['CARTOGRAPH_LARGE_FUNCTION_THRESHOLD'] = largeFunctionThresholdEnvValue(threshold);
  const files = buildFileDeltas({ root, ref, filtered, options });
  if (options.includeBiomarkers) annotateBiomarkers(cg, files);
  // Default true (2026-05-14): pure-renumber noise drowns out real changes on
  // every diff with upstream insertions. Pass `suppressLineRangeOnly: false`
  // to see every renumbered symbol individually (rare; usually for tests).
  if (options.suppressLineRangeOnly !== false) applyLineRangeOnlySuppression(files);
  const totals = accumulateTotals(files, options.includeEdges === true);
  const filesSkipped = files.filter((f) => f.skipReason !== undefined).length;
  // Record path-filter context so the renderer can tell "nothing
  // changed" apart from "the filter excluded every changed file".
  const pathFilterContext = buildPathFilterContext(options.pathFilter, allChanged.length, filtered.length);
  return {
    ref: refLabel,
    filesScanned: filtered.length,
    filesChanged: files.filter(fileHasChanges).length,
    filesSkipped,
    totals,
    files,
    ...(pathFilterContext ? { pathFilter: pathFilterContext } : {}),
  };
}

function buildPathFilterContext(
  pathFilter: string | undefined,
  changedBeforeFilter: number,
  matched: number,
): { value: string; changedBeforeFilter: number; matched: number } | null {
  if (pathFilter === undefined) return null;
  return { value: pathFilter, changedBeforeFilter, matched };
}

/**
 * Select the changed-file source: ref-to-ref (`head` set) walks
 * `listChangedFilesBetween`, otherwise the working tree vs `ref` via
 * `listChangedFilesSince`. Returns null when git fails (propagated as the
 * top-level error result). Behaviour-identical to the inline branch it
 * replaces — extracted to keep compareToRef's conditional load low.
 */
function listChangedPaths(root: string, ref: string, head: string | undefined): string[] | null {
  return head !== undefined ? listChangedFilesBetween(root, ref, head) : listChangedFilesSince(root, ref);
}

/**
 * Result label: `base..head` for a real ref-to-ref diff, otherwise the single
 * `ref`. The degenerate `head === ref` case (e.g. caller passed `head: 'HEAD'`
 * on a working-tree compare) collapses to the single-ref label — "HEAD..HEAD"
 * reads as a real diff when it never is.
 */
function formatRefLabel(ref: string, head: string | undefined): string {
  const isRealRefToRef = head !== undefined && head !== ref;
  return isRealRefToRef ? `${ref}..${head}` : ref;
}

/**
 * git-failure error text for the null changed-file case: names both refs in
 * ref-to-ref mode, just `ref` in working-tree mode.
 */
function gitFailureError(ref: string, head: string | undefined): string {
  return head !== undefined
    ? `git unavailable or one of "${ref}", "${head}" not found`
    : `git unavailable or ref "${ref}" not found`;
}

/**
 * Render `largeFunctionThreshold` for the `CARTOGRAPH_LARGE_FUNCTION_THRESHOLD`
 * env var: `Infinity` (the sentinel the extractor parses back) when the
 * threshold is positive-infinity, else the plain numeric string.
 */
function largeFunctionThresholdEnvValue(threshold: number): string {
  return threshold === Number.POSITIVE_INFINITY ? 'Infinity' : String(threshold);
}

/**
 * Returns true when a modified symbol's only reason is a line-range shift —
 * no signature change, no modifier flip, just renumbering from an upstream
 * insertion.
 */
function isPureLineRangeOnly(sym: SymbolDelta): boolean {
  const r = sym.modifiedReasons;
  return r !== undefined && r.length === 1 && r[0] === 'line range changed';
}

/**
 * Mutates each FileDelta in-place: partitions `modified` per-symbol into
 * "pure line-range-only shifts" (collapsed into `lineRangeOnlyCount`) and
 * real modifications (signature change, modifier flip — kept in `modified`).
 * The rollup line in the formatter accounts for the suppressed entries.
 *
 * Pre-2026-05-14 behaviour collapsed only when EVERY modified symbol was a
 * pure renumber. That left noise on every mixed file: a single new helper
 * shifted line numbers on 30+ symbols and surfaced all 30 as "modified"
 * rows. Per-symbol partitioning keeps the real changes individually visible
 * while still rolling up the renumber noise.
 */
function applyLineRangeOnlySuppression(files: FileDelta[]): void {
  for (const f of files) {
    if (f.modified.length === 0) continue;
    const real: SymbolDelta[] = [];
    let pureCount = 0;
    for (const sym of f.modified) {
      if (isPureLineRangeOnly(sym)) pureCount += 1;
      else real.push(sym);
    }
    if (pureCount === 0) continue;
    f.modified = real;
    f.lineRangeOnlyCount = (f.lineRangeOnlyCount ?? 0) + pureCount;
  }
}
