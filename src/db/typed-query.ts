/**
 * Typed prepared-statement wrapper.
 *
 * Captures the two ergonomic wins of an ORM (typed params, typed rows)
 * without leaving the existing raw-SQL surface — `schema.sql`, the 65
 * migrations, the FTS5 / R*Tree / vec0 virtual tables, and the
 * `SqliteDatabase` adapter all stay untouched.
 *
 * Shape: one Zod schema for params, one for rows. The wrapper prepares
 * the SQL once, validates params on every call (cheap), and validates
 * rows per `options.validateRows` (`'first'` default — drift-catching
 * with near-zero hot-path cost).
 *
 *   const findNode = defineQuery({
 *     sql: 'SELECT id, name FROM nodes WHERE id = @id',
 *     params: z.object({ id: z.string() }),
 *     row: z.object({ id: z.string(), name: z.string() }),
 *   });
 *   const q = findNode(db);
 *   q.get({ id: 'n_abc' });   // typed as { id: string; name: string } | undefined
 *   q.all({ id: 'n_abc' });   // typed as { id: string; name: string }[]
 *
 * Compose with Zod `.transform()` for snake_case → camelCase if you
 * want a single source of truth for shape + naming; otherwise let
 * `row-mapper.ts`'s `mapRow` continue to handle the rename layer.
 */

import { z, type ZodType, type infer as zInfer } from 'zod';
import type { SqliteDatabase, SqliteStatement } from './sqlite-adapter.js';

export type RowValidationMode = 'first' | 'all' | 'none';

interface TypedQueryOptions {
  /**
   * How aggressively to validate rows returned by the statement.
   *
   * - `'first'` (default): validate only the first row per call. Catches
   *   schema drift the moment it appears for ~0 hot-path cost.
   * - `'all'`: validate every row. Use in tests / CI / dev.
   * - `'none'`: skip row validation entirely. The row schema becomes a
   *   pure type marker; use when the SQL is closed-vocabulary enough
   *   that drift would surface at a higher layer.
   */
  readonly validateRows?: RowValidationMode;
}

export interface TypedQuery<TParams, TRow> {
  run(params: TParams): { changes: number; lastInsertRowid: number | bigint };
  get(params: TParams): TRow | undefined;
  all(params: TParams): TRow[];
  iterate(params: TParams): IterableIterator<TRow>;
  /** Underlying prepared statement — escape hatch for the rare exotic call site. */
  readonly stmt: SqliteStatement;
  /** The SQL that was prepared. Stable; useful for logging / introspection. */
  readonly sql: string;
}

export interface DefineQuerySpec<PSchema extends ZodType, RSchema extends ZodType> {
  readonly sql: string;
  readonly params: PSchema;
  readonly row: RSchema;
  readonly options?: TypedQueryOptions;
}

/**
 * Registry of every `defineQuery` invocation across the codebase
 * (F#75, 2026-05-28). Module-level side effect: each call appends one
 * entry. Consumers (`bench/probe-explain-query-plan.mts`) can
 * iterate the registry without holding a live `SqliteDatabase`
 * reference; just importing the queries-*.ts modules
 * (transitive via `Cartograph.open`) populates it.
 *
 * Gated by `CARTOGRAPH_REGISTER_DEFINED_QUERIES=1` so the production
 * hot path AND the test suite skip the per-call stack-trace parse
 * entirely. The bench script flips the env var before importing
 * Cartograph; the cost is paid only when the bench is actually
 * running. Without the gate, the ~262 `new Error().stack` parses at
 * `queries-*.ts` module load added enough wall time to push the
 * watcher-debounce parallel-suite tests over their 5 s budget.
 */
export interface DefinedQueryRecord {
  /** The raw SQL string captured at `defineQuery` time. */
  readonly sql: string;
  /** Best-effort source location (`<file>:<line>`) of the
   *  `defineQuery(...)` call, parsed from a stack trace at
   *  registration time. Falls back to `'<unknown>'` on environments
   *  where stack inspection fails. */
  readonly source: string;
}
const DEFINED_QUERY_REGISTRY: DefinedQueryRecord[] = [];

/** True when the registry side-effect is active. Checked per
 *  `defineQuery` call (not cached at module load) so a test or
 *  bench can flip the gate at any time and have subsequent calls
 *  participate. Earlier calls are NOT retroactively captured. */
function registryEnabled(): boolean {
  return process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] === '1';
}

/** Return the snapshot of registered `defineQuery` records. The list
 *  is in insertion order (registration order). Empty unless the env
 *  var was set before at least one `defineQuery` call fired. */
export function getDefinedQueryRegistry(): readonly DefinedQueryRecord[] {
  return DEFINED_QUERY_REGISTRY;
}

/** Parse the immediate caller's `<file>:<line>` from a V8-style stack
 *  trace. Returns '<unknown>' when the stack shape isn't recognised. */
