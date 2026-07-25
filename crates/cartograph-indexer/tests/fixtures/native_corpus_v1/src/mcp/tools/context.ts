import { z } from 'zod';
import { lowTokensField, projectPathField } from './_common-fields.js';
import type { ToolResult } from '../tool-types.js';
import { getNodeCoverage } from '../../db/queries-coverage.js';
import { getFindingsForNode } from '../../db/queries-findings.js';
import { compareSeverity } from '../../biomarkers/types.js';
import { createHash } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type Cartograph from '../../index.js';
import type { TaskContext } from '../../context/types.js';
import type { ScoreExplanation } from '../../graph/types.js';
import type { Node } from '../../types.js';
import type { SearchResult } from '../../search/types.js';
import {
  ContextRetrievalModeSchema,
  prepareBehaviorRetrieval,
  type BehaviorRetrievalTrace,
} from '../../context/behavior-retrieval.js';
import {
  analyzeCodingTask,
  buildContextRoute,
  collectContextIntentSeeds,
  type ContextRoute,
} from '../../features/context-route/index.js';
import {
  buildWorkingTreeOverlay,
  WorkingTreeOverlayModeSchema,
  type WorkingTreeOverlayReport,
} from '../../features/working-tree-overlay/index.js';
import {
  buildTaskHandoffPacket,
  renderTaskHandoffPacket,
  type TaskHandoffAction,
  type TaskHandoffIndexFreshness,
} from '../../features/task-handoff/index.js';
import {
  collectProjectLearningSeeds,
  ProjectLearningModeSchema,
  type ProjectLearningReport,
} from '../../features/retrieval-learning/index.js';
import { mcpServerProfileIncludesTool, resolveMcpServerProfile } from '../profiles.js';
import { formatContextAsMarkdown } from '../../context/formatter.js';
import { renderScoreExplanation } from '../../context/score-trace.js';
import { textResult } from './shared.js';
import { renderToolResponse } from './_response.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, err, ok } from './_outcome.js';

/**
 * Mark a Claude session as having consulted MCP tools.
 * This enables Grep/Glob/Bash commands that would otherwise be blocked.
 */
function markSessionConsulted(sessionId: string): void {
  try {
    // Non-security cache key — sha256 truncated to 16 hex chars
    // matches md5's length without the broken-for-security baggage.
    const hash = createHash('sha256').update(sessionId).digest('hex').slice(0, 16);
    const markerPath = join(tmpdir(), `cartograph-consulted-${hash}`);
    writeFileSync(markerPath, new Date().toISOString(), 'utf8');
  } catch {
    // Silently fail - don't break MCP on marker write failure
  }
}

/**
 * Heuristic to detect if a query looks like a feature request — used
 * to append a "ask user about UX" reminder to the context output.
 */
function looksLikeFeatureRequest(task: string): boolean {
  const featureKeywords = [
    'add',
    'create',
    'implement',
    'build',
    'enable',
    'allow',
    'new feature',
    'support for',
    'ability to',
    'want to',
    'should be able',
    'need to add',
    'swap',
    'edit',
    'modify',
  ];
  const bugKeywords = [
    'fix',
    'bug',
    'error',
    'broken',
    'crash',
    'issue',
    'problem',
    'not working',
    'fails',
    'undefined',
    'null',
  ];
  const explorationKeywords = [
    'how does',
    'where is',
    'what is',
    'find',
    'show me',
    'explain',
    'understand',
    'explore',
  ];

  const lowerTask = task.toLowerCase();
  const hasKeyword = (keyword: string): boolean => {
    if (keyword.includes(' ')) return lowerTask.includes(keyword);
    const escapedKeyword = keyword.replaceAll(/[.*+?^${}()|[\]\\]/g, String.raw`\$&`);
    return new RegExp(String.raw`\b${escapedKeyword}\b`).test(lowerTask);
  };

  // If it's clearly a bug or exploration, not a feature
  if (bugKeywords.some((k) => hasKeyword(k))) return false;
  if (explorationKeywords.some((k) => hasKeyword(k))) return false;

  // If it matches feature keywords, it's likely a feature request
  return featureKeywords.some((k) => hasKeyword(k));
}

const CROSS_CUTTING_TASK_PATTERNS: ReadonlyArray<RegExp> = [
  /\bwhole\s+codebase\b/i,
  /\bentire\s+codebase\b/i,
  /\bcross[-\s]?cutting\b/i,
  /\ball\s+(?:tools|features|modules|languages|resolvers|extractors)\b/i,
  /\bcoverage\b/i,
  /\baudit\b/i,
  /\bquality\b/i,
  /\bissues?\s+and\s+prs?\b/i,
  /\bpatterns?\s+across\b/i,
];

function looksLikeCrossCuttingTask(task: string): boolean {
  return CROSS_CUTTING_TASK_PATTERNS.some((re) => re.test(task));
}

/**
 * Pick the single most-severe biomarker finding on a node. Returns
 * `null` when the findings table is absent (e.g. older indexes) or
 * the node has no findings.
 */
type ContextFindingSummary = { biomarker: string; severity: 'info' | 'warning' | 'error' };

function topFindingForNode(cg: Cartograph, nodeId: string): ContextFindingSummary | null {
  let top: ContextFindingSummary | null = null;
  try {
    const findings = getFindingsForNode(cg.queries, nodeId);
    for (const f of findings) {
      if (!top || compareSeverity(f.severity, top.severity) > 0) {
        top = { biomarker: f.biomarker, severity: f.severity };
      }
    }
  } catch {
    /* table absent */
  }
  return top;
}

