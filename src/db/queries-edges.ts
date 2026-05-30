/**
 * Edge CRUD + traversal-friendly read queries.
 *
 * Extracted from `QueryBuilder` so the SQL repository doesn't carry
 * the per-domain edge helpers as direct members. The functions read
 * / write the `edges` table via the `@internal`-tagged `db` and
 * `queries` fields on the parent `QueryBuilder`. Prepared statements
 * are declared at module scope via {@link defineQuery} — Zod schemas
 * drive both compile-time and runtime validation of params + rows.
 * Lazy-cached on `qb.queries.X` to mirror the existing `qb.stmts.X`
 * pattern (and so cold-paths never pay for unused statements).
 *
 * Variable IN-list sites use Pattern A — `IN (SELECT value FROM
 * json_each(@arr))` with the array JSON-stringified into a single
 * named param. This keeps the SQL static (so `defineQuery` can wrap
 * it) without paying the placeholder-count combinatorial cost of
 * `IN (?, ?, ?, ...)`.
 */

import { z } from 'zod';
import type { Edge, EdgeKind } from '../types.js';
import { bindingsFromObject } from './row-mapper.js';
import { type QueryBuilder, type EdgeRow, rowToEdge, EDGE_SCHEMA, EDGE_INSERT_PARTS } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

/**
 * Shape `bindingsFromObject(edge, EDGE_SCHEMA)` produces for the
 * insertEdge INSERT — every key the SQL's `@bind` list references.
 * The EDGE_SCHEMA writes `column` (TS-side key) into the `col` column
 * via its `@column` placeholder.
 */
const InsertEdgeParamsSchema = z.object({
  source: z.string(),
  target: z.string(),
  kind: z.string(),
  // bindingsFromObject collapses `undefined → null` (per row-mapper's
  // writeField), and the DB-side defaults / nullability cover the
  // missing-value cases — `metadata` / `line` / `col` are nullable
  // columns, `confidence` has DEFAULT 'EXTRACTED'.
  metadata: z.string().nullable(),
  line: z.number().nullable(),
  column: z.number().nullable(),
  confidence: z.string().nullable(),
});

type InsertEdgeParams = z.infer<typeof InsertEdgeParamsSchema>;

/** SQLite-side `edges` row shape. Mirrors the {@link EdgeRow} interface. */
const EdgeRowSchema = z.object({
  id: z.number(),
  source: z.string(),
  target: z.string(),
  kind: z.string(),
  metadata: z.string().nullable(),
  line: z.number().nullable(),
  col: z.number().nullable(),
  confidence: z.string().nullable(),
}) satisfies z.ZodType<EdgeRow>;

// ─── Typed query definitions (module-level; bound per-DB lazily) ──────────

const insertEdgeQuery = defineQuery({
  sql: `INSERT OR IGNORE INTO edges (${EDGE_INSERT_PARTS.columns}) ` + `VALUES (${EDGE_INSERT_PARTS.bindings})`,
  params: InsertEdgeParamsSchema,
  row: z.never(),
});

const deleteEdgesBySourceAndKindQuery = defineQuery({
  sql: 'DELETE FROM edges WHERE source = @sourceId AND kind = @kind',
  params: z.object({ sourceId: z.string(), kind: z.string() }),
  row: z.never(),
});

const deleteAllEdgesByKindQuery = defineQuery({
  sql: 'DELETE FROM edges WHERE kind = @kind',
  params: z.object({ kind: z.string() }),
  row: z.never(),
});

const getEdgesBySourceQuery = defineQuery({
  sql: 'SELECT * FROM edges WHERE source = @sourceId',
  params: z.object({ sourceId: z.string() }),
  row: EdgeRowSchema,
});

const getEdgesByTargetQuery = defineQuery({
  sql: 'SELECT * FROM edges WHERE target = @targetId',
  params: z.object({ targetId: z.string() }),
  row: EdgeRowSchema,
});

