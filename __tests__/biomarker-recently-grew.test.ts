/**
 * recently_grew biomarker — Section A #5
 *
 * Engine-level rule tests. Persistence + integration via
 * analyseProject is exercised by the existing biomarker test suite
 * after this rule is wired in (snapshot rows accumulate; rule fires
 * on the second pass when the symbol grew).
 */
import { describe, it, expect } from 'vitest';
import { evaluateRules } from '../src/biomarkers/engine.js';

const MIN = 21; // > RECENT_MIN_PRIOR_LOC (20)
const NOW = 1_700_000_000_000;
const DAY = 24 * 60 * 60 * 1000;

function ctx(loc, prior, deltaDays) {
  return {
    nodeId: 'n1',
    language: 'typescript',
    nowMs: NOW,
    prior: prior == null ? undefined : { loc: prior, ts: NOW - deltaDays * DAY },
    metrics: {
      loc,
      cyclomatic: 1,
      maxNesting: 0,
      maxConditionalOperands: 0,
      paramCount: 0,
      magicNumberCount: 0,
      hardcodedUrlCount: 0,
    },
  };
}

describe('recently_grew biomarker', () => {
  it('does not fire on first encounter (no prior snapshot)', () => {
    const findings = evaluateRules(ctx(120, null, 0));
    expect(findings.find((f) => f.biomarker === 'recently_grew')).toBeUndefined();
  });

  it('does not fire when prior LoC is below RECENT_MIN_PRIOR_LOC', () => {
    // 5 → 12 LoC is doubling but tiny — no signal
    const findings = evaluateRules(ctx(12, 5, 7));
    expect(findings.find((f) => f.biomarker === 'recently_grew')).toBeUndefined();
  });

  it('does not fire when growth ratio is at-or-below 1.5x', () => {
    const findings = evaluateRules(ctx(45, MIN + 9, 7)); // 30 → 45 = 1.5x exactly
    expect(findings.find((f) => f.biomarker === 'recently_grew')).toBeUndefined();
  });

  it('does not fire when prior snapshot is older than the 30-day window', () => {
    const findings = evaluateRules(ctx(80, MIN, 31)); // 21 → 80 = ~3.8x but stale
    expect(findings.find((f) => f.biomarker === 'recently_grew')).toBeUndefined();
  });

  it('fires at info severity for growth in (1.5x, 2.0x)', () => {
    const findings = evaluateRules(ctx(40, MIN, 5)); // 21 → 40 ≈ 1.9x
    const f = findings.find((x) => x.biomarker === 'recently_grew');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
    expect(f?.metric).toBe(Math.round((40 / MIN) * 100));
  });

  it('fires at warning severity for growth in [2.0x, 3.0x)', () => {
    const findings = evaluateRules(ctx(45, MIN, 5)); // 21 → 45 ≈ 2.14x
    const f = findings.find((x) => x.biomarker === 'recently_grew');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('warning');
  });

  it('fires at error severity for growth at-or-above 3.0x', () => {
    const findings = evaluateRules(ctx(70, MIN, 5)); // 21 → 70 ≈ 3.33x
    const f = findings.find((x) => x.biomarker === 'recently_grew');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('error');
  });

  it('fires inside the 30-day window even when growth is just over threshold', () => {
    const findings = evaluateRules(ctx(35, MIN, 29)); // 21 → 35 ≈ 1.67x at day 29
    const f = findings.find((x) => x.biomarker === 'recently_grew');
    expect(f).toBeDefined();
    expect(f?.severity).toBe('info');
  });

  it('attaches detail block with priorLoc, currentLoc, ratio', () => {
    const findings = evaluateRules(ctx(60, MIN, 5));
    const f = findings.find((x) => x.biomarker === 'recently_grew');
    expect(f?.detail).toMatchObject({ priorLoc: MIN, currentLoc: 60 });
  });
});
