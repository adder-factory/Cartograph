/**
 * Database Queries
 *
 * Prepared statements for CRUD operations on the knowledge graph.
 */

import { z } from 'zod';
import type { SqliteDatabase } from './sqlite-adapter.js';
import { clearVecTables } from './vec-helpers.js';
import { clearPgvectorTables } from './pgvector-helpers.js';
import { bindingsFromObject, insertSqlParts, mapRow, updateSqlSets, type Schema } from './row-mapper.js';
import { defineQuery, type TypedQuery } from './typed-query.js';
import type { UnresolvedReference } from '../extraction/types.js';
import type { Node, Edge, FileRecord, NodeKind, EdgeKind, Language } from '../types.js';
import type { GraphStats } from './types.js';
import { buildNameSubwords } from '../utils.js';
import { logWarn } from '../errors.js';
import { clearStructural } from './queries-clear.js';

/**
 * Database row types (snake_case from SQLite)
 *
 * @internal Exported for cluster files (`queries-summaries.ts`,
 * `queries-search.ts`, etc.) that need to map raw SQLite rows back
 * to `Node` via `rowToNode`. Not part of the public surface.
 */
export interface NodeRow {
  id: string;
  kind: string;
  name: string;
  qualified_name: string;
  file_path: string;
  language: string;
  start_line: number;
  end_line: number;
  start_column: number;
  end_column: number;
  docstring: string | null;
  signature: string | null;
  visibility: string | null;
  is_exported: number;
  is_async: number;
  is_static: number;
  decorators: string | null;
  decorator_args: string | null;
  updated_at: number;
  centrality: number | null;
  betweenness: number | null;
  body_hash: string;
}

/** @internal Exported for cluster files (`queries-edges.ts`); see `NodeRow`. */
export interface EdgeRow {
  id: number;
  source: string;
  target: string;
  kind: string;
  metadata: string | null;
  line: number | null;
  col: number | null;
  confidence: string | null;
}

/** @internal Exported for cluster files (`queries-files.ts`); see `NodeRow`. */
export interface FileRow {
  path: string;
  content_hash: string;
  language: string;
  size: number;
  modified_at: number;
  indexed_at: number;
  node_count: number;
  errors: string | null;
  commit_count: number | null;
  loc: number | null;
  first_seen_ts: number | null;
  last_touched_ts: number | null;
  is_test: number;
  needs_reextract: number;
}

/** @internal Exported for cluster files (`queries-unresolved-refs.ts`); see `NodeRow`. */
export interface UnresolvedRefRow {
  id: number;
  from_node_id: string;
  reference_name: string;
  reference_kind: string;
  line: number;
  col: number;
  candidates: string | null;
  file_path: string;
  language: string;
  site_count: number;
  extra_lines: string | null;
}

/**
 * Convert database row to Node object
 */
/**
 * Read-side schemas for the four row → object mappings. Co-located
 * with the row interfaces above so a column rename or new field
 * surfaces compile errors at exactly one site instead of trickling
 * through hand-written mappers.
 *
 * Every key of the target type must appear here — TypeScript
 * enforces coverage via `Schema<T, Row>`.
 */
const NODE_SCHEMA: Schema<Node, NodeRow> = {
  id: 'id',
  kind: { col: 'kind', cast: (v) => v as NodeKind },
  name: 'name',
  qualifiedName: 'qualified_name',
  filePath: 'file_path',
  language: { col: 'language', cast: (v) => v as Language },
  startLine: 'start_line',
  endLine: 'end_line',
  startColumn: 'start_column',
  endColumn: 'end_column',
  docstring: { col: 'docstring', nullable: true },
  signature: { col: 'signature', nullable: true },
  visibility: { col: 'visibility', cast: (v) => (v ?? undefined) as Node['visibility'] },
  isExported: { col: 'is_exported', bool01: true },
  isAsync: { col: 'is_async', bool01: true },
  isStatic: { col: 'is_static', bool01: true },
  decorators: { col: 'decorators', json: true },
  decoratorArgs: { col: 'decorator_args', json: true },
  updatedAt: 'updated_at',
  centrality: { col: 'centrality', nullable: true },
  betweenness: { col: 'betweenness', nullable: true },
  // Empty string default for legacy rows (DEFAULT '' in migration 048);
  // 1:1 string mapping. Populated by the extractor's createNode path.
  bodyHash: 'body_hash',
};

