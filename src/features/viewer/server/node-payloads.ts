import * as fs from 'node:fs';
import * as path from 'node:path';
import { getFileByPath } from '../../../db/queries-files.js';
import { getFindingsForNode } from '../../../db/queries-findings.js';
import { getNodeCoverage } from '../../../db/queries-coverage.js';
import { getNodeMetrics } from '../../../db/queries-metrics.js';
import { getNodesByName, getNodesByLowerName } from '../../../db/queries-search.js';
import type { QueryBuilder } from '../../../db/queries.js';
import { errMsg, logDebug } from '../../../errors.js';
import type { Node } from '../../../types.js';
import type { RequestContext } from './context.js';

type SourcePayload = {
  source: string;
  startLine: number;
  endLine: number;
  language: string;
  file?: string;
  error?: string;
};

interface BuildMetricsBlockArgs {
  ctx: RequestContext;
  node: Node;
  findings: ReadonlyArray<{ biomarker: string; metric: number }>;
  file: ReturnType<typeof getFileByPath>;
}

export function sourcePayload(ctx: RequestContext, idOrName: string): SourcePayload | null {
  const node = resolveSymbolToNode(ctx.queries, idOrName);
  if (!node) return null;
  const abs = path.resolve(ctx.projectPath, node.filePath);
  const root = path.resolve(ctx.projectPath);
  if (!abs.startsWith(root + path.sep) && abs !== root) {
    return {
      source: '',
      startLine: node.startLine,
      endLine: node.endLine,
      language: node.language,
      error: 'path escapes project root',
    };
  }
  let lines: string[];
  try {
    lines = fs.readFileSync(abs, 'utf-8').split('\n');
  } catch (err) {
    logDebug('viewer: source read failed', { path: node.filePath, err: errMsg(err) });
    return {
      source: '',
      startLine: node.startLine,
      endLine: node.endLine,
      language: node.language,
      error: 'unreadable',
    };
  }
  const start = Math.max(1, node.startLine);
  const end = Math.min(lines.length, node.endLine);
  const slice = lines.slice(start - 1, end).join('\n');
  return {
    source: slice,
    startLine: start,
    endLine: end,
    language: node.language,
    file: node.filePath,
  };
}

export function symbolPayload(ctx: RequestContext, idOrName: string): Record<string, unknown> | null {
  const node = resolveSymbolToNode(ctx.queries, idOrName);
  if (!node) return null;
  const callers = ctx.traverser.getCallers(node.id, 1);
  const callees = ctx.traverser.getCallees(node.id, 1);
  const findings = getFindingsForNode(ctx.queries, node.id);
  const file = getFileByPath(ctx.queries, node.filePath);
  return {
    ...serializeNode(node),
    docstring: node.docstring ?? null,
    signature: node.signature ?? null,
    callers: dedupNodes(callers.map((c) => serializeNode(c.node))),
    callees: dedupNodes(callees.map((c) => serializeNode(c.node))),
    findings: findings.map((f) => ({ biomarker: f.biomarker, severity: f.severity, metric: f.metric })),
    metrics: buildMetricsBlock({ ctx, node, findings, file }),
    coverage: buildCoverageBlock(ctx, node.id),
  };
}

export function resolveSymbolToNode(queries: QueryBuilder, idOrName: string): Node | null {
  const direct = queries.getNodeById(idOrName);
  if (direct) return direct;
  const byName = getNodesByName(queries, idOrName);
  if (byName.length > 0) return [...byName].sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))[0]!;
  const byLower = getNodesByLowerName(queries, idOrName.toLowerCase());
  if (byLower.length === 0) return null;
  return [...byLower].sort((a, b) => (b.centrality ?? 0) - (a.centrality ?? 0))[0]!;
}

export function serializeNode(n: Node): Record<string, unknown> {
  return {
    id: n.id,
    label: n.name,
    kind: n.kind,
    file: n.filePath,
    line: n.startLine,
    centrality: n.centrality ?? 0,
    language: n.language,
  };
}

export function serializeGraphNode(ctx: RequestContext, n: Node): Record<string, unknown> {
  const findings = getFindingsForNode(ctx.queries, n.id);
  return {
    ...serializeNode(n),
    health: healthForFindings(findings),
    findings: findings.map((f) => ({ biomarker: f.biomarker, severity: f.severity, metric: f.metric })),
  };
}

function healthForFindings(findings: ReturnType<typeof getFindingsForNode>): 'error' | 'warning' | 'info' | 'healthy' {
  if (findings.some((f) => f.severity === 'error')) return 'error';
  if (findings.some((f) => f.severity === 'warning')) return 'warning';
  if (findings.some((f) => f.severity === 'info')) return 'info';
  return 'healthy';
}

function buildCoverageBlock(ctx: RequestContext, nodeId: string): Record<string, unknown> | null {
  const row = getNodeCoverage(ctx.queries, nodeId);
  if (!row) return null;
  const ratio = row.totalLines > 0 ? row.coveredLines / row.totalLines : null;
  return {
    source: row.source,
    coveredLines: row.coveredLines,
    totalLines: row.totalLines,
    coveredBranches: row.coveredBranches,
    totalBranches: row.totalBranches,
    ratio,
  };
}

function buildMetricsBlock(args: BuildMetricsBlockArgs): Record<string, unknown> {
  const { ctx, node, findings, file } = args;
  const findingMetric = (kind: string): number | null => {
    const m = findings.find((f) => f.biomarker === kind);
    return m ? m.metric : null;
  };
  const persisted = getNodeMetrics(ctx.queries, node.id);
  const loc = persisted?.loc ?? Math.max(0, node.endLine - node.startLine + 1);
  return {
    loc,
    cyclomatic: persisted?.cyclomatic ?? findingMetric('complex_method'),
    maxNesting: persisted?.maxNesting ?? findingMetric('nested_complexity'),
    paramCount: persisted?.paramCount ?? null,
    fileFirstSeenTs: file?.firstSeenTs ?? null,
    fileLastTouchedTs: file?.lastTouchedTs ?? null,
    fileCommits: file?.commitCount ?? null,
  };
}

function dedupNodes(nodes: ReadonlyArray<Record<string, unknown>>): Record<string, unknown>[] {
  const seen = new Set<unknown>();
  const out: Record<string, unknown>[] = [];
  for (const n of nodes) {
    if (seen.has(n['id'])) continue;
    seen.add(n['id']);
    out.push(n);
  }
  return out;
}