/** Coverage percentage in [0, 1], or null when unavailable. */
function coverageForNode(cg: Cartograph, nodeId: string): number | null {
  try {
    const cov = getNodeCoverage(cg.queries, nodeId);
    if (cov && cov.totalLines > 0) return cov.coveredLines / cov.totalLines;
  } catch {
    /* table absent */
  }
  return null;
}

/**
 * Days since the file was last touched per churn metadata.
 * `cache` memoises the file-level lookup so a batch of symbols in
 * the same file pays one DB round-trip.
 */
function lastTouchedDaysForFile(cg: Cartograph, filePath: string, cache: Map<string, number | null>): number | null {
  let touchedTs = cache.get(filePath);
  if (touchedTs === undefined) {
    try {
      const churn = cg.stats.getFileChurn(filePath);
      touchedTs = churn?.lastTouchedTs ?? null;
    } catch {
      touchedTs = null;
    }
    cache.set(filePath, touchedTs);
  }
  if (touchedTs === null) return null;
  return Math.floor((Date.now() / 1000 - touchedTs) / 86400);
}

/**
 * Compose per-symbol risk metadata (biomarkers, coverage, last-touched)
 * for symbols already in the context subgraph. Composes existing
 * data-layer queries — no new index work — so this runs in <5ms even
 * on a 50-symbol context.
 *
 * Renders a single "Risk signals" markdown section. Each row carries
 * the most-severe biomarker the symbol has (one), its coverage
 * percentage if loaded, and a last-touched-ago timestamp from the
 * file's churn metadata. Symbols with no signals across all three
 * lenses are omitted.
 *
 * Returns `''` when no symbols have any signal.
 */
/** Days threshold (30) below which `fmtAgo` reports in days; at/above, in months. */
const FMT_AGO_DAYS_TO_MONTHS = 30;
/** Multiplier (100) converting a 0..1 coverage fraction to a percentage. */
const COVERAGE_PCT_SCALE = 100;

interface RiskRow {
  name: string;
  kind: string;
  filePath: string;
  line: number;
  biomarker: { name: string; severity: 'info' | 'warning' | 'error' } | null;
  coveragePct: number | null;
  lastTouchedDays: number | null;
}

/**
 * Render a "how long ago was this touched" suffix in the smallest
 * unit that still reads naturally — `today`, `1d ago`, `12d ago`,
 * `1mo ago`, `3mo ago`. Days < 30 stay in days; everything else
 * collapses to months.
 */
function fmtAgo(days: number): string {
  if (days <= 0) return 'today';
  if (days === 1) return '1d ago';
  if (days < FMT_AGO_DAYS_TO_MONTHS) return `${days}d ago`;
  const months = Math.floor(days / FMT_AGO_DAYS_TO_MONTHS);
  return months === 1 ? '1mo ago' : `${months}mo ago`;
}

/** Severity → traffic-light icon for the biomarker badge in each row. */
function severityIcon(sev: 'info' | 'warning' | 'error'): string {
  if (sev === 'error') return '🔴';
  if (sev === 'warning') return '🟡';
  return '⚪';
}

function formatContextRiskSignals(cg: Cartograph, nodes: Node[]): string {
  if (nodes.length === 0) return '';

  const fileTouchCache = new Map<string, number | null>();
  const rows: RiskRow[] = [];

  for (const n of nodes) {
    const topFinding = topFindingForNode(cg, n.id);
    const coveragePct = coverageForNode(cg, n.id);
    const lastTouchedDays = lastTouchedDaysForFile(cg, n.filePath, fileTouchCache);

    // Skip rows with no signals across any lens — keeps the section tight.
    if (!topFinding && coveragePct === null && lastTouchedDays === null) continue;

    rows.push({
      name: n.name,
      kind: n.kind,
      filePath: n.filePath,
      line: n.startLine,
      biomarker: topFinding ? { name: topFinding.biomarker, severity: topFinding.severity } : null,
      coveragePct,
      lastTouchedDays,
    });
  }

  if (rows.length === 0) return '';

  const lines: string[] = [
    '',
    '### Risk signals',
    '',
    '_Why shown here: candidate symbols with biomarkers, ingested coverage, or file churn metadata._',
    '',
  ];
  for (const r of rows) {
    lines.push(formatRiskRow(r));
  }
  lines.push('');
  return lines.join('\n');
}

/** Render one risk row as `- \`name\` (kind) — path:line (flag1, flag2, ...)`. */
function formatRiskRow(r: RiskRow): string {
  const parts: string[] = [`- \`${r.name}\` (${r.kind}) — ${r.filePath}:${r.line}`];
  const flags: string[] = [];
  if (r.biomarker) {
    flags.push(`${severityIcon(r.biomarker.severity)} ${r.biomarker.name}`);
  }
  if (r.coveragePct !== null) {
    flags.push(`coverage ${(r.coveragePct * COVERAGE_PCT_SCALE).toFixed(0)}%`);
  }
  if (r.lastTouchedDays !== null) {
    flags.push(`touched ${fmtAgo(r.lastTouchedDays)}`);
  }
  if (flags.length > 0) parts.push(`(${flags.join(', ')})`);
  return parts.join(' ');
}

/**
 * Annotate the rendered `explain`-mode score trace with a per-candidate
 * "entered at pass X" marker.
 *
 * A candidate that joins the retrieval pool mid-pipeline (e.g.
 * `FileWatcher` seeded by `semantic-extras` rather than the leading
 * `lexical-merge` pass) has no row for the passes it missed. Without a
 * marker the agent has to diff the candidate's first listed pass against
 * the trace header's pass list to see where it entered. This appends an
 * explicit `(entered at <pass>)` suffix to the header line of every
 * candidate whose first pass is not the pipeline's first pass — the
 * candidates seeded from pass 0 read as normal (no suffix is noise).
 *
 * Operates on `renderScoreExplanation`'s output by reconstructing each
 * candidate's exact header-line prefix from the structured trace, so the
 * match is deterministic (no fragile regex over the rendered text).
 */
