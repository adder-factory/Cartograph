/**
 * Role-classification queries.
 *
 * Storage post-migration 040: `nodes.role` + `nodes.role_model`.
 * Pre-040 the role was stored on `symbol_summaries.role`. The
 * migration backfills from there onto `nodes`; we read/write only
 * the new location going forward.
 *
 * Input cascade post-040: the classifier feeds summary when present,
 * else docstring. See `project_role_classifier_input_eval_2026_05_08`
 * memory note for the empirical justification (B↔baseline 66.7% vs
 * A↔baseline 68.8% — fallback only 2 pts below summary-input).
 *
 * MIGRATED TO TYPED QUERIES (2026-05-20). Static prepared statements
 * are declared at module scope via {@link defineQuery}; Zod schemas
 * drive params + row validation. Lazy-cached on `qb.queries.X`.
 * `getSymbolRoles` uses Pattern A (`json_each(@nodeIds)`) — the
 * IN-list placeholder count varies with input size, so its SQL
 * stays dynamic.
 */

import { z } from 'zod';
import type { Node } from '../types.js';
import { type QueryBuilder, type NodeRow, rowToNode } from './queries.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import { FRAMEWORK_IMPORT_PREFIXES } from '../llm/role-labeler.js';
import { prefixLikePattern } from './sql-like.js';

// ─── Zod schemas ──────────────────────────────────────────────────────────

/** NodeRow shape — mirrors {@link NodeRow} in `queries.js`. Used by
 *  `findNodesByRole` and `findOrphanedSymbols`, both of which `SELECT *`
 *  off `nodes`. */
const NodeRowSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualified_name: z.string(),
  file_path: z.string(),
  language: z.string(),
  start_line: z.number(),
  end_line: z.number(),
  start_column: z.number(),
  end_column: z.number(),
  docstring: z.string().nullable(),
  signature: z.string().nullable(),
  visibility: z.string().nullable(),
  is_exported: z.number(),
  is_async: z.number(),
  is_static: z.number(),
  decorators: z.string().nullable(),
  decorator_args: z.string().nullable(),
  updated_at: z.number(),
  centrality: z.number().nullable(),
  betweenness: z.number().nullable(),
  body_hash: z.string(),
}) satisfies z.ZodType<NodeRow>;

const ClassifiableRowSchema = z.object({
  node_id: z.string(),
  name: z.string(),
  kind: z.string(),
  file_path: z.string(),
  signature: z.string().nullable(),
  docstring: z.string().nullable(),
  summary: z.string().nullable(),
  is_exported: z.number(),
});

const CallerCountRowSchema = z.object({
  node_id: z.string(),
  caller_count: z.number(),
});

const FrameworkImportRowSchema = z.object({
  file_path: z.string(),
  module_name: z.string(),
});

const NeighborhoodRowSchema = z.object({
  src: z.string(),
  ek: z.string(),
  tname: z.string(),
});

const NameRowSchema = z.object({ name: z.string() });

const RoleCountRowSchema = z.object({
  role: z.string(),
  n: z.number(),
});

const CountRowSchema = z.object({ n: z.number() });

const NoParams = z.object({});

// ─── Typed query definitions ──────────────────────────────────────────────

const queryClassifiableRowsQuery = defineQuery({
  sql: `SELECT n.id AS node_id, n.name AS name, n.kind AS kind,
            n.file_path AS file_path,
            n.signature AS signature, n.docstring AS docstring,
            ss.summary AS summary,
            n.is_exported AS is_exported
     FROM nodes n
     LEFT JOIN symbol_summaries ss ON ss.node_id = n.id
     WHERE (
            (ss.summary IS NOT NULL AND ss.summary != '')
         OR (n.docstring IS NOT NULL AND n.docstring != '')
     )
       AND (
            n.role IS NULL
         OR n.role_model IS NULL
         OR (
              n.role_model != @roleModel
              AND n.role_model NOT LIKE 'structural:%'
            )
       )`,
  params: z.object({ roleModel: z.string() }),
  row: ClassifiableRowSchema,
});

const getCallerCountMapQuery = defineQuery({
  sql: `SELECT target AS node_id, COUNT(*) AS caller_count
     FROM edges
     WHERE kind = 'calls'
     GROUP BY target`,
  params: NoParams,
  row: CallerCountRowSchema,
});

