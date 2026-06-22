import { describe, expect, it } from 'vitest';
import { parseBiomarkerWorkerInit, parseBiomarkerWorkerReply } from '../src/biomarkers/biomarker-worker-contract.js';

describe('biomarker worker IPC contract', () => {
  it('parses the worker init payload at the thread boundary', () => {
    const parsed = parseBiomarkerWorkerInit({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      ruleKind: 'duplicate_code',
    });

    expect(parsed).toEqual({
      dbPath: '/tmp/cartograph.db',
      projectRoot: '/repo',
      ruleKind: 'duplicate_code',
    });
  });

  it('rejects unknown cross-file rules before the worker runs', () => {
    expect(() =>
      parseBiomarkerWorkerInit({
        dbPath: '/tmp/cartograph.db',
        projectRoot: '/repo',
        ruleKind: 'not_a_rule',
      }),
    ).toThrow(/invalid biomarker worker init: ruleKind:/);
  });

  it('rejects malformed successful replies before the pool aggregates them', () => {
    expect(() => parseBiomarkerWorkerReply({ ok: true, ruleKind: 'duplicate_code', durationMs: 1 })).toThrow(
      /invalid biomarker worker reply: findings:/,
    );
  });

  it('rejects findings with unknown biomarker names', () => {
    expect(() =>
      parseBiomarkerWorkerReply({
        ok: true,
        ruleKind: 'duplicate_code',
        findings: [{ nodeId: 'n1', biomarker: 'not_a_biomarker', severity: 'warning', metric: 1 }],
        durationMs: 1,
      }),
    ).toThrow(/invalid biomarker worker reply: findings\.0\.biomarker:/);
  });
});
