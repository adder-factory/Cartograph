/**
 * Code Health findings (biomarker output) queries.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain biomarker storage helpers as direct members. The
 * functions read / write the `code_health_findings` table via the
 * `@internal`-tagged `db` and `queries` fields on the parent
 * `QueryBuilder`.
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20). Static prepared statements
 * are declared at module scope via {@link defineQuery}; Zod schemas
 * drive params + row validation. Lazy-cached on `qb.queries.X`.
 * {@link getFindingsRanked} — with six independent optional filters
 * (biomarker/minSeverity/minCentrality/minMetric/maxMetric/excludeFile)
 * — uses {@link defineDynamicQuery}: the SQL is built per call from the
 * present filters, and prepared statements are cached per filter-shape
 * within the instance. Avoids both Pattern C variant explosion (64
 * variants) and Pattern B planner-defeat on the indexed `nodes.centrality`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, defineDynamicQuery, type TypedQuery, type DynamicTypedQuery } from './typed-query.js';
import { logWarn } from '../errors.js';
import { CROSS_FILE_BIOMARKERS } from '../biomarkers/types.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

const SeveritySchema = z.enum(['info', 'warning', 'error']);
const PassKindSchema = z.enum(['full-pass', 'partial-rescan', 'cached']);
type FindingSeverity = z.infer<typeof SeveritySchema>;
type FindingInput = {
  biomarker: string;
  severity: FindingSeverity;
  metric: number;
  detail?: unknown;
};
type FindingForNode = {
  biomarker: string;
  severity: FindingSeverity;
  metric: number;
  detail: unknown;
  detectedAt: number;
  surfaceReason: PassKind;
};
type RankedFinding = {
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  biomarker: string;
  severity: FindingSeverity;
  metric: number;
  centrality: number | null;
  detail: unknown;
  surfaceReason: PassKind;
};

const InsertFindingParamsSchema = z.object({
  nodeId: z.string(),
  biomarker: z.string(),
  severity: SeveritySchema,
  metric: z.number(),
  detail: z.string().nullable(),
  detectedAt: z.number(),
  sourceContentHash: z.string(),
  passKind: PassKindSchema,
});
type InsertFindingParams = z.infer<typeof InsertFindingParamsSchema>;

const HashRowSchema = z.object({ hash: z.string().nullable() });
const ContentHashRowSchema = z.object({ content_hash: z.string().nullable() });

const FindingForNodeRowSchema = z.object({
  biomarker: z.string(),
  severity: SeveritySchema,
  metric: z.number(),
  detail: z.string().nullable(),
  detected_at: z.number(),
  pass_kind: z.string(),
});
type FindingForNodeRow = z.infer<typeof FindingForNodeRowSchema>;

const CountRowSchema = z.object({ n: z.number() });
const BiomarkerSeverityCountRowSchema = z.object({
  biomarker: z.string(),
  severity: z.string(),
  n: z.number(),
});
const SeverityCountRowSchema = z.object({ severity: z.string(), n: z.number() });
const PassKindCountRowSchema = z.object({ pass_kind: z.string(), n: z.number() });

const NoParams = z.object({});

// ─── Typed query definitions ──────────────────────────────────────────────

/** Single-row INSERT shared by `appendFindings` and `replaceFindingsForFile`. */
const insertFindingQuery = defineQuery({
  sql: `INSERT INTO code_health_findings
       (node_id, biomarker, severity, metric, detail, detected_at, source_content_hash, pass_kind)
     VALUES (@nodeId, @biomarker, @severity, @metric, @detail, @detectedAt, @sourceContentHash, @passKind)`,
  params: InsertFindingParamsSchema,
  row: z.never(),
});

const getNodeFileHashQuery = defineQuery({
  sql: `SELECT f.content_hash AS hash
       FROM nodes n JOIN files f ON n.file_path = f.path
      WHERE n.id = @nodeId`,
  params: z.object({ nodeId: z.string() }),
  row: HashRowSchema,
});

const deleteFindingsByKindQuery = defineQuery({
  sql: 'DELETE FROM code_health_findings WHERE biomarker = @biomarker',
  params: z.object({ biomarker: z.string() }),
  row: z.never(),
});