const getFrameworkImportRowsQuery = defineQuery({
  sql: `SELECT f.file_path AS file_path, i.name AS module_name
     FROM nodes f
     JOIN edges e ON e.source = f.id
     JOIN nodes i ON i.id = e.target
     WHERE f.kind = 'file' AND e.kind = 'imports' AND i.kind = 'import'`,
  params: NoParams,
  row: FrameworkImportRowSchema,
});

const getSymbolNeighborhoodQuery = defineQuery({
  sql: `SELECT e.source AS src, e.kind AS ek, t.name AS tname
     FROM edges e
     JOIN nodes s ON s.id = e.source
     JOIN nodes t ON t.id = e.target
     WHERE e.kind IN ('extends', 'implements')
        OR (e.kind = 'contains'
            AND s.kind IN ('class', 'interface', 'struct', 'trait', 'protocol')
            AND t.kind IN ('method', 'field', 'property'))`,
  params: NoParams,
  row: NeighborhoodRowSchema,
});

const updateNodeRoleQuery = defineQuery({
  sql: `UPDATE nodes SET role = @role, role_model = @roleModel WHERE id = @nodeId`,
  params: z.object({ role: z.string(), roleModel: z.string(), nodeId: z.string() }),
  row: z.never(),
});

const upsertRoleAssignmentQuery = defineQuery({
  sql: `INSERT INTO role_assignments (node_id, role, role_model, body_hash, generated_at)
       VALUES (@nodeId, @role, @roleModel,
               COALESCE((SELECT body_hash FROM nodes WHERE id = @nodeId), ''),
               @generatedAt)
       ON CONFLICT(node_id) DO UPDATE SET
         role = excluded.role,
         role_model = excluded.role_model,
         body_hash = excluded.body_hash,
         generated_at = excluded.generated_at`,
  params: z.object({
    nodeId: z.string(),
    role: z.string(),
    roleModel: z.string(),
    generatedAt: z.number(),
  }),
  row: z.never(),
});

const findNodesByRoleQuery = defineQuery({
  sql: `SELECT * FROM nodes
     WHERE role = @role
     ORDER BY file_path, start_line
     LIMIT @limit`,
  params: z.object({ role: z.string(), limit: z.number() }),
  row: NodeRowSchema,
});

const sampleSiblingNamesQuery = defineQuery({
  sql: `SELECT DISTINCT name FROM nodes
     WHERE kind = @kind AND name != @excludeName AND file_path != @excludeFile
     ORDER BY name
     LIMIT @limit`,
  params: z.object({
    kind: z.string(),
    excludeName: z.string(),
    excludeFile: z.string(),
    limit: z.number(),
  }),
  row: NameRowSchema,
});

/**
 * `findOrphanedSymbols` — the `kind IN (...)` list is bound via a single
 * JSON-encoded `@livenessKinds` parameter consumed by `json_each`, so
 * the SQL stays static and `defineQuery`-compatible regardless of how
 * many edge kinds {@link ORPHAN_LIVENESS_EDGE_KINDS} grows to.
 */
const findOrphanedSymbolsQuery = defineQuery({
  sql: String.raw`SELECT n.* FROM nodes n
     WHERE n.is_exported = 0
       AND n.kind IN ('function', 'method', 'class', 'component')
       AND n.file_path LIKE @pathLike ESCAPE '\'
       AND NOT EXISTS (
         SELECT 1 FROM edges e
         WHERE e.target = n.id
           AND e.kind IN (SELECT value FROM json_each(@livenessKinds))
       )
     ORDER BY n.file_path, n.start_line
     LIMIT @limit OFFSET @offset`,
  params: z.object({
    livenessKinds: z.string(),
    pathLike: z.string(),
    limit: z.number(),
    offset: z.number(),
  }),
  row: NodeRowSchema,
});

const getRoleCountsQuery = defineQuery({
  sql: `SELECT role, COUNT(*) AS n FROM nodes
     WHERE role IS NOT NULL GROUP BY role`,
  params: NoParams,
  row: RoleCountRowSchema,
});

const getUnclassifiedNodeCountQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n FROM nodes WHERE role IS NULL`,
  params: NoParams,
  row: CountRowSchema,
});

/**
 * Node kinds the role classifier intentionally targets. Mirrors the
 * LLM-classifiable shape (function/method/class/interface/struct/trait/
 * protocol/component) called out in the role.ts denominator-correction
 * fix (bug #12). Skipped kinds (file, import, constant, variable,
 * property, field, parameter, etc.) are NOT counted against the
 * "unclassified" denominator — they would otherwise inflate the gap by
 * thousands of nodes the classifier never even considers.
 */
const CLASSIFIER_TARGET_KINDS = [
  'function',
  'method',
  'class',
  'interface',
  'struct',
  'trait',
  'protocol',
  'component',
] as const;

const CLASSIFIER_TARGET_KINDS_JSON = JSON.stringify(CLASSIFIER_TARGET_KINDS);

const getUnclassifiedTargetNodeCountQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n FROM nodes
        WHERE role IS NULL
          AND kind IN (SELECT value FROM json_each(@targetKinds))`,
  params: z.object({ targetKinds: z.string() }),
  row: CountRowSchema,
});

