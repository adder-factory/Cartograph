import { afterEach, describe, expect, it, mock } from 'bun:test';
import type { SqliteDatabase } from '../src/db/sqlite-adapter.js';

type IndexCtorArgs = {
  dimensions: number;
  metric: string;
  quantization: string;
  connectivity: number;
  expansion_add: number;
  expansion_search: number;
  multi: boolean;
};

const fakeUsearch = {
  instances: [] as FakeIndex[],
  loadShouldThrow: false,
  Index: class FakeIndex {
    readonly args: IndexCtorArgs;
    savedPath: string | null = null;
    loadedPath: string | null = null;
    addedKeys: BigUint64Array = new BigUint64Array();
    addedVectors: Float32Array = new Float32Array();
    addedThreads: number | undefined;
    searchCalls: Array<{ k: number; threads?: number; dim: number }> = [];

    constructor(args: IndexCtorArgs) {
      this.args = args;
      fakeUsearch.instances.push(this);
    }

    add(keys: BigUint64Array, vectors: Float32Array, threads?: number): void {
      this.addedKeys = keys;
      this.addedVectors = vectors;
      this.addedThreads = threads;
    }

    search(vec: Float32Array, k: number, threads?: number) {
      this.searchCalls.push({ k, threads, dim: vec.length });
      return {
        keys: BigUint64Array.from([1n, 2n, 3n, 999n]),
        distances: new Float32Array([0.1, 0.2, 0.3, 0.4]),
      };
    }

    save(path: string): void {
      this.savedPath = path;
    }

    load(path: string): void {
      if (fakeUsearch.loadShouldThrow) throw new Error('load failed');
      this.loadedPath = path;
    }

    view(_path: string): void {}

    size(): number {
      return this.addedKeys.length;
    }

    dimensions(): number {
      return this.args.dimensions;
    }
  },
  MetricKind: { IP: 'ip', Cos: 'cos', L2sq: 'l2sq' },
  ScalarKind: { F32: 'f32', F16: 'f16', BF16: 'bf16', I8: 'i8', B1: 'b1' },
};

type FakeIndex = InstanceType<typeof fakeUsearch.Index>;

mock.module('usearch', () => fakeUsearch);

const { HnswIndex, computeRowsetSignature, discoverEmbeddingDims, efForIndexSize, isHnswAvailable } = await import(
  '../src/embeddings/hnsw-index.js'
);

function vectorBuffer(values: number[]): Buffer {
  return Buffer.from(new Float32Array(values).buffer);
}

function slicedVectorBuffer(prefix: number[], values: number[], suffix: number[]): Buffer {
  const all = new Float32Array([...prefix, ...values, ...suffix]);
  return Buffer.from(all.buffer).subarray(prefix.length * 4, (prefix.length + values.length) * 4);
}

function dbWithRows(rows: unknown[]): SqliteDatabase {
  return {
    prepare(sql: string) {
      return {
        get(arg?: unknown) {
          if (sql.includes('COUNT(*) AS c') && arg === undefined) return { c: 5, m: 42 };
          if (sql.includes('COUNT(*) AS c') && arg !== undefined) return { c: 2, m: 9 };
          return undefined;
        },
        all() {
          return rows;
        },
      };
    },
  } as unknown as SqliteDatabase;
}

