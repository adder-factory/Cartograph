/**
 * F#75 (2026-05-28) — EXPLAIN QUERY PLAN audit over every registered
 * `defineQuery(...)` SQL statement.
 *
 * Walks the side-effect registry built by `src/db/typed-query.ts`
 * after importing all queries-*.ts modules transitively (via
 * `Cartograph.open`). For each captured SQL, runs `EXPLAIN QUERY
 * PLAN` against the project's live database and classifies the
 * resulting plan rows. The output is sorted by "concerning" first
 * — full table scans on big tables (nodes / edges) at the top,
 * index-backed SEARCH paths at the bottom.
 *
 * Categories (matched against the `detail` field SQLite emits per
 * plan row):
 *
 *   - `SCAN ...`            full table or virtual-table scan
 *   - `SEARCH ...`          index-backed lookup
 *   - `USE TEMP B-TREE`     SQLite materialised an intermediate sort
 *                            / GROUP BY structure
 *   - `LIST SUBQUERY`       a CTE or derived table was materialised
 *
 * A query that ONLY has SEARCH rows is well-indexed for its current
 * shape. A query that has any SCAN row deserves a look — though
 * SCAN of a tiny table (project_metadata, schema_version) is fine
 * and intentional.
 *
 * The audit ignores `defineDynamicQuery` factories because their
 * SQL is per-call; EXPLAIN QUERY PLAN on the static template
 * would require representative bindings the registry can't supply.
 * If future work needs them, a separate dynamic-query audit can
 * walk one synthesised instance per template.
 *
 * Usage:
 *   BENCH_PROJECT_DIR=/path/to/indexed-project bun bench/probe-explain-query-plan.mts
 *
 * Default project root: the current working directory.
 */

// MUST be set BEFORE any `defineQuery(...)` call fires. The
// queries-*.ts modules call `defineQuery` at module-init; ESM
// imports are hoisted, so a top-level static `import` of
// '../src/index.js' would run BEFORE the `process.env` assignment
// below. We use dynamic `await import(...)` after flipping the env
// var so the registry-gate inside `defineQuery` reads '1' on the
// first call.
process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] = '1';

import * as path from 'path';

const { Cartograph } = await import('../src/index.js');
const { getDefinedQueryRegistry } = await import('../src/db/typed-query.js');
type DefinedQueryRecord = import('../src/db/typed-query.js').DefinedQueryRecord;

interface PlanRow {
  id: number;
  parent: number;
  notused: number;
  detail: string;
}

interface QueryAudit {
  record: DefinedQueryRecord;
  /** EXPLAIN QUERY PLAN failure (e.g. unbindable named param). The
   *  audit still reports the SQL so the operator can investigate. */
  prepareError?: string;
  plan: PlanRow[];
  /** True when the plan contains at least one SCAN row over a
   *  non-trivially-small table (excludes `project_metadata`,
   *  `schema_version`, anonymous CTEs). */
  hasNotableScan: boolean;
  /** SCAN row count (any table). */
  scanCount: number;
  /** SEARCH row count. */
  searchCount: number;
  /** Total plan rows — gives a rough complexity proxy. */
  rowCount: number;
}

const SMALL_TABLE_SCAN_EXEMPT = new Set<string>([
  // Tiny key-value tables where a full scan is < 100 rows in practice.
  'project_metadata',
  'schema_version',
]);

function classifyPlanRow(detail: string): {
  isScan: boolean;
  isSearch: boolean;
  tableName?: string;
  /** True when SQLite reports "USING COVERING INDEX" — the scan
   *  walks the index, never touches the table heap, and is
   *  effectively as cheap as a SEARCH for the aggregation shape
   *  that triggers it (typical case: `SELECT COUNT(*) FROM X`).
   *  Not a covering-index candidate for further work. */
  isCoveringIndexScan: boolean;
  /** True when the scan target is a virtual table (`json_each`,
   *  `fts5`, R*Tree, etc.). Virtual tables have their own indices
   *  the planner can't override; flagging them as concerning would
   *  be noise. */
  isVirtualTableScan: boolean;
} {
  // Detail shape examples:
  //   "SCAN TABLE nodes"
  //   "SCAN nodes USING COVERING INDEX idx_nodes_betweenness"
  //   "SCAN json_each VIRTUAL TABLE INDEX 1:"
  //   "SEARCH TABLE nodes USING INDEX idx_nodes_kind (kind=?)"
  //   "SEARCH TABLE nodes USING INTEGER PRIMARY KEY (rowid=?)"
  //   "SEARCH TABLE edges USING COVERING INDEX idx_edges_source (source=?)"
  //   "SCAN CONSTANT ROW"
  //   "USE TEMP B-TREE FOR ORDER BY"
  //   "LIST SUBQUERY 1"
  //   "MATERIALIZE 1"
  const scanMatch = detail.match(/^SCAN(?: TABLE)?\s+(\S+)/);
  if (scanMatch) {
    const tableName = scanMatch[1];
    const isCoveringIndexScan = / USING COVERING INDEX /.test(detail);
    const isVirtualTableScan = / VIRTUAL TABLE /.test(detail);
    return { isScan: true, isSearch: false, tableName, isCoveringIndexScan, isVirtualTableScan };
  }
  const searchMatch = detail.match(/^SEARCH(?: TABLE)?\s+(\S+)/);
  if (searchMatch) {
    return {
      isScan: false,
      isSearch: true,
      tableName: searchMatch[1],
      isCoveringIndexScan: false,
      isVirtualTableScan: / VIRTUAL TABLE /.test(detail),
    };
  }
  return { isScan: false, isSearch: false, isCoveringIndexScan: false, isVirtualTableScan: false };
}

