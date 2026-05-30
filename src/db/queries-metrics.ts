/**
 * Per-symbol metrics persistence — current snapshot, overwritten
 * each analyseProject pass. Distinct from `code_health_findings`
 * (threshold-only) and `node_loc_history` (LoC time-series).
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { qbTransaction } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

interface NodeMetricsRow {
  nodeId: string;
  loc: number;
  cyclomatic: number;
  maxNesting: number;
  maxConditionalOperands: number;
  paramCount: number;
  magicNumberCount: number;
  hardcodedUrlCount: number;
  updatedTs: number;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const UpsertNodeMetricsParamsSchema = z.object({
  nodeId: z.string(),
  loc: z.number(),
  cyclomatic: z.number(),
  maxNesting: z.number(),
  maxConditionalOperands: z.number(),
  paramCount: z.number(),
  magicNumberCount: z.number(),
  hardcodedUrlCount: z.number(),
  updatedTs: z.number(),
});

type UpsertNodeMetricsParams = z.infer<typeof UpsertNodeMetricsParamsSchema>;

const upsertNodeMetricsQuery = defineQuery({
  sql: `
    INSERT INTO node_metrics (
      node_id, loc, cyclomatic, max_nesting, max_conditional_operands,
      param_count, magic_number_count, hardcoded_url_count, updated_ts
    )
    SELECT @nodeId, @loc, @cyclomatic, @maxNesting, @maxConditionalOperands,
           @paramCount, @magicNumberCount, @hardcodedUrlCount, @updatedTs
     WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @nodeId)
       ON CONFLICT(node_id) DO UPDATE SET
         loc = excluded.loc,
         cyclomatic = excluded.cyclomatic,
         max_nesting = excluded.max_nesting,
         max_conditional_operands = excluded.max_conditional_operands,
         param_count = excluded.param_count,
         magic_number_count = excluded.magic_number_count,
         hardcoded_url_count = excluded.hardcoded_url_count,
         updated_ts = excluded.updated_ts
  `,
  params: UpsertNodeMetricsParamsSchema,
  row: z.never(),
});

const NodeMetricsDbRowSchema = z.object({
  node_id: z.string(),
  loc: z.number(),
  cyclomatic: z.number(),
  max_nesting: z.number(),
  max_conditional_operands: z.number(),
  param_count: z.number(),
  magic_number_count: z.number(),
  hardcoded_url_count: z.number(),
  updated_ts: z.number(),
});

type NodeMetricsDbRow = z.infer<typeof NodeMetricsDbRowSchema>;

const getNodeMetricsQuery = defineQuery({
  sql: `
      SELECT node_id, loc, cyclomatic, max_nesting, max_conditional_operands,
             param_count, magic_number_count, hardcoded_url_count, updated_ts
        FROM node_metrics
       WHERE node_id = @nodeId
    `,
  params: z.object({ nodeId: z.string() }),
  row: NodeMetricsDbRowSchema,
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    upsertNodeMetrics?: TypedQuery<UpsertNodeMetricsParams, never>;
    getNodeMetrics?: TypedQuery<{ nodeId: string }, NodeMetricsDbRow>;
  }
}

/**
 * Upsert a batch of metrics rows in one transaction. The FK-safe
 * SELECT WHERE EXISTS pattern keeps the write race-free even if
 * the underlying nodes row was deleted concurrently.
 */
export function upsertNodeMetricsBatch(qb: QueryBuilder, rows: ReadonlyArray<NodeMetricsRow>): void {
  if (rows.length === 0) return;
  qb.queries.upsertNodeMetrics ??= upsertNodeMetricsQuery(qb.db);
  const stmt = qb.queries.upsertNodeMetrics;
  qbTransaction(qb, () => {
    for (const r of rows) {
      stmt.run(r);
    }
  });
}

/** Fetch one symbol's metrics; null when no analyseProject pass has touched it. */
export function getNodeMetrics(qb: QueryBuilder, nodeId: string): NodeMetricsRow | null {
  qb.queries.getNodeMetrics ??= getNodeMetricsQuery(qb.db);
  const row = qb.queries.getNodeMetrics.get({ nodeId });
  if (!row) return null;
  return {
    nodeId: row.node_id,
    loc: row.loc,
    cyclomatic: row.cyclomatic,
    maxNesting: row.max_nesting,
    maxConditionalOperands: row.max_conditional_operands,
    paramCount: row.param_count,
    magicNumberCount: row.magic_number_count,
    hardcodedUrlCount: row.hardcoded_url_count,
    updatedTs: row.updated_ts,
  };
}
