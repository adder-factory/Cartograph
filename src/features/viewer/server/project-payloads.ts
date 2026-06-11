import { spawnSync } from 'node:child_process';
import { getAllFilesWithSymbolCount } from '../../../db/queries-files.js';
import { getFindingsRanked, getFindingsStats } from '../../../db/queries-findings.js';
import { getHotspots } from '../../../db/queries-history.js';
import { getMetadata } from '../../../db/queries-metadata.js';
import { getStats as qbGetStats } from '../../../db/queries.js';
import { searchNodes } from '../../../db/queries-search.js';
import { callsForSession, recentSessions } from '../../../db/queries-trace.js';
import type { Node } from '../../../types.js';
import {
  GIT_BINARY,
  HEALTH_BASELINE,
  HEALTH_DECIMAL_RESOLUTION,
  HEALTH_FLOOR,
  HEALTH_PENALTY_ERROR,
  HEALTH_PENALTY_INFO,
  HEALTH_PENALTY_WARNING,
} from './constants.js';
import type { RequestContext } from './context.js';
import { serializeGraphNode, serializeNode } from './node-payloads.js';

interface GitChangedFile {
  readonly status: string;
  readonly path: string;
  readonly oldPath?: string;
}

export function statusPayload(ctx: RequestContext): unknown {
  const stats = qbGetStats(ctx.queries);
  const indexedAt = getMetadata(ctx.queries, 'index_timestamp') ?? null;
  const head = getMetadata(ctx.queries, 'index_head_sha') ?? null;
  const languages = Object.keys(stats.filesByLanguage).sort((a, b) => a.localeCompare(b));
  return {
    projectRoot: ctx.projectPath,
    files: stats.fileCount,
    nodes: stats.nodeCount,
    edges: stats.edgeCount,
    indexedAt: indexedAt ? Number(indexedAt) : null,
    head,
    languages,
    nodesByKind: stats.nodesByKind,
    dirs: scopeDirsPayload(ctx),
    readiness: readinessPayload(ctx.projectPath, stats, indexedAt),
  };
}

/** Cap on scope-filter rows; the viewer adds its own "everything else" row. */
const SCOPE_DIR_LIMIT = 12;

/**
 * Top-level directory buckets for the viewer's "File scope" rail,
 * ordered by symbol count. Repo-root files (no `/` in the path) are
 * deliberately omitted — the viewer's "everything else" row covers
 * them. The rail used to be hardcoded to this repo's own `src/…`
 * layout, which blanked the graph on any project shaped differently.
 */
export function scopeDirsPayload(ctx: RequestContext): Array<{ prefix: string; files: number; nodes: number }> {
  const buckets = new Map<string, { files: number; nodes: number }>();
  for (const file of getAllFilesWithSymbolCount(ctx.queries)) {
    const slash = file.path.indexOf('/');
    if (slash <= 0) continue;
    const prefix = file.path.slice(0, slash + 1);
    const bucket = buckets.get(prefix) ?? { files: 0, nodes: 0 };
    bucket.files += 1;
    bucket.nodes += file.nodeCount;
    buckets.set(prefix, bucket);
  }
  return [...buckets.entries()]
    .map(([prefix, bucket]) => ({ prefix, ...bucket }))
    .sort((a, b) => b.nodes - a.nodes || a.prefix.localeCompare(b.prefix))
    .slice(0, SCOPE_DIR_LIMIT);
}

function readinessPayload(
  projectPath: string,
  stats: ReturnType<typeof qbGetStats>,
  indexedAt: string | null,
): { grade: 'ok' | 'warn' | 'err'; label: string; summary: string; nextSteps: string[] } {
  if (!indexedAt) {
    return {
      grade: 'err',
      label: 'Not indexed',
      summary: 'No completed index timestamp is recorded.',
      nextSteps: [`cartograph index ${projectPath}`],
    };
  }
  if (stats.fileCount === 0) {
    return {
      grade: 'err',
      label: 'No files',
      summary: 'The index exists but contains no files.',
      nextSteps: ['Check include/exclude config, then run `cartograph index .` again.'],
    };
  }
  if (stats.nodeCount === 0) {
    return {
      grade: 'warn',
      label: 'No symbols',
      summary: 'Files are indexed, but no symbols were extracted.',
      nextSteps: ['Check language support and file-size limits, then run `cartograph doctor .`.'],
    };
  }
  return {
    grade: 'ok',
    label: 'Ready',
    summary: `${stats.fileCount.toLocaleString()} files and ${stats.nodeCount.toLocaleString()} symbols indexed.`,
    nextSteps: ['Use search, graph, health, compare, or agent trace views.'],
  };
}

export function searchPayload(ctx: RequestContext, q: string, limit: number): unknown {
  if (q.length < 2) return { query: q, results: [] };
  const results = searchNodes(ctx.queries, q, { limit, perFileCap: 2 });
  return {
    query: q,
    results: results.map((r) => ({
      ...serializeNode(r.node),
      score: r.score,
    })),
  };
}

