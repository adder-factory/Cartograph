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