const getNonClassifierTargetNodeCountQuery = defineQuery({
  sql: `SELECT COUNT(*) AS n FROM nodes
        WHERE role IS NULL
          AND kind NOT IN (SELECT value FROM json_each(@targetKinds))`,
  params: z.object({ targetKinds: z.string() }),
  row: CountRowSchema,
});

const getSymbolRolesByIdsQuery = defineQuery({
  sql: `SELECT id AS node_id, role AS value FROM nodes
      WHERE role IS NOT NULL
        AND id IN (SELECT value FROM json_each(@nodeIds))`,
  params: z.object({ nodeIds: z.string() }),
  row: z.object({ node_id: z.string(), value: z.string() }),
});

// ─── Module augmentation ──────────────────────────────────────────────────

declare module './queries.js' {
  interface QueryRegistry {
    queryClassifiableRows?: TypedQuery<{ roleModel: string }, z.infer<typeof ClassifiableRowSchema>>;
    getCallerCountMap?: TypedQuery<Record<string, never>, z.infer<typeof CallerCountRowSchema>>;
    getFrameworkImportRows?: TypedQuery<Record<string, never>, z.infer<typeof FrameworkImportRowSchema>>;
    getSymbolNeighborhood?: TypedQuery<Record<string, never>, z.infer<typeof NeighborhoodRowSchema>>;
    updateNodeRole?: TypedQuery<{ role: string; roleModel: string; nodeId: string }, never>;
    upsertRoleAssignment?: TypedQuery<{ nodeId: string; role: string; roleModel: string; generatedAt: number }, never>;
    findNodesByRole?: TypedQuery<{ role: string; limit: number }, NodeRow>;
    sampleSiblingNames?: TypedQuery<
      { kind: string; excludeName: string; excludeFile: string; limit: number },
      { name: string }
    >;
    findOrphanedSymbols?: TypedQuery<
      { livenessKinds: string; pathLike: string; limit: number; offset: number },
      NodeRow
    >;
    getRoleCounts?: TypedQuery<Record<string, never>, { role: string; n: number }>;
    getUnclassifiedNodeCount?: TypedQuery<Record<string, never>, { n: number }>;
    getUnclassifiedTargetNodeCount?: TypedQuery<{ targetKinds: string }, { n: number }>;
    getNonClassifierTargetNodeCount?: TypedQuery<{ targetKinds: string }, { n: number }>;
    getSymbolRolesByIds?: TypedQuery<{ nodeIds: string }, { node_id: string; value: string }>;
  }
}

/** Raw DB row returned by the classifiable-nodes query. */
interface ClassifiableRow {
  node_id: string;
  name: string;
  kind: string;
  file_path: string;
  signature: string | null;
  docstring: string | null;
  summary: string | null;
  is_exported: number;
}

/** Output shape returned by {@link getClassifiableNodes}. */
export interface ClassifiableNode {
  nodeId: string;
  name: string;
  kind: string;
  filePath: string;
  signature: string | null;
  docstring: string | null;
  summary: string | null;
  /** Whether the symbol is exported — rendered into the classifier's
   *  LLM evidence block. */
  isExported: number;
}

/**
 * Execute the classifiable-nodes SQL query and return raw DB rows.
 *
 * Two label families are excluded from the re-classification pool:
 *
 *   - `structural:%`  — the structural pre-filter in
 *     src/llm/classifier.ts assigns labels via deterministic rules
 *     (kind, test-file path, framework-handler signature). High
 *     precision; survives backend swaps. Versioned via the prefix
 *     so a rule change (e.g. `structural:v2`) auto-invalidates.
 */
function queryClassifiableRows(qb: QueryBuilder, roleModel: string): ClassifiableRow[] {
  qb.queries.queryClassifiableRows ??= queryClassifiableRowsQuery(qb.db);
  return qb.queries.queryClassifiableRows.all({ roleModel });
}