export function annotateScoreTraceEntryMarkers(rendered: string, trace: ScoreExplanation): string {
  const firstPass = trace.passNames[0];
  if (!firstPass || rendered === '') return rendered;

  // candidate header-line prefix → entry pass, for candidates that
  // entered after pass 0. Mirrors the header format emitted by
  // `renderScoreExplanation`: `${mark} ${name} (${kind})  ${path}:${line}  final ${score}`.
  const markerByPrefix = new Map<string, string>();
  for (const c of trace.candidates) {
    const entryPass = c.passes[0]?.pass;
    if (!entryPass || entryPass === firstPass) continue;
    const mark = c.survived ? '[+]' : '[-]';
    const prefix = `${mark} ${c.name} (${c.kind})  ${c.filePath}:${c.line}  final ${c.finalScore.toFixed(2)}`;
    markerByPrefix.set(prefix, entryPass);
  }
  if (markerByPrefix.size === 0) return rendered;

  return rendered
    .split('\n')
    .map((line) => {
      const marker = markerByPrefix.get(line);
      return marker ? `${line}  (entered at ${marker})` : line;
    })
    .join('\n');
}

interface FormatContextResponseArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  task: string;
  context: TaskContext;
  format: ContextFormat;
  retrieval: BehaviorRetrievalTrace;
  route: ContextRoute;
  workingTree: WorkingTreeOverlayReport;
  projectLearning: ProjectLearningReport;
  toolAvailable: (toolName: string) => boolean;
}

type ContextFormat = 'markdown' | 'json' | 'plan' | 'handoff';
type NextAction = TaskHandoffAction;

const PLAN_ACTION_NODE_LIMIT = 3;
const PLAN_RENDER_NODE_LIMIT = 8;
const PLAN_SEMANTIC_FIND_LIMIT = 10;
const PLAN_IMPACT_HOPS = 2;
const PLAN_IMPACT_MAX_NODES = 50;
const PLAN_PRIORITY_PRIMARY = 1;
const PLAN_PRIORITY_IMPACT = 2;
const PLAN_PRIORITY_TESTS = 3;
const PLAN_PRIORITY_SKIM = 4;
const PLAN_PRIORITY_FINAL_CHECK = 99;

function attachNextActions(result: ToolResult, nextActions: NextAction[]): ToolResult {
  if (nextActions.length === 0) return result;
  return {
    ...result,
    metadata: {
      ...result.metadata,
      nextActions,
    },
  };
}

function topContextNodes(context: TaskContext, limit: number): Node[] {
  return Array.from(context.subgraph.nodes.values()).slice(0, limit);
}

interface BuildContextNextActionsArgs {
  context: TaskContext;
  task: string;
  route: ContextRoute;
  toolAvailable: (toolName: string) => boolean;
}

function buildContextNextActions(args: BuildContextNextActionsArgs): NextAction[] {
  const { context, task, route, toolAvailable } = args;
  const nodes = contextActionNodes(context, route);
  const crossCutting = looksLikeCrossCuttingTask(task);
  const actions =
    nodes.length === 0 || route.status === 'abstained'
      ? buildFallbackContextActions({ task, crossCutting, toolAvailable })
      : buildRoutedContextActions({ task, nodes, crossCutting, toolAvailable });
  return actions.filter((action) => toolAvailable(action.tool));
}

function contextActionNodes(context: TaskContext, route: ContextRoute): Node[] {
  const routeNodeIds = route.candidates
    .filter((candidate) => candidate.bucket === 'edit-site' && candidate.confidence !== 'low')
    .map((candidate) => candidate.nodeId);
  const nodesById = context.subgraph.nodes;
  const routedNodes = routeNodeIds.flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    return node ? [node] : [];
  });
  const candidates = routedNodes.length > 0 ? routedNodes : topContextNodes(context, PLAN_ACTION_NODE_LIMIT);
  return candidates.slice(0, PLAN_ACTION_NODE_LIMIT);
}

interface BuildFallbackContextActionsArgs {
  task: string;
  crossCutting: boolean;
  toolAvailable: (toolName: string) => boolean;
}

function buildFallbackContextActions(args: BuildFallbackContextActionsArgs): NextAction[] {
  const searchMode = args.crossCutting ? 'intent' : 'semantic';
  const fallback: NextAction[] = [
    {
      tool: 'cartograph_find',
      args: { by: 'name', mode: searchMode, query: args.task, limit: PLAN_SEMANTIC_FIND_LIMIT, lowTokens: true },
      reason: args.crossCutting
        ? 'Try concept-oriented retrieval because broad cross-cutting wording found no entry symbols.'
        : 'Try a broader semantic symbol search because context found no entry symbols.',
      priority: PLAN_PRIORITY_PRIMARY,
    },
    {
      tool: 'cartograph_files',
      args: { format: 'summary', lowTokens: true },
      reason: 'Re-orient around indexed directory structure before trying content search.',
      priority: PLAN_PRIORITY_IMPACT,
    },
  ];
  if (args.crossCutting && args.toolAvailable('cartograph_deps')) {
    fallback.unshift(buildDependencyCoverageAction());
  }
  return fallback;
}

