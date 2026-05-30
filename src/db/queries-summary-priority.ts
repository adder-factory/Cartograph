/**
 * Summary priority queue queries.
 *
 * Demand-driven summary prioritization: when intent-search misses a
 * query, enqueue the matching unsummarised symbols for next-pass
 * priority summarization. The summariser pulls from this queue to
 * override its default updated_at-DESC ordering.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

const NoParams = z.object({});

const PriorityRowSchema = z.object({ node_id: z.string() });
const AttemptsRowSchema = z.object({ attempts: z.number() });
const PriorityStatsRowSchema = z.object({
  pending: z.number(),
  oldestEnqueuedAt: z.number().nullable(),
  newestEnqueuedAt: z.number().nullable(),
});

// ─── Typed query definitions ──────────────────────────────────────────────

// Pattern A — variable IN-list via `json_each(@nodeIdsJson)` keeps the
// SQL static so `defineQuery` can wrap it; the caller passes the chunk
// as a JSON-stringified array.
const enqueueForPriorityQuery = defineQuery({
  sql: `
      INSERT INTO summary_priority_queue (node_id, enqueued_at, requested_count)
      SELECT id, @now, 1
      FROM nodes
      WHERE id IN (SELECT value FROM json_each(@nodeIdsJson))
      ON CONFLICT(node_id) DO UPDATE SET
        enqueued_at = excluded.enqueued_at,
        requested_count = requested_count + 1
    `,
  params: z.object({ now: z.number(), nodeIdsJson: z.string() }),
  row: z.never(),
});

const getPriorityNodeIdsQuery = defineQuery({
  sql: `
    SELECT node_id FROM summary_priority_queue
    ORDER BY enqueued_at DESC
    LIMIT @limit
  `,
  params: z.object({ limit: z.number() }),
  row: PriorityRowSchema,
});

const clearPriorityQueueForNodeQuery = defineQuery({
  sql: 'DELETE FROM summary_priority_queue WHERE node_id = @nodeId',
  params: z.object({ nodeId: z.string() }),
  row: z.never(),
});

const selectPriorityAttemptsQuery = defineQuery({
  sql: 'SELECT attempts FROM summary_priority_queue WHERE node_id = @nodeId',
  params: z.object({ nodeId: z.string() }),
  row: AttemptsRowSchema,
});

const deletePriorityForNodeQuery = defineQuery({
  sql: 'DELETE FROM summary_priority_queue WHERE node_id = @nodeId',
  params: z.object({ nodeId: z.string() }),
  row: z.never(),
});

const updatePriorityAttemptsQuery = defineQuery({
  sql: 'UPDATE summary_priority_queue SET attempts = @attempts WHERE node_id = @nodeId',
  params: z.object({ attempts: z.number(), nodeId: z.string() }),
  row: z.never(),
});

const getPriorityQueueStatsQuery = defineQuery({
  sql: `
    SELECT
      COUNT(*) AS pending,
      MIN(enqueued_at) AS oldestEnqueuedAt,
      MAX(enqueued_at) AS newestEnqueuedAt
    FROM summary_priority_queue
  `,
  params: NoParams,
  row: PriorityStatsRowSchema,
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    getPriorityNodeIds?: TypedQuery<{ limit: number }, { node_id: string }>;
    clearPriorityQueueForNode?: TypedQuery<{ nodeId: string }, never>;
    selectPriorityAttempts?: TypedQuery<{ nodeId: string }, { attempts: number }>;
    deletePriorityForNode?: TypedQuery<{ nodeId: string }, never>;
    updatePriorityAttempts?: TypedQuery<{ attempts: number; nodeId: string }, never>;
    getPriorityQueueStats?: TypedQuery<
      Record<string, never>,
      { pending: number; oldestEnqueuedAt: number | null; newestEnqueuedAt: number | null }
    >;
    enqueueForPriority?: TypedQuery<{ now: number; nodeIdsJson: string }, never>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Enqueue node IDs that the agent's last intent-search query missed.
 * Upserts: existing rows bump requestedCount and refresh enqueuedAt.
 * Cascade-deleted with the parent node, so dead entries self-clean on
 * resync.
 *
 * Uses FK-safe upsert pattern: only inserts if node_id exists in nodes.
 * Returns { enqueued, refreshed } counts.
 */