/** @internal Exported for cluster files (`queries-unresolved-refs.ts`). */
export const UNRESOLVED_REF_SCHEMA: Schema<UnresolvedReference, UnresolvedRefRow> = {
  fromNodeId: 'from_node_id',
  referenceName: 'reference_name',
  referenceKind: { col: 'reference_kind', cast: (v) => v as EdgeKind },
  line: 'line',
  column: 'col',
  candidates: { col: 'candidates', json: true },
  filePath: 'file_path',
  language: { col: 'language', cast: (v) => v as Language },
  // Default 1 so legacy rows behave like single-site refs even before
  // the migration's default kicks in.
  siteCount: { col: 'site_count', cast: (v) => (v as number | null) ?? 1 },
  extraLines: { col: 'extra_lines', json: true },
};

/** @internal Exported for cluster files (`queries-edges.ts`); see `NodeRow`. */
export const EDGE_SCHEMA: Schema<Edge, EdgeRow> = {
  source: 'source',
  target: 'target',
  kind: { col: 'kind', cast: (v) => v as EdgeKind },
  metadata: { col: 'metadata', json: true },
  line: { col: 'line', nullable: true },
  column: { col: 'col', nullable: true },
  // The `confidence` column is NOT NULL with DB-side default 'EXTRACTED'
  // (migration 032), so a missing in-memory value still lands on the
  // safe default at insert time via the schema's nullable handling.
  confidence: { col: 'confidence', cast: (v) => (v ?? 'EXTRACTED') as Edge['confidence'] },
};

/** @internal Exported for cluster files; see `NodeRow` above. */
export function rowToNode(row: NodeRow): Node {
  return mapRow(row, NODE_SCHEMA);
}

/** @internal Exported for cluster files (`queries-unresolved-refs.ts`). */
export function rowToUnresolvedRef(row: UnresolvedRefRow): UnresolvedReference {
  return mapRow(row, UNRESOLVED_REF_SCHEMA);
}

/** @internal Exported for cluster files (`queries-edges.ts`); see `NodeRow`. */
export function rowToEdge(row: EdgeRow): Edge {
  return mapRow(row, EDGE_SCHEMA);
}

/**
 * Convert database row to FileRecord object
 */
/** @internal Exported for cluster files (`queries-files.ts`). */
export const FILE_RECORD_SCHEMA: Schema<FileRecord, FileRow> = {
  path: 'path',
  contentHash: 'content_hash',
  language: { col: 'language', cast: (v) => v as Language },
  size: 'size',
  modifiedAt: 'modified_at',
  indexedAt: 'indexed_at',
  nodeCount: 'node_count',
  errors: { col: 'errors', json: true },
  // commitCount / loc default to 0 (not undefined) so the surrounding
  // Compact<>-typed assignment expects a number; cast handles the
  // null → 0 collapse.
  commitCount: { col: 'commit_count', cast: (v) => (v as number | null) ?? 0 },
  loc: { col: 'loc', cast: (v) => (v as number | null) ?? 0 },
  // firstSeenTs / lastTouchedTs are `number | null` (NOT optional),
  // so null passes through unchanged — the cast is just a no-op
  // type narrower for the schema.
  firstSeenTs: { col: 'first_seen_ts', cast: (v) => (v as number | null) ?? null },
  lastTouchedTs: { col: 'last_touched_ts', cast: (v) => (v as number | null) ?? null },
  isTest: { col: 'is_test', bool01: true },
  needsReextract: { col: 'needs_reextract', bool01: true },
};

/** @internal Exported for cluster files (`queries-files.ts`). */
export function rowToFileRecord(row: FileRow): FileRecord {
  return mapRow(row, FILE_RECORD_SCHEMA);
}

// Pre-generated SQL fragments for INSERTs derived from the schemas
// above. Single source of truth: a column rename in the schema flows
// through both reads (mapRow) and writes (these fragments) at compile
// time — no chance of the two sides drifting.
const NODE_INSERT_PARTS = insertSqlParts(NODE_SCHEMA);
/** @internal Exported for cluster files (`queries-edges.ts`); see `NodeRow`. */
export const EDGE_INSERT_PARTS = insertSqlParts(EDGE_SCHEMA);
/** @internal Exported for cluster files (`queries-unresolved-refs.ts`). */
export const UNRESOLVED_INSERT_PARTS = insertSqlParts(UNRESOLVED_REF_SCHEMA);
// Churn-managed columns: owned by the mining subsystem, never set on
// regular re-index. Excluded from upsertFile's INSERT + ON CONFLICT
// update so re-indexing a file does NOT clobber mined git history.
/** @internal Exported for cluster files (`queries-files.ts`). */
export const FILE_CHURN_MANAGED_COLS = ['commit_count', 'loc', 'first_seen_ts', 'last_touched_ts'];
/** @internal Exported for cluster files (`queries-files.ts`). */
export const FILE_INSERT_PARTS = insertSqlParts(FILE_RECORD_SCHEMA, {
  omitCols: FILE_CHURN_MANAGED_COLS,
});