interface BuildRoutedContextActionsArgs {
  task: string;
  nodes: readonly Node[];
  crossCutting: boolean;
  toolAvailable: (toolName: string) => boolean;
}

function buildRoutedContextActions(args: BuildRoutedContextActionsArgs): NextAction[] {
  const primary = args.nodes[0]!;
  const actions = buildCrossCuttingContextActions(args.task, args.crossCutting, args.toolAvailable);
  actions.push(...buildPrimaryContextActions(primary, args.crossCutting));
  appendAdjacentContextAction(actions, args.nodes.slice(1));
  actions.push(buildFinalVerificationAction(args.toolAvailable));
  return actions;
}

function buildCrossCuttingContextActions(
  task: string,
  crossCutting: boolean,
  toolAvailable: (toolName: string) => boolean,
): NextAction[] {
  if (!crossCutting) return [];
  const actions: NextAction[] = [];
  if (toolAvailable('cartograph_deps')) actions.push(buildDependencyCoverageAction());
  actions.push({
    tool: 'cartograph_find',
    args: { by: 'name', mode: 'intent', query: task, limit: PLAN_SEMANTIC_FIND_LIMIT, lowTokens: true },
    reason: 'Cross-cutting wording benefits from concept search before committing to one symbol route.',
    priority: PLAN_PRIORITY_PRIMARY,
  });
  return actions;
}

function buildPrimaryContextActions(primary: Node, crossCutting: boolean): NextAction[] {
  const priority = crossCutting ? PLAN_PRIORITY_SKIM : PLAN_PRIORITY_PRIMARY;
  return [
    {
      tool: 'cartograph_node',
      args: {
        symbol: primary.id,
        includeCallers: true,
        includeCallees: true,
        includeBiomarkers: true,
        includeTests: true,
      },
      reason: `Inspect the leading candidate \`${primary.name}\` with local risk and test signals.`,
      priority,
    },
    {
      tool: 'cartograph_graph',
      args: {
        start: primary.id,
        direction: 'impact',
        hops: PLAN_IMPACT_HOPS,
        includeTests: false,
        maxNodes: PLAN_IMPACT_MAX_NODES,
        lowTokens: true,
      },
      reason: `Map the blast radius around \`${primary.name}\` before editing.`,
      priority: crossCutting ? PLAN_PRIORITY_SKIM : PLAN_PRIORITY_IMPACT,
    },
    {
      tool: 'cartograph_tests_for',
      args: { symbol: primary.id },
      reason: `Find tests that directly or transitively cover \`${primary.name}\`.`,
      priority: crossCutting ? PLAN_PRIORITY_SKIM : PLAN_PRIORITY_TESTS,
    },
  ];
}

function appendAdjacentContextAction(actions: NextAction[], rest: readonly Node[]): void {
  if (rest.length > 0) {
    actions.push({
      tool: 'cartograph_node',
      args: { symbols: rest.map((n) => n.id), lowTokens: true },
      reason: 'Skim adjacent candidate symbols without pulling source bodies.',
      priority: PLAN_PRIORITY_SKIM,
    });
  }
}

function buildFinalVerificationAction(toolAvailable: (toolName: string) => boolean): NextAction {
  if (toolAvailable('cartograph_verify')) {
    return {
      tool: 'cartograph_verify',
      args: {},
      reason: 'After edits, select tests and compute the structural/finding delta in one verification packet.',
      priority: PLAN_PRIORITY_FINAL_CHECK,
    };
  }
  return {
    tool: 'cartograph_compare_to_ref',
    args: { findingsDelta: true },
    reason: 'Run this before reporting done after code edits.',
    priority: PLAN_PRIORITY_FINAL_CHECK,
  };
}

function buildDependencyCoverageAction(): NextAction {
  return {
    tool: 'cartograph_deps',
    args: { mode: 'coverage', lowTokens: true, limit: 20 },
    reason: 'Measure graph resolution gaps before drilling into one symbol for a broad cross-cutting task.',
    priority: PLAN_PRIORITY_PRIMARY,
  };
}

function renderContextPlan(args: {
  task: string;
  context: TaskContext;
  nextActions: NextAction[];
  retrieval: BehaviorRetrievalTrace;
  route: ContextRoute;
  workingTree: WorkingTreeOverlayReport;
  projectLearning: ProjectLearningReport;
}): string {
  const { task, nextActions, retrieval, route, workingTree, projectLearning } = args;
  const entryLines = renderRouteCandidateGroups(route);
  const anchorParts = [
    ...route.anchors.identifiers.map((anchor) => `\`${anchor}\``),
    ...route.anchors.paths.map((anchor) => `\`${anchor}\``),
  ];
  const decisionLines =
    route.status === 'abstained'
      ? [
          '',
          `> **Router abstained:** ${route.reason}`,
          '> Use the fallback calls below to narrow the task before editing.',
          '',
        ]
      : [];

  return [
    `## Context route plan`,
    '',
    `**Query:** ${task}`,
    `**Retrieval:** ${describeRetrieval(retrieval)}`,
    '**Router:** deterministic task clauses + intent/documentation evidence + graph candidates',
    `**Task kind:** ${route.taskKind}`,
    `**Clauses:** ${route.clauses.join(' | ')}`,
    `**Explicit anchors:** ${anchorParts.length > 0 ? anchorParts.join(', ') : 'none detected'}`,
    `**Working tree:** ${describeWorkingTreeOverlay(workingTree)}`,
    `**Project-local learning:** ${describeProjectLearning(projectLearning)}`,
    '',
    ...decisionLines,
    ...entryLines,
    '### Next MCP calls',
    '',
    '```json',
    JSON.stringify(nextActions, null, 2),
    '```',
    '',
    '### Route notes',
    '',
    '- Start with the priority-1 call, then widen only if the caller/callee map shows real blast radius.',
    '- Use preview or low-token calls until you know the edit target.',
    '- After edits, call `cartograph_verify` for tiered tests, commands, and structural/finding deltas.',
  ].join('\n');
}

