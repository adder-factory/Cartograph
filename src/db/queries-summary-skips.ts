/**
 * Context-too-large summary skip markers (issue #27, reactive half).
 *
 * When a summary prompt exceeds the chat backend's per-slot context (HTTP
 * 400), the summariser records the symbol here instead of re-attempting
 * the same body every pass. The candidate / pending queries
 * (`queries-summaries.ts`) exclude symbols with a skip whose `body_hash`
 * still matches the node's current `body_hash`; status counts those as a
 * distinct "skipped — too large" bucket. `summarize --all` clears the
 * table to retry everything (e.g. after the operator raises the backend's
 * `-c`, per the `doctor` warning).
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

const NoParams = z.object({});

// FK-safe upsert (mirrors `upsertSummaryRef`): the `WHERE EXISTS` guard
// no-ops if a concurrent sync deleted the node between the summariser's
// id capture and this write, instead of raising an FK violation.
const upsertSummarySkipQuery = defineQuery({
  sql: `
    INSERT INTO summary_skips (node_id, body_hash, reason, recorded_at)
    SELECT @nodeId, @bodyHash, @reason, @now
    WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @nodeId)
    ON CONFLICT(node_id) DO UPDATE SET
      body_hash = excluded.body_hash,
      reason = excluded.reason,
      recorded_at = excluded.recorded_at
  `,
  params: z.object({ nodeId: z.string(), bodyHash: z.string(), reason: z.string(), now: z.number() }),
  row: z.never(),
});

// Only skips whose recorded body_hash still matches the node's current
// body count — a body change invalidates the skip (the candidate query
// re-qualifies the symbol), so the stale row must not be counted.
const countCurrentSummarySkipsQuery = defineQuery({
  sql: `
    SELECT COUNT(*) AS c
    FROM summary_skips s
    JOIN nodes n ON n.id = s.node_id
    WHERE n.body_hash = s.body_hash
  `,
  params: NoParams,
  row: z.object({ c: z.number() }),
});

const clearSummarySkipsQuery = defineQuery({
  sql: 'DELETE FROM summary_skips',
  params: NoParams,
  row: z.never(),
});

declare module './queries.js' {
  interface QueryRegistry {
    upsertSummarySkip?: TypedQuery<{ nodeId: string; bodyHash: string; reason: string; now: number }, never>;
    countCurrentSummarySkips?: TypedQuery<Record<string, never>, { c: number }>;
    clearSummarySkips?: TypedQuery<Record<string, never>, never>;
  }
}

/**
 * Record (or refresh) a "prompt too large for the chat backend's
 * per-slot context" skip for a symbol, stamped with the `body_hash` it
 * failed on. No-ops if the node was deleted mid-flight (FK-safe).
 */
export function recordSummarySkip(qb: QueryBuilder, args: { nodeId: string; bodyHash: string; reason: string }): void {
  qb.queries.upsertSummarySkip ??= upsertSummarySkipQuery(qb.db);
  qb.queries.upsertSummarySkip.run({
    nodeId: args.nodeId,
    bodyHash: args.bodyHash,
    reason: args.reason,
    now: Date.now(),
  });
}

/**
 * Count symbols currently skipped for being too large — only those whose
 * recorded `body_hash` still matches the node's current body. A body
 * change invalidates the skip (re-qualifying the symbol as a candidate),
 * so its stale row is not counted.
 */
export function countCurrentSummarySkips(qb: QueryBuilder): number {
  qb.queries.countCurrentSummarySkips ??= countCurrentSummarySkipsQuery(qb.db);
  return qb.queries.countCurrentSummarySkips.get({})?.c ?? 0;
}

/**
 * Clear every skip marker so the next pass re-attempts all symbols. Used
 * by `summarize --all` (the explicit "retry everything" full pass).
 */
export function clearSummarySkips(qb: QueryBuilder): void {
  qb.queries.clearSummarySkips ??= clearSummarySkipsQuery(qb.db);
  qb.queries.clearSummarySkips.run({});
}