function captureCallerSource(): string {
  const stack = new Error().stack;
  if (!stack) return '<unknown>';
  // Lines look like `    at functionName (/abs/path/file.ts:LINE:COL)`
  // or `    at /abs/path/file.ts:LINE:COL` (anonymous module-init).
  // Skip the first three lines (Error header + this helper + the
  // `defineQuery` frame) so frame[3] is the caller (a queries-*.ts
  // module init).
  const lines = stack.split('\n');
  for (let i = 3; i < lines.length; i++) {
    const line = lines[i]!;
    const match = /[(\s](\/[^():]+\.ts):(\d+)(?::\d+)?\)?$/.exec(line);
    if (match) {
      const [, filePath, lineNum] = match;
      // Trim the absolute prefix down to `src/db/queries-x.ts` style
      // by lopping everything before `/src/` (the canonical project
      // layout). Falls back to the basename if `/src/` isn't found.
      const srcIdx = filePath!.indexOf('/src/');
      const trimmed = srcIdx >= 0 ? filePath!.slice(srcIdx + 1) : filePath!.split('/').pop()!;
      return `${trimmed}:${lineNum}`;
    }
  }
  return '<unknown>';
}

/**
 * Build a TypedQuery factory. The factory is curried so the SQL +
 * schemas are declared once at module top-level and bound to a
 * specific `SqliteDatabase` at QueryBuilder construction — matches
 * the lazy-prep call-site pattern (`qb.queries.X ??= xQuery(qb.db)`).
 */
export function defineQuery<PSchema extends ZodType, RSchema extends ZodType>(
  spec: DefineQuerySpec<PSchema, RSchema>,
): (db: SqliteDatabase) => TypedQuery<zInfer<PSchema>, zInfer<RSchema>> {
  if (registryEnabled()) {
    DEFINED_QUERY_REGISTRY.push({ sql: spec.sql, source: captureCallerSource() });
  }
  const mode: RowValidationMode = spec.options?.validateRows ?? 'first';
  const sqlPreview = truncate(spec.sql, 120);

  return (db: SqliteDatabase): TypedQuery<zInfer<PSchema>, zInfer<RSchema>> => {
    const stmt = db.prepare(spec.sql);

    const parseParams = (raw: unknown): Record<string, unknown> | unknown[] => {
      const parsed = spec.params.safeParse(raw);
      if (!parsed.success) {
        throw new TypedQueryParamsError(sqlPreview, parsed.error);
      }
      return parsed.data as Record<string, unknown> | unknown[];
    };

    const parseRow = (raw: unknown): zInfer<RSchema> => {
      const parsed = spec.row.safeParse(raw);
      if (!parsed.success) {
        throw new TypedQueryRowError(sqlPreview, parsed.error);
      }
      return parsed.data as zInfer<RSchema>;
    };

    return {
      stmt,
      sql: spec.sql,

      run(params) {
        const bound = parseParams(params);
        return stmt.run(bound);
      },

      get(params) {
        const bound = parseParams(params);
        const row = stmt.get(bound);
        if (row === undefined || row === null) return undefined;
        if (mode === 'none') return row as zInfer<RSchema>;
        return parseRow(row);
      },

      all(params) {
        const bound = parseParams(params);
        const rows = stmt.all(bound);
        if (mode === 'none' || rows.length === 0) {
          return rows as zInfer<RSchema>[];
        }
        if (mode === 'first') {
          parseRow(rows[0]);
          return rows as zInfer<RSchema>[];
        }
        return rows.map(parseRow);
      },

      *iterate(params) {
        const bound = parseParams(params);
        let seen = 0;
        for (const row of stmt.iterate(bound)) {
          if (mode === 'none') {
            yield row as zInfer<RSchema>;
          } else if (mode === 'first' && seen > 0) {
            yield row as zInfer<RSchema>;
          } else {
            yield parseRow(row);
          }
          seen++;
        }
      },
    };
  };
}

/** Convenience type aliases — `TypedQueryParams<typeof q>` resolves the param shape. */
export type TypedQueryParams<Q> = Q extends TypedQuery<infer P, unknown> ? P : never;
export type TypedQueryRow<Q> = Q extends TypedQuery<unknown, infer R> ? R : never;

export class TypedQueryParamsError extends Error {
  constructor(sqlPreview: string, zerr: z.ZodError) {
    super(`TypedQuery params failed validation\n` + `  SQL: ${sqlPreview}\n` + `  ${z.prettifyError(zerr)}`);
    this.name = 'TypedQueryParamsError';
  }
}

export class TypedQueryRowError extends Error {
  constructor(sqlPreview: string, zerr: z.ZodError) {
    super(
      `TypedQuery row failed validation (schema drift?)\n` + `  SQL: ${sqlPreview}\n` + `  ${z.prettifyError(zerr)}`,
    );
    this.name = 'TypedQueryRowError';
  }
}

