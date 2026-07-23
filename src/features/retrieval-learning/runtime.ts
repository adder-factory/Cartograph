import { z } from 'zod';
import type Cartograph from '../../index.js';
import { latestToolCalls, recentSessions, type ToolCallRow } from '../../db/queries-trace.js';
import { getNodesByName } from '../../db/queries-search.js';
import type { Node } from '../../types.js';
import type { SearchResult } from '../../search/types.js';
import { ProjectLearningReportSchema, type ProjectLearningMode, type ProjectLearningReport } from './contract.js';

export interface CollectProjectLearningOptions {
  task: string;
  mode?: ProjectLearningMode;
}

export interface ProjectLearningResult {
  report: ProjectLearningReport;
  extraCandidates: SearchResult[];
  evidenceByNodeId: ReadonlyMap<string, readonly string[]>;
}

interface CandidateSignal {
  node: Node;
  score: number;
  contexts: Set<string>;
  tools: Set<string>;
}

const ContextArgsSchema = z.looseObject({
  task: z.string().optional(),
  query: z.string().optional(),
});
const FollowUpArgsSchema = z.looseObject({
  symbol: z.string().optional(),
  symbols: z.array(z.string()).optional(),
  start: z.string().optional(),
  file: z.string().optional(),
  path: z.string().optional(),
  files: z.array(z.string()).optional(),
  ranges: z.array(z.looseObject({ file: z.string().optional() })).optional(),
});

const TRACE_CALL_LIMIT = 1_000;
const FOLLOW_UP_WINDOW = 12;
const CANDIDATE_LIMIT = 5;
const MIN_SHARED_TASK_TOKENS = 2;
const MIN_TASK_JACCARD = 0.25;
const VERIFIED_CLOSURE_BONUS = 1;
const LEARNED_SEED_BASE = 20;
const TOOL_WEIGHTS: Readonly<Record<string, number>> = {
  cartograph_node: 4,
  cartograph_graph: 3,
  cartograph_tests_for: 2.5,
  cartograph_at_range: 2,
  cartograph_files: 1.5,
  cartograph_verify: 3,
};
const TASK_STOP_WORDS = new Set([
  'a',
  'an',
  'and',
  'behavior',
  'bug',
  'debug',
  'fix',
  'for',
  'handling',
  'in',
  'of',
  'on',
  'the',
  'to',
  'update',
  'with',
]);

export function collectProjectLearningSeeds(
  cg: Cartograph,
  options: CollectProjectLearningOptions,
): ProjectLearningResult {
  const mode = options.mode ?? 'auto';
  if (mode === 'off') return emptyLearning(mode, 'off');

  // `recentSessions` deliberately returns legacy NULL-project rows for the
  // viewer, but learning must be strictly project-local. Keep only sessions
  // stamped with this exact root before consuming their calls.
  const allowedSessionIds = new Set(
    recentSessions(cg.queries, 100, cg.projectRoot)
      .filter((session) => session.projectRoot === cg.projectRoot)
      .map((session) => session.id),
  );
  const calls = latestToolCalls(cg.queries, { limit: TRACE_CALL_LIMIT, projectRoot: cg.projectRoot }).filter((call) =>
    allowedSessionIds.has(call.sessionId),
  );
  const sessions = groupCallsBySession(calls);
  const taskTokens = meaningfulTaskTokens(options.task);
  const signals = new Map<string, CandidateSignal>();
  let contextMatches = 0;
  let outcomeSignals = 0;

  for (const [sessionId, sessionCalls] of sessions) {
    for (let index = 0; index < sessionCalls.length; index++) {
      const contextCall = sessionCalls[index]!;
      if (contextCall.toolName !== 'cartograph_context' || !callSucceeded(contextCall)) continue;
      const priorTask = contextTask(contextCall);
      if (!priorTask) continue;
      const similarity = taskSimilarity(taskTokens, meaningfulTaskTokens(priorTask));
      if (similarity === 0) continue;
      contextMatches++;

      const window = collectFollowUpWindow(sessionCalls, index + 1);
      const verifiedClosure = window.some((call) => call.toolName === 'cartograph_verify' && callSucceeded(call));
      const contextKey = `${sessionId}:${contextCall.step}`;
      for (const call of window) {
        if (!callSucceeded(call)) continue;
        const weight = TOOL_WEIGHTS[call.toolName];
        if (weight === undefined) continue;
        const nodes = resolveFollowUpNodes(cg, call);
        for (const node of nodes) {
          outcomeSignals++;
          const signal = signals.get(node.id) ?? {
            node,
            score: 0,
            contexts: new Set<string>(),
            tools: new Set<string>(),
          };
          signal.score += weight * similarity + (verifiedClosure ? VERIFIED_CLOSURE_BONUS : 0);
          signal.contexts.add(contextKey);
          signal.tools.add(call.toolName);
          signals.set(node.id, signal);
        }
      }
    }
  }

  const ranked = [...signals.values()]
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.contexts.size - a.contexts.size ||
        a.node.filePath.localeCompare(b.node.filePath) ||
        a.node.startLine - b.node.startLine,
    )
    .slice(0, CANDIDATE_LIMIT);
  if (ranked.length === 0) {
    return {
      ...emptyLearning(mode, 'empty'),
      report: ProjectLearningReportSchema.parse({
        mode,
        status: 'empty',
        sessionsScanned: sessions.size,
        contextMatches,
        outcomeSignals,
        candidates: [],
      }),
    };
  }

  const evidenceByNodeId = new Map<string, readonly string[]>();
  const candidates = ranked.map((signal) => {
    const tools = [...signal.tools].sort((a, b) => a.localeCompare(b));
    evidenceByNodeId.set(signal.node.id, [
      `project-local follow-up selected this symbol after ${signal.contexts.size} similar prior context${signal.contexts.size === 1 ? '' : 's'} (${tools.join(', ')})`,
    ]);
    return {
      nodeId: signal.node.id,
      name: signal.node.name,
      kind: signal.node.kind,
      filePath: signal.node.filePath,
      line: signal.node.startLine,
      score: roundScore(signal.score),
      matchedContexts: signal.contexts.size,
      tools,
      provenance: 'project-session-outcome' as const,
    };
  });
  const report = ProjectLearningReportSchema.parse({
    mode,
    status: 'ready',
    sessionsScanned: sessions.size,
    contextMatches,
    outcomeSignals,
    candidates,
  });
  return {
    report,
    extraCandidates: ranked.map((signal) => ({ node: signal.node, score: LEARNED_SEED_BASE + signal.score })),
    evidenceByNodeId,
  };
}

