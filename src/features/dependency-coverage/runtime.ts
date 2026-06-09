import type { QueryBuilder } from '../../db/queries.js';

export const DEFAULT_DEPENDENCY_COVERAGE_LIMIT = 20;
export const MAX_DEPENDENCY_COVERAGE_LIMIT = 100;

export interface DependencyCoverageRow {
  language: string;
  edgeKind: string;
  resolved: number;
  unresolved: number;
  crossFile: number;
  extracted: number;
  inferred: number;
  ambiguous: number;
  resolvedPct: number | null;
}

export interface UnresolvedNameRow {
  name: string;
  language: string;
  edgeKind: string;
  count: number;
}

export interface ChainCandidateRow {
  name: string;
  language: string;
  edgeKind: string;
  count: number;
}

export interface DependencyCoverageReport {
  rows: DependencyCoverageRow[];
  unresolvedNames: UnresolvedNameRow[];
  chainCandidates: ChainCandidateRow[];
  totals: {
    resolved: number;
    unresolved: number;
    crossFile: number;
  };
}

interface ResolvedAggregateRow {
  language: string | null;
  edgeKind: string;
  resolved: number;
  crossFile: number;
  extracted: number;
  inferred: number;
  ambiguous: number;
}

interface UnresolvedAggregateRow {
  language: string | null;
  edgeKind: string;
  unresolved: number;
}

export function collectDependencyCoverage(
  qb: QueryBuilder,
  limit = DEFAULT_DEPENDENCY_COVERAGE_LIMIT,
): DependencyCoverageReport {
  const resolvedRows = qb.db
    .prepare(
      `SELECT
         COALESCE(NULLIF(src.language, ''), 'unknown') AS language,
         e.kind AS edgeKind,
         COUNT(*) AS resolved,
         SUM(CASE WHEN src.file_path != dst.file_path THEN 1 ELSE 0 END) AS crossFile,
         SUM(CASE WHEN COALESCE(e.confidence, 'EXTRACTED') = 'EXTRACTED' THEN 1 ELSE 0 END) AS extracted,
         SUM(CASE WHEN e.confidence = 'INFERRED' THEN 1 ELSE 0 END) AS inferred,
         SUM(CASE WHEN e.confidence = 'AMBIGUOUS' THEN 1 ELSE 0 END) AS ambiguous
       FROM edges e
       JOIN nodes src ON src.id = e.source
       JOIN nodes dst ON dst.id = e.target
       GROUP BY COALESCE(NULLIF(src.language, ''), 'unknown'), e.kind`,
    )
    .all() as ResolvedAggregateRow[];

  const unresolvedRows = qb.db
    .prepare(
      `SELECT
         COALESCE(NULLIF(language, ''), 'unknown') AS language,
         reference_kind AS edgeKind,
         COUNT(*) AS unresolved
       FROM unresolved_refs
       GROUP BY COALESCE(NULLIF(language, ''), 'unknown'), reference_kind`,
    )
    .all() as UnresolvedAggregateRow[];

  const allRows = mergeCoverageRows(resolvedRows, unresolvedRows);
  const sortedRows = [...allRows];
  sortedRows.sort(
    (a, b) =>
      b.unresolved - a.unresolved ||
      b.resolved - a.resolved ||
      a.language.localeCompare(b.language) ||
      a.edgeKind.localeCompare(b.edgeKind),
  );
  const rows = sortedRows.slice(0, limit);

  const unresolvedNames = collectUnresolvedNames(qb, limit);
  const chainCandidates = collectChainCandidates(qb, Math.min(limit, 20));
  return {
    rows,
    unresolvedNames,
    chainCandidates,
    totals: allRows.reduce(
      (acc, row) => ({
        resolved: acc.resolved + row.resolved,
        unresolved: acc.unresolved + row.unresolved,
        crossFile: acc.crossFile + row.crossFile,
      }),
      { resolved: 0, unresolved: 0, crossFile: 0 },
    ),
  };
}

function coverageKey(language: string | null, edgeKind: string): string {
  return `${language || 'unknown'}\0${edgeKind}`;
}

function mergeCoverageRows(
  resolvedRows: readonly ResolvedAggregateRow[],
  unresolvedRows: readonly UnresolvedAggregateRow[],
): DependencyCoverageRow[] {
  const byKey = new Map<string, DependencyCoverageRow>();
  for (const row of resolvedRows) {
    const language = row.language || 'unknown';
    const key = coverageKey(language, row.edgeKind);
    byKey.set(key, {
      language,
      edgeKind: row.edgeKind,
      resolved: row.resolved,
      unresolved: 0,
      crossFile: row.crossFile,
      extracted: row.extracted,
      inferred: row.inferred,
      ambiguous: row.ambiguous,
      resolvedPct: null,
    });
  }
  for (const row of unresolvedRows) {
    const language = row.language || 'unknown';
    const key = coverageKey(language, row.edgeKind);
    const existing =
      byKey.get(key) ??
      ({
        language,
        edgeKind: row.edgeKind,
        resolved: 0,
        unresolved: 0,
        crossFile: 0,
        extracted: 0,
        inferred: 0,
        ambiguous: 0,
        resolvedPct: null,
      } satisfies DependencyCoverageRow);
    existing.unresolved = row.unresolved;
    byKey.set(key, existing);
  }
  return [...byKey.values()].map((row) => {
    const denominator = row.resolved + row.unresolved;
    return { ...row, resolvedPct: denominator === 0 ? null : row.resolved / denominator };
  });
}

function collectUnresolvedNames(qb: QueryBuilder, limit: number): UnresolvedNameRow[] {
  return qb.db
    .prepare(
      `SELECT
         reference_name AS name,
         COALESCE(NULLIF(language, ''), 'unknown') AS language,
         reference_kind AS edgeKind,
         COUNT(*) AS count
       FROM unresolved_refs
       GROUP BY reference_name, COALESCE(NULLIF(language, ''), 'unknown'), reference_kind
       ORDER BY count DESC, name ASC
       LIMIT ?`,
    )
    .all(limit) as UnresolvedNameRow[];
}

function collectChainCandidates(qb: QueryBuilder, limit: number): ChainCandidateRow[] {
  return qb.db
    .prepare(
      `SELECT
         reference_name AS name,
         COALESCE(NULLIF(language, ''), 'unknown') AS language,
         reference_kind AS edgeKind,
         COUNT(*) AS count
       FROM unresolved_refs
       WHERE reference_name LIKE '%.%(%).%' OR reference_name LIKE '%().%' OR reference_name LIKE '%->%'
       GROUP BY reference_name, COALESCE(NULLIF(language, ''), 'unknown'), reference_kind
       ORDER BY count DESC, name ASC
       LIMIT ?`,
    )
    .all(limit) as ChainCandidateRow[];
}
