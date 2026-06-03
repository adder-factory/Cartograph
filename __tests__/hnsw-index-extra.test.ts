import { spawnSync } from 'node:child_process';
import { describe, expect, it } from 'bun:test';

function runBunProbe(source: string): void {
  const result = spawnSync(process.execPath, ['-e', source], {
    cwd: process.cwd(),
    encoding: 'utf8',
    env: {
      ...process.env,
      CARTOGRAPH_USEARCH_QUANT: '',
    },
  });
  if (result.status !== 0) {
    throw new Error(`probe failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`);
  }
}

describe('HnswIndex usearch module loading shapes', () => {
  it('creates an index when usearch exposes its API under default', () => {
    runBunProbe(`
      import { mock } from 'bun:test';

      const fake = {
        instances: [],
        Index: class DefaultExportFakeIndex {
          constructor(args) {
            this.args = args;
            this.addedKeys = new BigUint64Array();
            this.addedVectors = new Float32Array();
            this.searchCalls = [];
            fake.instances.push(this);
          }
          add(keys, vectors, threads) {
            this.addedKeys = keys;
            this.addedVectors = vectors;
            this.addedThreads = threads;
          }
          search(vec, k, threads) {
            this.searchCalls.push({ k, threads, dim: vec.length });
            return { keys: BigUint64Array.from([10n]), distances: new Float32Array([0.125]) };
          }
          save() {}
          load() {}
          view() {}
          size() { return this.addedKeys.length; }
          dimensions() { return this.args.dimensions; }
        },
        MetricKind: { IP: 'ip', Cos: 'cos', L2sq: 'l2sq' },
        ScalarKind: { F32: 'f32', F16: 'f16', BF16: 'bf16', I8: 'i8', B1: 'b1' },
      };
      const fail = (message) => {
        console.error(message);
        process.exit(1);
      };
      const vectorBuffer = (values) => Buffer.from(new Float32Array(values).buffer);

      mock.module('usearch', () => ({ default: fake }));
      const { HnswIndex, isHnswAvailable } = await import('./src/embeddings/hnsw-index.js?default-export-probe');

      if (!(await isHnswAvailable())) fail('usearch default export shape was not available');
      const idx = await HnswIndex.create(2);
      if (idx === null) fail('HnswIndex.create returned null for default export shape');
      const result = await idx.build([
        { rowid: 10, node_id: 'node:default-export', embedding_model: 'model-a', embedding: vectorBuffer([0, 1]) },
      ]);
      if (!result.built || result.rowCount !== 1) fail('default export build did not index the row');

      const native = fake.instances[0];
      if (native.args.quantization !== 'f16') fail('default quantization was not f16');
      if (native.addedThreads !== 0) fail('build did not request auto-threaded add');
      if (String(native.addedKeys[0]) !== '10') fail('rowid key was not passed as BigUint64');
      if (native.addedVectors[0] !== 0 || native.addedVectors[1] !== 1) fail('vector was not packed');

      const hits = idx.query(new Float32Array([0, 1]), 1);
      if (hits.length !== 1 || hits[0].nodeId !== 'node:default-export' || hits[0].distance !== 0.125) {
        fail('query did not return the default-export row');
      }
      if (native.searchCalls.length !== 1 || native.searchCalls[0].k !== 1 || native.searchCalls[0].threads !== 0) {
        fail('query did not call usearch search with expected arguments');
      }
    `);
  });

  it('treats malformed usearch modules as unavailable', () => {
    runBunProbe(`
      import { mock } from 'bun:test';

      mock.module('usearch', () => ({ default: {} }));
      const { HnswIndex, isHnswAvailable } = await import('./src/embeddings/hnsw-index.js?malformed-probe');

      if (await isHnswAvailable()) {
        console.error('malformed usearch module reported available');
        process.exit(1);
      }
      if ((await HnswIndex.create(2)) !== null) {
        console.error('HnswIndex.create returned an index for malformed usearch module');
        process.exit(1);
      }
    `);
  });
});