function groupCallsBySession(calls: readonly ToolCallRow[]): Map<string, ToolCallRow[]> {
  const sessions = new Map<string, ToolCallRow[]>();
  for (const call of calls) {
    const rows = sessions.get(call.sessionId) ?? [];
    rows.push(call);
    sessions.set(call.sessionId, rows);
  }
  for (const rows of sessions.values()) rows.sort((a, b) => a.step - b.step);
  return sessions;
}

function contextTask(call: ToolCallRow): string | null {
  const parsed = parseTraceArgs(call.argsJson, ContextArgsSchema);
  if (!parsed) return null;
  const task = parsed.task?.trim() || parsed.query?.trim();
  return task || null;
}

function collectFollowUpWindow(calls: readonly ToolCallRow[], start: number): ToolCallRow[] {
  const out: ToolCallRow[] = [];
  for (let index = start; index < calls.length && out.length < FOLLOW_UP_WINDOW; index++) {
    const call = calls[index]!;
    if (call.toolName === 'cartograph_context') break;
    out.push(call);
  }
  return out;
}

function resolveFollowUpNodes(cg: Cartograph, call: ToolCallRow): Node[] {
  const args = parseTraceArgs(call.argsJson, FollowUpArgsSchema);
  if (!args) return [];
  const refs = new Set<string>();
  if (args.symbol) refs.add(args.symbol);
  for (const symbol of args.symbols ?? []) refs.add(symbol);
  if (args.start) refs.add(args.start);
  const paths = new Set<string>();
  if (args.file) paths.add(args.file);
  if (args.path) paths.add(args.path);
  for (const file of args.files ?? []) paths.add(file);
  for (const range of args.ranges ?? []) if (range.file) paths.add(range.file);

  const nodes = new Map<string, Node>();
  for (const ref of refs) {
    const resolved = resolveNodeRef(cg, ref);
    if (resolved) nodes.set(resolved.id, resolved);
  }
  for (const filePath of paths) {
    const candidates = cg.queries
      .getNodesByFile(filePath)
      .filter((node) => !['file', 'import', 'export', 'parameter'].includes(node.kind))
      .slice(0, 3);
    for (const candidate of candidates) nodes.set(candidate.id, candidate);
  }
  return [...nodes.values()];
}

function resolveNodeRef(cg: Cartograph, ref: string): Node | null {
  const byId = cg.queries.getNodeById(ref);
  if (byId) return byId;
  if (ref.startsWith('n_')) return null;
  const byName = getNodesByName(cg.queries, ref);
  return byName.length === 1 ? byName[0]! : null;
}

function parseTraceArgs<S extends z.ZodType>(argsJson: string, schema: S): z.infer<S> | null {
  try {
    const parsed: unknown = JSON.parse(argsJson);
    const result = schema.safeParse(parsed);
    return result.success ? result.data : null;
  } catch {
    return null;
  }
}

function meaningfulTaskTokens(task: string): ReadonlySet<string> {
  const tokens = task.toLowerCase().match(/[\p{L}\p{N}_]+/gu) ?? [];
  return new Set(tokens.filter((token) => token.length >= 3 && !TASK_STOP_WORDS.has(token)));
}

function taskSimilarity(current: ReadonlySet<string>, prior: ReadonlySet<string>): number {
  if (current.size === 0 || prior.size === 0) return 0;
  let intersection = 0;
  for (const token of current) if (prior.has(token)) intersection++;
  if (intersection < MIN_SHARED_TASK_TOKENS) return 0;
  const union = new Set([...current, ...prior]).size;
  const jaccard = intersection / union;
  return jaccard >= MIN_TASK_JACCARD ? jaccard : 0;
}

function callSucceeded(call: ToolCallRow): boolean {
  return call.resultSummary !== '⚠ tool error';
}

function roundScore(score: number): number {
  return Math.round(score * 1_000) / 1_000;
}

function emptyLearning(mode: ProjectLearningMode, status: 'off' | 'empty'): ProjectLearningResult {
  return {
    report: ProjectLearningReportSchema.parse({
      mode,
      status,
      sessionsScanned: 0,
      contextMatches: 0,
      outcomeSignals: 0,
      candidates: [],
    }),
    extraCandidates: [],
    evidenceByNodeId: new Map(),
  };
}
