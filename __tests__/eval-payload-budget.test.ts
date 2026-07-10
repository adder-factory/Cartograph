/**
 * Eval payload-budget gate (B5). Locks in the per-case + mean
 * thresholds in `compare.ts` so a future change can't silently
 * widen them. The runtime-comparison tests are integration-style
 * (eval-against-baseline); here we drive `compareReports` directly
 * with synthetic reports.
 */
import { describe, it, expect } from 'vitest';
import { compareReports } from './evaluation/compare.js';
import { scoreSemanticSearch } from './evaluation/scoring.js';
import type { EvalReport, EvalResult } from './evaluation/types.js';
import { semanticEvalSkipDetail } from './evaluation/semantic-skip.js';
import { LlmEndpointError } from '../src/llm/client.js';

function makeReport(results: Partial<EvalResult>[]): EvalReport {
  const filled: EvalResult[] = results.map((r, i) => ({
    caseId: r.caseId ?? `case-${i}`,
    pass: r.pass ?? true,
    recall: r.recall ?? 1,
    mrr: r.mrr ?? 1,
    foundSymbols: r.foundSymbols ?? [],
    missedSymbols: r.missedSymbols ?? [],
    latencyMs: r.latencyMs ?? 1,
    ...(r.payloadBytes === undefined ? {} : { payloadBytes: r.payloadBytes }),
    ...(r.skipped === undefined ? {} : { skipped: r.skipped }),
    ...(r.skipDetail === undefined ? {} : { skipDetail: r.skipDetail }),
  }));
  const total = filled.length;
  const passed = filled.filter((r) => r.pass).length;
  return {
    timestamp: '2026-05-03T00:00:00Z',
    codebasePath: '/test',
    cartographSha: 'test',
    summary: {
      total,
      passed,
      failed: total - passed,
      meanRecall: total > 0 ? filled.reduce((s, r) => s + r.recall, 0) / total : 0,
      meanMRR: total > 0 ? filled.reduce((s, r) => s + r.mrr, 0) / total : 0,
    },
    results: filled,
  };
}