/**
 * Per-file non-cross-file finding wipe. The `biomarker NOT IN (...)`
 * list is bound via a single JSON-encoded `@crossFileBiomarkers`
 * parameter consumed by `json_each`, so the SQL stays static
 * (a precondition of {@link defineQuery}) even when
 * {@link CROSS_FILE_BIOMARKERS} grows.
 */
const deleteNonCrossFileFindingsQuery = defineQuery({
  sql: `DELETE FROM code_health_findings
       WHERE biomarker NOT IN (SELECT value FROM json_each(@crossFileBiomarkers))
         AND node_id IN (SELECT id FROM nodes WHERE file_path = @filePath)`,
  params: z.object({ crossFileBiomarkers: z.string(), filePath: z.string() }),
  row: z.never(),
});

const getFileContentHashQuery = defineQuery({
  sql: `SELECT content_hash FROM files WHERE path = @filePath`,
  params: z.object({ filePath: z.string() }),
  row: ContentHashRowSchema,
});

const promoteCachedToFullPassQuery = defineQuery({
  sql: `UPDATE code_health_findings
        SET pass_kind = 'full-pass'
      WHERE pass_kind = 'cached'`,
  params: NoParams,
  row: z.never(),
});

const demoteFullPassRowsToCachedQuery = defineQuery({
  sql: `UPDATE code_health_findings
        SET pass_kind = 'cached'
      WHERE pass_kind IN ('full-pass', 'partial-rescan')`,
  params: NoParams,
  row: z.never(),
});

const getFindingsForNodeQuery = defineQuery({
  sql: `SELECT biomarker, severity, metric, detail, detected_at, pass_kind
     FROM code_health_findings
     WHERE node_id = @nodeId
     ORDER BY ${severityOrderCaseExpr('severity')}, biomarker`,
  params: z.object({ nodeId: z.string() }),
  row: FindingForNodeRowSchema,
});

const getFindingsStatsTotalQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n FROM code_health_findings`,
  params: NoParams,
  row: CountRowSchema,
});

const getFindingsStatsByBiomarkerSeverityQuery = defineQuery({
  sql: `SELECT biomarker, severity, COUNT(*) AS n
     FROM code_health_findings
     GROUP BY biomarker, severity`,
  params: NoParams,
  row: BiomarkerSeverityCountRowSchema,
});

const getFindingsStatsBySeverityQuery = defineQuery({
  sql: `SELECT severity, COUNT(*) AS n FROM code_health_findings GROUP BY severity`,
  params: NoParams,
  row: SeverityCountRowSchema,
});

const getFindingsStatsByPassKindQuery = defineQuery({
  sql: `SELECT pass_kind, COUNT(*) AS n FROM code_health_findings GROUP BY pass_kind`,
  params: NoParams,
  row: PassKindCountRowSchema,
});

const getFindingsStatsNodesQuery = defineQuery({
  sql: `SELECT COUNT(DISTINCT node_id) AS n FROM code_health_findings`,
  params: NoParams,
  row: CountRowSchema,
});

/**
 * Module-level twin of {@link severityOrderCase} — `defineQuery` needs
 * the SQL string fully assembled at module top-level, before the
 * existing `severityOrderCase` function declaration runs. The
 * function form stays below (used by the dynamic SQL in
 * {@link getFindingsRanked}); both render the identical SQL fragment.
 */
function severityOrderCaseExpr(col: string): string {
  return `CASE ${col} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;
}

/**
 * Pass-kind tag stamped on every row at write time. See the
 * `pass_kind` column doc in schema.sql for full semantics.
 */
export type PassKind = 'full-pass' | 'partial-rescan' | 'cached';

/**
 * Append findings without touching existing ones. Used by cross-file
 * rules (like `unused_export`) that compute findings AFTER the
 * per-file replace pass has already written, and so can't go through
 * `replaceFindingsForFile` without clobbering. Atomic per call.
 *
 * Caller must ensure the same finding isn't appended twice — this
 * function does no dedup. For `unused_export` that's safe because
 * each scan starts by globally clearing the kind: see
 * `clearFindingsByKind`.
 *
 * `passKind` defaults to `'full-pass'` so explicit callers (tests
 * inserting fixture rows, the cross-file orchestrator on a full pass)
 * don't have to pass it. The orchestrator overrides it to
 * `'partial-rescan'` when the run was triggered by a per-edit sync.
 */