function truncate(s: string, n: number): string {
  return s.length <= n ? s : s.slice(0, n - 3) + '...';
}

// ───────────────────────────────────────────────────────────────────────────
// Dynamic variant — for queries whose SQL is built from input at call time
// (variable IN-list lengths beyond what `json_each` covers, optional WHERE
// combinations whose Pattern-B sentinel-OR would defeat the planner on an
// indexed column, or multi-LIKE OR-of-OR shapes). Caches prepared statements
// by SQL string within the instance, so repeated calls with the same shape
// reuse a single prepared statement — same hot-path benefit `defineQuery`
// has, just keyed by the lazy-built SQL instead of fixed at module load.
// ───────────────────────────────────────────────────────────────────────────

export interface DefineDynamicQuerySpec<PSchema extends ZodType, RSchema extends ZodType> {
  /**
   * Build the SQL + bindings from validated params. Called per call; the
   * returned SQL string is the prepared-statement cache key (so a fixed
   * filter-combination repeats one prepared statement).
   */
  readonly build: (params: zInfer<PSchema>) => { sql: string; bindings: Record<string, unknown> };
  readonly params: PSchema;
  readonly row: RSchema;
  readonly options?: TypedQueryOptions;
}

/**
 * Subset of {@link TypedQuery} for dynamic-SQL sites. Lacks the
 * `stmt` / `sql` escape-hatch fields — those don't make sense when
 * the SQL is built per call. Behaviour of `.run/.get/.all/.iterate`
 * matches {@link TypedQuery} otherwise.
 */
export interface DynamicTypedQuery<TParams, TRow> {
  run(params: TParams): { changes: number; lastInsertRowid: number | bigint };
  get(params: TParams): TRow | undefined;
  all(params: TParams): TRow[];
  iterate(params: TParams): IterableIterator<TRow>;
}

export function defineDynamicQuery<PSchema extends ZodType, RSchema extends ZodType>(
  spec: DefineDynamicQuerySpec<PSchema, RSchema>,
): (db: SqliteDatabase) => DynamicTypedQuery<zInfer<PSchema>, zInfer<RSchema>> {
  const mode: RowValidationMode = spec.options?.validateRows ?? 'first';

  return (db: SqliteDatabase): DynamicTypedQuery<zInfer<PSchema>, zInfer<RSchema>> => {
    // Bounded by the per-site Cartesian product of inputs to `build()`
    // (typically <=64 entries on the largest current consumer —
    // `getFindingsRanked` with 6 optional filters). Not an LRU; growth
    // is structural rather than open-ended.
    const stmtCache = new Map<string, SqliteStatement>();

    const prepareCached = (sql: string): SqliteStatement => {
      let stmt = stmtCache.get(sql);
      if (!stmt) {
        stmt = db.prepare(sql);
        stmtCache.set(sql, stmt);
      }
      return stmt;
    };

    const parseParams = (raw: unknown): zInfer<PSchema> => {
      const parsed = spec.params.safeParse(raw);
      if (!parsed.success) {
        throw new TypedQueryParamsError('(dynamic SQL)', parsed.error);
      }
      return parsed.data as zInfer<PSchema>;
    };

    const parseRow = (raw: unknown, sqlPreview: string): zInfer<RSchema> => {
      const parsed = spec.row.safeParse(raw);
      if (!parsed.success) {
        throw new TypedQueryRowError(truncate(sqlPreview, 120), parsed.error);
      }
      return parsed.data as zInfer<RSchema>;
    };

    return {
      run(params) {
        const validated = parseParams(params);
        const { sql, bindings } = spec.build(validated);
        return prepareCached(sql).run(bindings);
      },

      get(params) {
        const validated = parseParams(params);
        const { sql, bindings } = spec.build(validated);
        const row = prepareCached(sql).get(bindings);
        if (row === undefined || row === null) return undefined;
        if (mode === 'none') return row as zInfer<RSchema>;
        return parseRow(row, sql);
      },

      all(params) {
        const validated = parseParams(params);
        const { sql, bindings } = spec.build(validated);
        const rows = prepareCached(sql).all(bindings);
        if (mode === 'none' || rows.length === 0) {
          return rows as zInfer<RSchema>[];
        }
        if (mode === 'first') {
          parseRow(rows[0], sql);
          return rows as zInfer<RSchema>[];
        }
        return rows.map((r) => parseRow(r, sql));
      },

      *iterate(params) {
        const validated = parseParams(params);
        const { sql, bindings } = spec.build(validated);
        let seen = 0;
        for (const row of prepareCached(sql).iterate(bindings)) {
          if (mode === 'none') {
            yield row as zInfer<RSchema>;
          } else if (mode === 'first' && seen > 0) {
            yield row as zInfer<RSchema>;
          } else {
            yield parseRow(row, sql);
          }
          seen++;
        }
      },
    };
  };
}
