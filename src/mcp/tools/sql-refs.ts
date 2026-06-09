/**
 * @internal — sql-mode handler for the consolidated `cartograph_string_refs`
 * family tool. Dispatched from `refs.ts` when `kind === 'sql'`. No
 * registered ToolModule export — the registry only knows REFS_TOOL.
 */
import type { ToolResult } from '../tool-types.js';
import { getSqlRefsByTable, getSqlTables } from '../../db/queries-refs.js';
import { clamp, isTestPath } from '../../utils.js';
import { textResult, truncateOutput, countByTestPath, formatRefSiteLine } from './shared.js';
import { renderMarkdownTable, type MarkdownTableSpec } from './_result-spec.js';
import type { ToolCtx } from './types.js';

/** Clamp ceiling for `limit` from agent input. */
const SQL_REFS_LIMIT_MAX = 500;

/** Default `limit` when caller doesn't pass one. */
const SQL_REFS_LIMIT_DEFAULT = 30;

/**
 * Multiplier widening the raw fetch beyond `limit` so prod/test
 * post-filtering still produces enough rows for prod-heavy tables.
 */
const SQL_REFS_OVERFETCH_MULTIPLIER = 4;

function enrichSqlTable(
  cg: ReturnType<ToolCtx['getCartograph']>,
  row: { tableName: string; reads: number; writes: number; ddl: number; total: number },
): typeof row & { prodTotal: number; testTotal: number } {
  const sites = getSqlRefsByTable(cg.queries, row.tableName);
  const { prod, test } = countByTestPath(sites);
  return { ...row, prodTotal: prod, testTotal: test };
}

const VALID_SQL_OPS: ReadonlySet<string> = new Set(['read', 'write', 'ddl']);

/** Type-guard the `op` arg coming in from the JSON-RPC layer. */
function parseSqlOp(raw: unknown): 'read' | 'write' | 'ddl' | undefined {
  if (typeof raw !== 'string') return undefined;
  if (!VALID_SQL_OPS.has(raw)) return undefined;
  return raw as 'read' | 'write' | 'ddl';
}

/**
 * Render the no-table mode of `cartograph_string_refs({kind:'sql'})`: top SQL tables
 * touched by the codebase, ranked by prod usage, optionally filtering test-only.
 */
function renderSqlTableList(
  cg: ReturnType<ToolCtx['getCartograph']>,
  args: Record<string, unknown>,
  includeTests: boolean,
): ToolResult {
  const rawLimit = args['limit'];
  const clampedLimit = clamp(rawLimit as number, 1, SQL_REFS_LIMIT_MAX);
  const limit = rawLimit == null ? SQL_REFS_LIMIT_DEFAULT : clampedLimit;
  const rows = getSqlTables(cg.queries, { limit: limit * SQL_REFS_OVERFETCH_MULTIPLIER });
  const enriched = rows.map((r) => enrichSqlTable(cg, r));
  const filtered = includeTests ? enriched : enriched.filter((e) => e.prodTotal > 0);
  filtered.sort((a, b) => b.prodTotal - a.prodTotal || b.total - a.total);
  const shown = filtered.slice(0, limit);

  return textResult(truncateOutput(renderMarkdownTable(buildSqlTablesSpec(shown, includeTests))));
}

/**
 * One row of the sql-tables table as the renderer sees it.
 *
 * Exported alongside {@link buildSqlTablesSpec} so the wording-lint
 * can assert on the spec's user-facing wording without spinning up a
 * real `Cartograph`.
 */
export interface SqlTablesRow {
  i: number;
  tableName: string;
  reads: number;
  writes: number;
  ddl: number;
  prodTotal: number;
  testTotal: number;
}

/**
 * Build the typed `ResultSpec` for the sql-tables table. Pure — call
 * sites pass the already-fetched + enriched + sliced rows. The
 * wording-alignment lint imports this and pins the spec's `title` to
 * "SQL tables" so the env-sibling terminology drift (#17 caught on the
 * env side; the same risk lurked here) stays impossible.
 */
export function buildSqlTablesSpec(
  shown: ReadonlyArray<Omit<SqlTablesRow, 'i'>>,
  includeTests: boolean,
): MarkdownTableSpec<SqlTablesRow> {
  const footers = ['Pass `key` to a follow-up call to see exact call sites.'];
  if (!includeTests) footers.push('_test-only tables hidden (`includeTests: true` to show)._');
  return {
    title: `SQL tables touched by this codebase (top ${shown.length})`,
    emptyState:
      'No SQL refs found. Either the index has no SQL string-literal call sites, or `enableSqlRefs` is disabled in config.',
    columns: [
      { header: '#', align: 'right', cell: (r) => String(r.i + 1) },
      { header: 'Table', cell: (r) => `\`${r.tableName}\`` },
      { header: 'Reads', align: 'right', cell: (r) => String(r.reads) },
      { header: 'Writes', align: 'right', cell: (r) => String(r.writes) },
      { header: 'DDL', align: 'right', cell: (r) => String(r.ddl) },
      { header: 'Refs (prod)', align: 'right', cell: (r) => String(r.prodTotal) },
      { header: 'Refs (test)', align: 'right', cell: (r) => String(r.testTotal) },
    ],
    rows: shown.map((r, i) => ({ ...r, i })),
    footers,
  };
}

