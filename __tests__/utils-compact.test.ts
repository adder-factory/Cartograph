/**
 * Unit tests for the `compact()` helper added during the strict-flag
 * tightening pass.
 *
 * Pins the contract: undefined-valued keys are stripped, every other
 * value (including `null`, `0`, `''`, `false`) passes through, and
 * the returned object has only the keys whose source values were
 * defined.
 */
import { describe, it, expect } from 'vitest';
import { compact, isDiagnosticPath } from '../src/utils.js';

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('compact()', () => {
  it('passes through an all-required object unchanged in shape', () => {
    const out = compact({ a: 1, b: 'x', c: true });
    expect(out).toEqual({ a: 1, b: 'x', c: true });
    // Same key set — nothing dropped.
    expect(Object.keys(out).sort(byName)).toEqual(['a', 'b', 'c']);
  });

  it('drops keys whose value is undefined', () => {
    const out = compact({ a: 1, b: undefined, c: 'x', d: undefined });
    expect(out).toEqual({ a: 1, c: 'x' });
    expect(Object.keys(out).sort(byName)).toEqual(['a', 'c']);
    expect('b' in out).toBe(false);
    expect('d' in out).toBe(false);
  });

  it('preserves null, 0, empty string, and false (only undefined is stripped)', () => {
    const out = compact({ a: null, b: 0, c: '', d: false });
    expect(out).toEqual({ a: null, b: 0, c: '', d: false });
    expect(Object.keys(out).sort(byName)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('does not iterate inherited prototype properties', () => {
    class Box {
      static readonly name = 'Box';
      x = 1;
      get y() {
        return 2;
      }
    }
    const b = new Box();
    const out = compact(b);
    // `x` is the only own enumerable string key on the instance.
    expect(out).toEqual({ x: 1 });
    expect('y' in out).toBe(false);
  });

  it('handles an empty object', () => {
    const out = compact({});
    expect(out).toEqual({});
  });

  it('returns a new object — does not mutate the input', () => {
    const input = { a: 1, b: undefined };
    const out = compact(input);
    expect(out).not.toBe(input);
    // Input still has the original undefined-valued key.
    expect('b' in input).toBe(true);
  });
});

describe('isDiagnosticPath()', () => {
  it('flags paths under top-level scripts/', () => {
    expect(isDiagnosticPath('scripts/bench.ts')).toBe(true);
    expect(isDiagnosticPath('scripts/nested/deep.js')).toBe(true);
  });

  it('flags paths under bench/, benchmark(s)/, example(s)/, demo(s)/', () => {
    expect(isDiagnosticPath('bench/run.ts')).toBe(true);
    expect(isDiagnosticPath('benchmark/foo.ts')).toBe(true);
    expect(isDiagnosticPath('benchmarks/bar.ts')).toBe(true);
    expect(isDiagnosticPath('example/main.ts')).toBe(true);
    expect(isDiagnosticPath('examples/main.ts')).toBe(true);
    expect(isDiagnosticPath('demo/x.ts')).toBe(true);
    expect(isDiagnosticPath('demos/y.ts')).toBe(true);
  });

  it('flags diagnostic paths nested under any prefix', () => {
    // Policy: a directory named scripts/bench/etc. counts as diagnostic
    // wherever it lives, not only at the project root.
    expect(isDiagnosticPath('packages/foo/scripts/run.ts')).toBe(true);
    expect(isDiagnosticPath('src/bench/perf.ts')).toBe(true);
  });

  it('does NOT flag production paths whose names happen to contain a diagnostic word', () => {
    // The patterns anchor on a directory boundary — file names can
    // include `script` or `example` without being diagnostic.
    expect(isDiagnosticPath('src/processing-scripts.ts')).toBe(false);
    expect(isDiagnosticPath('src/script-runner.ts')).toBe(false);
    expect(isDiagnosticPath('src/example.ts')).toBe(false);
    expect(isDiagnosticPath('src/utils/benchmarking.ts')).toBe(false);
  });

  it('returns false for empty / root paths', () => {
    expect(isDiagnosticPath('')).toBe(false);
    expect(isDiagnosticPath('src/index.ts')).toBe(false);
    expect(isDiagnosticPath('lib/main.ts')).toBe(false);
  });
});