export function appendFindings(
  qb: QueryBuilder,
  findings: ReadonlyArray<{
    nodeId: string;
    biomarker: string;
    severity: FindingSeverity;
    metric: number;
    detail?: unknown;
  }>,
  passKind: PassKind = 'full-pass',
): void {
  if (findings.length === 0) return;
  const now = Date.now();
  qb.queries.insertFinding ??= insertFindingQuery(qb.db);
  const ins = qb.queries.insertFinding;
  // Resolve the file content_hash for each finding's node so we can
  // detect later whether the finding is stale relative to the file's
  // current content. Cached by node_id within this batch — multiple
  // findings on the same node share one lookup.
  qb.queries.getNodeFileHash ??= getNodeFileHashQuery(qb.db);
  const getHash = qb.queries.getNodeFileHash;
  const hashCache = new Map<string, string>();
  const resolveHash = (nodeId: string): string => {
    const cached = hashCache.get(nodeId);
    if (cached !== undefined) return cached;
    const row = getHash.get({ nodeId });
    const hash = row?.hash ?? '';
    hashCache.set(nodeId, hash);
    return hash;
  };
  qb.db.transaction(() => {
    for (const f of findings) {
      ins.run({
        nodeId: f.nodeId,
        biomarker: f.biomarker,
        severity: f.severity,
        metric: f.metric,
        detail: f.detail === undefined ? null : JSON.stringify(f.detail),
        detectedAt: now,
        sourceContentHash: resolveHash(f.nodeId),
        passKind,
      });
    }
  })();
}

/** Drop all findings of a single biomarker kind across the project.
 *  Used by cross-file rules before re-scanning so old hits don't
 *  linger when the underlying graph state changes. */
export function clearFindingsByKind(qb: QueryBuilder, biomarker: string): void {
  qb.queries.deleteFindingsByKind ??= deleteFindingsByKindQuery(qb.db);
  qb.queries.deleteFindingsByKind.run({ biomarker });
}

/**
 * Replace every finding for the nodes belonging to `filePath`.
 * Atomic — readers never see a half-written file.
 *
 * The map is `node_id → findings[]`. Nodes in `filePath` not present
 * in the map have their findings cleared (turning warnings into
 * green is a real outcome; we want it reflected immediately).
 */
/**
 * Wipe per-file (non-cross-file) findings for one file. Cross-file
 * biomarkers (computed from global graph state, not this file's AST)
 * must NOT be wiped by per-file replace, or sync runs that touch a
 * file would silently lose those findings without recomputing them.
 */
function deleteNonCrossFileFindings(qb: QueryBuilder, filePath: string): void {
  qb.queries.deleteNonCrossFileFindings ??= deleteNonCrossFileFindingsQuery(qb.db);
  qb.queries.deleteNonCrossFileFindings.run({
    crossFileBiomarkers: JSON.stringify([...CROSS_FILE_BIOMARKERS]),
    filePath,
  });
}

/**
 * Look up the content_hash for `filePath`, warning when the file row
 * is missing (a deletion race) so findings still get inserted with
 * an empty hash and surface as stale on the next status call.
 */
function resolveFileHashOrWarn(qb: QueryBuilder, filePath: string): string {
  qb.queries.getFileContentHash ??= getFileContentHashQuery(qb.db);
  const fileRow = qb.queries.getFileContentHash.get({ filePath });
  if (!fileRow) {
    logWarn('replaceFindingsForFile: file row missing, source_content_hash will be empty', { filePath });
  }
  return fileRow?.content_hash ?? '';
}

/** Arguments for {@link replaceFindingsForFile}. */
export interface ReplaceFindingsForFileArgs {
  qb: QueryBuilder;
  filePath: string;
  findingsByNode: ReadonlyMap<string, ReadonlyArray<FindingInput>>;
  passKind?: PassKind;
}