export function enqueueForPrioritySummary(args: { qb: QueryBuilder; nodeIds: readonly string[] }): {
  enqueued: number;
  refreshed: number;
} {
  const { qb, nodeIds } = args;
  if (nodeIds.length === 0) {
    return { enqueued: 0, refreshed: 0 };
  }

  const now = Date.now();
  let enqueued = 0;
  let refreshed = 0;

  const CHUNK = 500;
  qb.queries.enqueueForPriority ??= enqueueForPriorityQuery(qb.db);
  const stmt = qb.queries.enqueueForPriority;
  for (let i = 0; i < nodeIds.length; i += CHUNK) {
    const chunk = nodeIds.slice(i, i + CHUNK);

    // Pattern A — chunk passed through `json_each(@nodeIdsJson)`; the SQL
    // stays static so the typed wrapper applies.
    const info = stmt.run({ now, nodeIdsJson: JSON.stringify(chunk) });

    // We can't easily distinguish between inserts and updates at this
    // granularity, but the caller can log the total. Changes > 0 means
    // at least one row was affected (INSERT or UPDATE).
    if (info.changes > 0) {
      // Rough heuristic: assume half are new, half are updates. This is
      // imprecise but helps the caller understand queue growth.
      enqueued += Math.ceil(info.changes / 2);
      refreshed += Math.floor(info.changes / 2);
    }
  }

  return { enqueued, refreshed };
}

/**
 * Read top-N priority entries newest-first. Used by the summariser
 * to override its default updated_at-DESC ordering.
 */
export function getPriorityNodeIds(qb: QueryBuilder, limit: number): string[] {
  qb.queries.getPriorityNodeIds ??= getPriorityNodeIdsQuery(qb.db);
  const rows = qb.queries.getPriorityNodeIds.all({ limit });
  return rows.map((r) => r.node_id);
}

/**
 * Remove a node from the priority queue. Called after summarization.
 */
export function clearPriorityQueueForNode(qb: QueryBuilder, nodeId: string): void {
  qb.queries.clearPriorityQueueForNode ??= clearPriorityQueueForNodeQuery(qb.db);
  qb.queries.clearPriorityQueueForNode.run({ nodeId });
}

/**
 * Max attempts before evicting a poison row from the queue. Picked
 * conservative-low because the failure mode this guards against is
 * deterministic empty-response from the LLM (not transient): retrying
 * 3× catches genuine transient errors without burning unbounded calls
 * on a body the model will never produce a summary for.
 *
 * Reset semantics: `attempts` is reset to 0 ONLY when the row is
 * recreated by an INSERT (i.e. after a prior eviction DELETEs it, the
 * next intent-search miss inserts a fresh row with the DEFAULT 0).
 * The `ON CONFLICT` re-enqueue path (still-queued node, same query
 * fires again) deliberately preserves `attempts`, so repeated user
 * queries can't refresh the retry budget on a row that's been failing
 * in-flight.
 */
export const MAX_PRIORITY_QUEUE_ATTEMPTS = 3;

/**
 * Record a failed summarisation attempt for `nodeId`. Increments the
 * row's `attempts` counter; if the new count reaches
 * {@link MAX_PRIORITY_QUEUE_ATTEMPTS}, the row is DELETEd (poison
 * eviction). No-op when the row is missing (already evicted or never
 * enqueued).
 *
 * Returns `{ evicted }` so the caller can log eviction events.
 */
export function recordPriorityQueueFailure(qb: QueryBuilder, nodeId: string): { evicted: boolean } {
  // SELECT-then-UPDATE-then-DELETE inside a transaction — read-then-write
  // would race a parallel pass; the transaction makes the increment +
  // optional evict atomic. Codebase doesn't use RETURNING anywhere else,
  // so don't introduce a new pattern.
  let evicted = false;
  qb.db.transaction(() => {
    qb.queries.selectPriorityAttempts ??= selectPriorityAttemptsQuery(qb.db);
    const row = qb.queries.selectPriorityAttempts.get({ nodeId });
    if (!row) return;
    const next = row.attempts + 1;
    if (next >= MAX_PRIORITY_QUEUE_ATTEMPTS) {
      qb.queries.deletePriorityForNode ??= deletePriorityForNodeQuery(qb.db);
      qb.queries.deletePriorityForNode.run({ nodeId });
      evicted = true;
    } else {
      qb.queries.updatePriorityAttempts ??= updatePriorityAttemptsQuery(qb.db);
      qb.queries.updatePriorityAttempts.run({ attempts: next, nodeId });
    }
  })();
  return { evicted };
}

/**
 * Stats for monitoring queue health: pending count, age range.
 */
export function getPriorityQueueStats(qb: QueryBuilder): {
  pending: number;
  oldestEnqueuedAt: number | null;
  newestEnqueuedAt: number | null;
} {
  qb.queries.getPriorityQueueStats ??= getPriorityQueueStatsQuery(qb.db);
  const row = qb.queries.getPriorityQueueStats.get({});
  if (!row) {
    return { pending: 0, oldestEnqueuedAt: null, newestEnqueuedAt: null };
  }
  return {
    pending: row.pending,
    oldestEnqueuedAt: row.oldestEnqueuedAt,
    newestEnqueuedAt: row.newestEnqueuedAt,
  };
}