const getOutgoingEdgesByKindsQuery = defineQuery({
  sql: 'SELECT * FROM edges WHERE source = @sourceId ' + 'AND kind IN (SELECT value FROM json_each(@kindsJson))',
  params: z.object({ sourceId: z.string(), kindsJson: z.string() }),
  row: EdgeRowSchema,
});

const getIncomingEdgesByKindsQuery = defineQuery({
  sql: 'SELECT * FROM edges WHERE target = @targetId ' + 'AND kind IN (SELECT value FROM json_each(@kindsJson))',
  params: z.object({ targetId: z.string(), kindsJson: z.string() }),
  row: EdgeRowSchema,
});

const findEdgesBetweenNodesQuery = defineQuery({
  sql:
    'SELECT * FROM edges ' +
    'WHERE source IN (SELECT value FROM json_each(@idsJson)) ' +
    'AND target IN (SELECT value FROM json_each(@idsJson))',
  params: z.object({ idsJson: z.string() }),
  row: EdgeRowSchema,
});

const findEdgesBetweenNodesByKindsQuery = defineQuery({
  sql:
    'SELECT * FROM edges ' +
    'WHERE source IN (SELECT value FROM json_each(@idsJson)) ' +
    'AND target IN (SELECT value FROM json_each(@idsJson)) ' +
    'AND kind IN (SELECT value FROM json_each(@kindsJson))',
  params: z.object({ idsJson: z.string(), kindsJson: z.string() }),
  row: EdgeRowSchema,
});

const filterExistingEndpointsQuery = defineQuery({
  sql: 'SELECT id FROM nodes WHERE id IN (SELECT value FROM json_each(@ids))',
  params: z.object({ ids: z.string() }),
  row: z.object({ id: z.string() }),
});

// ─── Module augmentation: register typed entries on QueryRegistry ─────────

declare module './queries.js' {
  interface QueryRegistry {
    insertEdge?: TypedQuery<InsertEdgeParams, never>;
    deleteEdgesBySourceAndKind?: TypedQuery<{ sourceId: string; kind: string }, never>;
    deleteAllEdgesByKind?: TypedQuery<{ kind: string }, never>;
    getEdgesBySource?: TypedQuery<{ sourceId: string }, EdgeRow>;
    getEdgesByTarget?: TypedQuery<{ targetId: string }, EdgeRow>;
    getOutgoingEdgesByKinds?: TypedQuery<{ sourceId: string; kindsJson: string }, EdgeRow>;
    getIncomingEdgesByKinds?: TypedQuery<{ targetId: string; kindsJson: string }, EdgeRow>;
    findEdgesBetweenNodes?: TypedQuery<{ idsJson: string }, EdgeRow>;
    findEdgesBetweenNodesByKinds?: TypedQuery<{ idsJson: string; kindsJson: string }, EdgeRow>;
    filterExistingEndpoints?: TypedQuery<{ ids: string }, { id: string }>;
  }
}

// ─── Public functions ─────────────────────────────────────────────────────

/**
 * Insert a new edge
 */
export function insertEdge(qb: QueryBuilder, edge: Edge): void {
  qb.queries.insertEdge ??= insertEdgeQuery(qb.db);
  qb.queries.insertEdge.run(bindingsFromObject(edge, EDGE_SCHEMA) as InsertEdgeParams);
}

/**
 * Drop edges whose `source` or `target` node is absent from `nodes`.
 *
 * `edges.source` / `edges.target` carry `FOREIGN KEY ... REFERENCES
 * nodes(id)`, and SQLite's `OR IGNORE` conflict clause does NOT suppress
 * foreign-key violations — only UNIQUE / NOT NULL / CHECK. So an edge
 * pointing at a node that no longer exists (a re-extraction round-trip
 * that re-minted ids, a stale resolver name-match against a since-deleted
 * symbol) throws `FOREIGN KEY constraint failed` and aborts the entire
 * `index` pass. An edge to a non-existent node is meaningless anyway —
 * filter it here, the same way `INSERT OR IGNORE` filters duplicate rows,
 * so one dangling endpoint can't crash the whole index.
 *
 * The `json_each(?)` binding stays positional (inline raw prepare) —
 * the array is JSON-stringified into a single string param, but
 * `defineQuery`'s typed wrapper would still preserve that shape; the
 * raw form here is no less safe and avoids a one-shot named-param
 * schema for a single binding.
 */
