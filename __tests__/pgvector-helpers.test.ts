import { Buffer } from 'node:buffer';
import { describe, expect, it } from 'vitest';
import type { DatabaseConfig } from '../src/db/database-config.js';
import {
  bootstrapPgvector,
  bootstrapPgvectorTables,
  clearPgvectorTables,
  findSimilarViaPgvector,
  isPgvectorAvailable,
  mirrorChunkEmbeddingToPgvector,
  mirrorEmbeddingToPgvector,
  pgvectorChunkTableNameForDim,
  pgvectorStoreTableNameForDim,
} from '../src/db/pgvector-helpers.js';
import type { SqliteDatabase, SqliteStatement } from '../src/db/sqlite-adapter.js';

const POSTGRES_DATABASE: DatabaseConfig = {
  provider: 'postgres',
  url: 'postgres://localhost/cartograph',
  pgvector: 'auto',
};
const VECTOR_DIM = 2;
const VECTOR_BYTES = VECTOR_DIM * 4;
const INVALID_VECTOR_BYTES = 0;
const TOO_LARGE_VECTOR_BYTES = 32772;
const STORE_ROWID = 1;
const CHUNK_ROWID = 2;
const STORE_DISTANCE = 0.4;
const STORE_SHARED_DISTANCE = 0.8;
const CHUNK_SHARED_DISTANCE = 0.2;
const CHUNK_DISTANCE = 0.3;