describe('HnswIndex', () => {
  afterEach(() => {
    fakeUsearch.instances.length = 0;
    fakeUsearch.loadShouldThrow = false;
    delete process.env['CARTOGRAPH_USEARCH_QUANT'];
  });

  it('scales query expansion between the documented min and max', () => {
    expect(efForIndexSize(1)).toBe(128);
    expect(efForIndexSize(16_384)).toBe(256);
    expect(efForIndexSize(100_000)).toBe(384);
  });

  it('reports availability when the optional usearch module exposes the expected API', async () => {
    expect(await isHnswAvailable()).toBe(true);
  });

  it('honors every supported quantization override and defaults unknown values to f16', async () => {
    const cases = [
      ['f32', 'f32'],
      ['f16', 'f16'],
      ['bf16', 'bf16'],
      ['b1', 'b1'],
      ['unsupported', 'f16'],
    ] as const;

    for (const [envValue, expected] of cases) {
      process.env['CARTOGRAPH_USEARCH_QUANT'] = envValue;
      const idx = await HnswIndex.create(1);
      await idx!.build([
        {
          rowid: fakeUsearch.instances.length + 1,
          node_id: `node:${envValue}`,
          embedding_model: 'm',
          embedding: vectorBuffer([1]),
        },
      ]);
      expect(fakeUsearch.instances.at(-1)!.args.quantization).toBe(expected);
    }
  });

  it('builds only rows matching the configured dimension and stores row metadata for filtered queries', async () => {
    process.env['CARTOGRAPH_USEARCH_QUANT'] = 'i8';
    const idx = await HnswIndex.create(2);
    expect(idx).not.toBeNull();

    const result = await idx!.build([
      { rowid: 1, node_id: 'node:a', embedding_model: 'model-a', embedding: vectorBuffer([1, 0]) },
      { rowid: 2, node_id: 'node:b', embedding_model: 'model-b', embedding: vectorBuffer([0, 1]) },
      { rowid: 3, node_id: 'node:c', embedding_model: 'model-a', embedding: vectorBuffer([0.5, 0.5]) },
      { rowid: 4, node_id: 'wrong-dim', embedding_model: 'model-a', embedding: vectorBuffer([1, 2, 3]) },
    ]);

    expect(result).toEqual({ built: true, rowCount: 3 });
    expect(idx!.isReady()).toBe(true);
    expect(idx!.size()).toBe(3);
    expect(idx!.getDim()).toBe(2);

    const native = fakeUsearch.instances[0]!;
    expect(native.args).toMatchObject({
      dimensions: 2,
      metric: 'ip',
      quantization: 'i8',
      connectivity: 16,
      expansion_add: 200,
      multi: false,
    });
    expect(native.addedThreads).toBe(0);
    expect([...native.addedKeys].map(String)).toEqual(['1', '2', '3']);
    expect([...native.addedVectors]).toEqual([1, 0, 0, 1, 0.5, 0.5]);

    const modelAHits = idx!.query(new Float32Array([1, 0]), 2, 'model-a');
    expect(modelAHits.map((h) => h.nodeId)).toEqual(['node:a', 'node:c']);
    expect(modelAHits[0]!.distance).toBeCloseTo(0.1);
    expect(modelAHits[1]!.distance).toBeCloseTo(0.3);
    expect(native.searchCalls[0]).toMatchObject({ k: 3, threads: 0, dim: 2 });

    const unfilteredHits = idx!.query(new Float32Array([1, 0]), 4);
    expect(unfilteredHits.map((h) => h.nodeId)).toEqual(['node:a', 'node:b', 'node:c']);
    expect(unfilteredHits.map((h) => h.distance)).toEqual([
      expect.closeTo(0.1),
      expect.closeTo(0.2),
      expect.closeTo(0.3),
    ]);
    expect(native.searchCalls.at(-1)).toMatchObject({ k: 3, threads: 0, dim: 2 });

    expect(idx!.query(new Float32Array([1, 0]), 2, 'missing-model')).toEqual([]);
    expect(idx!.query(new Float32Array([1, 0, 0]), 2)).toEqual([]);
  });

  it('packs sliced embedding buffers using their byte offset and byte length', async () => {
    const idx = await HnswIndex.create(2);

    await idx!.build([
      {
        rowid: 7,
        node_id: 'node:sliced',
        embedding_model: 'model-a',
        embedding: slicedVectorBuffer([99, 98], [1.25, -2.5], [97]),
      },
    ]);

    expect([...fakeUsearch.instances[0]!.addedKeys].map(String)).toEqual(['7']);
    expect([...fakeUsearch.instances[0]!.addedVectors]).toEqual([1.25, -2.5]);
  });

  it('returns a non-built result and clears readiness when no rows match the index dimension', async () => {
    const idx = await HnswIndex.create(4);
    const result = await idx!.build([
      { rowid: 1, node_id: 'node:a', embedding_model: 'm', embedding: vectorBuffer([1]) },
    ]);

    expect(result).toEqual({ built: false, rowCount: 0, reason: 'no embeddings at this dim' });
    expect(idx!.isReady()).toBe(false);
    expect(idx!.size()).toBe(0);
    expect(idx!.query(new Float32Array([1, 0, 0, 0]), 1)).toEqual([]);
    expect(() => idx!.persist('/tmp/hnsw.bin')).toThrow(/before build\/load/);
  });

  it('drops a previously built index when a rebuild has no rows at the configured dimension', async () => {
    const idx = await HnswIndex.create(2);
    await idx!.build([{ rowid: 1, node_id: 'node:a', embedding_model: 'm', embedding: vectorBuffer([1, 0]) }]);

    const result = await idx!.build([
      { rowid: 2, node_id: 'wrong-dim', embedding_model: 'm', embedding: vectorBuffer([1, 0, 0]) },
    ]);

    expect(result).toEqual({ built: false, rowCount: 0, reason: 'no embeddings at this dim' });
    expect(idx!.isReady()).toBe(false);
    expect(idx!.size()).toBe(0);
    expect(idx!.query(new Float32Array([1, 0]), 1)).toEqual([]);
  });

  it('loads graph data from disk and repopulates metadata from embedding store references', async () => {
    const idx = await HnswIndex.create(2);
    const ok = idx!.load(
      '/tmp/hnsw_2.bin',
      dbWithRows([
        { rowid: 1, node_id: 'node:a', embedding_model: 'model-a' },
        { rowid: 2, node_id: null, embedding_model: 'model-a' },
        { rowid: 3, node_id: 'node:c', embedding_model: 'model-c' },
      ]),
    );

    expect(ok).toBe(true);
    expect(idx!.isReady()).toBe(true);
    expect(idx!.size()).toBe(2);
    expect(fakeUsearch.instances[0]!.loadedPath).toBe('/tmp/hnsw_2.bin');
    const modelCHits = idx!.query(new Float32Array([1, 0]), 10, 'model-c');
    expect(modelCHits.map((h) => h.nodeId)).toEqual(['node:c']);
    expect(modelCHits[0]!.distance).toBeCloseTo(0.3);

    idx!.persist('/tmp/persisted.bin');
    expect(fakeUsearch.instances[0]!.savedPath).toBe('/tmp/persisted.bin');
  });

  it('fails closed when the persisted graph cannot be loaded or has no referenced symbol metadata', async () => {
    const loadFailure = await HnswIndex.create(2);
    fakeUsearch.loadShouldThrow = true;
    expect(loadFailure!.load('/tmp/missing.bin', dbWithRows([]))).toBe(false);
    expect(loadFailure!.isReady()).toBe(false);

    fakeUsearch.loadShouldThrow = false;
    const emptyMeta = await HnswIndex.create(2);
    expect(emptyMeta!.load('/tmp/hnsw.bin', dbWithRows([{ rowid: 1, node_id: null, embedding_model: 'm' }]))).toBe(
      false,
    );
    expect(emptyMeta!.isReady()).toBe(true);
    expect(emptyMeta!.size()).toBe(0);
    expect(emptyMeta!.query(new Float32Array([1, 0]), 1)).toEqual([]);
    expect(fakeUsearch.instances.at(-1)!.searchCalls).toHaveLength(0);
  });
});

