/**
 * Similarity edge CRUD helpers for building and maintaining
 * similar_to edges derived from embedding search.
 */

import { z } from 'zod';
import type { Edge } from '../types.js';
import { bindingsFromObject } from './row-mapper.js';
import { type QueryBuilder, EDGE_SCHEMA, EDGE_INSERT_PARTS } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

const NoParams = z.object({});

/**
 * Shape `bindingsFromObject(edge, EDGE_SCHEMA)` produces for the
 * insertSimilarToEdge INSERT — every key the SQL's `@bind` list
 * references. Extra keys the helper might emit are dropped by Zod's
 * default `.strip`.
 */
const InsertSimilarToEdgeParamsSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.string(),
  metadata: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
  confidence: z.string().nullable(),
});

type InsertSimilarToEdgeParams = z.infer<typeof InsertSimilarToEdgeParamsSchema>;

// ─── Typed query definitions ──────────────────────────────────────────────

const deleteAllSimilarToEdgesQuery = defineQuery({
  sql: "DELETE FROM edges WHERE kind = 'similar_to'",
  params: NoParams,
  row: z.never(),
});

const insertSimilarToEdgeQuery = defineQuery({
  sql: `INSERT OR IGNORE INTO edges (${EDGE_INSERT_PARTS.columns}) ` + `VALUES (${EDGE_INSERT_PARTS.bindings})`,
  params: InsertSimilarToEdgeParamsSchema,
  row: z.never(),
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    deleteAllSimilarToEdges?: TypedQuery<Record<string, never>, never>;
    insertSimilarToEdge?: TypedQuery<InsertSimilarToEdgeParams, never>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Delete all similar_to edges. Used before backfill to ensure
 * idempotent re-runs (old edges are cleared before new ones inserted).
 */
export function deleteAllSimilarToEdges(qb: QueryBuilder): void {
  qb.queries.deleteAllSimilarToEdges ??= deleteAllSimilarToEdgesQuery(qb.db);
  qb.queries.deleteAllSimilarToEdges.run({});
}

/**
 * Delete the OUTGOING similar_to edges of the given source nodes. Used by the
 * bounded incremental repair (`repairSimilarToForNodes`) so re-running it for a
 * re-extracted node is idempotent — clear that node's edges, then re-insert its
 * fresh KNN. Targets `idx_edges_source_kind_similar_to`, so it is cheap.
 */
export function deleteSimilarToEdgesFrom(qb: QueryBuilder, nodeIds: readonly string[]): void {
  if (nodeIds.length === 0) return;
  qb.db
    .prepare("DELETE FROM edges WHERE kind = 'similar_to' AND source IN (SELECT value FROM json_each(@nodeIds))")
    .run({ nodeIds: JSON.stringify(nodeIds) });
}

/**
 * Insert similar_to edges in a batch. Each row includes source, target,
 * and similarity score (0..1). Edges are written with confidence='INFERRED'
 * and metadata storing the score.
 */
export function insertSimilarToEdges(
  qb: QueryBuilder,
  rows: Array<{ source: string; target: string; score: number }>,
): void {
  if (rows.length === 0) return;

  qb.queries.insertSimilarToEdge ??= insertSimilarToEdgeQuery(qb.db);
  const stmt = qb.queries.insertSimilarToEdge;
  qb.db.transaction(() => {
    for (const row of rows) {
      const edge: Edge = {
        source: row.source,
        target: row.target,
        kind: 'similar_to',
        confidence: 'INFERRED',
        metadata: { score: row.score },
      };
      stmt.run(bindingsFromObject(edge, EDGE_SCHEMA) as InsertSimilarToEdgeParams);
    }
  })();
}