function renderRouteCandidateGroups(route: ContextRoute): string[] {
  if (route.candidates.length === 0)
    return ['_No relevant symbols were found. Start with the fallback calls below._', ''];
  const groups: ReadonlyArray<readonly [ContextRoute['candidates'][number]['bucket'], string]> = [
    ['edit-site', 'Likely edit sites'],
    ['supporting', 'Supporting context'],
    ['test', 'Tests'],
    ['configuration', 'Configuration'],
  ];
  const lines: string[] = [];
  let rendered = 0;
  for (const [bucket, heading] of groups) {
    const candidates = route.candidates.filter((candidate) => candidate.bucket === bucket);
    if (candidates.length === 0) continue;
    lines.push(`### ${heading}`, '');
    for (const candidate of candidates) {
      if (rendered >= PLAN_RENDER_NODE_LIMIT) break;
      const location = candidate.line > 0 ? `:${candidate.line}` : '';
      lines.push(
        `- **${candidate.confidence}** \`${candidate.name}\` (${candidate.kind}) — ${candidate.filePath}${location}`,
        `  Why: ${candidate.evidence.join('; ')}`,
      );
      rendered++;
    }
    lines.push('');
    if (rendered >= PLAN_RENDER_NODE_LIMIT) break;
  }
  return lines;
}

/** Render the context object into a tool result. Extracted from {@link handleContext}. */
function formatContextResponse(args: FormatContextResponseArgs): ToolResult {
  const nextActions = buildContextNextActions({
    context: args.context,
    task: args.task,
    route: args.route,
    toolAvailable: args.toolAvailable,
  });
  if (args.format === 'json') return formatJsonContextResponse(args, nextActions);
  if (args.format === 'plan') return formatPlanContextResponse(args, nextActions);
  if (args.format === 'handoff') return formatHandoffContextResponse(args, nextActions);
  return formatMarkdownContextResponse(args, nextActions);
}

function formatJsonContextResponse(args: FormatContextResponseArgs, nextActions: NextAction[]): ToolResult {
  const { context, retrieval, route, workingTree, projectLearning } = args;
  // JSON consumers get a properly serialized TaskContext. `subgraph.nodes`
  // is a Map which `JSON.stringify` renders as `{}` — serialize it to an array
  // so programmatic consumers can iterate nodes. The score trace is included
  // when `explain: true` was requested.
  const serializable = {
    query: context.query,
    summary: context.summary,
    entryPoints: context.entryPoints,
    subgraph: {
      nodes: Array.from(context.subgraph.nodes.values()),
      edges: context.subgraph.edges,
      roots: context.subgraph.roots,
      ...(context.subgraph.scoreTrace === undefined ? {} : { scoreTrace: context.subgraph.scoreTrace }),
    },
    codeBlocks: context.codeBlocks,
    relatedFiles: context.relatedFiles,
    stats: context.stats,
    retrieval,
    route,
    workingTree,
    projectLearning,
  };
  return attachNextActions(textResult(JSON.stringify(serializable, null, 2)), nextActions);
}

function formatPlanContextResponse(args: FormatContextResponseArgs, nextActions: NextAction[]): ToolResult {
  const { task, context, retrieval, route, workingTree, projectLearning } = args;
  return attachNextActions(
    textResult(renderContextPlan({ task, context, nextActions, retrieval, route, workingTree, projectLearning })),
    nextActions,
  );
}

function formatHandoffContextResponse(args: FormatContextResponseArgs, nextActions: NextAction[]): ToolResult {
  const packet = buildTaskHandoffPacket({
    task: args.task,
    route: args.route,
    contextFiles: args.context.relatedFiles,
    indexFreshness: taskHandoffIndexFreshness(args.cg),
    workingTree: args.workingTree,
    projectLearning: args.projectLearning,
    nextActions,
  });
  return attachNextActions(textResult(renderTaskHandoffPacket(packet)), nextActions);
}

function formatMarkdownContextResponse(args: FormatContextResponseArgs, nextActions: NextAction[]): ToolResult {
  const nodes = [...args.context.subgraph.nodes.values()];
  if (nodes.length === 0) return formatEmptyMarkdownContextResponse(args, nextActions);
  return formatPopulatedMarkdownContextResponse(args, nodes, nextActions);
}

function formatEmptyMarkdownContextResponse(args: FormatContextResponseArgs, nextActions: NextAction[]): ToolResult {
  // No-match guard (audit-4 #5): a 0-node subgraph would otherwise
  // render a bare `## Code Context` + `**Query:**` stub with no
  // "nothing found" line and no freshness hint — leaving the agent
  // unable to tell a stale index from a genuine empty result. Mirror
  // explore's empty path.
  // Empty-result branch: the `## Code Context` stub is the message;
  // the chokepoint appends the index-freshness hint so the agent
  // can tell a stale index from a genuine miss (audit-4 #5).
  const message =
    `## Code Context\n\n**Query:** ${args.task}\n\n_Retrieval: ${describeRetrieval(args.retrieval)}_\n\n` +
    `No relevant code found for "${args.task}".` +
    formatWorkingTreeOverlay(args.workingTree) +
    formatProjectLearning(args.projectLearning);
  return attachNextActions(
    renderToolResponse({ body: '', empty: { message, freshness: { cg: args.cg } } }),
    nextActions,
  );
}