export function comparePayload(ctx: RequestContext, limit: number): unknown {
  const diff = gitNameStatus(ctx.projectPath);
  if (!diff.ok) {
    return {
      base: 'HEAD',
      gitAvailable: false,
      error: diff.error,
      changedFiles: [],
      totals: { files: 0, nodes: 0 },
    };
  }

  const changedFiles = parseGitNameStatus(diff.stdout).slice(0, limit);
  let nodeTotal = 0;
  const rows = changedFiles.map((file) => {
    const nodes = file.status === 'D' ? [] : rankedNodesForFile(ctx, file.path).slice(0, 8);
    nodeTotal += nodes.length;
    return {
      status: file.status,
      path: file.path,
      oldPath: file.oldPath ?? null,
      nodeCount: file.status === 'D' ? 0 : ctx.queries.getNodesByFile(file.path).length,
      nodes: nodes.map((node) => serializeGraphNode(ctx, node)),
    };
  });

  return {
    base: 'HEAD',
    gitAvailable: true,
    changedFiles: rows,
    totals: { files: changedFiles.length, nodes: nodeTotal },
  };
}

function rankedNodesForFile(ctx: RequestContext, filePath: string): Node[] {
  return ctx.queries
    .getNodesByFile(filePath)
    .slice()
    .sort(
      (a, b) => (b.centrality ?? 0) - (a.centrality ?? 0) || a.startLine - b.startLine || a.name.localeCompare(b.name),
    );
}

function gitNameStatus(projectPath: string): { ok: true; stdout: string } | { ok: false; error: string } {
  const result = spawnSync(GIT_BINARY, ['diff', '--name-status', 'HEAD', '--'], {
    cwd: projectPath,
    encoding: 'utf8',
    maxBuffer: 1024 * 1024,
  });
  if (result.error) return { ok: false, error: result.error.message };
  if (result.status !== 0) return { ok: false, error: (result.stderr || 'git diff failed').trim() };
  return { ok: true, stdout: result.stdout };
}

function parseGitNameStatus(output: string): GitChangedFile[] {
  const files: GitChangedFile[] = [];
  for (const line of output.split('\n')) {
    if (!line.trim()) continue;
    const parts = line.split('\t');
    const rawStatus = parts[0] ?? '';
    const status = rawStatus[0] || '?';
    if (status === 'R' || status === 'C') {
      const oldPath = parts[1];
      const newPath = parts[2];
      if (oldPath && newPath) files.push({ status, oldPath, path: newPath });
      continue;
    }
    const filePath = parts[1];
    if (filePath) files.push({ status, path: filePath });
  }
  return files;
}

export function findingsPayload(ctx: RequestContext): unknown {
  const stats = qbGetStats(ctx.queries);
  const fStats = getFindingsStats(ctx.queries);
  const errs = fStats.bySeverity['error'] ?? 0;
  const warns = fStats.bySeverity['warning'] ?? 0;
  const infos = fStats.bySeverity['info'] ?? 0;
  const denom = Math.max(1, fStats.nodesWithFindings);
  const penalty = (errs * HEALTH_PENALTY_ERROR + warns * HEALTH_PENALTY_WARNING + infos * HEALTH_PENALTY_INFO) / denom;
  const codeHealth = Math.max(
    HEALTH_FLOOR,
    Math.round((HEALTH_BASELINE - penalty) * HEALTH_DECIMAL_RESOLUTION) / HEALTH_DECIMAL_RESOLUTION,
  );
  return {
    totalFindings: fStats.totalFindings,
    byBiomarker: fStats.byBiomarker,
    bySeverity: fStats.bySeverity,
    nodesWithFindings: fStats.nodesWithFindings,
    totalNodes: stats.nodeCount,
    totalFiles: stats.fileCount,
    codeHealth,
  };
}

export function sessionsPayload(ctx: RequestContext, limit: number): unknown {
  const rows = recentSessions(ctx.queries, limit);
  return {
    sessions: rows.map((r) => ({
      id: r.id,
      lastActivityTs: r.lastActivityTs,
      toolCount: r.toolCount,
    })),
  };
}

export function sessionDetailPayload(ctx: RequestContext, sessionId: string): unknown {
  const calls = callsForSession(ctx.queries, sessionId);
  return {
    sessionId,
    calls: calls.map((c) => ({
      step: c.step,
      ts: c.ts,
      tool: c.toolName,
      args: safeParseJson(c.argsJson),
      result: c.resultSummary,
      durationMs: c.durationMs,
    })),
  };
}

function safeParseJson(s: string): unknown {
  try {
    return JSON.parse(s);
  } catch {
    return s;
  }
}

export function biomarkerFindingsPayload(ctx: RequestContext, biomarker: string, limit: number): unknown {
  const rows = getFindingsRanked(ctx.queries, { biomarker, limit });
  return {
    biomarker,
    findings: rows.map((r) => ({
      id: r.nodeId,
      name: r.name,
      file: r.filePath,
      severity: r.severity,
      metric: r.metric,
    })),
  };
}

export function hotspotsPayload(ctx: RequestContext, limit: number): unknown {
  const rows = getHotspots(ctx.queries, { limit, sortBy: 'risk' });
  return {
    hotspots: rows.map((r) => ({
      filePath: r.filePath,
      commits: r.commitCount,
      loc: r.loc,
      lastTouchedTs: r.lastTouchedTs,
      risk: r.riskScore,
    })),
  };
}
