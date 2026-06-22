import { EventEmitter } from 'node:events';
import { describe, it, expect, beforeEach } from 'vitest';
import { ParseWorkerPool } from '../src/extraction/parse-worker-pool.js';
import type { ExtractionResult } from '../src/types.js';

function extractionResult(filePath = 'src/a.ts'): ExtractionResult {
  return {
    filePath,
    language: 'typescript',
    nodes: [],
    edges: [],
    unresolvedReferences: [],
    errors: [],
    durationMs: 1,
  };
}

type WorkerMessage = {
  type: string;
  id?: number;
  filePath?: string;
  content?: string;
  languages?: string[];
};

class FakeWorker extends EventEmitter {
  static instances: FakeWorker[] = [];
  static autoParse = true;
  static grammarMode: 'success' | 'failure' | 'silent' = 'success';
  readonly messages: WorkerMessage[] = [];
  terminated = false;

  constructor(readonly workerPath: string) {
    super();
    FakeWorker.instances.push(this);
  }

  postMessage(msg: WorkerMessage): void {
    this.messages.push(msg);
    if (msg.type === 'load-grammars') {
      if (FakeWorker.grammarMode === 'success') {
        queueMicrotask(() => this.emit('message', { type: 'grammars-loaded' }));
      } else if (FakeWorker.grammarMode === 'failure') {
        queueMicrotask(() => this.emit('message', { type: 'grammars-load-failed', error: 'bad wasm' }));
      }
      return;
    }
    if (msg.type === 'parse' && FakeWorker.autoParse) {
      queueMicrotask(() => {
        this.emit('message', {
          type: 'parse-result',
          id: msg.id,
          result: extractionResult(msg.filePath),
        });
      });
    }
  }

  async terminate(): Promise<number> {
    this.terminated = true;
    queueMicrotask(() => this.emit('exit', 0));
    return 0;
  }
}

function makePool(
  opts: {
    poolSize?: number;
    recycleInterval?: number;
    logWarns?: Array<Record<string, unknown>>;
    grammarLoadTimeoutMs?: number;
  } = {},
) {
  const logs: string[] = [];
  const warnings = opts.logWarns ?? [];
  const pool = new ParseWorkerPool({
    WorkerClass: FakeWorker as never,
    parseWorkerPath: '/fake/parse-worker.js',
    poolSize: opts.poolSize ?? 1,
    neededLanguages: ['typescript'],
    recycleInterval: opts.recycleInterval ?? 100,
    grammarLoadTimeoutMs: opts.grammarLoadTimeoutMs,
    log: (msg) => logs.push(msg),
    logWarn: (msg, ctx) => warnings.push({ msg, ...(ctx ?? {}) }),
  });
  return { pool, logs, warnings };
}

