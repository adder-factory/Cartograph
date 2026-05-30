import { z } from 'zod';
import { projectPathField, nonEmptyString } from './_common-fields.js';
import { compareToRef, type CompareResult, type FileDelta, type SymbolDelta } from '../../compare/index.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok, err } from './_outcome.js';
import { AGENT_PRONE_BIOMARKERS } from './agent-audit-review.js';

/** Cap on edges-delta rows shown per add/remove section. The added /
 *  removed lists can run into hundreds on a wide refactor; clamping
 *  keeps the response within token-budget while the trailing rollup
 *  ("…and N more") tells the agent how much was omitted. */
const EDGES_DELTA_PREVIEW_CAP = 20;

/**
 * Format one symbol entry as a markdown bullet. Includes the location,
 * the modification reason chips when present, and a compact biomarker
 * trail (`unused_export warning`, `large_method warning`) so the agent
 * can spot newly-introduced findings without a follow-up call.
 */
function fmtSymbol(sym: SymbolDelta): string {
  const hasStart = sym.startLine !== undefined;
  const lineRange = ` (L${sym.startLine}–${sym.endLine ?? sym.startLine})`;
  const loc = hasStart ? lineRange : '';
  const reasons = sym.modifiedReasons && sym.modifiedReasons.length > 0 ? ` — ${sym.modifiedReasons.join(', ')}` : '';
  const findings =
    sym.findings && sym.findings.length > 0
      ? `  · findings: ${sym.findings.map((f) => `${f.biomarker} ${f.severity}`).join(', ')}`
      : '';
  return `  - \`${sym.qualifiedName}\` (${sym.kind})${loc}${reasons}${findings}`;
}

function fileStatusSuffix(f: FileDelta): string {
  if (!f.hadBaseline) return ' (new file)';
  if (!f.hadCurrent) return ' (deleted)';
  return '';
}

function appendSymbolList(out: string[], label: string, symbols: ReadonlyArray<SymbolDelta>): void {
  if (symbols.length === 0) return;
  out.push(`  **${label}:**`);
  for (const s of symbols) out.push(fmtSymbol(s));
}

function appendFindingsDelta(out: string[], fd: FileDelta['findingsDelta']): void {
  if (!fd) return;
  if (fd.added.length === 0 && fd.cleared.length === 0 && fd.carried.length === 0) return;
  if (fd.added.length > 0) {
    out.push('  **+ findings introduced:**');
    for (const x of fd.added) {
      out.push(`  - \`${x.qualifiedName}\` — ${x.biomarker} ${x.severity} (metric ${x.metric})`);
    }
  }
  if (fd.cleared.length > 0) {
    out.push('  **− findings cleared:**');
    for (const x of fd.cleared) {
      out.push(`  - \`${x.qualifiedName}\` — ${x.biomarker}`);
    }
  }
  if (fd.carried.length > 0) {
    // Collapsed: count only. Listing every carried finding doubles
    // the report length on a typical refactor diff and isn't usually
    // actionable — the agent cares about delta, not status quo.
    out.push(`  _${fd.carried.length} pre-existing finding(s) carried over._`);
  }
}

type EdgeEntry = NonNullable<FileDelta['edgesDelta']>['added'][number];

/** Render one endpoint: the resolved qualified name when available,
 *  else the raw node id (truncated — the full hash is pure token cost
 *  and carries no signal an agent can act on). */
function fmtEdgeEndpoint(name: string | undefined, rawId: string): string {
  if (name !== undefined && name.length > 0) return name;
  // Fallback only — name resolution missed this endpoint. Show a short
  // id prefix so it's still distinguishable without dumping the full hash.
  return `${rawId.slice(0, 24)}…`;
}

function fmtEdge(e: EdgeEntry): string {
  const lineNote = e.line === undefined ? '' : ` @L${e.line}`;
  const src = fmtEdgeEndpoint(e.sourceName, e.source);
  const tgt = fmtEdgeEndpoint(e.targetName, e.target);
  return `  - \`${e.kind}\` \`${src}\` → \`${tgt}\`${lineNote}`;
}

function appendEdgeSection(out: string[], label: string, edges: EdgeEntry[]): void {
  if (edges.length === 0) return;
  out.push(`  ${label} (${edges.length}):**`);
  for (const e of edges.slice(0, EDGES_DELTA_PREVIEW_CAP)) out.push(fmtEdge(e));
  const hasOverflow = edges.length > EDGES_DELTA_PREVIEW_CAP;
  if (hasOverflow) out.push(`  _…and ${edges.length - EDGES_DELTA_PREVIEW_CAP} more_`);
}

/** Edge kinds that carry no meaningful signal for a reviewer — structural
 *  containment and module imports produce long lists of raw node-id pairs
 *  that are harder to read than useful. Suppressed before rendering. */