export function replaceFindingsForFile({
  qb,
  filePath,
  findingsByNode,
  passKind = 'full-pass',
}: ReplaceFindingsForFileArgs): void {
  const now = Date.now();
  qb.db.transaction(() => {
    deleteNonCrossFileFindings(qb, filePath);

    // One file → one content_hash. Look it up once per call instead
    // of per-finding (vs the per-node lookup in appendFindings).
    const sourceHash = resolveFileHashOrWarn(qb, filePath);

    qb.queries.insertFinding ??= insertFindingQuery(qb.db);
    const ins = qb.queries.insertFinding;
    for (const [nodeId, findings] of findingsByNode) {
      for (const f of findings) {
        ins.run({
          nodeId,
          biomarker: f.biomarker,
          severity: f.severity,
          metric: f.metric,
          detail: f.detail === undefined ? null : JSON.stringify(f.detail),
          detectedAt: now,
          sourceContentHash: sourceHash,
          passKind,
        });
      }
    }
  })();
}

/**
 * Promote every `'cached'` row to `'full-pass'` at the END of a
 * successful full pass. Called after the per-file loop completes so
 * rows that the content-hash cache short-circuited (i.e. the file was
 * checked and found unchanged) carry the same `'full-pass'` label as
 * rows that were actively re-evaluated this pass.
 *
 * Why this matters: without this promotion, `mode:stats` reports
 * `full-pass: N` for cross-file findings (which are always rewritten on
 * a full pass) while `mode:ranked` shows `cached` for per-file findings
 * whose source didn't change — even though both sets were validated by
 * the same full-project scan. The inconsistency misleads agents into
 * treating per-file findings as "stale" when they are current.
 *
 * `partial-rescan` rows are NOT promoted — a partial-rescan is not a
 * full-project validation; those findings remain labelled `partial-rescan`
 * until the next full pass overwrites them.
 */
export function promoteFullPassCachedToFullPass(qb: QueryBuilder): void {
  qb.queries.promoteCachedToFullPass ??= promoteCachedToFullPassQuery(qb.db);
  qb.queries.promoteCachedToFullPass.run({});
}

/**
 * Demote every existing row's `pass_kind` to `'cached'`. The biomarker
 * orchestrator calls this AT THE START of a full pass so rows that
 * subsequently get rewritten flip back to `'full-pass'`, while rows
 * that the file-level content-hash cache short-circuits stay at
 * `'cached'` — i.e. the file's source didn't change since the last
 * full pass, the finding is still believed accurate, but the rules
 * weren't re-run against fresh AST this time.
 *
 * Both `'full-pass'` and `'partial-rescan'` rows are demoted. We could
 * leave `'partial-rescan'` untouched (it carries the same signal:
 * accurate, not freshly evaluated), but the simpler "demote everything
 * not rewritten this pass" rule is clearer. Steady-state semantics
 * post-full-pass: `'full-pass'` = re-emitted this pass; `'cached'` =
 * not re-evaluated this pass; `'partial-rescan'` = will only re-appear
 * when a subsequent per-file rescan writes it.
 */
export function demoteFullPassRowsToCached(qb: QueryBuilder): void {
  qb.queries.demoteFullPassRowsToCached ??= demoteFullPassRowsToCachedQuery(qb.db);
  qb.queries.demoteFullPassRowsToCached.run({});
}

/** SQL `CASE` fragment mapping a severity column to a sort key where
 *  `error` sorts first (0) — use inside `ORDER BY`. Mirrors the
 *  `SEVERITY_DESC` ordering in `biomarkers/types.ts`; kept as a local
 *  string because SQL can't consume the TS const directly. */
function severityOrderCase(col: string): string {
  return `CASE ${col} WHEN 'error' THEN 0 WHEN 'warning' THEN 1 ELSE 2 END`;
}

/** SQL `CASE` fragment mapping a severity column/param to its rank
 *  (`error` 2 … `info` 0) — use for `minSeverity` threshold compares,
 *  e.g. `${severityFilterCase('f.severity')} >= ${severityFilterCase('@minSev')}`.
 *  Exported so the `biomarkers` empty-result probe shares the one
 *  expression rather than re-inlining the ranking. */
