import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as errorModule from '../src/errors.js';
import * as workerSlice from '../src/utils/worker-slice.js';

const state = {
  replies: [] as unknown[],
  workerCalls: [] as Array<{ workerData: unknown; timeoutMs: number; sliceLabel: string }>,
  logs: [] as string[],
};

vi.spyOn(workerSlice, 'runWorkerSlice').mockImplementation((async (args: {
  workerData: unknown;
  timeoutMs: number;
  sliceLabel: string;
}) => {
  state.workerCalls.push(args);
  const reply = state.replies.shift();
  if (!reply) return { ok: true, results: [], durationMs: 0 };
  return reply;
}) as never);

vi.spyOn(errorModule, 'logDebug').mockImplementation(((message: string) => state.logs.push(message)) as never);

const { PER_FILE_WORKER_THRESHOLD, runPerFileBiomarkersInWorkers, shouldUsePerFileWorkers } = await import(
  '../src/biomarkers/per-file-pool.js'
);

const ORIGINAL_WORKERS = process.env['CARTOGRAPH_BIOMARKER_PERFILE_WORKERS'];
const STATS_DELTA = {
  symbolsAnalysed: 0,
  findingsEmitted: 0,
  unsupportedLanguages: 0,
  errors: 0,
  skippedRangeMismatch: 0,
};

function perFileResult(relPath: string, outcome: 'computed' | 'unsupported-language') {
  return {
    relPath,
    currentHash: null,
    outcome,
    statsDelta: STATS_DELTA,
  };
}

function setWorkers(value: string | undefined): void {
  if (value === undefined) delete process.env['CARTOGRAPH_BIOMARKER_PERFILE_WORKERS'];
  else process.env['CARTOGRAPH_BIOMARKER_PERFILE_WORKERS'] = value;
}

beforeEach(() => {
  state.replies = [];
  state.workerCalls = [];
  state.logs = [];
  setWorkers(undefined);
  vi.clearAllMocks();
});

afterAll(() => {
  setWorkers(ORIGINAL_WORKERS);
  vi.restoreAllMocks();
});

describe('biomarker per-file worker pool', () => {
  it('routes to workers only above the file-count threshold and when worker count is non-zero', () => {
    setWorkers('2');
    expect(shouldUsePerFileWorkers(PER_FILE_WORKER_THRESHOLD - 1)).toBe(false);
    expect(shouldUsePerFileWorkers(PER_FILE_WORKER_THRESHOLD)).toBe(true);

    setWorkers('0');
    expect(shouldUsePerFileWorkers(PER_FILE_WORKER_THRESHOLD)).toBe(false);

    setWorkers('not-a-number');
    expect(shouldUsePerFileWorkers(PER_FILE_WORKER_THRESHOLD)).toBe(true);
  });

  it('returns no results for empty inputs or zero configured workers', async () => {
    setWorkers('2');
    await expect(
      runPerFileBiomarkersInWorkers({ dbPath: '/db', projectRoot: '/repo', files: [], nowMs: 1 }),
    ).resolves.toEqual([]);

    setWorkers('0');
    await expect(
      runPerFileBiomarkersInWorkers({
        dbPath: '/db',
        projectRoot: '/repo',
        files: [{ relPath: 'src/a.ts', currentHash: 'a' }],
        nowMs: 1,
      }),
    ).resolves.toEqual([]);
    expect(state.workerCalls).toEqual([]);
  });

  it('partitions files round-robin, aggregates successful replies, and logs failed workers', async () => {
    setWorkers('3');
    const computed = perFileResult('src/a.ts', 'computed');
    const unsupported = perFileResult('src/c.ts', 'unsupported-language');
    state.replies = [
      { ok: true, results: [computed], durationMs: 1 },
      { ok: false, error: 'worker timeout' },
      { ok: true, results: [unsupported], durationMs: 1 },
    ];

    const results = await runPerFileBiomarkersInWorkers({
      dbPath: '/db',
      projectRoot: '/repo',
      nowMs: 123,
      perWorkerTimeoutMs: 77,
      files: [
        { relPath: 'src/a.ts', currentHash: 'a' },
        { relPath: 'src/b.ts', currentHash: null },
        { relPath: 'src/c.ts', currentHash: 'c' },
        { relPath: 'src/d.ts', currentHash: 'd' },
      ],
    });

    expect(results).toEqual([computed, unsupported]);
    expect(state.workerCalls).toHaveLength(3);
    expect(state.workerCalls.map((call) => call.timeoutMs)).toEqual([77, 77, 77]);
    expect(state.workerCalls.map((call) => call.sliceLabel)).toEqual(['#0/3', '#1/3', '#2/3']);
    expect(
      state.workerCalls.map((call) =>
        (call.workerData as { batch: Array<{ relPath: string }> }).batch.map((f) => f.relPath),
      ),
    ).toEqual([['src/a.ts', 'src/d.ts'], ['src/b.ts'], ['src/c.ts']]);
    expect(state.logs).toEqual(['biomarkers per-file worker failed: worker timeout']);
  });

  it('logs malformed worker replies and skips their results', async () => {
    setWorkers('1');
    state.replies = [{ ok: true, results: [{ relPath: 'src/a.ts', outcome: 'computed' }], durationMs: 1 }];

    const results = await runPerFileBiomarkersInWorkers({
      dbPath: '/db',
      projectRoot: '/repo',
      nowMs: 123,
      files: [{ relPath: 'src/a.ts', currentHash: null }],
    });

    expect(results).toEqual([]);
    expect(state.logs).toHaveLength(1);
    expect(state.logs[0]).toContain('invalid biomarker per-file worker reply');
  });
});