const SUPPRESSED_EDGE_KINDS = new Set(['contains', 'imports']);

/** True for a self-referential edge — source and target are the same
 *  symbol. The dominant case is a `def_use` edge for a symbol's own
 *  intra-procedural data flow: it carries no cross-symbol change signal
 *  and reads as noise in a delta report. Compared by resolved name when
 *  available (the stable identity), falling back to the raw node id. */
function isSelfEdge(e: EdgeEntry): boolean {
  const src = e.sourceName ?? e.source;
  const tgt = e.targetName ?? e.target;
  return src === tgt;
}

/** Filter an edge list down to the rows worth showing: drop structural
 *  noise (contains / imports) and self-referential edges. */
function meaningfulEdges(edges: ReadonlyArray<EdgeEntry>): EdgeEntry[] {
  return edges.filter((e) => !SUPPRESSED_EDGE_KINDS.has(e.kind) && !isSelfEdge(e));
}

/** Render the per-file edge-delta sections. Called by `fmtFileSection`;
 *  also exported so unit tests can exercise the self-edge / noise-kind
 *  filtering directly, since it is otherwise only reachable through a
 *  full `compareToRef` run with opt-in `def_use` edges. */
export function appendEdgesDelta(out: string[], ed: FileDelta['edgesDelta']): void {
  if (!ed) return;
  // Filter out structural noise (contains / imports) and self-edges
  // before capping. The noise kinds dominate in added/deleted-file
  // diffs and bury the semantically meaningful call / reference /
  // extends edges; self-edges (e.g. a `def_use` to the symbol itself)
  // carry no cross-symbol signal.
  const added = meaningfulEdges(ed.added);
  const removed = meaningfulEdges(ed.removed);
  const hasChanges = added.length > 0 || removed.length > 0;
  if (!hasChanges) return;
  appendEdgeSection(out, '**+ edges added', added);
  appendEdgeSection(out, '**− edges removed', removed);
}

function fmtFileSection(f: FileDelta): string[] {
  const head: string[] = [`### \`${f.filePath}\`${fileStatusSuffix(f)}`];
  if (f.skipReason) head.push(`  _${f.skipReason}_`);
  const noStructural = f.added.length === 0 && f.removed.length === 0 && f.modified.length === 0;
  const fd = f.findingsDelta;
  const ed = f.edgesDelta;
  const noFindingsChanges = !fd || (fd.added.length === 0 && fd.cleared.length === 0 && fd.carried.length === 0);
  const noEdgeChanges = !hasRenderableEdges(ed);
  const hasLineRangeOnly = (f.lineRangeOnlyCount ?? 0) > 0;
  if (noStructural && noFindingsChanges && noEdgeChanges && !hasLineRangeOnly) {
    head.push('  _no symbol-level changes_');
    return head;
  }
  appendSymbolList(head, 'added', f.added);
  appendSymbolList(head, 'removed', f.removed);
  appendSymbolList(head, 'modified', f.modified);
  if (hasLineRangeOnly) {
    head.push(`  _${f.lineRangeOnlyCount} symbol(s) renumbered (line range changed only — no content change)._`);
  }
  appendFindingsDelta(head, fd);
  appendEdgesDelta(head, ed);
  return head;
}

function renderResult(result: CompareResult, findingsDeltaRequested = false): string {
  if (result.error) return `Error: ${result.error}`;
  const lines: string[] = [];
  lines.push(`## Structural delta vs \`${result.ref}\``, '');
  if (result.filesScanned === 0) {
    if (result.pathFilter && result.pathFilter.changedBeforeFilter > 0) {
      lines.push(
        `No changed files match path filter \`${result.pathFilter.value}\` ` +
          `(${result.pathFilter.changedBeforeFilter} file(s) differ from \`${result.ref}\` overall).`,
      );
    } else {
      lines.push(`No files differ from \`${result.ref}\`.`);
    }
    if (findingsDeltaRequested) {
      lines.push(`✓ findings delta computed — 0 per-file biomarker findings introduced, 0 cleared.`);
    }
    return lines.join('\n');
  }
  lines.push(
    `**${result.totals.added}** added · **${result.totals.removed}** removed · **${result.totals.modified}** modified across ${result.filesChanged}/${result.filesScanned} file(s).`,
  );
  if (result.totals.edgesAdded !== undefined && result.totals.edgesRemoved !== undefined) {
    lines.push(
      `**+${result.totals.edgesAdded}** edges added · **−${result.totals.edgesRemoved}** edges removed (intra-file).`,
    );
  }
  appendCompareFindingsTotals(lines, result.files, findingsDeltaRequested);
  appendCompareBodyOnlyFiles(lines, result);
  appendCompareSkippedFiles(lines, result);
  lines.push('');
  for (const f of result.files) {
    if (!shouldRenderCompareFile(f)) continue;
    lines.push(...fmtFileSection(f));
    lines.push('');
  }
  return lines.join('\n');
}