/** Map a raw DB row to the caller-facing {@link ClassifiableNode} shape. */
function mapClassifiableRow(r: ClassifiableRow): ClassifiableNode {
  return {
    nodeId: r.node_id,
    name: r.name,
    kind: r.kind,
    filePath: r.file_path,
    signature: r.signature,
    docstring: r.docstring,
    summary: r.summary,
    isExported: r.is_exported,
  };
}

/**
 * Symbols that need (re-)classification. Cascade input: returns nodes
 * with a non-empty summary OR a non-empty docstring (whichever is
 * present), where the role is missing or stale for `roleModel`.
 *
 * `summary` is left-joined from `symbol_summaries`; may be null when
 * only the docstring path applies.
 *
 * Delegates SQL execution to {@link queryClassifiableRows} and row
 * shaping to {@link mapClassifiableRow}.
 */
export function getClassifiableNodes(qb: QueryBuilder, roleModel: string): ClassifiableNode[] {
  return queryClassifiableRows(qb, roleModel).map(mapClassifiableRow);
}

/**
 * Project-wide caller count map. One read pass over the `edges` table
 * — every node that's the target of at least one `calls` edge gets a
 * row; nodes with zero callers are absent from the map (treat as 0).
 *
 * Pre-computed once per classify-pass to avoid an N+1 query when
 * building per-node `RoleFeatures` over thousands of candidates.
 */
export function getCallerCountMap(qb: QueryBuilder): Map<string, number> {
  qb.queries.getCallerCountMap ??= getCallerCountMapQuery(qb.db);
  const rows = qb.queries.getCallerCountMap.all({});
  return new Map(rows.map((r) => [r.node_id, r.caller_count]));
}

/**
 * Project-wide map of file paths whose imports contain at least one
 * known web/DI framework module. Re-uses `FRAMEWORK_IMPORT_PREFIXES`
 * from `role-labeler.ts` so train- and inference-time definitions
 * stay in lock-step. The set is small (~30 prefixes) so a single
 * scan over the `imports` edges + an in-memory prefix check is cheap.
 */
export function getFrameworkImportFiles(qb: QueryBuilder): Set<string> {
  qb.queries.getFrameworkImportRows ??= getFrameworkImportRowsQuery(qb.db);
  const rows = qb.queries.getFrameworkImportRows.all({});
  const result = new Set<string>();
  for (const r of rows) {
    if (result.has(r.file_path)) continue;
    for (const p of FRAMEWORK_IMPORT_PREFIXES) {
      if (r.module_name === p || r.module_name.startsWith(p)) {
        result.add(r.file_path);
        break;
      }
    }
  }
  return result;
}

/** Per-symbol structural neighbourhood — see {@link getSymbolNeighborhood}. */
export interface SymbolNeighborhood {
  /** Names of types this symbol extends / implements. */
  supertypes: string[];
  /** Member (method / field / property) names of a class-like symbol. */
  members: string[];
}

/** Max member names kept per symbol — enough for a behavioural
 *  fingerprint in the classifier prompt without bloating it. */
const SYMBOL_NEIGHBORHOOD_MAX_MEMBERS = 14;

/** Max supertype names kept per symbol — bounds the prompt on extreme
 *  multi-interface classes (some Java/C# classes implement many). */
const SYMBOL_NEIGHBORHOOD_MAX_SUPERTYPES = 8;

/**
 * Project-wide map of each symbol's structural neighbourhood: the types
 * it extends / implements, and (for class-like kinds) the names of its
 * member methods / fields.
 *
 * Feeds the role-classifier's LLM prompt. The classifier was previously
 * given only name + signature + a one-line description — which starves
 * the model on class-like symbols (a class's role is rarely decidable
 * from one line, but `extends BaseController` + members `index/create/
 * destroy` makes it obvious). One pass over `edges`; the `contains`
 * fan-out is scoped to class-like sources so it stays cheap on large
 * repos.
 */
export function getSymbolNeighborhood(qb: QueryBuilder): Map<string, SymbolNeighborhood> {
  qb.queries.getSymbolNeighborhood ??= getSymbolNeighborhoodQuery(qb.db);
  const rows = qb.queries.getSymbolNeighborhood.all({});
  const result = new Map<string, SymbolNeighborhood>();
  for (const r of rows) {
    let nb = result.get(r.src);
    if (!nb) {
      nb = { supertypes: [], members: [] };
      result.set(r.src, nb);
    }
    if (r.ek === 'contains') {
      if (nb.members.length < SYMBOL_NEIGHBORHOOD_MAX_MEMBERS) nb.members.push(r.tname);
    } else if (nb.supertypes.length < SYMBOL_NEIGHBORHOOD_MAX_SUPERTYPES) {
      nb.supertypes.push(r.tname);
    }
  }
  return result;
}