// ===========================================================================
// NodeLruCache — extracted from QueryBuilder to reduce its member count
// while keeping the LRU + names-list caching logic in one place.
// ===========================================================================

/**
 * LRU node cache + distinct-names list cache.
 * Holds the state that was previously spread across three QueryBuilder
 * fields (`nodeCache`, `maxCacheSize`, `nodeNamesCache`) and two private
 * methods (`cacheNode`, `clearCache`). Bundled here so QueryBuilder stays
 * below the god_class threshold.
 *
 * @internal Used only by QueryBuilder.
 */
class NodeLruCache {
  private readonly map: Map<string, Node> = new Map();
  private readonly maxSize: number;
  /** @internal Read/written by QueryBuilder on insert/update/delete. */
  namesList: string[] | null = null;

  constructor(maxSize = 1000) {
    this.maxSize = maxSize;
  }

  /** Add a node, evicting the oldest entry when at capacity. */
  set(node: Node): void {
    if (this.map.size >= this.maxSize) {
      const firstKey = this.map.keys().next().value;
      // Explicit `!== undefined` (not truthy) — a falsy-but-defined key
      // like `''` must still evict, else the cache grows unbounded.
      if (firstKey !== undefined) this.map.delete(firstKey);
    }
    this.map.set(node.id, node);
  }

  /** LRU-touch get: re-inserts the entry at the end of iteration order. */
  get(id: string): Node | undefined {
    const node = this.map.get(id);
    if (node === undefined) return undefined;
    this.map.delete(id);
    this.map.set(id, node);
    return node;
  }

  /** Delete one entry (used on node update / replace). */
  delete(id: string): void {
    this.map.delete(id);
  }

  /** Delete all entries whose filePath matches (used on file-level deletes). */
  deleteByFile(filePath: string): void {
    for (const [id, node] of this.map) {
      if (node.filePath === filePath) this.map.delete(id);
    }
  }

  /** Drain the entire cache. */
  clear(): void {
    this.map.clear();
    this.namesList = null;
  }

  /** Whether the given id is cached. */
  has(id: string): boolean {
    return this.map.has(id);
  }
}

// ===========================================================================
// Typed queries owned by this file (the QueryBuilder class methods + the
// module-level free functions further down). Per-domain query files
// (`queries-files.ts`, etc.) declare their own typed queries and augment
// `QueryRegistry` via `declare module './queries.js'`.
// ===========================================================================

/** Mirrors {@link NodeRow}; locked by `satisfies z.ZodType<NodeRow>`. */
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

/**
 * Shape `bindingsFromObject(node, NODE_SCHEMA)` produces + the call-site
 * overrides (`qualifiedName`, `updatedAt`) + the derived `nameSubwords`.
 * Insert and update share the same column set — only the WHERE clause
 * (which references `@id` already in the schema) differs.
 */
const NodeInsertParamsSchema = z.object({
  id: z.string(),
  kind: z.string(),
  name: z.string(),
  qualifiedName: z.string(),
  filePath: z.string(),
  language: z.string(),
  startLine: z.number(),
  endLine: z.number(),
  startColumn: z.number(),
  endColumn: z.number(),
  docstring: z.string().nullable(),
  signature: z.string().nullable(),
  visibility: z.string().nullable(),
  isExported: z.union([z.literal(0), z.literal(1)]),
  isAsync: z.union([z.literal(0), z.literal(1)]),
  isStatic: z.union([z.literal(0), z.literal(1)]),
  decorators: z.string().nullable(),
  decoratorArgs: z.string().nullable(),
  updatedAt: z.number(),
  centrality: z.number().nullable(),
  betweenness: z.number().nullable(),
  bodyHash: z.string(),
  nameSubwords: z.string(),
});
type NodeInsertParams = z.infer<typeof NodeInsertParamsSchema>;

const IdParams = z.object({ id: z.string() });
const NoParams = z.object({});

