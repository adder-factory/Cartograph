/**
 * R*Tree range-overlap queries over `nodes_rtree`.
 *
 * The `nodes_rtree` virtual table (migration 034) indexes every node
 * by `(start_line, end_line)` using SQLite's built-in R*Tree module.
 * Range-overlap probes run in O(log n) rather than a full nodes-table
 * scan, which matters for large files with thousands of nodes.
 *
 * Per-domain query file — free functions, NOT QueryBuilder methods.
 * Pattern follows `queries-files.ts`.
 */

import { z } from 'zod';
import type { QueryBuilder } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';

/**
 * Minimal node fields returned by a range-overlap lookup.
 * Callers that need the full `Node` record can follow up with
 * `qb.getNodeById(row.id)` — but most callers only need location
 * + identity for "what's in this hunk?" answers.
 */
export interface NodeAtRange {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  start_line: number;
  end_line: number;
  signature: string | null;
}

// ─── Typed query definitions ─────────────────────────────────────────────

const NodeAtRangeRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  file_path: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  signature: z.string().nullable(),
}) satisfies z.ZodType<NodeAtRange>;

const getNodesAtRangeQuery = defineQuery({
  sql: `
    SELECT n.id, n.kind, n.name, n.qualified_name, n.file_path, n.start_line, n.end_line, n.signature
    FROM nodes_rtree r
    JOIN nodes n ON n.rowid = r.id
    WHERE r.start_line <= @endLine
      AND r.end_line   >= @startLine
      AND n.file_path  = @filePath
      AND n.kind      != 'file'
    ORDER BY (r.end_line - r.start_line) ASC, r.start_line ASC
    LIMIT @limit
  `,
  params: z.object({
    filePath: z.string(),
    startLine: z.number(),
    endLine: z.number(),
    limit: z.number(),
  }),
  row: NodeAtRangeRowSchema,
});

// ─── Module augmentation ─────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    getNodesAtRange?: TypedQuery<{ filePath: string; startLine: number; endLine: number; limit: number }, NodeAtRange>;
  }
}

/**
 * Find every node whose line range overlaps [startLine, endLine] in
 * the given file. Results are ordered smallest-enclosing-first
 * (innermost scope before the class/module that wraps it).
 *
 * Overlap condition: A.start ≤ B.end AND A.end ≥ B.start (where A is
 * the node's range and B is the query range). The R*Tree expresses
 * this directly as a bounding-box probe: `r.start_line <= endLine AND
 * r.end_line >= startLine`.
 *
 * `kind = 'file'` rows are excluded: file nodes always span the entire
 * file and would otherwise dominate every query.
 *
 * @param qb        - QueryBuilder (provides the underlying `db`).
 * @param args.filePath   - Repo-relative or absolute file path to scope the lookup.
 * @param args.startLine  - First line of the query range (1-indexed, inclusive).
 * @param args.endLine    - Last line of the query range (1-indexed, inclusive).
 * @param args.limit      - Maximum results to return.
 */
export function getNodesAtRange(
  qb: QueryBuilder,
  args: { filePath: string; startLine: number; endLine: number; limit: number },
): NodeAtRange[] {
  qb.queries.getNodesAtRange ??= getNodesAtRangeQuery(qb.db);
  return qb.queries.getNodesAtRange.all(args);
}