/**
 * Persist a role assignment.
 *
 * Dual-writes:
 *   - `nodes.role` / `nodes.role_model` — the structural read-cache
 *     queried by every consumer (~15 call sites across
 *     `findNodesByRole`, MCP tools, etc.).
 *   - `role_assignments` — the side table that survives
 *     `clearStructural` so a force reindex can restore via the
 *     `role-restore` index hook (staleness-redesign Phase 5,
 *     migration 052). Keyed by the node's current `body_hash` so
 *     restoration on the next index is gated on body equality.
 */
export function upsertSymbolRole(qb: QueryBuilder, nodeId: string, data: { role: string; roleModel: string }): void {
  // Defensive cache invalidate. `role` is NOT in NODE_SCHEMA today
  // (see queries.ts:391 comment), so nodeCache currently doesn't
  // carry stale role values — but co-locating the invalidate with
  // the write keeps the rule load-bearing on its own line rather
  // than on a type-shape comment two files away. If a future change
  // adds `role` to NODE_SCHEMA, this line is what prevents stale
  // reads on the next getNodeById.
  qb.nodeCache.delete(nodeId);
  qb.queries.updateNodeRole ??= updateNodeRoleQuery(qb.db);
  qb.queries.updateNodeRole.run({ role: data.role, roleModel: data.roleModel, nodeId });
  // Side-table mirror. body_hash sourced via subquery from the node
  // we just wrote to — guaranteed-fresh (UPDATE doesn't touch
  // body_hash). COALESCE handles the edge case where the node row is
  // gone (concurrent delete) or body_hash hasn't been populated yet.
  qb.queries.upsertRoleAssignment ??= upsertRoleAssignmentQuery(qb.db);
  qb.queries.upsertRoleAssignment.run({
    nodeId,
    role: data.role,
    roleModel: data.roleModel,
    generatedAt: Date.now(),
  });
}

/**
 * Bulk fetch roles for a set of node ids. Returns a Map keyed by
 * node id; nodes whose `role` is NULL are absent from the map (the
 * underlying SQL filters them out — agents using `map.has(id)` get
 * a clean "classified" / "not classified" check).
 *
 * Used by `cartograph_callers` / `cartograph_callees` / `cartograph_walk`
 * when `includeRoles: true` to inline each shown row's role — saves
 * a per-row `cartograph_role` round-trip on chained graph queries.
 */
export function getSymbolRoles(qb: QueryBuilder, nodeIds: readonly string[]): Map<string, string> {
  const out = new Map<string, string>();
  if (nodeIds.length === 0) return out;
  qb.queries.getSymbolRolesByIds ??= getSymbolRolesByIdsQuery(qb.db);
  const rows = qb.queries.getSymbolRolesByIds.all({
    nodeIds: JSON.stringify([...nodeIds]),
  });
  for (const r of rows) out.set(r.node_id, r.value);
  return out;
}

/** Find every node currently classified with a given role. */
export function findNodesByRole(qb: QueryBuilder, role: string, limit = 100): Node[] {
  qb.queries.findNodesByRole ??= findNodesByRoleQuery(qb.db);
  const rows = qb.queries.findNodesByRole.all({ role, limit });
  return rows.map(rowToNode);
}

/**
 * Sample existing sibling names for the naming-convention checker.
 * Excludes the symbol's own file (so the new symbol's own name
 * doesn't bias the convention) and prefers symbols that have
 * survived multiple sync cycles (proxy: anything in the index).
 */
interface SampleSiblingNamesArgs {
  qb: QueryBuilder;
  kind: string;
  excludeName: string;
  excludeFile: string;
  limit: number;
}

export function sampleSiblingNames(args: SampleSiblingNamesArgs): string[] {
  const { qb, kind, excludeName, excludeFile, limit } = args;
  qb.queries.sampleSiblingNames ??= sampleSiblingNamesQuery(qb.db);
  const rows = qb.queries.sampleSiblingNames.all({ kind, excludeName, excludeFile, limit });
  return rows.map((r) => r.name);
}