/** Args bundle for {@link renderSqlTableSites} — splits the per-table
 *  rendering out of {@link handleSqlRefs} to keep that function as a
 *  thin dispatch (mirrors {@link renderEnvKeySites} in env-refs.ts). */
interface RenderSqlTableSitesArgs {
  cg: ReturnType<ToolCtx['getCartograph']>;
  table: string;
  op: ReturnType<typeof parseSqlOp>;
  rawLimitArg: unknown;
  includeTests: boolean;
}

/** Single-table path: render every call site of the requested table.
 *  Filters test sites when `includeTests` is false — matches the
 *  no-table path's filtering semantics. */
function renderSqlTableSites(opts: RenderSqlTableSitesArgs): ToolResult {
  const { cg, table, op, rawLimitArg, includeTests } = opts;
  const opSuffix = op ? ` (op=${op})` : '';
  const rawSites = getSqlRefsByTable(cg.queries, table, op ? { op } : {});
  if (rawSites.length === 0) {
    return textResult(`No SQL refs found for table "${table}"${opSuffix}.${sqlTableMissHint(cg, table, op)}`);
  }
  // Sort prod call sites before test call sites so `src/` rows appear first
  // under any `limit` — the DB returns alphabetically by file_path which puts
  // `__tests__/` ahead of `src/`.
  const sorted = [...rawSites].sort((a, b) => (isTestPath(a.filePath) ? 1 : 0) - (isTestPath(b.filePath) ? 1 : 0));
  const sites = includeTests ? sorted : sorted.filter((s) => !isTestPath(s.filePath));
  const hiddenTestCount = sorted.length - sites.length;
  if (sites.length === 0) {
    return textResult(
      `No prod refs found for table "${table}"${opSuffix} — ${hiddenTestCount} test-only site${pluralS(hiddenTestCount)} hidden (pass \`includeTests: true\` to see them).`,
    );
  }
  const limit = rawLimitArg == null ? SQL_REFS_LIMIT_DEFAULT : clamp(rawLimitArg as number, 1, SQL_REFS_LIMIT_MAX);
  const shown = sites.slice(0, limit);
  const { prod: prodCount, test: testCount } = countByTestPath(sites);
  const truncated = sites.length > shown.length;
  const truncatedSuffix = truncated ? ` — showing first ${shown.length}` : '';
  const lines: string[] = [
    `## Call sites for \`${table}\`${opSuffix} — ${sites.length} site${pluralS(sites.length)} (${prodCount} prod / ${testCount} test)${truncatedSuffix}`,
    '',
    ...shown.map((s) => formatRefSiteLine(s, (site) => `[${site.op}]`)),
  ];
  if (truncated) {
    lines.push(
      '',
      `_${sites.length - shown.length} more sites suppressed by \`limit=${limit}\` — raise \`limit\` to see them._`,
    );
  }
  if (!includeTests && hiddenTestCount > 0) {
    lines.push(
      '',
      `_${hiddenTestCount} test-only site${pluralS(hiddenTestCount)} hidden (\`includeTests: true\` to show)._`,
    );
  }
  return textResult(truncateOutput(lines.join('\n')));
}

/** Inflect the trailing 's' on a noun by count. Tiny helper kept local to
 *  this file — extracting it everywhere would be churn for no benefit. */
function pluralS(n: number): string {
  return n === 1 ? '' : 's';
}

function sqlTableMissHint(
  cg: ReturnType<ToolCtx['getCartograph']>,
  table: string,
  op: ReturnType<typeof parseSqlOp>,
): string {
  if (op) {
    const otherSites = getSqlRefsByTable(cg.queries, table);
    if (otherSites.length > 0) {
      const counts = {
        read: otherSites.filter((site) => site.op === 'read').length,
        write: otherSites.filter((site) => site.op === 'write').length,
        ddl: otherSites.filter((site) => site.op === 'ddl').length,
      };
      return ` The table exists under other ops: read=${counts.read}, write=${counts.write}, ddl=${counts.ddl}. Omit \`op\` or choose one of those ops.`;
    }
  }
  const tables = getSqlTables(cg.queries, { limit: 5 }).map((row) => `\`${row.tableName}\``);
  if (tables.length === 0) return ' No SQL tables are indexed; check `enableSqlRefs` and re-run indexing.';
  return ` Known tables include: ${tables.join(', ')}.`;
}

export async function handleSqlRefs(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolResult> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const table = typeof args['table'] === 'string' ? args['table'].trim() : '';
  const op = parseSqlOp(args['op']);
  // Same semantics as handleEnvRefs: includeTests=true (default) keeps
  // test-only tables/sites visible but ranks by prod usage so test
  // fixtures don't dominate. includeTests=false hides test-only entries
  // on both the table-list and per-table site paths.
  const includeTests = args['includeTests'] !== false;
  return table
    ? renderSqlTableSites({ cg, table, op, rawLimitArg: args['limit'], includeTests })
    : renderSqlTableList(cg, args, includeTests);
}