describe('pgvector helper fallbacks', () => {
  it('respects dialect, mode, extension creation, and availability checks', () => {
    expect(bootstrapPgvector(fakeSqliteDb(), POSTGRES_DATABASE)).toBe(false);

    const offDb = new FakePgvectorDb();
    expect(bootstrapPgvector(offDb.db, { ...POSTGRES_DATABASE, pgvector: 'off' })).toBe(false);
    expect(isPgvectorAvailable(offDb.db)).toBe(false);

    const extensionFailure = new FakePgvectorDb({ throwExtension: true });
    expect(() => bootstrapPgvector(extensionFailure.db, { ...POSTGRES_DATABASE, pgvector: 'require' })).toThrow(
      'could not enable pgvector',
    );

    const unavailable = new FakePgvectorDb({ available: false });
    expect(bootstrapPgvector(unavailable.db, POSTGRES_DATABASE)).toBe(false);
    expect(() =>
      bootstrapPgvector(new FakePgvectorDb({ available: false }).db, { ...POSTGRES_DATABASE, pgvector: 'require' }),
    ).toThrow('extension `vector` is not available');

    const available = new FakePgvectorDb();
    expect(bootstrapPgvector(available.db, POSTGRES_DATABASE)).toBe(true);
    expect(
      available.execs.some((sql) => sql.includes('CREATE EXTENSION IF NOT EXISTS vector WITH SCHEMA public')),
    ).toBe(true);
    expect(available.execs).not.toContain('ALTER EXTENSION vector SET SCHEMA public');
  });

  it('backfills, mirrors, and merges native pgvector hits when available', () => {
    const fake = new FakePgvectorDb({ throwHnsw: true });
    expect(bootstrapPgvector(fake.db, POSTGRES_DATABASE)).toBe(true);

    bootstrapPgvectorTables(fake.db, true);

    expect(pgvectorStoreTableNameForDim(VECTOR_DIM)).toBe('pgvector_symbol_embeddings_2');
    expect(pgvectorChunkTableNameForDim(VECTOR_DIM)).toBe('pgvector_chunk_embeddings_2');
    expect(fake.execs.some((sql) => sql.includes('CREATE TABLE IF NOT EXISTS pgvector_symbol_embeddings_2'))).toBe(
      true,
    );
    expect(fake.execs.some((sql) => sql.includes('USING ivfflat'))).toBe(true);
    expect(fake.runs.some((run) => JSON.stringify(run.params).includes('[1,0]'))).toBe(true);
    expect(fake.runs.some((run) => JSON.stringify(run.params).includes('[0,1]'))).toBe(true);

    const runCount = fake.runs.length;
    mirrorEmbeddingToPgvector({
      db: fake.db,
      rowid: 9,
      bodyHash: 'bad',
      model: 'test-model',
      grain: 'symbol',
      embedding: Buffer.from([1, 2, 3]),
    });
    mirrorChunkEmbeddingToPgvector({
      db: fake.db,
      rowid: 10,
      nodeId: 'n:bad',
      model: 'test-model',
      embedding: floatBytes([Number.NaN, 1]),
    });
    expect(fake.runs.length).toBe(runCount);

    const hits = findSimilarViaPgvector({
      db: fake.db,
      queryVec: Float32Array.from([1, 0]),
      model: 'test-model',
      k: 2,
    });
    expect(hits).toEqual([
      { nodeId: 'n:shared', distance: CHUNK_SHARED_DISTANCE },
      { nodeId: 'n:chunk', distance: CHUNK_DISTANCE },
    ]);

    expect(
      findSimilarViaPgvector({
        db: fake.db,
        queryVec: Float32Array.from([1, 0]),
        model: 'test-model',
        k: 1,
        grain: 'symbol',
        includeChunks: false,
      }),
    ).toEqual([{ nodeId: 'n:store', distance: STORE_DISTANCE }]);
    expect(
      findSimilarViaPgvector({
        db: fake.db,
        queryVec: Float32Array.from([Number.NaN, 0]),
        model: 'test-model',
        k: 1,
      }),
    ).toEqual([]);
  });

  it('skips the KNN when a mirror table is absent (no relation-does-not-exist)', () => {
    // No bootstrapPgvectorTables() → mirror tables are never created and the
    // existence cache is empty; to_regclass reports them absent. The search
    // must skip the KNN entirely instead of issuing it and letting Postgres
    // raise + log `relation does not exist` (caught, but noise in CI logs).
    const fake = new FakePgvectorDb();
    expect(bootstrapPgvector(fake.db, POSTGRES_DATABASE)).toBe(true);

    const hits = findSimilarViaPgvector({
      db: fake.db,
      queryVec: Float32Array.from([1, 0]),
      model: 'test-model',
      k: 2,
    });

    expect(hits).toEqual([]);
    // Guard proof: the KNN was never issued, even though the mock would have
    // returned hits for those tables had the query run.
    expect(fake.alls.some((sql) => sql.includes('embedding <=>'))).toBe(false);
  });

  it('clears only recognized pgvector mirror tables and tolerates query failures', () => {
    const fake = new FakePgvectorDb();
    clearPgvectorTables(fake.db);
    expect(fake.execs).toContain('DELETE FROM pgvector_symbol_embeddings_2');
    expect(fake.execs).toContain('DELETE FROM pgvector_chunk_embeddings_2');
    expect(fake.execs.some((sql) => sql.includes('not_pgvector_symbol_embeddings_2'))).toBe(false);

    const failingList = new FakePgvectorDb({ tableNameQueryThrows: true });
    clearPgvectorTables(failingList.db);
    expect(failingList.execs.filter((sql) => sql.startsWith('DELETE FROM'))).toEqual([]);
  });
});

function fakeSqliteDb(): SqliteDatabase {
  return {
    dialect: 'sqlite',
    open: true,
    prepare: () => fakeStatement(),
    exec: () => undefined,
    pragma: () => undefined,
    transaction: (fn) => fn,
    close: () => undefined,
  };
}

interface FakePgvectorOptions {
  available?: boolean;
  throwExtension?: boolean;
  throwHnsw?: boolean;
  tableNameQueryThrows?: boolean;
}

class FakePgvectorDb {
  readonly execs: string[] = [];
  readonly runs: Array<{ sql: string; params: unknown }> = [];
  readonly alls: string[] = [];
  readonly db: SqliteDatabase;