function nodeInsertParams(node: Node, action: 'insert' | 'update'): NodeInsertParams | null {
  if (
    node.id == null ||
    node.id === '' ||
    node.kind == null ||
    node.name == null ||
    node.name === '' ||
    node.filePath == null ||
    node.filePath === '' ||
    node.language == null
  ) {
    if (action === 'update') {
      logWarn('Skipping node update with missing required fields', { id: node.id });
    } else {
      logWarn('Skipping node with missing required fields', {
        id: node.id,
        kind: node.kind,
        name: node.name,
        filePath: node.filePath,
        language: node.language,
      });
    }
    return null;
  }

  return {
    ...bindingsFromObject(node, NODE_SCHEMA),
    // Defaults the bindings helper can't supply (it uses the value as-is):
    // qualified_name falls back to name, updated_at to now, name_subwords
    // is computed, and body_hash falls back to '' (matches migration 048).
    qualifiedName: node.qualifiedName ?? node.name,
    updatedAt: node.updatedAt ?? Date.now(),
    nameSubwords: buildNameSubwords(node.name),
    bodyHash: node.bodyHash ?? '',
  } as NodeInsertParams;
}

const insertNodeQuery = defineQuery({
  sql:
    `INSERT OR REPLACE INTO nodes (${NODE_INSERT_PARTS.columns}, name_subwords) ` +
    `VALUES (${NODE_INSERT_PARTS.bindings}, @nameSubwords)`,
  params: NodeInsertParamsSchema,
  row: z.never(),
});

/**
 * Update form used by the G7 format-only fast path in
 * `eoPersistFileExtraction`. Plain `UPDATE … WHERE id = @id` fires
 * only AFTER UPDATE triggers (the FTS5 delete+re-insert pair and the
 * rtree REPLACE) which keep nodes_fts / nodes_rtree in sync correctly.
 *
 * The companion `INSERT OR REPLACE` form ALSO fires AFTER UPDATE
 * triggers under bun:sqlite, but pairs them with AFTER INSERT
 * triggers on the same row — the AI trigger's `INSERT OR REPLACE
 * INTO nodes_rtree` then collides with the AU trigger's already-
 * replaced row on the rtree virtual table (R*Tree's UNIQUE handling
 * differs from a real table's), raising `UNIQUE constraint failed:
 * nodes_rtree.id`. Plain UPDATE sidesteps the dual-trigger fan-out.
 *
 * `centrality` is intentionally excluded from the SET clause: it's
 * owned by the centrality hook, and preserving it across re-extracts
 * is the whole win of the stable-id path. `role` isn't in NODE_SCHEMA
 * so it's already preserved by omission. `name_subwords` is appended
 * outside the schema (matches the insert's tail-bind shape).
 */
const updateNodeQuery = defineQuery({
  sql:
    `UPDATE nodes SET ` +
    updateSqlSets(NODE_SCHEMA, { omitCols: ['id', 'centrality'] }) +
    `, name_subwords = @nameSubwords ` +
    `WHERE id = @id`,
  params: NodeInsertParamsSchema,
  row: z.never(),
});

const deleteNodeQuery = defineQuery({
  sql: 'DELETE FROM nodes WHERE id = @id',
  params: IdParams,
  row: z.never(),
});

const getNodeByIdQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE id = @id',
  params: IdParams,
  row: NodeRowSchema,
});

const getNodesByFileQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE file_path = @filePath ORDER BY start_line',
  params: z.object({ filePath: z.string() }),
  row: NodeRowSchema,
});

const NodeNameRowSchema = z.object({ name: z.string() });

const getAllNodeNamesQuery = defineQuery({
  sql: 'SELECT DISTINCT name FROM nodes',
  params: NoParams,
  row: NodeNameRowSchema,
});

const getNodesByKindQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE kind = @kind',
  params: z.object({ kind: z.string() }),
  row: NodeRowSchema,
});

const getAllNodesQuery = defineQuery({
  sql: 'SELECT * FROM nodes',
  params: NoParams,
  row: NodeRowSchema,
});

const NodeIdRowSchema = z.object({ id: z.string() });

const getAllNodeIdsQuery = defineQuery({
  sql: 'SELECT id FROM nodes',
  params: NoParams,
  row: NodeIdRowSchema,
});

const StatsCountsRowSchema = z.object({
  node_count: z.number(),
  edge_count: z.number(),
  file_count: z.number(),
  test_file_count: z.number(),
});
type StatsCountsRow = z.infer<typeof StatsCountsRowSchema>;

const getStatsCountsQuery = defineQuery({
  sql: `SELECT
      (SELECT COUNT(*) FROM nodes) AS node_count,
      (SELECT COUNT(*) FROM edges) AS edge_count,
      (SELECT COUNT(*) FROM files) AS file_count,
      (SELECT COUNT(*) FROM files WHERE is_test = 1) AS test_file_count`,
  params: NoParams,
  row: StatsCountsRowSchema,
});

const KindCountRowSchema = z.object({ kind: z.string(), count: z.number() });
type KindCountRow = z.infer<typeof KindCountRowSchema>;

