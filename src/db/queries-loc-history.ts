/**
 * Per-symbol LoC history queries.
 *
 * Append a snapshot every analyseProject pass that touches the symbol;
 * read the previous snapshot to drive the recently_grew biomarker.
 */
import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { qbTransaction } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

interface LocSnapshot {
  /** Unix milliseconds when the snapshot was recorded. */
  ts: number;
  /** Lines of code at that time. */
  loc: number;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const recordLocSnapshotQuery = defineQuery({
  sql: `
    INSERT INTO node_loc_history (node_id, indexed_ts, loc)
      SELECT @nodeId, @ts, @loc
      WHERE EXISTS (SELECT 1 FROM nodes WHERE id = @nodeId)
      ON CONFLICT(node_id, indexed_ts) DO UPDATE SET loc = excluded.loc
  `,
  params: z.object({ nodeId: z.string(), ts: z.number(), loc: z.number() }),
  row: z.never(),
});

const getPriorLocSnapshotQuery = defineQuery({
  sql: `
    SELECT indexed_ts, loc FROM node_loc_history
     WHERE node_id = @nodeId AND indexed_ts < @beforeTs
     ORDER BY indexed_ts DESC
     LIMIT 1
  `,
  params: z.object({ nodeId: z.string(), beforeTs: z.number() }),
  row: z.object({ indexed_ts: z.number(), loc: z.number() }),
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    recordLocSnapshot?: TypedQuery<{ nodeId: string; ts: number; loc: number }, never>;
    getPriorLocSnapshot?: TypedQuery<{ nodeId: string; beforeTs: number }, { indexed_ts: number; loc: number }>;
  }
}

/**
 * Append many snapshots in one transaction. Used by analyseProject so
 * a 5k-symbol pass is a single fsync rather than 5k. PRIMARY KEY is
 * (node_id, indexed_ts) so a same-pass double-call collides safely
 * via ON CONFLICT; the value would be the same anyway.
 */
export function recordLocSnapshots(
  qb: QueryBuilder,
  rows: ReadonlyArray<{ nodeId: string; ts: number; loc: number }>,
): void {
  if (rows.length === 0) return;
  qb.queries.recordLocSnapshot ??= recordLocSnapshotQuery(qb.db);
  const stmt = qb.queries.recordLocSnapshot;
  qbTransaction(qb, () => {
    for (const r of rows) stmt.run(r);
  });
}

/**
 * Latest snapshot strictly before `beforeTs` for each requested node.
 * Returns a map; missing entries indicate no prior snapshot (first
 * time the analyser has seen the symbol, or the table was just
 * cleared). The compound index (node_id, indexed_ts DESC) makes each
 * lookup a single seek + one row read; we prepare once and step the
 * statement N times so a 5k-symbol scan is N seeks, not N
 * preparations.
 */
export function getPriorLocSnapshots(
  qb: QueryBuilder,
  nodeIds: ReadonlyArray<string>,
  beforeTs: number,
): Map<string, LocSnapshot> {
  const out = new Map<string, LocSnapshot>();
  if (nodeIds.length === 0) return out;
  qb.queries.getPriorLocSnapshot ??= getPriorLocSnapshotQuery(qb.db);
  const stmt = qb.queries.getPriorLocSnapshot;
  for (const id of nodeIds) {
    const row = stmt.get({ nodeId: id, beforeTs });
    if (row) out.set(id, { ts: row.indexed_ts, loc: row.loc });
  }
  return out;
}