function filterEdgesWithExistingEndpoints(qb: QueryBuilder, edges: Edge[]): Edge[] {
  const ids = new Set<string>();
  for (const e of edges) {
    ids.add(e.source);
    ids.add(e.target);
  }
  if (ids.size === 0) return edges;
  qb.queries.filterExistingEndpoints ??= filterExistingEndpointsQuery(qb.db);
  const existing = new Set<string>();
  const rows = qb.queries.filterExistingEndpoints.all({ ids: JSON.stringify([...ids]) });
  for (const r of rows) existing.add(r.id);
  return edges.filter((e) => existing.has(e.source) && existing.has(e.target));
}

/**
 * Edge kinds where source === target is semantically null. `type_of` and
 * `returns` fire spuriously when a constructor-style function returns its
 * receiver struct (`func NewClient() *Client` produces `Client → type_of
 * → Client` via the return-type extraction). `calls` self-loops are
 * KEPT — they encode legitimate recursion. Same for `references`, which
 * can capture self-references in dispatch tables. The conservative set
 * here matches the documented constructor-FP class without dropping
 * structurally meaningful self-edges.
 */
const SELF_LOOP_NOISE_KINDS: ReadonlySet<string> = new Set(['type_of', 'returns']);

/**
 * Insert multiple edges in a transaction. Two pre-insert filters apply:
 *   1. Self-loops on {@link SELF_LOOP_NOISE_KINDS} are dropped (source
 *      === target with kind `type_of` / `returns` is semantically null).
 *   2. Edges with a dangling source or target node are dropped
 *      (see {@link filterEdgesWithExistingEndpoints}) rather than
 *      allowed to FK-abort the transaction.
 *
 * Returns the edges that survived BOTH filters (the candidates sent
 * through the per-edge `INSERT OR IGNORE`). The resolver uses this
 * return value to gate `deleteSpecificResolvedReferences`: before this
 * returned a value, a resolved ref whose corresponding edge was
 * silently dropped here (e.g. its `from_node_id` pointed at a node
 * that was cascade-deleted between resolve and insert) STILL got its
 * `unresolved_refs` row deleted, vanishing both ref AND edge without
 * trace. Returning the survivors lets the caller correlate. Handoff
 * #10 root cause.
 *
 * Note: the returned set is the post-filter candidate set, NOT the
 * literally-newly-inserted set. The `INSERT OR IGNORE` may further
 * reject duplicates, but those are SEMANTICALLY equivalent to a
 * successful insert (the edge exists in the table either way), so the
 * resolver correctly treats both as "resolved".
 */
export function insertEdges(qb: QueryBuilder, edges: Edge[]): Edge[] {
  if (edges.length === 0) return [];
  const nonSelfLoops = edges.filter((e) => !(e.source === e.target && SELF_LOOP_NOISE_KINDS.has(e.kind)));
  const insertable = filterEdgesWithExistingEndpoints(qb, nonSelfLoops);
  if (insertable.length === 0) return [];
  qb.db.transaction(() => {
    for (const edge of insertable) {
      insertEdge(qb, edge);
    }
  })();
  return insertable;
}

/**
 * Delete all edges of a given kind from a single source node. Used by
 * the tests-edges rebuild path to refresh `tests` edges for a single
 * test file without disturbing its other outgoing edges.
 */
export function deleteEdgesBySourceAndKind(qb: QueryBuilder, sourceId: string, kind: EdgeKind): void {
  qb.queries.deleteEdgesBySourceAndKind ??= deleteEdgesBySourceAndKindQuery(qb.db);
  qb.queries.deleteEdgesBySourceAndKind.run({ sourceId, kind });
}

/**
 * Delete every edge of a given kind across the whole graph. Used to
 * fully rebuild a derived edge layer (e.g. `tests`) before re-inserting
 * the current set.
 */
