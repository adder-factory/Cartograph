import { describe, expect, it } from 'vitest';
import { findLowCoverage } from '../src/biomarkers/low-coverage.js';
import { findFeatureEnvy, findGodClasses } from '../src/db/queries-biomarkers-graph.js';
import { getCoverageRanked, getCoverageStats, upsertNodeCoverage } from '../src/db/queries-coverage.js';
import { applyChurnDeltas, applyCoChangeDeltas } from '../src/db/queries-history.js';
import {
  bootstrapPostgresIntentSearch,
  searchIntentSymbolRows,
  searchIntentTestNameRows,
} from '../src/db/queries-intent-search.js';
import { QueryBuilder } from '../src/db/queries.js';
import type { SqliteDatabase, SqliteStatement } from '../src/db/sqlite-adapter.js';

function makeCapturingQueryBuilder(): {
  qb: QueryBuilder;
  db: SqliteDatabase;
  sqls: string[];
  execSqls: string[];
} {
  const sqls: string[] = [];
  const execSqls: string[] = [];
  const db: SqliteDatabase = {
    dialect: 'postgres',
    open: true,
    prepare(sql: string): SqliteStatement {
      sqls.push(sql);
      return {
        run: () => ({ changes: 1, lastInsertRowid: 0 }),
        runBatch: () => ({ changes: 1, lastInsertRowid: 0 }),
        get: () => ({ n: 0, cov: null, tot: null }),
        all: () => [],
        iterate: function* () {},
      };
    },
    exec: (sql) => {
      execSqls.push(sql);
    },
    pragma: () => [],
    transaction: (fn) => fn,
    close: () => undefined,
  };
  return { qb: new QueryBuilder(db), db, sqls, execSqls };
}

describe('PostgreSQL query SQL portability', () => {
  it('uses portable post-hook history SQL', () => {
    const { qb, sqls } = makeCapturingQueryBuilder();

    applyCoChangeDeltas(qb, [['a.ts', 'b.ts', 1]]);
    applyChurnDeltas(qb, [{ path: 'a.ts', commitCountDelta: 1, lastTouchedTs: 2, firstSeenTs: 1 }]);

    expect(sqls.join('\n')).toContain('count = co_changes.count + excluded.count');
    expect(sqls.join('\n')).not.toContain('MAX(COALESCE');
  });

  it('qualifies coverage upsert columns and ranks coverage rows with window functions', () => {
    const { qb, sqls } = makeCapturingQueryBuilder();

    upsertNodeCoverage(qb, {
      nodeId: 'n1',
      source: 'unit',
      coveredLines: 1,
      totalLines: 2,
      coveredBranches: null,
      totalBranches: null,
      ingestedAt: 3,
    });
    getCoverageStats(qb);
    getCoverageRanked(qb);

    const joined = sqls.join('\n');
    expect(joined).toContain('node_coverage.total_lines');
    expect(joined).toContain('node_coverage.covered_lines');
    expect(joined).toContain('ROW_NUMBER() OVER');
    expect(joined).not.toContain('MAX(CAST(covered_lines AS REAL)');
  });

  it('avoids SELECT-alias references in biomarker HAVING clauses', () => {
    const { qb, sqls } = makeCapturingQueryBuilder();

    findGodClasses(qb, 20);
    findFeatureEnvy({ qb, minATFD: 5, maxFDP: 2, maxLAA: 1 / 3 });
    findLowCoverage(qb);

    const joined = sqls.join('\n');
    expect(joined).toContain('HAVING COUNT(child.id) >= @minMembers');
    expect(joined).not.toContain('HAVING memberCount');
    expect(joined).toContain('FROM metrics');
    expect(joined).toContain('WHERE atfd > @minATFD');
    expect(joined).not.toContain('HAVING atfd');
    expect(joined).toContain('ranked_coverage');
    expect(joined).not.toContain('HAVING coveragePct');
  });

  it('uses native PostgreSQL intent queries and bootstraps all corpus indexes', () => {
    const { db, sqls, execSqls } = makeCapturingQueryBuilder();

    bootstrapPostgresIntentSearch(db);
    searchIntentSymbolRows({
      db,
      corpus: 'summary',
      expression: 'database OR maintenance',
      filters: { kind: 'function', pathPrefix: 'src/' },
      limit: 10,
      rowCount: 1,
    });
    searchIntentSymbolRows({
      db,
      corpus: 'docstring',
      expression: 'database maintenance',
      filters: {},
      limit: 10,
      rowCount: 1,
    });
    searchIntentTestNameRows({
      db,
      expression: 'database OR maintenance',
      limit: 10,
      rowCount: 1,
    });

    const queries = sqls.join('\n');
    expect(queries).toContain("websearch_to_tsquery('simple', ?)");
    expect(queries).toContain('ts_rank_cd');
    expect(queries).not.toContain(' MATCH ');
    expect(queries).not.toContain('bm25(');
    const bootstrap = execSqls.join('\n');
    expect(bootstrap).toContain('idx_summary_store_intent_fts');
    expect(bootstrap).toContain('idx_nodes_docstring_intent_fts');
    expect(bootstrap).toContain('idx_test_names_intent_fts');
  });
});