describe('B5 — payload regression budget', () => {
  it('+0% candidate matches baseline → withinBudget=true, payloadDelta=0', () => {
    const baseline = makeReport([{ caseId: 'a', payloadBytes: 1000 }]);
    const candidate = makeReport([{ caseId: 'a', payloadBytes: 1000 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.withinBudget).toBe(true);
    expect(cmp.meanPayloadDelta).toBe(0);
    expect(cmp.perCase[0]!.payloadDelta).toBe(0);
  });

  it('+24% per-case below 25% threshold → no per-case regression', () => {
    const baseline = makeReport([{ caseId: 'a', payloadBytes: 1000 }]);
    const candidate = makeReport([{ caseId: 'a', payloadBytes: 1240 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(0);
  });

  it('+30% per-case trips the per-case payload threshold', () => {
    const baseline = makeReport([{ caseId: 'a', payloadBytes: 1000 }]);
    const candidate = makeReport([{ caseId: 'a', payloadBytes: 1300 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(1);
    expect(cmp.regressions[0]!.reason).toMatch(/payload grew \+30%/);
    expect(cmp.withinBudget).toBe(false);
  });

  it('payload check skipped when baseline < 200 bytes (noise floor)', () => {
    // Even a +500% bump on a 100-byte payload should not flag, since
    // tiny payloads swing wildly without agent impact.
    const baseline = makeReport([{ caseId: 'a', payloadBytes: 100 }]);
    const candidate = makeReport([{ caseId: 'a', payloadBytes: 600 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(0);
  });

  it('+11% mean across the suite trips the mean-payload budget', () => {
    // Every case below the per-case 25% threshold, but the mean drift
    // catches the cumulative cost the agent pays per session.
    const baseline = makeReport([
      { caseId: 'a', payloadBytes: 1000 },
      { caseId: 'b', payloadBytes: 1000 },
      { caseId: 'c', payloadBytes: 1000 },
    ]);
    const candidate = makeReport([
      { caseId: 'a', payloadBytes: 1110 },
      { caseId: 'b', payloadBytes: 1110 },
      { caseId: 'c', payloadBytes: 1110 },
    ]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(0); // each case +11%, below 25%
    expect(cmp.meanPayloadDelta).toBeCloseTo(0.11, 2);
    expect(cmp.withinBudget).toBe(false); // mean trips the 10% threshold
  });

  it('legacy report without payloadBytes leaves payloadDelta=0 and skips the check', () => {
    // Ensures B5 doesn't break comparisons against pre-B5 baselines.
    const baseline = makeReport([{ caseId: 'a' }]); // no payloadBytes
    const candidate = makeReport([{ caseId: 'a', payloadBytes: 50000 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(0);
    expect(cmp.perCase[0]!.payloadDelta).toBe(0);
  });

  it('payload regression does NOT mask a separate recall regression', () => {
    // Recall drop should still be the headline reason even when
    // payload also exploded — recall is the more actionable signal.
    const baseline = makeReport([{ caseId: 'a', recall: 1, payloadBytes: 1000 }]);
    const candidate = makeReport([{ caseId: 'a', recall: 0.5, payloadBytes: 5000 }]);
    const cmp = compareReports(baseline, candidate);
    expect(cmp.regressions).toHaveLength(1);
    expect(cmp.regressions[0]!.reason).toMatch(/recall dropped/);
    expect(cmp.regressions[0]!.reason).not.toMatch(/payload/);
  });

  it('does not compare an environmental skip as a semantic regression', () => {
    const baseline = makeReport([{ caseId: 'semantic', recall: 1, mrr: 1, payloadBytes: 1000 }]);
    const candidate = makeReport([
      { caseId: 'semantic', recall: 0, mrr: 0, payloadBytes: 0, skipped: 'endpoint-unavailable' },
    ]);

    const cmp = compareReports(baseline, candidate);

    expect(cmp.withinBudget).toBe(true);
    expect(cmp.perCase[0]?.recallDelta).toBe(0);
    expect(cmp.meanRecallDelta).toBe(0);
  });
});

describe('B9 — semantic search SKIP semantics', () => {
  it('skips only transient endpoint failures', () => {
    expect(semanticEvalSkipDetail(new LlmEndpointError('embedding endpoint returned 503', 503))).toBe(
      'embedding endpoint returned 503',
    );
    expect(semanticEvalSkipDetail(new LlmEndpointError('embedding response contained a malformed vector'))).toBeNull();
    expect(semanticEvalSkipDetail(new Error('scoring bug'))).toBeNull();
  });

  it("'no-embeddings' skip → pass=true, recall=0, skipped marker set", () => {
    const r = scoreSemanticSearch('test', ['Foo', 'Bar'], [], 1, 'no-embeddings');
    expect(r.pass).toBe(true);
    expect(r.recall).toBe(0);
    expect(r.skipped).toBe('no-embeddings');
    expect(r.missedSymbols).toEqual(['Foo', 'Bar']);
  });

  it("'no-source-embedding' skip behaves the same way", () => {
    const r = scoreSemanticSearch('test', ['Foo'], [], 1, 'no-source-embedding');
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('no-source-embedding');
  });

  it("'endpoint-unavailable' skip preserves the exact backend failure", () => {
    const r = scoreSemanticSearch('test', ['Foo'], [], 1, 'endpoint-unavailable', 'embedding endpoint returned 503');
    expect(r.pass).toBe(true);
    expect(r.skipped).toBe('endpoint-unavailable');
    expect(r.skipDetail).toBe('embedding endpoint returned 503');
  });

  it('non-skipped semantic case scores like a regular search (recall + mrr)', () => {
    // When embeddings ARE available and the call returns hits, the
    // scorer treats the result identically to scoreSearchNodes.
    const r = scoreSemanticSearch(
      'test',
      ['Foo', 'Bar'],
      [
        { node: { name: 'Foo' }, score: 0.95 },
        { node: { name: 'Other' }, score: 0.8 },
        { node: { name: 'Bar' }, score: 0.7 },
      ],
      1,
    );
    expect(r.pass).toBe(true);
    expect(r.recall).toBe(1);
    expect(r.mrr).toBe(1); // Foo at rank 1
    expect(r.skipped).toBeUndefined();
  });
});