const LangCountRowSchema = z.object({ language: z.string(), count: z.number() });
type LangCountRow = z.infer<typeof LangCountRowSchema>;

const getStatsNodesByKindQuery = defineQuery({
  sql: 'SELECT kind, COUNT(*) as count FROM nodes GROUP BY kind',
  params: NoParams,
  row: KindCountRowSchema,
});

/**
 * Per-(kind, language) node breakdown. Used by the status formatter to
 * inline a per-language sub-tally on each kind row when 2+ languages
 * contribute. Defuses moments of confusion like "102 class nodes in a
 * pure-Go project" (the count is dominated by C++ / TypeScript files
 * elsewhere in the tree, but the raw kind rollup hides that).
 */
const KindLanguageCountRowSchema = z.object({ kind: z.string(), language: z.string(), count: z.number() });
type KindLanguageCountRow = z.infer<typeof KindLanguageCountRowSchema>;

const getStatsNodesByKindLanguageQuery = defineQuery({
  sql: 'SELECT kind, language, COUNT(*) as count FROM nodes GROUP BY kind, language ORDER BY kind, count DESC',
  params: NoParams,
  row: KindLanguageCountRowSchema,
});

export function getStatsNodesByKindLanguage(qb: QueryBuilder): KindLanguageCountRow[] {
  qb.queries.getStatsNodesByKindLanguage ??= getStatsNodesByKindLanguageQuery(qb.db);
  return qb.queries.getStatsNodesByKindLanguage.all({});
}

const getStatsEdgesByKindQuery = defineQuery({
  sql: 'SELECT kind, COUNT(*) as count FROM edges GROUP BY kind',
  params: NoParams,
  row: KindCountRowSchema,
});

const getStatsFilesByLanguageQuery = defineQuery({
  sql: 'SELECT language, COUNT(*) as count FROM files GROUP BY language',
  params: NoParams,
  row: LangCountRowSchema,
});

const ImportNodeRowSchema = z.object({
  name: z.string(),
  signature: z.string().nullable(),
  filePath: z.string(),
  line: z.number(),
  language: z.string(),
});
type ImportNodeRow = z.infer<typeof ImportNodeRowSchema>;

const getImportNodesQuery = defineQuery({
  sql:
    `SELECT name, signature, file_path AS filePath, start_line AS line, language ` + `FROM nodes WHERE kind = 'import'`,
  params: NoParams,
  row: ImportNodeRowSchema,
});

/**
 * Bulk node lookup by id list. Variable-length IN-list is expressed as
 * `id IN (SELECT value FROM json_each(@ids))` where `@ids` is the JSON-
 * stringified array. `json_each` is unaffected by SQLite's
 * `SQLITE_LIMIT_VARIABLE_NUMBER` cap (each id is a row in the virtual
 * table, not a separate bound parameter), so the prior chunk-at-500
 * loop in {@link QueryBuilder.getNodesByIds} collapses into a single
 * query regardless of input size.
 */
const getNodesByIdsQuery = defineQuery({
  sql: 'SELECT * FROM nodes WHERE id IN (SELECT value FROM json_each(@ids))',
  params: z.object({ ids: z.string() }),
  row: NodeRowSchema,
});

/**
 * Typed-query registry. Per-domain query files augment this interface via
 * `declare module './queries.js'`; the entries below are owned by this
 * file. The augmentations compose across files via TS interface merging;
 * `qb.queries.X` is typed by whichever file declared it.
 *
 * Pattern for new entries from other files:
 *
 *   // queries-files.ts
 *   declare module './queries.js' {
 *     interface QueryRegistry {
 *       upsertFile?: TypedQuery<UpsertFileParams, never>;
 *       // ...
 *     }
 *   }
 */
export interface QueryRegistry {
  insertNode?: TypedQuery<NodeInsertParams, never>;
  updateNode?: TypedQuery<NodeInsertParams, never>;
  deleteNode?: TypedQuery<{ id: string }, never>;
  getNodeById?: TypedQuery<{ id: string }, NodeRow>;
  getNodesByFile?: TypedQuery<{ filePath: string }, NodeRow>;
  getAllNodeNames?: TypedQuery<Record<string, never>, { name: string }>;
  getNodesByKind?: TypedQuery<{ kind: string }, NodeRow>;
  getAllNodes?: TypedQuery<Record<string, never>, NodeRow>;
  getAllNodeIds?: TypedQuery<Record<string, never>, { id: string }>;
  getStatsCounts?: TypedQuery<Record<string, never>, StatsCountsRow>;
  getStatsNodesByKind?: TypedQuery<Record<string, never>, KindCountRow>;
  getStatsNodesByKindLanguage?: TypedQuery<Record<string, never>, KindLanguageCountRow>;
  getStatsEdgesByKind?: TypedQuery<Record<string, never>, KindCountRow>;
  getStatsFilesByLanguage?: TypedQuery<Record<string, never>, LangCountRow>;
  getImportNodes?: TypedQuery<Record<string, never>, ImportNodeRow>;
  getNodesByIds?: TypedQuery<{ ids: string }, NodeRow>;
}