/**
 * Sum across-file added/cleared findings counts and emit the rollup line.
 * When `findingsDeltaRequested` is true and the delta is clean (0 introduced,
 * 0 cleared), emits a positive confirmation so the agent knows the flag was
 * honoured — identical to the principle behind the digest "clean" line.
 * When `findingsDeltaRequested` is false, emits nothing on a clean delta
 * (backward-compatible: only surfaces signal when there IS signal).
 */
function appendCompareFindingsTotals(
  lines: string[],
  files: CompareResult['files'],
  findingsDeltaRequested: boolean,
): void {
  let totalAdded = 0;
  let totalCleared = 0;
  let agentProneAdded = 0;
  const agentProneSet: ReadonlySet<string> = new Set(AGENT_PRONE_BIOMARKERS);
  for (const f of files) {
    if (!f.findingsDelta) continue;
    totalAdded += f.findingsDelta.added.length;
    totalCleared += f.findingsDelta.cleared.length;
    for (const a of f.findingsDelta.added) {
      if (agentProneSet.has(a.biomarker)) agentProneAdded += 1;
    }
  }
  if (totalAdded + totalCleared > 0) {
    lines.push(`**+${totalAdded}** findings introduced · **−${totalCleared}** findings cleared (per-file biomarkers).`);
    // G26 Phase 3 — `agentRisk` rollup. Surfaces the agent-prone
    // subset of the introduced findings so the agent's end-of-task
    // self-report shows "your edit added N patterns AI agents
    // disproportionately ship" without a separate cartograph_review
    // call. Suppressed when 0 — the line above already conveys the
    // overall delta.
    if (agentProneAdded > 0) {
      lines.push(
        `⚠ **${agentProneAdded}** of the introduced findings are in the agent-prone tier — call \`cartograph_review mode='agent-audit'\` for the per-detector breakdown.`,
      );
    }
  } else if (findingsDeltaRequested) {
    lines.push(`✓ findings delta computed — 0 per-file biomarker findings introduced, 0 cleared.`);
  }
}

/**
 * Emit the skip-count hint when `filesSkipped > 0`. Uses the pre-computed
 * `result.filesSkipped` count (avoids re-filtering) and lists paths inline.
 * Omitted entirely when 0 to keep clean diffs noise-free.
 *
 * @todo Add `--include-skipped` expansion flag for per-file detail on demand.
 */
function appendCompareSkippedFiles(lines: string[], result: CompareResult): void {
  if (result.filesSkipped === 0) return;
  lines.push(
    '',
    `> ${result.filesSkipped} file(s) skipped (non-indexed or non-TS): structural diff not available for these paths.`,
  );
  const skipped = result.files.filter((f) => f.skipReason);
  for (const f of skipped) lines.push(`  - \`${f.filePath}\` — ${f.skipReason}`);
}

/** True when the file's edge delta still has rows AFTER noise/self-edge
 *  filtering. Used so a file whose only edge changes are `contains` /
 *  `imports` / self-edges doesn't get an empty `### file` header. */
function hasRenderableEdges(ed: FileDelta['edgesDelta']): boolean {
  if (!ed) return false;
  return meaningfulEdges(ed.added).length > 0 || meaningfulEdges(ed.removed).length > 0;
}

/**
 * Emit the body-only-edits hint. A file git reports as changed but for
 * which the structural diff finds no symbol add/remove/signature change,
 * no findings delta, no edge delta, and no line-range roll-up is a
 * pure body-level edit (rename a local, tweak a literal, reorder
 * statements). These files are real changes but render nothing in the
 * per-file sections, so without this line `compare_to_ref` reads as
 * "nothing changed" when a genuine logic edit happened.
 *
 * Omitted when 0 to keep clean / fully-structural diffs noise-free.
 */
function appendCompareBodyOnlyFiles(lines: string[], result: CompareResult): void {
  const bodyOnly = result.files.filter((f) => !f.skipReason && !shouldRenderCompareFile(f));
  if (bodyOnly.length === 0) return;
  const n = bodyOnly.length;
  lines.push(
    '',
    `> ${n} file(s) changed with body-only edits (no symbol add/remove/signature change) — ` +
      `use \`cartograph_review\` or \`git diff\` for line-level review.`,
  );
  for (const f of bodyOnly) lines.push(`  - \`${f.filePath}\``);
}

/** True when the file has structural changes, findings-delta changes, edge-delta changes, or a line-range-only roll-up. */
function shouldRenderCompareFile(f: CompareResult['files'][number]): boolean {
  if (f.skipReason) return false;
  const hasStructural = f.added.length > 0 || f.removed.length > 0 || f.modified.length > 0;
  const hasFindings = !!f.findingsDelta && (f.findingsDelta.added.length > 0 || f.findingsDelta.cleared.length > 0);
  const hasEdges = hasRenderableEdges(f.edgesDelta);
  const hasLineRangeOnly = (f.lineRangeOnlyCount ?? 0) > 0;
  return hasStructural || hasFindings || hasEdges || hasLineRangeOnly;
}