function formatPopulatedMarkdownContextResponse(
  args: FormatContextResponseArgs,
  nodes: Node[],
  nextActions: NextAction[],
): ToolResult {
  const isFeatureQuery = looksLikeFeatureRequest(args.task);
  const reminder = isFeatureQuery ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria' : '';
  const trace = args.context.subgraph.scoreTrace
    ? annotateScoreTraceEntryMarkers(
        renderScoreExplanation(args.context.subgraph.scoreTrace),
        args.context.subgraph.scoreTrace,
      )
    : '';
  // Passive `explain:true` nudge. Off-target ranking (a result that
  // shares a lexeme with the query but isn't structurally relevant) is
  // diagnosable in one re-run with `explain:true`, but agents new to
  // the tool often don't know to reach for it. Surface the option here
  // for ranked-multi-result, non-explain calls only — single-hit
  // responses never have a ranking question and an explain-requested
  // call already renders the trace below.
  const explainHint =
    args.context.subgraph.scoreTrace === undefined && nodes.length >= 3
      ? '\n\n_Top result not what you expected? Pass `explain: true` for a per-candidate score trace that names which retrieval pass elevated each row._'
      : '';
  const body =
    formatContextAsMarkdown(args.context) +
    `\n\n_Retrieval: ${describeRetrieval(args.retrieval)}_` +
    formatWorkingTreeOverlay(args.workingTree) +
    formatProjectLearning(args.projectLearning) +
    formatContextRiskSignals(args.cg, nodes) +
    reminder +
    trace +
    explainHint;
  // The chokepoint bounds the body (the `explain` score-trace appends
  // on top of an already-large markdown body) then appends the
  // stale-files note for the result nodes — note placement is owned
  // by the chokepoint so it survives truncation.
  return attachNextActions(renderToolResponse({ body, freshness: { cg: args.cg, nodes } }), nextActions);
}

function taskHandoffIndexFreshness(cg: Cartograph): TaskHandoffIndexFreshness {
  const freshness = cg.stats.getFreshness();
  if (!freshness) return { available: false, reason: 'index has no freshness metadata' };
  return {
    available: true,
    severity: freshness.severity,
    isStale: freshness.isStale,
    filesChanged: freshness.filesChanged,
    contentDriftedFiles: freshness.contentDriftedFiles,
  };
}

function describeWorkingTreeOverlay(report: WorkingTreeOverlayReport): string {
  if (report.status === 'off') return 'overlay disabled';
  if (report.status === 'clean') return 'no changed source files detected';
  return `${report.status}; ${report.extractedFiles.length}/${report.changedFiles.length} changed files parsed from live disk, ${report.candidates.length} task-matched symbols`;
}

function formatWorkingTreeOverlay(report: WorkingTreeOverlayReport): string {
  if (report.status === 'off' || report.status === 'clean') return '';
  const changedFiles = report.changedFiles.map((file) => `\`${file}\``).join(', ');
  const lines = [
    '',
    '### Working-tree overlay',
    '',
    `_Working-tree source read from disk without persisting an index sync. Graph relationships outside these roots still come from the stored index._`,
    '',
    `- Status: ${describeWorkingTreeOverlay(report)}`,
    `- Changed files: ${changedFiles}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `- Live candidate: \`${candidate.name}\` (${candidate.kind}) — ${candidate.filePath}:${candidate.line} [${candidate.confidence}]`,
    );
  }
  for (const skipped of report.skipped) lines.push(`- Caveat: ${skipped.filePath} — ${skipped.reason}`);
  lines.push('');
  return lines.join('\n');
}

function describeProjectLearning(report: ProjectLearningReport): string {
  if (report.status === 'off') return 'disabled';
  if (report.status === 'empty') return 'no similar successful prior context';
  const contexts = `${report.contextMatches} similar prior context${report.contextMatches === 1 ? '' : 's'}`;
  return `${contexts}; ${report.outcomeSignals} successful follow-up signal${report.outcomeSignals === 1 ? '' : 's'}; ${report.candidates.length} learned candidate${report.candidates.length === 1 ? '' : 's'}`;
}

function formatProjectLearning(report: ProjectLearningReport): string {
  if (report.status !== 'ready') return '';
  const lines = [
    '',
    '### Project-local retrieval learning',
    '',
    `_Derived only from this project's prior Cartograph context → successful follow-up call sequences; no code or feedback leaves the local index._`,
    '',
    `- ${describeProjectLearning(report)}`,
  ];
  for (const candidate of report.candidates) {
    lines.push(
      `- Learned candidate: \`${candidate.name}\` (${candidate.kind}) — ${candidate.filePath}:${candidate.line} via ${candidate.tools.join(', ')}`,
    );
  }
  lines.push('');
  return lines.join('\n');
}

function describeRetrieval(trace: BehaviorRetrievalTrace): string {
  if (trace.reason === 'explicit-deterministic') return 'lexical + graph; hybrid disabled explicitly';
  if (trace.reason === 'non-behavior-query') return 'lexical + graph; hybrid not needed for this query shape';
  if (trace.reason === 'hybrid-failed') return 'lexical + graph fallback; hybrid candidate fetch failed';
  return `hybrid candidate channel (${trace.hybridCandidateCount} candidates) + lexical + graph`;
}

/**
 * Zod schema for `cartograph_context`.
 *
 * `maxNodes` is `.int().min(1)` — a zero / negative / non-integer is
 * REJECTED at the dispatch boundary (the locked reject-out-of-range
 * decision); the legacy handler had no upper bound, so none is
 * declared. `code` is the canonical include-code key; `includeCode`
 * is kept as an explicit optional alias so a legacy caller's key is
 * not stripped by `safeParse`.
 */
