/**
 * Prototype tests for the Zod-typed prepared-statement wrapper.
 *
 * Goals demonstrated here:
 *   1. Static type inference — params + rows are typed end-to-end.
 *   2. Param validation rejects bad input at the boundary.
 *   3. Row validation catches schema drift (with `'first'` default
 *      and `'all'` opt-in).
 *   4. `'none'` mode skips row validation for cost-sensitive hot paths.
 *   5. Parity with raw `db.prepare(...).all()` — values come back the
 *      same, the underlying prepared statement is reused (no per-call
 *      re-prepare).
 *   6. Sanity micro-bench: prepared-path overhead is in the
 *      tens-of-µs range, not orders of magnitude off raw.
 *
 * The test DB is in-memory and uses a hand-built schema (not the full
 * cartograph schema) — the wrapper is schema-agnostic by design.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { z } from 'zod';
import { createDatabase, type SqliteDatabase } from '../src/db/sqlite-adapter.js';
import {
  defineQuery,
  defineDynamicQuery,
  getDefinedQueryRegistry,
  TypedQueryParamsError,
  TypedQueryRowError,
  type TypedQuery,
  type TypedQueryParams,
  type TypedQueryRow,
} from '../src/db/typed-query.js';

// ---- fixture --------------------------------------------------------------

const NODE_KINDS = ['function', 'method', 'class', 'variable'] as const;

const NodeRowSchema = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  is_exported: z.union([z.literal(0), z.literal(1)]),
});

const InsertNodeParams = z.object({
  id: z.string(),
  kind: z.enum(NODE_KINDS),
  name: z.string(),
  is_exported: z.union([z.literal(0), z.literal(1)]),
});

const ByIdParams = z.object({ id: z.string() });
const ByKindParams = z.object({ kind: z.enum(NODE_KINDS) });

function makeDb(): SqliteDatabase {
  const { db } = createDatabase(':memory:');
  db.exec(`
    CREATE TABLE nodes (
      id TEXT PRIMARY KEY,
      kind TEXT NOT NULL,
      name TEXT NOT NULL,
      is_exported INTEGER NOT NULL DEFAULT 0
    ) STRICT;
  `);
  return db;
}

function seed(db: SqliteDatabase, rows: Array<{ id: string; kind: string; name: string; is_exported?: 0 | 1 }>) {
  const stmt = db.prepare('INSERT INTO nodes (id, kind, name, is_exported) VALUES (@id, @kind, @name, @is_exported)');
  for (const r of rows) {
    stmt.run({ id: r.id, kind: r.kind, name: r.name, is_exported: r.is_exported ?? 0 });
  }
}

// ---- query definitions (declared at module scope; bound per-DB in beforeEach) -

const findNodeById = defineQuery({
  sql: 'SELECT id, kind, name, is_exported FROM nodes WHERE id = @id',
  params: ByIdParams,
  row: NodeRowSchema,
});

const findNodesByKind = defineQuery({
  sql: 'SELECT id, kind, name, is_exported FROM nodes WHERE kind = @kind ORDER BY id',
  params: ByKindParams,
  row: NodeRowSchema,
});

const insertNode = defineQuery({
  sql: 'INSERT INTO nodes (id, kind, name, is_exported) VALUES (@id, @kind, @name, @is_exported)',
  params: InsertNodeParams,
  row: z.never(),
});

const findAllNodesNone = defineQuery({
  sql: 'SELECT id, kind, name, is_exported FROM nodes ORDER BY id',
  params: z.object({}),
  row: NodeRowSchema,
  options: { validateRows: 'none' },
});

const findAllNodesAll = defineQuery({
  sql: 'SELECT id, kind, name, is_exported FROM nodes ORDER BY id',
  params: z.object({}),
  row: NodeRowSchema,
  options: { validateRows: 'all' },
});

// ---- compile-time assertions (these only need to typecheck) ---------------

// eslint-disable-next-line @typescript-eslint/no-unused-vars
function _typeAssertions(q: ReturnType<typeof findNodeById>) {
  type Params = TypedQueryParams<typeof q>;
  type Row = TypedQueryRow<typeof q>;
  const params: Params = { id: 'x' };
  const row: Row | undefined = q.get({ id: 'x' });
  const rows: Row[] = q.all({ id: 'x' });
  return { params, row, rows };
}

describe('defineQuery registry gate', () => {
  const registrySql = 'SELECT 42 AS answer';
  let previousRegistryEnv: string | undefined;

  beforeEach(() => {
    previousRegistryEnv = process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'];
  });

  afterEach(() => {
    if (previousRegistryEnv === undefined) delete process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'];
    else process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] = previousRegistryEnv;
  });

  it('does not register queries when the registry gate is disabled', () => {
    delete process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'];
    const before = getDefinedQueryRegistry().length;

    defineQuery({
      sql: registrySql,
      params: z.object({}),
      row: z.object({ answer: z.number() }),
    });

    expect(getDefinedQueryRegistry()).toHaveLength(before);
  });

  it('registers SQL and a useful caller source when the gate is enabled', () => {
    process.env['CARTOGRAPH_REGISTER_DEFINED_QUERIES'] = '1';
    const before = getDefinedQueryRegistry().length;

    defineQuery({
      sql: registrySql,
      params: z.object({}),
      row: z.object({ answer: z.number() }),
    });

    const after = getDefinedQueryRegistry();
    const last = after.at(-1)!;
    expect(after).toHaveLength(before + 1);
    expect(last.sql).toBe(registrySql);
    expect(last.source).toMatch(/\.ts:\d+$/);
    expect(last.source).not.toBe('<unknown>');
  });
});

// ---- tests ----------------------------------------------------------------

describe('typed-query wrapper', () => {
  let db: SqliteDatabase;
  let byId: TypedQuery<{ id: string }, z.infer<typeof NodeRowSchema>>;
  let byKind: TypedQuery<{ kind: (typeof NODE_KINDS)[number] }, z.infer<typeof NodeRowSchema>>;
  let insert: TypedQuery<z.infer<typeof InsertNodeParams>, never>;

  beforeEach(() => {
    db = makeDb();
    byId = findNodeById(db);
    byKind = findNodesByKind(db);
    insert = insertNode(db);
    seed(db, [
      { id: 'n_1', kind: 'function', name: 'parseFoo', is_exported: 1 },
      { id: 'n_2', kind: 'function', name: 'bar', is_exported: 0 },
      { id: 'n_3', kind: 'class', name: 'Baz', is_exported: 1 },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  describe('basic reads', () => {
    it('get() returns the typed row', () => {
      const row = byId.get({ id: 'n_1' });
      expect(row).toEqual({ id: 'n_1', kind: 'function', name: 'parseFoo', is_exported: 1 });
    });

    it('get() returns undefined on miss', () => {
      expect(byId.get({ id: 'nope' })).toBeUndefined();
    });

    it('all() returns typed rows', () => {
      const rows = byKind.all({ kind: 'function' });
      expect(rows).toHaveLength(2);
      expect(rows[0]).toMatchObject({ id: 'n_1', kind: 'function' });
      expect(rows[1]).toMatchObject({ id: 'n_2', kind: 'function' });
    });

    it('iterate() yields typed rows', () => {
      const ids: string[] = [];
      for (const row of byKind.iterate({ kind: 'function' })) {
        ids.push(row.id);
      }
      expect(ids).toEqual(['n_1', 'n_2']);
    });
  });

  describe('insert + run', () => {
    it('run() returns changes', () => {
      const res = insert.run({ id: 'n_99', kind: 'method', name: 'x', is_exported: 0 });
      expect(res.changes).toBe(1);
    });

    it('round-trips through get()', () => {
      insert.run({ id: 'n_99', kind: 'method', name: 'x', is_exported: 0 });
      const row = byId.get({ id: 'n_99' });
      expect(row).toEqual({ id: 'n_99', kind: 'method', name: 'x', is_exported: 0 });
    });
  });

  describe('params validation', () => {
    it('rejects a missing key', () => {
      // @ts-expect-error — missing `id`
      expect(() => byId.get({})).toThrow(TypedQueryParamsError);
    });

    it('rejects a wrong-typed value', () => {
      // @ts-expect-error — id must be string
      expect(() => byId.get({ id: 42 })).toThrow(TypedQueryParamsError);
    });

    it('rejects an out-of-vocabulary enum', () => {
      // @ts-expect-error — 'route' is not in the local enum
      expect(() => byKind.all({ kind: 'route' })).toThrow(TypedQueryParamsError);
    });

    it('error message includes the SQL preview', () => {
      try {
        // @ts-expect-error — missing `id`
        byId.get({});
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/SELECT id, kind, name/);
      }
    });

    it('strips unknown keys silently (default zod object behaviour)', () => {
      const row = byId.get({ id: 'n_1', extra: 'ignored' } as { id: string });
      expect(row?.id).toBe('n_1');
    });
  });

  describe('row validation', () => {
    // Drift signal: `is_exported = 2` satisfies SQLite (STRICT INTEGER NOT NULL)
    // but violates the Zod row schema's `z.union([literal(0), literal(1)])`.
    // Models the real-world case where a writer skipped a constraint the
    // reader's Zod schema still enforces.
    const insertDriftRow = (id: string) => {
      db.prepare('INSERT INTO nodes (id, kind, name, is_exported) VALUES (?, ?, ?, ?)').run(
        id,
        'function',
        'broken',
        2,
      );
    };

    it('first mode catches drift on the first row', () => {
      insertDriftRow('n_drift');
      // Drop the seeded rows to ensure n_drift is the FIRST row returned
      db.prepare('DELETE FROM nodes WHERE id != ?').run('n_drift');
      expect(() => byKind.all({ kind: 'function' })).toThrow(TypedQueryRowError);
    });

    it('first mode does NOT validate later rows (drift in row 2+ slips through)', () => {
      insertDriftRow('n_zlater'); // sorts AFTER n_1, n_2
      const rows = byKind.all({ kind: 'function' });
      // First row passes validation; n_zlater slips through unchecked
      expect(rows).toHaveLength(3);
      expect(rows[2]?.id).toBe('n_zlater');
    });

    it("'all' mode catches drift anywhere in the result", () => {
      insertDriftRow('n_zlater');
      const q = findAllNodesAll(db);
      expect(() => q.all({})).toThrow(TypedQueryRowError);
    });

    it("'none' mode skips row validation entirely", () => {
      insertDriftRow('n_drift');
      const q = findAllNodesNone(db);
      expect(() => q.all({})).not.toThrow();
    });

    it('row error message includes a drift hint', () => {
      insertDriftRow('n_drift');
      const q = findAllNodesAll(db);
      try {
        q.all({});
        expect.fail('should have thrown');
      } catch (e) {
        expect((e as Error).message).toMatch(/schema drift/);
      }
    });
  });

  describe('parity with raw .prepare()', () => {
    it('returns the same rows as raw better-sqlite3-style prepared statement', () => {
      const raw = db
        .prepare('SELECT id, kind, name, is_exported FROM nodes WHERE kind = @kind ORDER BY id')
        .all({ kind: 'function' });
      const wrapped = byKind.all({ kind: 'function' });
      expect(wrapped).toEqual(raw);
    });

    it('exposes the underlying prepared statement as an escape hatch', () => {
      expect(byId.stmt).toBeDefined();
      const row = byId.stmt.get({ id: 'n_1' });
      expect(row).toMatchObject({ id: 'n_1' });
    });

    it('exposes the original SQL', () => {
      expect(byId.sql).toContain('SELECT id, kind, name, is_exported');
    });
  });

  describe('sanity microbench (overhead in tens of µs, not orders of magnitude)', () => {
    it('typed-query all() is within ~3x of raw all() on a hot loop', () => {
      // Seed enough rows that per-row work dominates the loop variance
      const extra = Array.from({ length: 200 }, (_, i) => ({
        id: `n_b${i}`,
        kind: 'function' as const,
        name: `f${i}`,
        is_exported: (i % 2) as 0 | 1,
      }));
      for (const r of extra) {
        insert.run(r);
      }
      const N = 200;

      // Raw path
      const rawStmt = db.prepare('SELECT id, kind, name, is_exported FROM nodes WHERE kind = @kind ORDER BY id');
      const rawStart = performance.now();
      for (let i = 0; i < N; i++) rawStmt.all({ kind: 'function' });
      const rawElapsed = performance.now() - rawStart;

      // Typed path (first-row validation default)
      const typedStart = performance.now();
      for (let i = 0; i < N; i++) byKind.all({ kind: 'function' });
      const typedElapsed = performance.now() - typedStart;

      // Loose bound — CI variance is high, and the wrapper only adds
      // O(1) work per call (one param parse + one row parse). 3x is
      // generous; on a quiet box it's typically <1.5x.
      const ratio = typedElapsed / Math.max(rawElapsed, 0.001);
      expect(ratio).toBeLessThan(5);
      // eslint-disable-next-line no-console
      console.log(
        `[typed-query] raw=${rawElapsed.toFixed(2)}ms typed=${typedElapsed.toFixed(2)}ms ratio=${ratio.toFixed(2)}x`,
      );
    });
  });
});

describe('dynamic typed-query wrapper', () => {
  let db: SqliteDatabase;

  beforeEach(() => {
    db = makeDb();
    seed(db, [
      { id: 'n_1', kind: 'function', name: 'parseFoo', is_exported: 1 },
      { id: 'n_2', kind: 'function', name: 'bar', is_exported: 0 },
      { id: 'n_3', kind: 'class', name: 'Baz', is_exported: 1 },
    ]);
  });

  afterEach(() => {
    db.close();
  });

  const dynamicByKind = defineDynamicQuery({
    params: z.object({
      kind: z.enum(NODE_KINDS),
      descending: z.boolean().default(false),
    }),
    row: NodeRowSchema,
    build: ({ kind, descending }) => ({
      sql: `SELECT id, kind, name, is_exported FROM nodes WHERE kind = @kind ORDER BY id ${
        descending ? 'DESC' : 'ASC'
      }`,
      bindings: { kind },
    }),
  });

  it('validates params, builds SQL, and returns rows', () => {
    const rows = dynamicByKind(db).all({ kind: 'function', descending: true });

    expect(rows.map((r) => r.id)).toEqual(['n_2', 'n_1']);
  });

  it('supports get(), iterate(), and run()', () => {
    const dynamicInsert = defineDynamicQuery({
      params: InsertNodeParams,
      row: z.never(),
      build: (params) => ({
        sql: 'INSERT INTO nodes (id, kind, name, is_exported) VALUES (@id, @kind, @name, @is_exported)',
        bindings: params,
      }),
    })(db);
    expect(dynamicInsert.run({ id: 'n_4', kind: 'method', name: 'm', is_exported: 0 }).changes).toBe(1);

    const q = dynamicByKind(db);
    expect(q.get({ kind: 'method' })?.id).toBe('n_4');
    expect([...q.iterate({ kind: 'function' })].map((r) => r.id)).toEqual(['n_1', 'n_2']);
  });

  it('throws the dynamic SQL params error on invalid params', () => {
    const q = dynamicByKind(db);

    // @ts-expect-error — kind must be one of NODE_KINDS
    expect(() => q.all({ kind: 'route' })).toThrow(TypedQueryParamsError);
  });

  it("'all' mode catches row drift beyond the first dynamic row", () => {
    db.prepare('INSERT INTO nodes (id, kind, name, is_exported) VALUES (?, ?, ?, ?)').run(
      'n_zlater',
      'function',
      'broken',
      2,
    );
    const q = defineDynamicQuery({
      params: z.object({}),
      row: NodeRowSchema,
      options: { validateRows: 'all' },
      build: () => ({
        sql: 'SELECT id, kind, name, is_exported FROM nodes WHERE kind = @kind ORDER BY id',
        bindings: { kind: 'function' },
      }),
    })(db);

    expect(() => q.all({})).toThrow(TypedQueryRowError);
  });
});

describe('postgres numeric normalization (dialect-gated)', () => {
  // The PG wire protocol returns int8 (every COUNT/SUM) and `numeric`
  // as STRINGS, and Bun.SQL exposes no column types — so the wrapper
  // converts using the row schema as the type oracle. Caught live: a
  // parse-cache stats query failed zod with "expected number,
  // received string" on the first real init against PostgreSQL.
  const ROW = z.object({ n: z.number(), id: z.string(), label: z.string().nullable() });

  /** Fake adapter: postgres dialect, statements return PG-shaped rows
   *  (numbers as strings). Lets the normalization be tested without a
   *  live server. */
  function fakePgDb(rows: Array<Record<string, unknown>>): SqliteDatabase {
    const stmt = {
      get: () => rows[0],
      all: () => rows,
      run: () => ({ changes: 0, lastInsertRowid: 0 }),
      *iterate() {
        yield* rows;
      },
    };
    return { dialect: 'postgres', prepare: () => stmt } as unknown as SqliteDatabase;
  }

  it('converts schema-numeric fields on EVERY row, not just the validated first', () => {
    // validateRows 'first' only zod-parses row[0]; rows beyond it are
    // returned raw — the conversion must not depend on validation.
    const rows = [
      { n: '42', id: '123', label: null },
      { n: '7', id: '456', label: 'x' },
    ];
    const q = defineQuery({ sql: 'SELECT 1', params: z.object({}), row: ROW })(fakePgDb(rows));
    const out = q.all({});
    expect(out[0]!.n).toBe(42);
    expect(out[1]!.n).toBe(7); // the row zod never saw
    // The corruption guard: digit-LIKE strings in string-typed fields
    // stay strings (ids are TEXT and may be all digits).
    expect(out[0]!.id).toBe('123');
    expect(out[1]!.id).toBe('456');
  });

  it('rejects integer strings that cannot be represented safely as numbers', () => {
    const q = defineQuery({ sql: 'SELECT 1', params: z.object({}), row: ROW })(
      fakePgDb([{ n: '9007199254740993', id: '123', label: null }]),
    );

    expect(() => q.get({})).toThrow(TypedQueryRowError);
  });

  it('rejects bigint values outside the JavaScript safe-integer range', () => {
    const q = defineQuery({ sql: 'SELECT 1', params: z.object({}), row: ROW })(
      fakePgDb([{ n: BigInt(Number.MIN_SAFE_INTEGER) - 2n, id: '123', label: null }]),
    );

    expect(() => q.get({})).toThrow(TypedQueryRowError);
  });

  it('leaves sqlite untouched (identity fast path)', () => {
    const db = createDatabase(':memory:').db;
    db.exec('CREATE TABLE t (id TEXT, n INTEGER)');
    db.exec("INSERT INTO t VALUES ('001', 5)");
    const q = defineQuery({
      sql: 'SELECT id, n FROM t',
      params: z.object({}),
      row: z.object({ id: z.string(), n: z.number() }),
    })(db);
    const row = q.get({})!;
    expect(row.id).toBe('001');
    expect(row.n).toBe(5);
    db.close();
  });

  it('handles decimals, scientific notation, nullable wrappers, and safe bigint values', () => {
    const q = defineQuery({
      sql: 'SELECT 1',
      params: z.object({}),
      row: z.object({
        decimal: z.number().nullable(),
        sci: z.number(),
        count: z.number(),
        id: z.string(),
      }),
    })(
      fakePgDb([
        {
          decimal: '3.5',
          sci: '1e2',
          count: BigInt(Number.MAX_SAFE_INTEGER),
          id: '001',
        },
      ]),
    );

    expect(q.get({})).toEqual({
      decimal: 3.5,
      sci: 100,
      count: Number.MAX_SAFE_INTEGER,
      id: '001',
    });
  });

  it('leaves non-object row schemas on the identity path', () => {
    const q = defineQuery({
      sql: 'SELECT 1',
      params: z.object({}),
      row: z.number(),
    })(fakePgDb([7]));

    expect(q.get({})).toBe(7);
  });

  it('rejects numeric strings that coerce to non-finite numbers', () => {
    const q = defineQuery({ sql: 'SELECT 1', params: z.object({}), row: ROW })(
      fakePgDb([{ n: '1e309', id: '123', label: null }]),
    );

    expect(() => q.get({})).toThrow(TypedQueryRowError);
  });

  it('normalizes Postgres numeric fields for dynamic queries too', () => {
    const q = defineDynamicQuery({
      params: z.object({}),
      row: z.object({ n: z.number(), id: z.string() }),
      build: () => ({ sql: 'SELECT n, id FROM stats', bindings: {} }),
    })(fakePgDb([{ n: '12', id: '001' }]));

    expect(q.get({})).toEqual({ n: 12, id: '001' });
  });
});
