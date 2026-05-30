/**
 * Centrality writers.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * per-domain mutators as direct members. Both functions invalidate
 * the node cache after writing because `nodes.centrality` is part of
 * the cached row shape — stale cache entries would otherwise hand
 * out pre-mutation centrality values to subsequent reads.
 *
 * The companion read methods (top-N-by-centrality, centrality rank)
 * were removed when this module was extracted: they had zero in-tree
 * callers (one was added speculatively, the other for a tool that
 * never landed). Future read needs go in this file alongside the
 * writers.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Typed query definitions ─────────────────────────────────────────────

const updateCentralityQuery = defineQuery({
  sql: 'UPDATE nodes SET centrality = @centrality WHERE id = @id',
  params: z.object({ id: z.string(), centrality: z.number() }),
  row: z.never(),
});

const updateBetweennessQuery = defineQuery({
  sql: 'UPDATE nodes SET betweenness = @betweenness WHERE id = @id',
  params: z.object({ id: z.string(), betweenness: z.number() }),
  row: z.never(),
});

const TopBetweennessRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  start_line: z.number(),
  betweenness: z.number(),
});

/**
 * Top-N nodes by betweenness DESC. `WHERE betweenness IS NOT NULL`
 * gates the result so the lens shows nothing on a project where the
 * betweenness hook hasn't run — rather than confusing the agent with
 * a list of every node (all tied at NULL).
 */
const topBetweennessNodesQuery = defineQuery({
  sql: `SELECT id, name, kind, file_path, start_line, betweenness
        FROM nodes
        WHERE betweenness IS NOT NULL
        ORDER BY betweenness DESC
        LIMIT @limit`,
  params: z.object({ limit: z.number() }),
  row: TopBetweennessRowSchema,
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    updateCentrality?: TypedQuery<{ id: string; centrality: number }, never>;
    updateBetweenness?: TypedQuery<{ id: string; betweenness: number }, never>;
    topBetweennessNodes?: TypedQuery<{ limit: number }, z.infer<typeof TopBetweennessRowSchema>>;
  }
}

/**
 * Persist centrality scores for the given nodes. No-op when `scores`
 * is empty. Wraps the per-row UPDATE in a single transaction so a
 * full pass over a 6 K-node graph is one fsync, not 6 K. Clears the
 * node cache so subsequent reads see the new centrality values.
 */
export function applyCentralityScores(qb: QueryBuilder, scores: Map<string, number>): void {
  if (scores.size === 0) return;
  qb.queries.updateCentrality ??= updateCentralityQuery(qb.db);
  const stmt = qb.queries.updateCentrality;
  qb.db.transaction(() => {
    for (const [id, score] of scores) {
      stmt.run({ id, centrality: score });
    }
  })();
  qb.nodeCache.clear();
}

/** Set every node's centrality back to NULL. Used before a full re-rank. */
export function clearCentrality(qb: QueryBuilder): void {
  qb.db.exec('UPDATE nodes SET centrality = NULL');
  qb.nodeCache.clear();
}

/**
 * Persist sampled betweenness scores. Same transaction-wrapped UPDATE
 * pattern as {@link applyCentralityScores} — one fsync per pass, not
 * one per node. Clears the node cache so subsequent reads pick up the
 * new betweenness column values.
 */
export function applyBetweennessScores(qb: QueryBuilder, scores: Map<string, number>): void {
  if (scores.size === 0) return;
  qb.queries.updateBetweenness ??= updateBetweennessQuery(qb.db);
  const stmt = qb.queries.updateBetweenness;
  qb.db.transaction(() => {
    for (const [id, score] of scores) {
      stmt.run({ id, betweenness: score });
    }
  })();
  qb.nodeCache.clear();
}

export interface TopBetweennessRow {
  id: string;
  name: string;
  kind: string;
  filePath: string;
  startLine: number;
  betweenness: number;
}

/**
 * Read the top-N nodes ranked by betweenness DESC. Returns an empty
 * array when no node has a non-null betweenness score — the canonical
 * "hook hasn't run" / "feature disabled" state — so callers can
 * branch on `length === 0` to render a graceful empty-lens message
 * instead of confusing the agent with a list of NULL ties.
 */
export function getTopBetweennessNodes(qb: QueryBuilder, limit: number): TopBetweennessRow[] {
  qb.queries.topBetweennessNodes ??= topBetweennessNodesQuery(qb.db);
  const rows = qb.queries.topBetweennessNodes.all({ limit });
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    startLine: r.start_line,
    betweenness: r.betweenness,
  }));
}