/**
 * Query builder for the knowledge graph database
 */
// Per-domain helper files (queries-llm.ts, etc.) read these
// fields directly via the /** @internal */ tag. They're not part
// of the package's public API surface, but visible across the
// db/ module's helper files.
export class QueryBuilder {
  /** @internal */ db: SqliteDatabase;
  /**
   * Whether the sqlite-vec extension is loaded into `db`. When true,
   * write paths that touch `symbol_embeddings` mirror the row into
   * the dim-matching vec0 virtual table; query paths can use the
   * indexed KNN. When false, everything falls through to the
   * existing in-memory `EmbeddingCache` brute-force scan.
   *
   * @internal Tagged so cluster extractions (e.g. `queries-summaries.ts`)
   * can read the flag through the public-typed reference.
   */
  /** @internal */ vecLoaded: boolean = false;

  // Node LRU cache + names list — bundled in NodeLruCache to keep this
  // facade small enough for the god_class detector's info floor.
  /** @internal */ readonly nodeCache: NodeLruCache = new NodeLruCache();

  /**
   * Typed prepared-statement registry — populated by per-domain query
   * modules as they migrate off the raw {@link stmts} cache. Augmented
   * via `declare module './queries.js'` in each migrated file (see
   * `queries-files.ts` for the canonical pattern). Lazy-cached identically
   * to {@link stmts}: `qb.queries.X ??= xQuery(qb.db)`.
   *
   * @internal Read/written by per-domain helper files (`queries-files.ts`,
   * etc.).
   */
  /** @internal */ queries: QueryRegistry = {};

  constructor(db: SqliteDatabase, vecLoaded: boolean = false) {
    this.db = db;
    this.vecLoaded = vecLoaded;
  }

  // ===========================================================================
  // Node Operations
  // ===========================================================================

  /**
   * Insert a new node
   */
  insertNode(node: Node): void {
    // Validate required fields to prevent SQLite bind errors. Explicit
    // null/undefined/empty-string checks instead of truthy guards on
    // the string fields (`id`, `name`, `filePath`) — the latter would
    // silently drop a hypothetical empty-string identifier from a
    // future extractor or tags.scm path. Same anti-pattern the G15
    // LRU eviction sweep closed. `kind` and `language` are closed
    // string-literal unions (NodeKind / Language) with no empty
    // member, so a null/undefined check is sufficient for them.
    const params = nodeInsertParams(node, 'insert');
    if (params === null) return;

    // INSERT OR REPLACE may overwrite a node we have cached. Drop the
    // stale entry so the next getNodeById sees the new row, not the old
    // one (matches the cache-invalidation pattern used by updateNode and
    // deleteNode below).
    this.nodeCache.delete(node.id);
    this.nodeCache.namesList = null;

    this.queries.insertNode ??= insertNodeQuery(this.db);
    this.queries.insertNode.run(params);
  }

  /**
   * Insert multiple nodes in a transaction
   */
  insertNodes(nodes: Node[]): void {
    const paramsList: NodeInsertParams[] = [];
    for (const node of nodes) {
      const params = nodeInsertParams(node, 'insert');
      if (params === null) continue;
      this.nodeCache.delete(node.id);
      this.nodeCache.namesList = null;
      paramsList.push(params);
    }
    if (paramsList.length === 0) return;
    const query = (this.queries.insertNode ??= insertNodeQuery(this.db));
    this.db.transaction(() => {
      query.runBatch(paramsList);
    })();
  }

  /**
   * Update an existing node
   */
  updateNode(node: Node): void {
    // Invalidate cache before update
    this.nodeCache.delete(node.id);
    this.nodeCache.namesList = null;

    // Validate required fields — same explicit-null/empty pattern as
    // insertNode so an empty-string identifier doesn't silently drop.
    const params = nodeInsertParams(node, 'update');
    if (params === null) return;

    this.queries.updateNode ??= updateNodeQuery(this.db);
    this.queries.updateNode.run(params);
  }

  /**
   * Delete a node by ID
   */
  deleteNode(id: string): void {
    // Invalidate cache
    this.nodeCache.delete(id);
    this.nodeCache.namesList = null;
    this.queries.deleteNode ??= deleteNodeQuery(this.db);
    this.queries.deleteNode.run({ id });
  }