/**
 * Zod schema for `cartograph_compare_to_ref`. All inputs are
 * string / boolean — no numeric range arg, so there is no clamp to
 * remove. Boolean flags stay `.optional()` and keep their existing
 * "absent ⇒ false" / (for `suppressLineRangeOnly`) "absent ⇒ true"
 * handler defaults; expressing those in the handler keeps the
 * `!== false` / `=== true` semantics identical.
 */
const compareToRefSchema = z.object({
  ref: nonEmptyString
    .optional()
    .describe(
      "Git ref to compare against (base). Default 'HEAD'; any rev-parse-able ref. When `head` is also set, this is the base of the branch-vs-branch diff.",
    ),
  head: nonEmptyString
    .optional()
    .describe(
      'When set, compare two git refs (base = `ref`, head = `head`) instead of the working tree; result label becomes `ref..head`. Use for PR review without a local checkout.',
    ),
  pathFilter: nonEmptyString
    .optional()
    .describe(
      "Restrict the diff to paths starting with this prefix (e.g. 'src/biomarkers/'); files outside it are skipped.",
    ),
  includeBiomarkers: z
    .boolean()
    .optional()
    .describe(
      'Attach current biomarker findings (from the persisted index) to each added/modified symbol. Off by default.',
    ),
  findingsDelta: z
    .boolean()
    .optional()
    .describe(
      'Compute per-file biomarker delta in-memory: findings the edits introduced, cleared, or carried over. No fresh index needed. Cross-file rules (unused_export, god_class, feature_envy) are skipped.',
    ),
  includeEdges: z
    .boolean()
    .optional()
    .describe(
      'Compute per-file edge delta — added/removed intra-file edges (calls, references, field_access, etc.) by stable (qualifiedName, edgeKind) identity, so body line shifts are ignored. Cross-file edges excluded. Off by default.',
    ),
  suppressLineRangeOnly: z
    .boolean()
    .optional()
    .describe(
      "Collapse pure-renumber noise: modified symbols whose only change is 'line range changed' move into a per-file roll-up line; real modifications still surface individually. Default true. Pass false to list every renumbered symbol.",
    ),
  projectPath: projectPathField,
});

type CompareToRefToolArgs = z.infer<typeof compareToRefSchema>;

async function handleCompareToRef(ctx: ToolCtx, args: CompareToRefToolArgs): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args.projectPath);
  // `ref` / `head` / `pathFilter` are Zod-validated non-blank strings
  // when present — no `validateString` pass needed.
  const ref = args.ref;
  const head = args.head;
  const pathFilter = args.pathFilter;
  const includeBiomarkers = args.includeBiomarkers === true;
  const findingsDelta = args.findingsDelta === true;
  const includeEdges = args.includeEdges === true;
  // Default true (2026-05-14): renumber noise is suppressed unless the caller
  // explicitly opts out with `suppressLineRangeOnly: false`. Per-symbol policy
  // — real modifications in the same file still surface individually.
  const suppressLineRangeOnly = args.suppressLineRangeOnly !== false;
  const result = await compareToRef(cg, {
    ...(ref === undefined ? {} : { ref }),
    ...(head === undefined ? {} : { head }),
    ...(pathFilter === undefined ? {} : { pathFilter }),
    includeBiomarkers,
    findingsDelta,
    includeEdges,
    suppressLineRangeOnly,
  });
  const rendered = renderResult(result, findingsDelta);
  // A bad/unparseable ref or head surfaces as `result.error` — return it
  // via the typed `err` arm so runViaMCP flips the CLI exit code to 1
  // ("printed an error" ⇒ "exited non-zero", audit-4 group-3 #3). The
  // error message is short by construction; no truncation needed.
  if (result.error) return err(rendered);
  // The structural-delta body routes through the chokepoint so
  // truncation is owned centrally.
  return ok(renderToolResponse({ body: rendered }));
}

export const COMPARE_TO_REF_TOOL = defineTool({
  name: 'cartograph_compare_to_ref',
  description:
    "End-of-task self-report — symbol-level +/-/~ delta vs a git ref. Call before reporting 'done'.\n\n" +
    'Default: working tree vs HEAD. Pass `head` for branch-vs-branch (PR review without checkout). ' +
    '`includeBiomarkers: true` attaches current findings; `findingsDelta: true` computes in-memory introduced/cleared/carried findings (cross-file biomarkers excluded).',
  schema: compareToRefSchema,
  handle: handleCompareToRef,
});