export function deleteAllEdgesByKind(qb: QueryBuilder, kind: EdgeKind): void {
  qb.queries.deleteAllEdgesByKind ??= deleteAllEdgesByKindQuery(qb.db);
  qb.queries.deleteAllEdgesByKind.run({ kind });
}

interface GetAdjacentEdgesArgs {
  qb: QueryBuilder;
  direction: 'outgoing' | 'incoming';
  nodeId: string;
  kinds?: EdgeKind[];
}

/**
 * Adjacent-edge lookup shared by {@link getOutgoingEdges} and
 * {@link getIncomingEdges}. Encodes "fetch every edge incident on
 * `nodeId` in the given direction, optionally filtered by edge
 * kinds." The `kinds`-filtered branch routes the array through
 * `json_each(@kindsJson)` (Pattern A) so the SQL stays static; the
 * unfiltered branch uses a per-direction typed wrapper.
 *
 * Direction-specific bits (cache key, query factory, the
 * `sourceId` vs `targetId` bind name) are dispatched inline —
 * factoring them into a table would replace four legible
 * conditionals with a runtime indirection that the type system
 * can't help police.
 */
function getAdjacentEdges(args: GetAdjacentEdgesArgs): Edge[] {
  const { qb, direction, nodeId, kinds } = args;
  if (kinds && kinds.length > 0) {
    const kindsJson = JSON.stringify(kinds);
    if (direction === 'outgoing') {
      qb.queries.getOutgoingEdgesByKinds ??= getOutgoingEdgesByKindsQuery(qb.db);
      return qb.queries.getOutgoingEdgesByKinds.all({ sourceId: nodeId, kindsJson }).map(rowToEdge);
    }
    qb.queries.getIncomingEdgesByKinds ??= getIncomingEdgesByKindsQuery(qb.db);
    return qb.queries.getIncomingEdgesByKinds.all({ targetId: nodeId, kindsJson }).map(rowToEdge);
  }
  if (direction === 'outgoing') {
    qb.queries.getEdgesBySource ??= getEdgesBySourceQuery(qb.db);
    return qb.queries.getEdgesBySource.all({ sourceId: nodeId }).map(rowToEdge);
  }
  qb.queries.getEdgesByTarget ??= getEdgesByTargetQuery(qb.db);
  return qb.queries.getEdgesByTarget.all({ targetId: nodeId }).map(rowToEdge);
}

/** Get outgoing edges from a node. */
export function getOutgoingEdges(qb: QueryBuilder, sourceId: string, kinds?: EdgeKind[]): Edge[] {
  return getAdjacentEdges({ qb, direction: 'outgoing', nodeId: sourceId, ...(kinds ? { kinds } : {}) });
}

/** Get incoming edges to a node. */
export function getIncomingEdges(qb: QueryBuilder, targetId: string, kinds?: EdgeKind[]): Edge[] {
  return getAdjacentEdges({ qb, direction: 'incoming', nodeId: targetId, ...(kinds ? { kinds } : {}) });
}

/**
 * Find all edges where both source and target are in the given node set.
 * Useful for recovering inter-node connectivity after BFS.
 *
 * Two static-SQL variants (with/without `kind IN`) dispatched at runtime;
 * each array passes through `json_each(@...)`.
 */
export function findEdgesBetweenNodes(qb: QueryBuilder, nodeIds: string[], kinds?: EdgeKind[]): Edge[] {
  if (nodeIds.length === 0) return [];

  const idsJson = JSON.stringify(nodeIds);

  if (kinds && kinds.length > 0) {
    qb.queries.findEdgesBetweenNodesByKinds ??= findEdgesBetweenNodesByKindsQuery(qb.db);
    const rows = qb.queries.findEdgesBetweenNodesByKinds.all({
      idsJson,
      kindsJson: JSON.stringify(kinds),
    });
    return rows.map(rowToEdge);
  }

  qb.queries.findEdgesBetweenNodes ??= findEdgesBetweenNodesQuery(qb.db);
  const rows = qb.queries.findEdgesBetweenNodes.all({ idsJson });
  return rows.map(rowToEdge);
}