export function severityFilterCase(colOrParam: string): string {
  return `CASE ${colOrParam} WHEN 'error' THEN 2 WHEN 'warning' THEN 1 ELSE 0 END`;
}

/**
 * JSON.parse wrapper that returns null on malformed input. DB
 * `detail` columns are populated by cartograph itself + are trusted,
 * but a schema-migration glitch or external edit could leave
 * malformed bytes — we'd rather show "no detail" than throw on a
 * downstream MCP read.
 */
function safeParseDetailJson(raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

/** All findings on a single symbol, ordered by severity then biomarker. */
export function getFindingsForNode(qb: QueryBuilder, nodeId: string): Array<FindingForNode> {
  qb.queries.getFindingsForNode ??= getFindingsForNodeQuery(qb.db);
  const rows = qb.queries.getFindingsForNode.all({ nodeId });
  return rows.map((r) => ({
    biomarker: r.biomarker,
    severity: r.severity,
    metric: r.metric,
    // Defensive JSON.parse — DB column contents are trusted but a
    // schema migration glitch or external edit could leave malformed
    // JSON. Falling back to null is safer than throwing on read.
    detail: r.detail === null ? null : safeParseDetailJson(r.detail),
    detectedAt: r.detected_at,
    surfaceReason: normalisePassKind(r.pass_kind),
  }));
}

/**
 * `getFindingsRanked` dynamic typed query — 6 independent optional
 * filters; Pattern C variant explosion (64 variants) or Pattern B
 * sentinel-OR (planner-defeat on indexed `nodes.centrality`) are both
 * worse than dynamic-typed.
 */
const FindingsRankedParamsSchema = z.object({
  biomarker: z.string().optional(),
  minSeverity: z.enum(['info', 'warning', 'error']).optional(),
  minCentrality: z.number().optional(),
  minMetric: z.number().optional(),
  maxMetric: z.number().optional(),
  excludeFile: z.string().optional(),
  limit: z.number(),
});
type FindingsRankedParams = z.infer<typeof FindingsRankedParamsSchema>;

const FindingsRankedRowSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  biomarker: z.string(),
  severity: z.enum(['info', 'warning', 'error']),
  metric: z.number(),
  centrality: z.number().nullable(),
  detail: z.string().nullable(),
  pass_kind: z.string(),
});
type FindingsRankedRow = z.infer<typeof FindingsRankedRowSchema>;

const getFindingsRankedQuery = defineDynamicQuery({
  params: FindingsRankedParamsSchema,
  row: FindingsRankedRowSchema,
  build: (p) => {
    const where: string[] = [];
    const bindings: Record<string, unknown> = { limit: p.limit };
    if (p.biomarker !== undefined) {
      where.push('f.biomarker = @biomarker');
      bindings['biomarker'] = p.biomarker;
    }
    if (p.minSeverity !== undefined) {
      where.push(`${severityFilterCase('f.severity')} >= ${severityFilterCase('@minSev')}`);
      bindings['minSev'] = p.minSeverity;
    }
    if (p.minCentrality !== undefined) {
      // Errors bypass the centrality floor — an error-tier finding is
      // worth surfacing regardless of structural reach (friction F-C).
      where.push("(n.centrality >= @minCentrality OR f.severity = 'error')");
      bindings['minCentrality'] = p.minCentrality;
    }
    if (p.minMetric !== undefined) {
      where.push('f.metric >= @minMetric');
      bindings['minMetric'] = p.minMetric;
    }
    if (p.maxMetric !== undefined) {
      where.push('f.metric <= @maxMetric');
      bindings['maxMetric'] = p.maxMetric;
    }
    if (p.excludeFile !== undefined && p.excludeFile.length > 0) {
      // Literal prefix exclusion via LIKE with explicit ESCAPE — paths
      // can contain `_` so we escape `_`/`%`/`\`. GLOB has no escape
      // syntax for its `*`/`?` metachars.
      const backslash = String.fromCodePoint(92);
      const escaped = p.excludeFile
        .replaceAll(backslash, backslash + backslash)
        .replaceAll('_', backslash + '_')
        .replaceAll('%', backslash + '%');
      where.push(String.raw`n.file_path NOT LIKE @excludeLike ESCAPE '\'`);
      bindings['excludeLike'] = escaped + '%';
    }
    const sql =
      `SELECT n.id AS node_id, n.name, n.kind, n.file_path,
              f.biomarker, f.severity, f.metric, n.centrality, f.detail,
              f.pass_kind
         FROM code_health_findings f
         JOIN nodes n ON n.id = f.node_id` +
      (where.length > 0 ? ' WHERE ' + where.join(' AND ') : '') +
      ` ORDER BY ${severityOrderCase('f.severity')},
                 n.centrality DESC NULLS LAST,
                 f.metric DESC
        LIMIT @limit`;
    return { sql, bindings };
  },
});