  /**
   * Evict a file's nodes from the in-process LRU cache + names list.
   *
   * Mirrors, in the cache, the explicit `DELETE FROM nodes WHERE
   * file_path = ?` that `deleteFile` runs on the database (the cache
   * is process-local — no SQL statement, FK cascade included, can
   * reach it). See {@link deleteFile} for why node removal is explicit
   * rather than left to the `nodes.file_path → files(path)` cascade.
   */
  invalidateNodeCacheForFile(filePath: string): void {
    this.nodeCache.deleteByFile(filePath);
    this.nodeCache.namesList = null;
  }

  /**
   * Get a node by ID
   */
  getNodeById(id: string): Node | null {
    // Check cache first (NodeLruCache.get also performs the LRU touch)
    const cached = this.nodeCache.get(id);
    if (cached !== undefined) return cached;

    this.queries.getNodeById ??= getNodeByIdQuery(this.db);
    const row = this.queries.getNodeById.get({ id });
    if (!row) return null;

    const node = rowToNode(row);
    this.nodeCache.set(node);
    return node;
  }

  /**
   * Batch lookup: fetch many nodes by ID in a single SQL round-trip.
   *
   * Replaces the N+1 pattern in graph traversal where every edge would
   * trigger its own `getNodeById` call. For a function with 50 callers
   * this collapses 50 point reads into one IN-list query (~10-50x
   * faster end-to-end).
   *
   * Returns a Map keyed by id so callers can preserve their own ordering
   * (typically the order edges were returned from the graph). Missing IDs
   * are simply absent from the map.
   *
   * Cache-aware: ids already in the LRU cache are served from memory and
   * the SQL query only touches the misses.
   */
  getNodesByIds(ids: readonly string[]): Map<string, Node> {
    const out = new Map<string, Node>();
    if (ids.length === 0) return out;

    // Serve cache hits first; build the miss list for SQL.
    const misses: string[] = [];
    for (const id of ids) {
      const cached = this.nodeCache.get(id); // NodeLruCache.get performs LRU touch
      if (cached === undefined) {
        misses.push(id);
      } else {
        out.set(id, cached);
      }
    }
    if (misses.length === 0) return out;

    // Single query — `json_each` reads the JSON-stringified id list as a
    // virtual table, so the per-statement parameter cap that forced the
    // prior chunk-at-500 loop no longer applies. One prepared statement
    // handles the union of all misses regardless of size.
    this.queries.getNodesByIds ??= getNodesByIdsQuery(this.db);
    const rows = this.queries.getNodesByIds.all({ ids: JSON.stringify(misses) });
    for (const row of rows) {
      const node = rowToNode(row);
      out.set(node.id, node);
      this.nodeCache.set(node);
    }
    return out;
  }

  /**
   * Get all nodes in a file
   */
  getNodesByFile(filePath: string): Node[] {
    this.queries.getNodesByFile ??= getNodesByFileQuery(this.db);
    const rows = this.queries.getNodesByFile.all({ filePath });
    return rows.map(rowToNode);
  }

  /**
   * Get all distinct node names (lightweight — just name strings for
   * pre-filtering). Result is cached and invalidated by mutating
   * paths so the fuzzy fallback and `suggestSymbolNames` don't re-scan
   * the table on every miss.
   */
  getAllNodeNames(): string[] {
    if (this.nodeCache.namesList !== null) return this.nodeCache.namesList;
    this.queries.getAllNodeNames ??= getAllNodeNamesQuery(this.db);
    const rows = this.queries.getAllNodeNames.all({});
    this.nodeCache.namesList = rows.map((r) => r.name);
    return this.nodeCache.namesList;
  }

  // ---- moved to module-scope free functions below (getStats, getNodesByKind, getAllNodes,
  //      clearAll, clearStructural, getImportNodes, qbTransaction) ----

  // ==========================================================================
  // Per-symbol Coverage (from external CI artifacts)
  // ==========================================================================

  /* PLACEHOLDER — kept for coverage queries in queries-coverage.ts */
}

// ===========================================================================
// Free-standing QueryBuilder utility functions (extracted from the class to
// keep it below the god_class threshold). Callers pattern: fn(qb, ...).
// ===========================================================================

/**
 * Execute a callback inside a single SQLite transaction. Useful when a
 * caller needs several `QueryBuilder` operations to commit atomically.
 */
export function qbTransaction<T>(qb: QueryBuilder, fn: () => T): T {
  return qb.db.transaction(fn)();
}

