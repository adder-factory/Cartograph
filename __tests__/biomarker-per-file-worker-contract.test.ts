import { describe, expect, it } from 'vitest';
import { parsePerFileWorkerInit, parsePerFileWorkerReply } from '../src/biomarkers/per-file-worker-contract.js';

const statsDelta = {
  symbolsAnalysed: 1,
  findingsEmitted: 1,
  unsupportedLanguages: 0,
  errors: 0,
  skippedRangeMismatch: 0,
};

describe('biomarker per-file worker IPC contract', () => {
  it('parses the worker init payload at the thread boundary', () => {
    const parsed = parsePerFileWorkerInit({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      batch: [{ relPath: 'src/a.ts', currentHash: null }],
      nowMs: 123,
    });

    expect(parsed).toEqual({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      batch: [{ relPath: 'src/a.ts', currentHash: null }],
      nowMs: 123,
    });
  });

  it('rejects malformed worker init batches with a pathful error', () => {
    expect(() =>
      parsePerFileWorkerInit({
        dbPath: '/tmp/cartograph.db',
        projectRoot: '/repo',
        batch: [{ relPath: 'src/a.ts' }],
        nowMs: 123,
      }),
    ).toThrow(/invalid biomarker per-file worker init: batch\.0\.currentHash:/);
  });

  it('parses computed replies with structured-cloned Maps', () => {
    const parsed = parsePerFileWorkerReply({
      ok: true,
      results: [
        {
          relPath: 'src/a.ts',
          currentHash: 'sha',
          outcome: 'computed',
          metricsByNode: new Map([
            [
              'n1',
              {
                loc: 101,
                cyclomatic: 12,
                maxNesting: 3,
                maxConditionalOperands: 2,
                paramCount: 1,
                magicNumberCount: 0,
                hardcodedUrlCount: 0,
              },
            ],
          ]),
          locByNode: new Map([['n1', 101]]),
          findingsByNode: new Map([
            ['n1', [{ nodeId: 'n1', biomarker: 'large_method', severity: 'warning', metric: 101 }]],
          ]),
          statsDelta,
        },
      ],
      durationMs: 1,
    });

    expect(parsed).toMatchObject({ ok: true, durationMs: 1 });
    expect(parsed.ok && parsed.results[0]?.findingsByNode?.get('n1')?.[0]?.biomarker).toBe('large_method');
  });

  it('rejects malformed successful replies before the pool aggregates them', () => {
    expect(() =>
      parsePerFileWorkerReply({
        ok: true,
        results: [{ relPath: 'src/a.ts', currentHash: 'sha', outcome: 'computed' }],
        durationMs: 1,
      }),
    ).toThrow(/invalid biomarker per-file worker reply: results\.0\.statsDelta:/);
  });
});
