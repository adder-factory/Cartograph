import { describe, expect, it } from 'vitest';
import {
  CHAIN_RESOLUTION_CASES,
  renderChainResolutionCoverage,
  validateChainResolutionCoverage,
} from '../scripts/chain-resolution-coverage.js';

describe('chain resolution coverage report', () => {
  it('documents covered chain patterns and known gaps', () => {
    const covered = CHAIN_RESOLUTION_CASES.filter((row) => row.status === 'covered');
    const gaps = CHAIN_RESOLUTION_CASES.filter((row) => row.status === 'gap');

    expect(covered.length).toBeGreaterThanOrEqual(6);
    expect(gaps.map((row) => row.pattern)).toContain('multi-hop builders: a().b().c()');
    expect(validateChainResolutionCoverage(process.cwd())).toEqual([]);
  });

  it('renders a markdown coverage table', () => {
    const report = renderChainResolutionCoverage();
    expect(report).toContain('# Chain Resolution Coverage');
    expect(report).toContain('typescript');
    expect(report).toContain('__tests__/resolution.test.ts');
    expect(report).toContain('singleton conventions');
  });
});
