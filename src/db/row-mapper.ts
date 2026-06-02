/**
 * Type-safe row → object mapper.
 *
 * Replaces the hand-rolled `rowToNode` / `rowToEdge` / etc. functions
 * with a declarative schema + one generic `mapRow` call. Two wins
 * over the hand-written form:
 *
 *   1. **Compile-time coverage check.** `Schema<T, Row>` has type
 *      `{[K in keyof T]: ...}` — TypeScript fails the build if a
 *      field is missing from the schema. Hand-rolled mappers can
 *      silently forget a field.
 *
 *   2. **Compile-time column validation.** Direct column references
 *      are typed as `keyof Row`, so a typo (`'qualified_nme'`)
 *      fails at compile time, not at runtime via "undefined".
 *
 * Common transforms get first-class support so call sites stay
 * declarative:
 *   - `bool01`     — SQLite's `INTEGER` 0/1 → JS `boolean`
 *   - `nullable`   — SQL `NULL` → JS `undefined` (so `compact` later strips the key)
 *   - `json`       — SQLite `TEXT` (JSON) → JS object/array, with `safeJsonParse` fallback
 *   - `cast`       — arbitrary transform `(raw) => T[K]` for the rare unique case
 *   - bare `keyof Row` — direct passthrough
 *
 * Anything more complex than these stays a `cast: (row) => ...` function — the
 * mini-DSL deliberately stops at the four common patterns this codebase had.
 */

import { safeJsonParse } from '../utils.js';

/**
 * One field's mapping spec. Either a bare column name (1:1) or an
 * object describing a transform.
 */
type FieldSpec<TVal, Row> =
  | (keyof Row & string)
  | {
      readonly col: keyof Row & string;
      readonly bool01: true;
    }
  | {
      readonly col: keyof Row & string;
      readonly nullable: true;
    }
  | {
      readonly col: keyof Row & string;
      readonly json: true;
      /** Returned when the column is null OR JSON.parse fails. */
      readonly fallback?: TVal;
    }
  | {
      readonly col: keyof Row & string;
      /**
       * Arbitrary transform. `raw` is typed as the union of ALL column
       * types in `Row` (not the specific column's type), because TS
       * can't narrow to the indexed column type from the spec object
       * alone. Callers should cast inside the function — e.g.
       * `cast: (v) => (v as number | null) ?? 0`.
       */
      readonly cast: (raw: Row[keyof Row]) => TVal;
    };

/**
 * Full schema: every key of `T` must be mapped. TypeScript enforces
 * coverage at compile time — adding a new field to `T` without a
 * spec is a compile error.
 */
export type Schema<T, Row> = {
  readonly [K in keyof T]-?: FieldSpec<T[K], Row>;
};

/**
 * Extract the column name from a spec — bare-string spec is itself
 * the column; object specs carry it as `.col`. Centralising this
 * keeps `mapRow`, `bindingsFromObject`, `insertSqlParts`, and
 * `updateSqlSets` from each re-implementing the union-narrow.
 */
function colOf<Row>(spec: FieldSpec<unknown, Row>): string {
  return typeof spec === 'string' ? spec : (spec as { col: string }).col;
}

/**
 * Apply one field spec to a row, returning the post-transform value
 * (or `undefined` to signal "strip this key from the output").
 */
function readField<Row>(spec: FieldSpec<unknown, Row>, row: Row): unknown {
  if (typeof spec === 'string') return row[spec as keyof Row];
  const obj = spec as Record<string, unknown> & { col: keyof Row & string };
  const raw = row[obj.col as keyof Row];
  // bun:sqlite can return either `number` or `bigint` depending on
  // whether the connection is in `safeIntegers` mode (per-statement
  // toggle; off by default in cartograph). `raw === 1` alone would
  // silently false-read every boolean column if a future call site
  // enables safeIntegers — guard with both shapes.
  if ('bool01' in obj) return raw === 1 || raw === 1n;
  if ('nullable' in obj) return raw ?? undefined;
  if ('json' in obj) {
    return raw == null ? obj['fallback'] : safeJsonParse(raw as string, obj['fallback']);
  }
  // 'cast' in obj
  return (obj['cast'] as (raw: unknown) => unknown)(raw);
}

/**
 * Inverse of {@link readField}: serialise one TS-side value into the
 * SQLite-compatible bind value. `undefined` collapses to `null`
 * everywhere except `bool01` (which always maps to 0/1).
 */
