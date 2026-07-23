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
  toolAvailable: (toolName: string) => boolean;
}

type ContextFormat = 'markdown' | 'json' | 'plan';
type NextAction = NonNullable<NonNullable<ToolResult['metadata']>['nextActions']>[number];

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

function buildContextNextActions(
  context: TaskContext,
  task: string,
  route: ContextRoute,
  toolAvailable: (toolName: string) => boolean,
): NextAction[] {
  const routeNodeIds = route.candidates
    .filter((candidate) => candidate.bucket === 'edit-site' && candidate.confidence !== 'low')
    .map((candidate) => candidate.nodeId);
  const nodesById = context.subgraph.nodes;
  const routedNodes = routeNodeIds.flatMap((nodeId) => {
    const node = nodesById.get(nodeId);
    return node ? [node] : [];
  });
  const nodes = (routedNodes.length > 0 ? routedNodes : topContextNodes(context, PLAN_ACTION_NODE_LIMIT)).slice(
    0,
    PLAN_ACTION_NODE_LIMIT,
  );
  const crossCutting = looksLikeCrossCuttingTask(task);
  if (nodes.length === 0 || route.status === 'abstained') {
    const searchMode = crossCutting ? 'intent' : 'semantic';
    const fallback: NextAction[] = [
      {
        tool: 'cartograph_find',
        args: { by: 'name', mode: searchMode, query: task, limit: PLAN_SEMANTIC_FIND_LIMIT, lowTokens: true },
        reason: crossCutting
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
    if (crossCutting && toolAvailable('cartograph_deps')) fallback.unshift(buildDependencyCoverageAction());
    return fallback.filter((action) => toolAvailable(action.tool));
  }

  const primary = nodes[0]!;
  const rest = nodes.slice(1);
  const actions: NextAction[] =
    crossCutting && toolAvailable('cartograph_deps')
      ? [
          buildDependencyCoverageAction(),
          {
            tool: 'cartograph_find',
            args: { by: 'name', mode: 'intent', query: task, limit: PLAN_SEMANTIC_FIND_LIMIT, lowTokens: true },
            reason: 'Cross-cutting wording benefits from concept search before committing to one symbol route.',
            priority: PLAN_PRIORITY_PRIMARY,
          },
        ]
      : crossCutting
        ? [
            {
              tool: 'cartograph_find',
              args: { by: 'name', mode: 'intent', query: task, limit: PLAN_SEMANTIC_FIND_LIMIT, lowTokens: true },
              reason: 'Cross-cutting wording benefits from concept search before committing to one symbol route.',
              priority: PLAN_PRIORITY_PRIMARY,
            },
          ]
        : [];
  actions.push(
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
      priority: crossCutting ? PLAN_PRIORITY_SKIM : PLAN_PRIORITY_PRIMARY,
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
  );

  if (rest.length > 0) {
    actions.push({
      tool: 'cartograph_node',
      args: { symbols: rest.map((n) => n.id), lowTokens: true },
      reason: 'Skim adjacent candidate symbols without pulling source bodies.',
      priority: PLAN_PRIORITY_SKIM,
    });
  }
  actions.push({
    tool: 'cartograph_compare_to_ref',
    args: { findingsDelta: true },
    reason: 'Run this before reporting done after code edits.',
    priority: PLAN_PRIORITY_FINAL_CHECK,
  });
  return actions.filter((action) => toolAvailable(action.tool));
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
}): string {
  const { task, nextActions, retrieval, route } = args;
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
    '- After edits, choose tests with `cartograph_affected({includeCommands: true})` or `cartograph_tests_for`.',
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
  const { cg, task, context, format, retrieval, route, toolAvailable } = args;
  const nextActions = buildContextNextActions(context, task, route, toolAvailable);
  // JSON consumers get a properly serialized TaskContext. `subgraph.nodes`
  // is a Map which `JSON.stringify` renders as `{}` — serialize it to an array
  // so programmatic consumers can iterate nodes. The score trace is included
  // when `explain: true` was requested.
  if (format === 'json') {
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
    };
    return attachNextActions(textResult(JSON.stringify(serializable, null, 2)), nextActions);
  }
  const nodes = [...context.subgraph.nodes.values()];
  if (format === 'plan') {
    return attachNextActions(
      textResult(renderContextPlan({ task, context, nextActions, retrieval, route })),
      nextActions,
    );
  }
  // No-match guard (audit-4 #5): a 0-node subgraph would otherwise
  // render a bare `## Code Context` + `**Query:**` stub with no
  // "nothing found" line and no freshness hint — leaving the agent
  // unable to tell a stale index from a genuine empty result. Mirror
  // explore's empty path.
  if (nodes.length === 0) {
    // Empty-result branch: the `## Code Context` stub is the message;
    // the chokepoint appends the index-freshness hint so the agent
    // can tell a stale index from a genuine miss (audit-4 #5).
    return attachNextActions(
      renderToolResponse({
        body: '',
        empty: {
          message:
            `## Code Context\n\n**Query:** ${task}\n\n_Retrieval: ${describeRetrieval(retrieval)}_\n\n` +
            `No relevant code found for "${task}".`,
          freshness: { cg },
        },
      }),
      nextActions,
    );
  }
  const isFeatureQuery = looksLikeFeatureRequest(task);
  const reminder = isFeatureQuery ? '\n\n⚠️ **Ask user:** UX preferences, edge cases, acceptance criteria' : '';
  const trace = context.subgraph.scoreTrace
    ? annotateScoreTraceEntryMarkers(renderScoreExplanation(context.subgraph.scoreTrace), context.subgraph.scoreTrace)
    : '';
  // Passive `explain:true` nudge. Off-target ranking (a result that
  // shares a lexeme with the query but isn't structurally relevant) is
  // diagnosable in one re-run with `explain:true`, but agents new to
  // the tool often don't know to reach for it. Surface the option here
  // for ranked-multi-result, non-explain calls only — single-hit
  // responses never have a ranking question and an explain-requested
  // call already renders the trace below.
  const explainHint =
    context.subgraph.scoreTrace === undefined && nodes.length >= 3
      ? '\n\n_Top result not what you expected? Pass `explain: true` for a per-candidate score trace that names which retrieval pass elevated each row._'
      : '';
  const body =
    formatContextAsMarkdown(context) +
    `\n\n_Retrieval: ${describeRetrieval(retrieval)}_` +
    formatContextRiskSignals(cg, nodes) +
    reminder +
    trace +
    explainHint;
  // The chokepoint bounds the body (the `explain` score-trace appends
  // on top of an already-large markdown body) then appends the
  // stale-files note for the result nodes — note placement is owned
  // by the chokepoint so it survives truncation.
  return attachNextActions(renderToolResponse({ body, freshness: { cg, nodes } }), nextActions);
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
    .enum(['markdown', 'json', 'plan'])
    .optional()
    .describe(
      'Output format: `markdown` (default) human-readable report with risk signals, `json` raw TaskContext, or `plan` for a low-token route plan with suggested next MCP calls.',
    ),
  explain: z
    .boolean()
    .default(false)
    .describe(
      'Append a "Score trace" section showing each candidate\'s score after every retrieval pass — use to diagnose why a symbol ranked where it did. Default false.',
    ),
  retrievalMode: ContextRetrievalModeSchema.default('auto').describe(
    '`auto` may use hybrid embeddings for behavior-shaped questions; `deterministic` guarantees this context call uses only lexical and graph retrieval.',
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
  if (args.format === 'plan') return false;
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
  const format: ContextFormat = args.format ?? 'markdown';
  // `maxNodes` is already a positive integer — Zod's `.int().min(1)`
  // rejected anything else at the dispatch boundary. No `numArg` needed.
  const lowTokens = args.lowTokens === true;
  const maxNodes = lowTokens ? Math.min(args.maxNodes, LOW_TOKEN_CONTEXT_MAX_NODES) : args.maxNodes;
  // `code` is the canonical key (defaults to true via the `!== false`
  // fallthrough); the legacy `includeCode` alias is consulted only when
  // `code` was not sent. `code` carries no Zod `.default` precisely so
  // "omitted" stays distinguishable from an explicit `code: true`.
  const codePreference = args.code ?? args.includeCode;
  const includeCode = shouldContextIncludeCode({ format, codePreference, lowTokens });
  // `explain` opts into the per-candidate score-trace section.
  const explain = args.explain;

  // Approach (a): when the task is a behaviour question ("how does X
  // happen / when is X triggered"), share `cartograph_ask`'s hybrid
  // retrieval substrate by pre-running it and forwarding the hits
  // to the context builder via `extraCandidates`. Cheap when no embed
  // model is configured — `searchHybrid` falls back to FTS-only, and
  // a fetch failure (e.g. summarise backend offline) returns `[]` so
  // context degrades to its lexical-only baseline.
  const behaviorRetrieval = await prepareBehaviorRetrieval({
    search: cg.llm,
    task,
    maxNodes,
    retrievalMode: args.retrievalMode,
  });
  const taskAnalysis = analyzeCodingTask(task);
  const intentSeeds =
    format === 'plan'
      ? collectContextIntentSeeds({
          clauses: taskAnalysis.clauses,
          queries: cg.queries,
          limit: Math.min(maxNodes, PLAN_SEMANTIC_FIND_LIMIT),
        })
      : null;
  const extraCandidates = mergeCandidateChannels(intentSeeds?.candidates ?? [], behaviorRetrieval.extraCandidates);

  // Use format: 'object' so buildContext returns the raw TaskContext
  // (its 'markdown' and 'json' formats serialise to a string and
  // discard the underlying subgraph). We render markdown ourselves
  // and keep the nodes available for the per-file stale check.
  const context = await cg.internals.contextBuilder.buildContext(task, {
    maxNodes,
    includeCode,
    format: 'object',
    extraCandidates,
    behaviorBias: behaviorRetrieval.behaviorBias,
    explain,
    ...(behaviorRetrieval.searchLimit === undefined ? {} : { searchLimit: behaviorRetrieval.searchLimit }),
  });
  // Shouldn't happen with format='object' but guard for safety.
  if (typeof context === 'string') {
    return ok(textResult(`${context}\n\n_Retrieval: ${describeRetrieval(behaviorRetrieval.trace)}_`));
  }

  const route = buildContextRoute({
    task,
    nodes: [...context.subgraph.nodes.values()],
    ...(intentSeeds === null ? {} : { intentEvidenceByNodeId: intentSeeds.evidenceByNodeId }),
  });

  // Format passthrough — `markdown` (default) emits the enriched markdown
  // report; `json` returns the structured TaskContext for programmatic consumers.
  return ok(
    formatContextResponse({
      cg,
      task,
      context,
      format,
      retrieval: behaviorRetrieval.trace,
      route,
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
    '`lowTokens: true` suppresses code snippets and caps breadth. For new features still clarify UX/behavior with the user.',
  schema: contextSchema,
  handle: handleContext,
});