describe('ParseWorkerPool', () => {
  beforeEach(() => {
    FakeWorker.instances = [];
    FakeWorker.autoParse = true;
    FakeWorker.grammarMode = 'success';
  });

  it('spawns lazily, loads grammars, and resolves parse results', async () => {
    const { pool, logs } = makePool();

    const result = await pool.requestParse('src/a.ts', 'export const a = 1;');

    expect(result.filePath).toBe('src/a.ts');
    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.workerPath).toBe('/fake/parse-worker.js');
    expect(FakeWorker.instances[0]!.messages[0]).toEqual({ type: 'load-grammars', languages: ['typescript'] });
    expect(FakeWorker.instances[0]!.messages[1]?.type).toBe('parse');
    expect(logs[0]).toContain('Spawning parse worker 0');
  });

  it('parks requests when the only worker is busy and resumes them when it becomes idle', async () => {
    FakeWorker.autoParse = false;
    const { pool } = makePool({ poolSize: 1 });

    const first = pool.requestParse('src/first.ts', 'first');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = FakeWorker.instances[0]!;
    const firstParse = worker.messages.find((msg) => msg.type === 'parse')!;

    let secondDone = false;
    const second = pool.requestParse('src/second.ts', 'second').then((result) => {
      secondDone = true;
      return result;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(worker.messages.filter((msg) => msg.type === 'parse')).toHaveLength(1);

    worker.emit('message', { type: 'parse-result', id: firstParse.id, result: extractionResult('src/first.ts') });
    await first;
    await new Promise((resolve) => setTimeout(resolve, 0));
    const secondParse = worker.messages.filter((msg) => msg.type === 'parse')[1]!;
    expect(secondParse.filePath).toBe('src/second.ts');
    expect(secondDone).toBe(false);

    worker.emit('message', { type: 'parse-result', id: secondParse.id, result: extractionResult('src/second.ts') });
    expect((await second).filePath).toBe('src/second.ts');
    expect(secondDone).toBe(true);
  });

  it('recycles an idle worker after the configured parse interval', async () => {
    const { pool, logs } = makePool({ recycleInterval: 1 });

    await pool.requestParse('src/one.ts', 'one');
    await pool.requestParse('src/two.ts', 'two');

    expect(FakeWorker.instances).toHaveLength(2);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(logs.some((line) => line.includes('Recycling worker 0 after 1 parses'))).toBe(true);
  });

  it('rejects pending parses on worker error', async () => {
    FakeWorker.autoParse = false;
    const { pool, warnings } = makePool();

    const errored = pool.requestParse('src/error.ts', 'error');
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWorker.instances[0]!.emit('error', new Error('parser crashed'));
    await expect(errored).rejects.toThrow(/Worker error: parser crashed/);
    expect(warnings.some((warning) => String(warning.msg).includes('Parse worker error'))).toBe(true);
  });

  it('rejects pending parses when a worker posts a malformed parse result', async () => {
    FakeWorker.autoParse = false;
    const { pool, warnings } = makePool();

    const malformed = pool.requestParse('src/malformed.ts', 'malformed');
    await new Promise((resolve) => setTimeout(resolve, 0));
    const worker = FakeWorker.instances[0]!;
    const parseMessage = worker.messages.find((msg) => msg.type === 'parse')!;

    worker.emit('message', {
      type: 'parse-result',
      id: parseMessage.id,
      result: { nodes: [], edges: [], errors: [] },
    });

    await expect(malformed).rejects.toThrow(/invalid parse worker reply: result:/);
    expect(warnings.some((warning) => String(warning.msg).includes('malformed message'))).toBe(true);
  });

  it('rejects and terminates a worker that reports grammar-load failure', async () => {
    FakeWorker.grammarMode = 'failure';
    const { pool, warnings } = makePool();

    await expect(pool.requestParse('src/failure.ts', 'failure')).rejects.toThrow(/bad wasm/);

    expect(FakeWorker.instances).toHaveLength(1);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);
    expect(warnings.some((warning) => String(warning.msg).includes('failed to load grammars'))).toBe(true);
  });

  it('times out a silent grammar-load handshake and keeps the slot reusable', async () => {
    FakeWorker.grammarMode = 'silent';
    const { pool } = makePool({ grammarLoadTimeoutMs: 1 });

    await expect(pool.requestParse('src/hang.ts', 'hang')).rejects.toThrow(/Timed out loading grammars/);
    expect(FakeWorker.instances[0]!.terminated).toBe(true);

    FakeWorker.grammarMode = 'success';
    const result = await pool.requestParse('src/retry.ts', 'retry');

    expect(result.filePath).toBe('src/retry.ts');
    expect(FakeWorker.instances).toHaveLength(2);
  });

  it('rejects pending parses on unexpected worker exit', async () => {
    FakeWorker.autoParse = false;
    const { pool, warnings } = makePool();

    const exited = pool.requestParse('src/exit.ts', 'exit');
    await new Promise((resolve) => setTimeout(resolve, 0));
    FakeWorker.instances[0]!.emit('exit', 7);
    await expect(exited).rejects.toThrow(/Worker exited with code 7/);
    expect(warnings.some((warning) => String(warning.msg).includes('Parse worker exited unexpectedly'))).toBe(true);
  });

  it('terminate rejects in-flight parses and shuts down every worker without unexpected-exit warnings', async () => {
    FakeWorker.autoParse = false;
    const { pool, warnings } = makePool({ poolSize: 2 });

    const pending = pool.requestParse('src/pending.ts', 'pending');
    await new Promise((resolve) => setTimeout(resolve, 0));
    await pool.terminate('index stopped');

    await expect(pending).rejects.toThrow(/index stopped/);
    expect(FakeWorker.instances.every((worker) => worker.terminated)).toBe(true);
    expect(warnings.some((warning) => String(warning.msg).includes('exited unexpectedly'))).toBe(false);
  });
});