function writeField<Row>(spec: FieldSpec<unknown, Row>, value: unknown): unknown {
  if (typeof spec === 'string') return value === undefined ? null : value;
  const arm = spec as Record<string, unknown>;
  if ('bool01' in arm) return value ? 1 : 0;
  if ('json' in arm) return value === undefined ? null : JSON.stringify(value);
  // 'nullable' or 'cast' — read-side cast narrows the type, not the
  // shape, so writes pass through with undefined → null for safety.
  return value === undefined ? null : value;
}

/**
 * Apply a schema to a row. Strips `undefined` values (matches the
 * `compact()` semantic) so consumers passing the result to types
 * with `?: T` (omit-only) optional fields don't violate
 * `exactOptionalPropertyTypes`.
 *
 * The cast at the end (`as T`) is sound: by construction we
 * populated exactly the fields the schema declares, with values
 * matching `T[K]` per the spec, with undefineds stripped.
 */
export function mapRow<T extends object, Row extends object>(row: Row, schema: Schema<T, Row>): T {
  const out: Record<string, unknown> = {};
  for (const k in schema) {
    const value = readField(schema[k], row);
    if (value !== undefined) out[k] = value;
  }
  return out as T;
}

// ===========================================================================
// Write-side: object → bindings (mirror of mapRow's read direction)
// ===========================================================================

/**
 * Inverse of {@link mapRow}: serialise an in-memory object into the
 * bind-parameter dict you pass to `stmt.run(bindings)`. Reuses the
 * same `Schema<T, Row>` so a column's metadata is declared once and
 * applied to BOTH directions.
 *
 * Bind keys are the TS-side field names (camelCase) — matches the
 * existing better-sqlite3 `@camelCaseName` placeholder convention
 * in `queries.ts`. The SQL generator below
 * ({@link insertSqlParts}) emits both the snake_case column list
 * and the camelCase placeholder list from the same schema, so the
 * two sides can't drift.
 *
 * Reverse transforms (mirror of the read side):
 *
 *   bool01:    `boolean → 0 | 1`
 *   nullable:  `undefined → null`, else passthrough
 *   json:      `undefined → null`, else `JSON.stringify(value)`
 *   cast:      identity (read-side cast is typically a type-narrow,
 *              not a value transform); supply your own conversion
 *              outside the schema if needed
 *   1:1:       passthrough, with `undefined → null` for safety
 */
export function bindingsFromObject<T extends object, Row>(obj: T, schema: Schema<T, Row>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const k in schema) {
    out[k] = writeField(schema[k], obj[k as keyof T]);
  }
  return out;
}

/**
 * Generate `INSERT` SQL fragments from a schema. Returns the
 * snake_case column list and the camelCase `@bind` list — caller
 * splices them into `INSERT INTO <table> (...) VALUES (...)` plus
 * any clauses (ON CONFLICT, etc.).
 *
 * Single source of truth for a table's column ↔ field mapping —
 * adding a new field to a schema automatically updates both
 * `mapRow` reads and `insertSqlParts` writes.
 */
export function insertSqlParts<T, Row>(
  schema: Schema<T, Row>,
  options?: {
    /**
     * Skip these columns from the generated INSERT. Useful when a
     * row has fields that are managed by another subsystem (e.g.
     * `files.commit_count` is owned by the churn miner — listing
     * it on every re-index would clobber mined git history).
     */
    omitCols?: ReadonlyArray<string>;
  },
): { columns: string; bindings: string } {
  const omit = new Set(options?.omitCols ?? []);
  const cols: string[] = [];
  const binds: string[] = [];
  for (const k of Object.keys(schema)) {
    const col = colOf((schema as Record<string, FieldSpec<unknown, Row>>)[k]!);
    if (omit.has(col)) continue;
    cols.push(col);
    binds.push(`@${k}`);
  }
  return { columns: cols.join(', '), bindings: binds.join(', ') };
}

/**
 * Generate the comma-separated SET clause body for an UPDATE
 * statement: `col = @tsKey, col = @tsKey, ...`. Pair with
 * {@link bindingsFromObject} for the runtime bindings. Caller
 * still writes `UPDATE <table> SET ... WHERE ...`.
 *
 * `omitCols` typically excludes the WHERE-clause column (the
 * row's PK) plus any read-only columns.
 */
export function updateSqlSets<T, Row>(schema: Schema<T, Row>, options?: { omitCols?: ReadonlyArray<string> }): string {
  const omit = new Set(options?.omitCols ?? []);
  const sets: string[] = [];
  for (const k of Object.keys(schema)) {
    const col = colOf((schema as Record<string, FieldSpec<unknown, Row>>)[k]!);
    if (omit.has(col)) continue;
    sets.push(`${col} = @${k}`);
  }
  return sets.join(', ');
}