/**
 * Get all nodes of a specific kind.
 */
export function getNodesByKind(qb: QueryBuilder, kind: NodeKind): Node[] {
  qb.queries.getNodesByKind ??= getNodesByKindQuery(qb.db);
  return qb.queries.getNodesByKind.all({ kind }).map(rowToNode);
}

/**
 * Get all nodes in the database.
 */
export function getAllNodes(qb: QueryBuilder): Node[] {
  qb.queries.getAllNodes ??= getAllNodesQuery(qb.db);
  return qb.queries.getAllNodes.all({}).map(rowToNode);
}

/**
 * All node ids only. For passes that read just `node.id` (PageRank,
 * betweenness) — avoids hydrating full rows (docstrings, signatures,
 * source spans) into memory as ballast, which on a 500k–1M-node graph
 * is hundreds of MB per recompute.
 */
export function getAllNodeIds(qb: QueryBuilder): { id: string }[] {
  qb.queries.getAllNodeIds ??= getAllNodeIdsQuery(qb.db);
  return qb.queries.getAllNodeIds.all({});
}

/**
 * Get graph statistics.
 */
export function getStats(qb: QueryBuilder): GraphStats {
  qb.queries.getStatsCounts ??= getStatsCountsQuery(qb.db);
  const counts = qb.queries.getStatsCounts.get({});
  if (!counts) throw new Error('getStats: counts row missing');

  qb.queries.getStatsNodesByKind ??= getStatsNodesByKindQuery(qb.db);
  const nodesByKind = {} as Record<NodeKind, number>;
  for (const row of qb.queries.getStatsNodesByKind.all({})) {
    nodesByKind[row.kind as NodeKind] = row.count;
  }

  qb.queries.getStatsEdgesByKind ??= getStatsEdgesByKindQuery(qb.db);
  const edgesByKind = {} as Record<EdgeKind, number>;
  for (const row of qb.queries.getStatsEdgesByKind.all({})) {
    edgesByKind[row.kind as EdgeKind] = row.count;
  }

  qb.queries.getStatsFilesByLanguage ??= getStatsFilesByLanguageQuery(qb.db);
  const filesByLanguage = {} as Record<Language, number>;
  for (const row of qb.queries.getStatsFilesByLanguage.all({})) {
    filesByLanguage[row.language as Language] = row.count;
  }

  return {
    nodeCount: counts.node_count,
    edgeCount: counts.edge_count,
    fileCount: counts.file_count,
    testFileCount: counts.test_file_count,
    nodesByKind,
    edgesByKind,
    filesByLanguage,
    dbSizeBytes: 0, // Set by caller using DatabaseConnection.getSize()
    lastUpdated: Date.now(),
  };
}

/**
 * Clear all data — both structural (nodes/edges/files/...) and
 * LLM-derived caches (summaries/embeddings/dir summaries). Use this
 * for a true reset (e.g. `cartograph nuke`); for `--force` re-index
 * use {@link clearStructural} instead so the LLM caches survive.
 */
export function clearAll(qb: QueryBuilder): void {
  clearStructural(qb);
  qb.db.transaction(() => {
    qb.db.exec('DELETE FROM symbol_embeddings');
    // Stage 5 #C — chunk embeddings have ON DELETE CASCADE on
    // nodes(id), but clearStructural disables FKs while wiping
    // nodes, so the cascade never fires. Clear explicitly here so
    // the chunk vec0 mirror tables don't accumulate ghost rowids
    // after a full reset.
    qb.db.exec('DELETE FROM symbol_chunk_embeddings');
    // Design C: symbol_summaries is a VIEW (migration 049). Clear the
    // underlying summary_refs + summary_store tables instead.
    qb.db.exec('DELETE FROM summary_refs');
    qb.db.exec('DELETE FROM summary_store');
    qb.db.exec('DELETE FROM directory_summaries');
    clearVecTables(qb.db, qb.vecLoaded);
    clearPgvectorTables(qb.db);
  })();
}

// `clearStructural` (the --force structural wipe) lives in its own module
// (imported above for clearAll's use) to keep this god-module under its
// line budget; re-exported here so callers keep importing it from queries.
export { clearStructural };

/**
 * All indexed import nodes — one row per import statement /
 * dynamic-import call. Used by `cartograph_imports` to classify
 * resolution kind at query time.
 */
export function getImportNodes(qb: QueryBuilder): Array<{
  name: string;
  signature: string | null;
  filePath: string;
  line: number;
  language: string;
}> {
  qb.queries.getImportNodes ??= getImportNodesQuery(qb.db);
  return qb.queries.getImportNodes.all({});
}