describe('HNSW embedding rowset helpers', () => {
  it('computes all-dimension and dimension-scoped rowset signatures', () => {
    expect(computeRowsetSignature(dbWithRows([]))).toEqual({ rowCount: 5, maxRowid: 42 });
    expect(computeRowsetSignature(dbWithRows([]), 2)).toEqual({ rowCount: 2, maxRowid: 9 });
  });

  it('discovers only positive integer embedding dimensions from symbol-grain rows', () => {
    expect(
      discoverEmbeddingDims(dbWithRows([{ bytes: 8 }, { bytes: 12 }, { bytes: 0 }, { bytes: 10 }, { bytes: 16 }])),
    ).toEqual([2, 3, 4]);
  });

  it('passes the expected byte length into dimension-scoped rowset signatures', () => {
    const getCalls: unknown[] = [];
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          get(arg?: unknown) {
            getCalls.push(arg);
            return { c: 3, m: 99 };
          },
        };
      },
    } as unknown as SqliteDatabase;

    expect(computeRowsetSignature(db, 3)).toEqual({ rowCount: 3, maxRowid: 99 });
    expect(getCalls).toEqual([12]);
    expect(preparedSql[0]).toContain('LENGTH(embedding) = ?');
  });

  it('queries only symbol-grain embeddings when discovering dimensions', () => {
    const preparedSql: string[] = [];
    const db = {
      prepare(sql: string) {
        preparedSql.push(sql);
        return {
          all() {
            return [{ bytes: 4 }, { bytes: 6 }, { bytes: 20 }];
          },
        };
      },
    } as unknown as SqliteDatabase;

    expect(discoverEmbeddingDims(db)).toEqual([1, 5]);
    expect(preparedSql[0]).toContain("grain = 'symbol'");
  });
});