const contextSchema = z.object({
  task: z
    .string()
    .optional()
    .describe('Task, bug, or feature to build context for. Prefer short code anchors over broad prose.'),
  query: z
    .string()
    .optional()
    .describe('Alias for `task` for clients that send a query-shaped parameter. Prefer short code anchors.'),
  maxNodes: z.number().int().min(1).default(20).describe('Maximum symbols to include (default: 20)'),
  code: z.boolean().optional().describe('Include code snippets for key symbols (default: true)'),
  includeCode: z.boolean().optional().describe('Deprecated alias for `code`.'),
  format: z
    .enum(['markdown', 'json', 'plan', 'handoff'])
    .optional()
    .describe(
      'Output format: `markdown` (default) human-readable report, `json` raw TaskContext, `plan` for a low-token route, or `handoff` for a resumable coding-task packet with live changes and verification guidance.',
    ),
  explain: z
    .boolean()
    .default(false)
    .describe(
      'Append a "Score trace" section showing each candidate\'s score after every retrieval pass — use to diagnose why a symbol ranked where it did. Default false.',
    ),
  retrievalMode: ContextRetrievalModeSchema.default('auto').describe(
    '`auto` may use hybrid embeddings for behavior-shaped questions; `deterministic` guarantees lexical + graph only; `hybrid` explicitly attempts the semantic candidate channel for any task and falls back safely if unavailable.',
  ),
  workingTree: WorkingTreeOverlayModeSchema.default('auto').describe(
    '`auto` follows the normal freshness policy then overlays any remaining changed source; `live` skips context auto-sync and parses current changed files ephemerally; `off` disables the overlay.',
  ),
  localLearning: ProjectLearningModeSchema.default('auto').describe(
    '`auto` may seed routing from similar prior context calls followed by successful node/graph/test inspection in this project; `off` disables this deterministic local signal.',
  ),
  lowTokens: lowTokensField,
  projectPath: projectPathField,
});

type ContextArgs = z.infer<typeof contextSchema>;

const LOW_TOKEN_CONTEXT_MAX_NODES = 8;

function resolveContextTask(args: Pick<ContextArgs, 'task' | 'query'>): string | null {
  const rawTask = args.task;
  const rawQuery = args.query;
  const task = rawTask?.trim();
  if (task) return task;
  const query = rawQuery?.trim();
  return query || null;
}

function shouldContextIncludeCode(args: {
  format: ContextFormat;
  codePreference: boolean | undefined;
  lowTokens: boolean;
}): boolean {
  if (args.format === 'plan' || args.format === 'handoff') return false;
  if (args.codePreference === undefined) return !args.lowTokens;
  return args.codePreference !== false;
}

function contextToolAvailable(ctx: ToolCtx, toolName: string): boolean {
  if (ctx.options.disabledTools?.has(toolName)) return false;
  return mcpServerProfileIncludesTool(resolveMcpServerProfile(ctx.options.profile), toolName);
}

function mergeCandidateChannels(...channels: ReadonlyArray<readonly SearchResult[]>): SearchResult[] {
  const merged: SearchResult[] = [];
  const seen = new Set<string>();
  for (const channel of channels) {
    for (const candidate of channel) {
      if (seen.has(candidate.node.id)) continue;
      seen.add(candidate.node.id);
      merged.push(candidate);
    }
  }
  return merged;
}

function mergeEvidenceMaps(
  ...maps: ReadonlyArray<ReadonlyMap<string, readonly string[]>>
): Map<string, readonly string[]> {
  const merged = new Map<string, readonly string[]>();
  for (const evidenceMap of maps) {
    for (const [nodeId, evidence] of evidenceMap) {
      merged.set(nodeId, [...new Set([...(merged.get(nodeId) ?? []), ...evidence])]);
    }
  }
  return merged;
}

interface ContextExecutionOptions {
  format: ContextFormat;
  maxNodes: number;
  includeCode: boolean;
  explain: boolean;
}

function resolveContextExecutionOptions(args: ContextArgs): ContextExecutionOptions {
  const format: ContextFormat = args.format ?? 'markdown';
  // `maxNodes` is already a positive integer — Zod's `.int().min(1)`
  // rejected anything else at the dispatch boundary. No `numArg` needed.
  const lowTokens = args.lowTokens === true;
  const maxNodes = lowTokens ? Math.min(args.maxNodes, LOW_TOKEN_CONTEXT_MAX_NODES) : args.maxNodes;
  // `code` is the canonical key; the legacy `includeCode` alias is
  // consulted only when `code` was not sent.
  const codePreference = args.code ?? args.includeCode;
  return {
    format,
    maxNodes,
    includeCode: shouldContextIncludeCode({ format, codePreference, lowTokens }),
    explain: args.explain,
  };
}

interface PreparedContextChannels {
  projectLearning: ReturnType<typeof collectProjectLearningSeeds>;
  workingTree: Awaited<ReturnType<typeof buildWorkingTreeOverlay>>;
  behaviorRetrieval: Awaited<ReturnType<typeof prepareBehaviorRetrieval>>;
  intentSeeds: ReturnType<typeof collectContextIntentSeeds> | null;
  extraCandidates: SearchResult[];
}

interface PrepareContextChannelsArgs {
  cg: Cartograph;
  args: ContextArgs;
  task: string;
  execution: ContextExecutionOptions;
}