/** Map raw finding row to public result shape. */
function mapFindingsRow(r: {
  node_id: string;
  name: string;
  kind: string;
  file_path: string;
  biomarker: string;
  severity: FindingSeverity;
  metric: number;
  centrality: number | null;
  detail: string | null;
  pass_kind: string;
}): RankedFinding {
  return {
    nodeId: r.node_id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    biomarker: r.biomarker,
    severity: r.severity,
    metric: r.metric,
    centrality: r.centrality,
    detail: r.detail === null ? null : safeParseDetailJson(r.detail),
    // `pass_kind` is the stored column; `surfaceReason` is the agent-
    // facing field name (more intuitive in tool output than the
    // implementation term).
    surfaceReason: normalisePassKind(r.pass_kind),
  };
}

/** Coerce an arbitrary string from the DB into a known `PassKind`.
 *  Pre-migration rows default to 'cached' via the column default;
 *  unknown values (shouldn't happen) also map to 'cached' so callers
 *  always get one of the three documented states. */
function normalisePassKind(value: string): PassKind {
  if (value === 'full-pass' || value === 'partial-rescan' || value === 'cached') {
    return value;
  }
  return 'cached';
}

/**
 * Symbols ranked by severity of their worst finding. Joins centrality
 * so the agent can ask "what's the worst-health, highest-impact code
 * in the project?" with one query.
 */
export function getFindingsRanked(
  qb: QueryBuilder,
  options: {
    biomarker?: string;
    minSeverity?: FindingSeverity;
    minCentrality?: number;
    minMetric?: number;
    maxMetric?: number;
    excludeFile?: string;
    limit?: number;
  } = {},
): Array<RankedFinding> {
  qb.queries.getFindingsRanked ??= getFindingsRankedQuery(qb.db);
  const rows = qb.queries.getFindingsRanked.all({
    biomarker: options.biomarker,
    minSeverity: options.minSeverity,
    minCentrality: options.minCentrality,
    minMetric: options.minMetric,
    maxMetric: options.maxMetric,
    excludeFile: options.excludeFile,
    limit: options.limit ?? 50,
  });
  return rows.map(mapFindingsRow);
}

/**
 * Per-severity row appearing in the per-biomarker breakdown. Defaults
 * to zeros so callers can read `.warning` etc. without null-checking.
 */
interface SeverityCounts {
  info: number;
  warning: number;
  error: number;
}

/**
 * Per-surface-reason rollup. Always present for all three states
 * so consumers can read `.full-pass` without null-checking.
 */
interface SurfaceCounts {
  'full-pass': number;
  'partial-rescan': number;
  cached: number;
}

/**
 * Project-wide rollup: per-biomarker counts, per-severity counts, a
 * per-biomarker × per-severity breakdown, AND (since migration 061)
 * a per-surface-reason rollup so the agent can see at a glance how
 * many findings are partial-rescan-surfaced (i.e. potentially
 * edit-induced and worth a closer look) vs full-pass / cached.
 *
 * The rollup reads the live `code_health_findings` table at query
 * time. Both per-symbol full passes and per-edit partial rescans
 * mutate this table; cross-file rules (unused_export / god_class /
 * feature_envy / illegal_import) re-run on every partial sync against
 * the current global graph state. So this count is always the union
 * of fresh + cached cross-file findings — it never lags the latest
 * partial sync.
 */