function shouldFlagScan(
  tableName: string | undefined,
  isCoveringIndexScan: boolean,
  isVirtualTableScan: boolean,
): boolean {
  if (!tableName) return false;
  if (SMALL_TABLE_SCAN_EXEMPT.has(tableName)) return false;
  // CONSTANT ROW / SUBQUERY / virtual constructs aren't real scans.
  if (/^(CONSTANT|SUBQUERY|MATERIALIZED|LIST)\b/i.test(tableName)) return false;
  // Virtual-table scans (`json_each`, fts5, R*Tree) have their own
  // internal indices the planner can't override.
  if (isVirtualTableScan) return false;
  // A SCAN that walks a COVERING INDEX never touches the table
  // heap — it's effectively as cheap as a SEARCH. The planner
  // legitimately picks this shape for aggregations like
  // `SELECT COUNT(*) FROM nodes`; treating it as concerning would
  // produce noise across every aggregation query.
  if (isCoveringIndexScan) return false;
  return true;
}

function explainOne(cg: Cartograph, record: DefinedQueryRecord): QueryAudit {
  const audit: QueryAudit = {
    record,
    plan: [],
    hasNotableScan: false,
    scanCount: 0,
    searchCount: 0,
    rowCount: 0,
  };
  try {
    const rows = cg.queries.db.prepare(`EXPLAIN QUERY PLAN ${record.sql}`).all() as PlanRow[];
    audit.plan = rows;
    audit.rowCount = rows.length;
    for (const r of rows) {
      const cls = classifyPlanRow(r.detail);
      if (cls.isScan) {
        audit.scanCount++;
        if (shouldFlagScan(cls.tableName, cls.isCoveringIndexScan, cls.isVirtualTableScan)) {
          audit.hasNotableScan = true;
        }
      }
      if (cls.isSearch) audit.searchCount++;
    }
  } catch (err) {
    audit.prepareError = err instanceof Error ? err.message : String(err);
  }
  return audit;
}

function compareConcerning(a: QueryAudit, b: QueryAudit): number {
  // Notable scans first, then non-notable scans, then anything else
  // by sheer plan-row count desc.
  if (a.hasNotableScan !== b.hasNotableScan) return a.hasNotableScan ? -1 : 1;
  if (a.scanCount !== b.scanCount) return b.scanCount - a.scanCount;
  return b.rowCount - a.rowCount;
}

function previewSql(sql: string, max: number): string {
  const oneLine = sql.replace(/\s+/g, ' ').trim();
  return oneLine.length <= max ? oneLine : `${oneLine.slice(0, max - 1)}…`;
}

async function main(): Promise<void> {
  const projectRoot = process.env['BENCH_PROJECT_DIR'] ?? path.resolve('.');
  console.log(`probing EXPLAIN QUERY PLAN against: ${projectRoot}\n`);

  const cg = await Cartograph.open(projectRoot, { autoMigrate: false });
  try {
    const registry = getDefinedQueryRegistry();
    console.log(`registered \`defineQuery\` records: ${registry.length}\n`);

    const audits = registry.map((rec) => explainOne(cg, rec));
    audits.sort(compareConcerning);

    const flagged = audits.filter((a) => a.hasNotableScan);
    const scanOnly = audits.filter((a) => !a.hasNotableScan && a.scanCount > 0);
    const indexed = audits.filter((a) => a.scanCount === 0 && !a.prepareError);
    const errors = audits.filter((a) => a.prepareError !== undefined);

    console.log(`  notable SCAN (covering-index candidates): ${flagged.length}`);
    console.log(`  scan-only on small/virtual tables: ${scanOnly.length}`);
    console.log(`  fully index-backed: ${indexed.length}`);
    console.log(`  prepare errors (skipped): ${errors.length}\n`);

    if (flagged.length > 0) {
      console.log('── NOTABLE SCAN candidates ──────────────────────────────────────────────');
      for (const a of flagged) {
        console.log(`\n  ${a.record.source}  (scans=${a.scanCount}, searches=${a.searchCount})`);
        console.log(`    SQL: ${previewSql(a.record.sql, 160)}`);
        for (const r of a.plan) {
          console.log(`    PLAN: ${r.detail}`);
        }
      }
    }

    if (errors.length > 0) {
      console.log('\n── prepare errors (typically bound-param shape mismatches) ──────────────');
      for (const a of errors.slice(0, 10)) {
        console.log(`  ${a.record.source}: ${a.prepareError}`);
        console.log(`    SQL: ${previewSql(a.record.sql, 160)}`);
      }
      if (errors.length > 10) console.log(`  … ${errors.length - 10} more`);
    }
  } finally {
    cg.destroy();
  }
}

await main();