/** Incoming edge kinds that count as a symbol being *used*. A symbol
 *  with none of these is a graph orphan. `calls` covers ordinary
 *  function/method calls; the rest cover a class/component that is only
 *  ever constructed (`instantiates`), subclassed (`extends`), implemented
 *  (`implements`), overridden, used as a type (`type_of` / `returns`),
 *  applied as a decorator (`decorates`), or otherwise named
 *  (`references`). `field_access` covers methods/properties reached
 *  through member access when call resolution cannot disambiguate the
 *  callee but field resolution can. Without these, a class that is
 *  only `new`'d — never called — would be falsely flagged dead.
 *  `contains` / `imports` /
 *  `exports` are deliberately excluded: they are structural, not use. */
const ORPHAN_LIVENESS_EDGE_KINDS = [
  'calls',
  'instantiates',
  'references',
  'field_access',
  'extends',
  'implements',
  'overrides',
  'type_of',
  'returns',
  'decorates',
] as const;

/**
 * Find symbols with zero incoming *usage* edges (see
 * `ORPHAN_LIVENESS_EDGE_KINDS`) that are not marked exported. Pre-filter
 * for the dead-code judge — cheap, runs in SQL, narrows the LLM workload
 * to the graph-suspicious set.
 *
 * `offset` lets the caller paginate when in-memory post-filters
 * (e.g. exempt-path patterns) eat the early pages.
 */
export interface FindOrphanedSymbolsOptions {
  limit?: number;
  offset?: number;
  pathFilter?: string;
}

export function findOrphanedSymbols(qb: QueryBuilder, options: FindOrphanedSymbolsOptions = {}): Node[] {
  const { limit = 200, offset = 0, pathFilter } = options;
  qb.queries.findOrphanedSymbols ??= findOrphanedSymbolsQuery(qb.db);
  const rows = qb.queries.findOrphanedSymbols.all({
    livenessKinds: JSON.stringify(ORPHAN_LIVENESS_EDGE_KINDS),
    pathLike: prefixLikePattern(pathFilter),
    limit,
    offset,
  });
  return rows.map(rowToNode);
}

/** Counts of classified symbols by role (for status display). */
export function getRoleCounts(qb: QueryBuilder): Map<string, number> {
  qb.queries.getRoleCounts ??= getRoleCountsQuery(qb.db);
  const rows = qb.queries.getRoleCounts.all({});
  const out = new Map<string, number>();
  for (const r of rows) out.set(r.role, r.n);
  return out;
}

/**
 * Count of indexed nodes with NO role assigned (`role IS NULL`).
 *
 * The companion to {@link getRoleCounts}, which deliberately counts only
 * *classified* symbols. The project-wide role-distribution table needs
 * this so it can show an explicit "unclassified" row — otherwise the
 * percentages add to 100% of the classified subset while the table
 * claims to be "project-wide", silently hiding every NULL-role node.
 */
export function getUnclassifiedNodeCount(qb: QueryBuilder): number {
  qb.queries.getUnclassifiedNodeCount ??= getUnclassifiedNodeCountQuery(qb.db);
  const row = qb.queries.getUnclassifiedNodeCount.get({});
  return row?.n ?? 0;
}

/**
 * Count of NULL-role nodes whose `kind` IS a classifier target
 * (function / method / class / interface / struct / trait / protocol /
 * component). These are the nodes the role-distribution percentage
 * legitimately measures the gap against (bug #12 fix). Distinct from
 * {@link getUnclassifiedNodeCount} which includes `file` / `import` /
 * `constant` / etc. — kinds the classifier never targets, so counting
 * them as "unclassified" inflates the gap by thousands of nodes.
 */
export function getUnclassifiedTargetNodeCount(qb: QueryBuilder): number {
  qb.queries.getUnclassifiedTargetNodeCount ??= getUnclassifiedTargetNodeCountQuery(qb.db);
  const row = qb.queries.getUnclassifiedTargetNodeCount.get({ targetKinds: CLASSIFIER_TARGET_KINDS_JSON });
  return row?.n ?? 0;
}

/**
 * Count of NULL-role nodes whose `kind` is NOT a classifier target
 * (file, import, constant, variable, property, field, parameter, etc.).
 * Surfaced as a separate "intentionally not classified" disclosure in
 * the role-distribution table — these nodes are excluded from the
 * percentage denominator (bug #12).
 */
export function getNonClassifierTargetNodeCount(qb: QueryBuilder): number {
  qb.queries.getNonClassifierTargetNodeCount ??= getNonClassifierTargetNodeCountQuery(qb.db);
  const row = qb.queries.getNonClassifierTargetNodeCount.get({ targetKinds: CLASSIFIER_TARGET_KINDS_JSON });
  return row?.n ?? 0;
}