  constructor(private readonly options: FakePgvectorOptions = {}) {
    this.db = {
      dialect: 'postgres',
      open: true,
      prepare: (sql) => this.prepare(sql),
      exec: (sql) => this.exec(sql),
      pragma: () => undefined,
      transaction: (fn) => fn,
      close: () => undefined,
    };
  }

  private prepare(sql: string): SqliteStatement {
    return fakeStatement({
      run: (params) => {
        this.runs.push({ sql, params });
        return { changes: 1, lastInsertRowid: 0 };
      },
      get: () => {
        if (sql.includes("to_regtype('public.vector')")) return { ok: this.options.available === false ? 0 : 1 };
        return undefined;
      },
      all: () => this.rowsFor(sql),
    });
  }

  private exec(sql: string): void {
    this.execs.push(sql);
    if (sql.includes('CREATE EXTENSION') && this.options.throwExtension) throw new Error('extension denied');
    if (sql.includes('USING hnsw') && this.options.throwHnsw) throw new Error('hnsw unavailable');
  }

  private rowsFor(sql: string): unknown[] {
    this.alls.push(sql);
    if (sql.includes('SELECT DISTINCT LENGTH(embedding) AS len FROM embedding_store')) {
      return [{ len: VECTOR_BYTES }, { len: INVALID_VECTOR_BYTES }, { len: TOO_LARGE_VECTOR_BYTES }];
    }
    if (sql.includes('SELECT DISTINCT LENGTH(embedding) AS len FROM symbol_chunk_embeddings')) {
      return [{ len: VECTOR_BYTES }];
    }
    if (sql.includes('FROM embedding_store es') && sql.includes('WHERE LENGTH(es.embedding)')) {
      return [
        {
          r: STORE_ROWID,
          body_hash: 'body-store',
          model: 'test-model',
          grain: 'symbol',
          embedding: floatBytes([1, 0]),
        },
      ];
    }
    if (sql.includes('FROM symbol_chunk_embeddings sce') && sql.includes('WHERE LENGTH(sce.embedding)')) {
      return [
        {
          r: CHUNK_ROWID,
          node_id: 'n:chunk',
          embedding_model: 'test-model',
          embedding: floatBytes([0, 1]),
        },
      ];
    }
    if (sql.includes('information_schema.tables')) {
      if (this.options.tableNameQueryThrows) throw new Error('list failed');
      return [
        { name: 'pgvector_symbol_embeddings_2' },
        { name: 'pgvector_chunk_embeddings_2' },
        { name: 'not_pgvector_symbol_embeddings_2' },
        { name: 'pgvector_symbol_embeddings_unsafe' },
      ];
    }
    if (sql.includes('FROM pgvector_symbol_embeddings_2 p')) {
      return [
        { node_id: 'n:store', distance: STORE_DISTANCE },
        { node_id: 'n:shared', distance: STORE_SHARED_DISTANCE },
      ];
    }
    if (sql.includes('FROM pgvector_chunk_embeddings_2')) {
      return [
        { node_id: 'n:shared', distance: CHUNK_SHARED_DISTANCE },
        { node_id: 'n:chunk', distance: CHUNK_DISTANCE },
      ];
    }
    return [];
  }
}

function fakeStatement(impl: Partial<SqliteStatement> = {}): SqliteStatement {
  return {
    run: (...params) => impl.run?.(...params) ?? { changes: 0, lastInsertRowid: 0 },
    get: (...params) => impl.get?.(...params),
    all: (...params) => impl.all?.(...params) ?? [],
    *iterate(...params) {
      for (const row of impl.all?.(...params) ?? []) yield row;
    },
  };
}

function floatBytes(values: number[]): Buffer {
  const bytes = Buffer.alloc(values.length * 4);
  values.forEach((value, index) => {
    bytes.writeFloatLE(value, index * 4);
  });
  return bytes;
}
