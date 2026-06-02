import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  replies: [] as Array<{ ok: true; results: unknown[] } | { ok: false; error: string }>,
  workerCalls: [] as Array<{ workerData: unknown; timeoutMs: number; sliceLabel: string }>,
  logs: [] as string[],
};

vi.mock('../src/utils/worker-slice.js', () => ({
  runWorkerSlice: vi.fn(async (args: { workerData: unknown; timeoutMs: number; sliceLabel: string }) => {
    state.workerCalls.push(args);
    const reply = state.replies.shift();
    if (!reply) return { ok: true, results: [] };
    return reply;
  }),
}));

vi.mock('../src/errors.js', () => ({
  logDebug: vi.fn((message: string) => state.logs.push(message)),
}));

const { PER_FILE_WORKER_THRESHOLD, runPerFileBiomarkersInWorkers, shouldUsePerFileWorkers } = await import(
  '../src/biomarkers/per-file-pool.js'
);

const ORIGINAL_WORKERS = process.env['CARTOGRAPH_BIOMARKER_PERFILE_WORKERS'];

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
    state.replies = [
      { ok: true, results: [{ relPath: 'src/a.ts', outcome: 'computed' }] },
      { ok: false, error: 'worker timeout' },
      { ok: true, results: [{ relPath: 'src/c.ts', outcome: 'unsupported-language' }] },
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

    expect(results).toEqual([
      { relPath: 'src/a.ts', outcome: 'computed' },
      { relPath: 'src/c.ts', outcome: 'unsupported-language' },
    ]);
    expect(state.workerCalls).toHaveLength(3);
    expect(state.workerCalls.map((call) => call.timeoutMs)).toEqual([77, 77, 77]);
    expect(state.workerCalls.map((call) => call.sliceLabel)).toEqual(['#0/3', '#1/3', '#2/3']);
    expect(state.workerCalls.map((call) => (call.workerData as { batch: Array<{ relPath: string }> }).batch.map((f) => f.relPath))).toEqual([
      ['src/a.ts', 'src/d.ts'],
      ['src/b.ts'],
      ['src/c.ts'],
    ]);
    expect(state.logs).toEqual(['biomarkers per-file worker failed: worker timeout']);
  });
});