async function prepareContextChannels(args: PrepareContextChannelsArgs): Promise<PreparedContextChannels> {
  const { cg, task, execution } = args;
  // Disk overlay extraction and optional semantic retrieval are independent.
  // Start both before the synchronous project-local trace scan and intent
  // routing so wall time is bounded by the slowest channel, not their sum.
  const workingTreePromise = buildWorkingTreeOverlay(cg, {
    task,
    mode: args.args.workingTree,
    maxFiles: Math.min(execution.maxNodes, 20),
  });
  const behaviorRetrievalPromise = prepareBehaviorRetrieval({
    search: cg.llm,
    task,
    maxNodes: execution.maxNodes,
    retrievalMode: args.args.retrievalMode,
  });
  const projectLearning = collectProjectLearningSeeds(cg, { task, mode: args.args.localLearning });
  const taskAnalysis = analyzeCodingTask(task);
  const intentSeeds = prepareIntentSeeds(cg, execution, taskAnalysis.clauses);
  const [workingTree, behaviorRetrieval] = await Promise.all([workingTreePromise, behaviorRetrievalPromise]);
  const extraCandidates = mergeCandidateChannels(
    workingTree.extraCandidates,
    projectLearning.extraCandidates,
    intentSeeds?.candidates ?? [],
    behaviorRetrieval.extraCandidates,
  );
  return { projectLearning, workingTree, behaviorRetrieval, intentSeeds, extraCandidates };
}

function prepareIntentSeeds(
  cg: Cartograph,
  execution: ContextExecutionOptions,
  clauses: readonly string[],
): ReturnType<typeof collectContextIntentSeeds> | null {
  if (execution.format !== 'plan' && execution.format !== 'handoff') return null;
  return collectContextIntentSeeds({
    clauses,
    queries: cg.queries,
    limit: Math.min(execution.maxNodes, PLAN_SEMANTIC_FIND_LIMIT),
  });
}

interface BuildRawTaskContextArgs {
  cg: Cartograph;
  task: string;
  execution: ContextExecutionOptions;
  channels: PreparedContextChannels;
}

async function buildRawTaskContext(args: BuildRawTaskContextArgs): Promise<TaskContext | string> {
  const { cg, task, execution, channels } = args;
  // Use format: 'object' so buildContext returns the raw TaskContext and
  // preserves nodes for freshness checks and route construction.
  return cg.internals.contextBuilder.buildContext(task, {
    maxNodes: execution.maxNodes,
    includeCode: execution.includeCode,
    format: 'object',
    extraCandidates: channels.extraCandidates,
    behaviorBias: channels.behaviorRetrieval.behaviorBias,
    explain: execution.explain,
    ...(channels.behaviorRetrieval.searchLimit === undefined
      ? {}
      : { searchLimit: channels.behaviorRetrieval.searchLimit }),
  });
}

function routeBuiltContext(task: string, context: TaskContext, channels: PreparedContextChannels): ContextRoute {
  return buildContextRoute({
    task,
    nodes: [...context.subgraph.nodes.values()],
    ...(channels.intentSeeds ? { intentSpecificityByNodeId: channels.intentSeeds.specificityByNodeId } : {}),
    intentEvidenceByNodeId: mergeEvidenceMaps(
      channels.workingTree.evidenceByNodeId,
      channels.projectLearning.evidenceByNodeId,
      channels.intentSeeds?.evidenceByNodeId ?? new Map(),
    ),
  });
}

async function handleContext(ctx: ToolCtx, args: ContextArgs): Promise<ToolOutcome> {
  const task = resolveContextTask(args);
  if (!task) {
    return err(
      'cartograph_context requires `task` or `query`; use a short code anchor like "watcher sync" or "AuthService login".',
    );
  }

  // Mark session as consulted (enables Grep/Glob/Bash)
  const sessionId = process.env['CLAUDE_SESSION_ID'];
  if (sessionId) markSessionConsulted(sessionId);

  const cg = ctx.getCartograph(args.projectPath);
  const execution = resolveContextExecutionOptions(args);
  const channels = await prepareContextChannels({ cg, args, task, execution });
  const context = await buildRawTaskContext({ cg, task, execution, channels });
  // Shouldn't happen with format='object' but guard for safety.
  if (typeof context === 'string') {
    return ok(textResult(`${context}\n\n_Retrieval: ${describeRetrieval(channels.behaviorRetrieval.trace)}_`));
  }

  const route = routeBuiltContext(task, context, channels);
  return ok(
    formatContextResponse({
      cg,
      task,
      context,
      format: execution.format,
      retrieval: channels.behaviorRetrieval.trace,
      route,
      workingTree: channels.workingTree.report,
      projectLearning: channels.projectLearning.report,
      toolAvailable: (toolName) => contextToolAvailable(ctx, toolName),
    }),
  );
}

export const CONTEXT_TOOL = defineTool({
  name: 'cartograph_context',
  description:
    'Primary tool — natural-language `task` → entry points + related symbols + key code in one call. ' +
    'Often enough to understand a feature or bug without further calls; takes free-form text (e.g. "how does session login work"). ' +
    'Returns CODE context by default; `retrievalMode: "deterministic"` prevents hybrid/embedding retrieval for this call; ' +
    '`workingTree: "live"` parses unsynced source without writing the graph; `format: "handoff"` packages live state for another agent; ' +
    '`localLearning: "auto"` can reuse successful follow-up choices from prior local sessions; ' +
    '`lowTokens: true` suppresses code snippets and caps breadth. For new features still clarify UX/behavior with the user.',
  schema: contextSchema,
  handle: handleContext,
  bypassFreshnessGate: (args) => args['workingTree'] === 'live' || args['format'] === 'handoff',
});