export function getFindingsStats(qb: QueryBuilder): {
  totalFindings: number;
  byBiomarker: Record<string, number>;
  byBiomarkerSeverity: Record<string, SeverityCounts>;
  bySeverity: Record<string, number>;
  bySurfaceReason: SurfaceCounts;
  nodesWithFindings: number;
} {
  qb.queries.getFindingsStatsTotal ??= getFindingsStatsTotalQuery(qb.db);
  const total = qb.queries.getFindingsStatsTotal.get({}) ?? { n: 0 };
  // Single GROUP BY (biomarker, severity) so the per-biomarker totals
  // and the severity breakdown both come from the same scan.
  qb.queries.getFindingsStatsByBiomarkerSeverity ??= getFindingsStatsByBiomarkerSeverityQuery(qb.db);
  const cross = qb.queries.getFindingsStatsByBiomarkerSeverity.all({});
  qb.queries.getFindingsStatsBySeverity ??= getFindingsStatsBySeverityQuery(qb.db);
  const bySeverity = qb.queries.getFindingsStatsBySeverity.all({});
  qb.queries.getFindingsStatsByPassKind ??= getFindingsStatsByPassKindQuery(qb.db);
  const surface = qb.queries.getFindingsStatsByPassKind.all({});
  qb.queries.getFindingsStatsNodes ??= getFindingsStatsNodesQuery(qb.db);
  const nodes = qb.queries.getFindingsStatsNodes.get({}) ?? { n: 0 };

  const byBiomarker: Record<string, number> = {};
  const byBiomarkerSeverity: Record<string, SeverityCounts> = {};
  for (const r of cross) {
    byBiomarker[r.biomarker] = (byBiomarker[r.biomarker] ?? 0) + r.n;
    const slot = byBiomarkerSeverity[r.biomarker] ?? { info: 0, warning: 0, error: 0 };
    if (r.severity === 'info' || r.severity === 'warning' || r.severity === 'error') {
      slot[r.severity] += r.n;
    }
    byBiomarkerSeverity[r.biomarker] = slot;
  }

  const bySurfaceReason: SurfaceCounts = { 'full-pass': 0, 'partial-rescan': 0, cached: 0 };
  for (const r of surface) {
    const k = normalisePassKind(r.pass_kind);
    bySurfaceReason[k] += r.n;
  }

  return {
    totalFindings: total.n,
    byBiomarker,
    byBiomarkerSeverity,
    bySeverity: Object.fromEntries(bySeverity.map((r) => [r.severity, r.n])),
    bySurfaceReason,
    nodesWithFindings: nodes.n,
  };
}

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    insertFinding?: TypedQuery<InsertFindingParams, never>;
    getNodeFileHash?: TypedQuery<{ nodeId: string }, { hash: string | null }>;
    deleteFindingsByKind?: TypedQuery<{ biomarker: string }, never>;
    deleteNonCrossFileFindings?: TypedQuery<{ crossFileBiomarkers: string; filePath: string }, never>;
    getFileContentHash?: TypedQuery<{ filePath: string }, { content_hash: string | null }>;
    promoteCachedToFullPass?: TypedQuery<Record<string, never>, never>;
    demoteFullPassRowsToCached?: TypedQuery<Record<string, never>, never>;
    getFindingsForNode?: TypedQuery<{ nodeId: string }, FindingForNodeRow>;
    getFindingsStatsTotal?: TypedQuery<Record<string, never>, { n: number }>;
    getFindingsStatsByBiomarkerSeverity?: TypedQuery<
      Record<string, never>,
      { biomarker: string; severity: string; n: number }
    >;
    getFindingsStatsBySeverity?: TypedQuery<Record<string, never>, { severity: string; n: number }>;
    getFindingsStatsByPassKind?: TypedQuery<Record<string, never>, { pass_kind: string; n: number }>;
    getFindingsStatsNodes?: TypedQuery<Record<string, never>, { n: number }>;
    getFindingsRanked?: DynamicTypedQuery<FindingsRankedParams, FindingsRankedRow>;
  }
}
