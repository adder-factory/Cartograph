/**
 * Coverage ingestion tests: lcov parser + symbol-span rollup +
 * QueryBuilder upsert/read.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  getCoverageRanked,
  getCoverageStats,
  getNodeCoverage,
  listCoverageSources,
  clearCoverageSource,
} from '../src/db/queries-coverage.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { parseLcov, summariseSpan } from '../src/coverage/lcov.js';
import { getCoverageReportPaths, removeCoverageReportPath, coveragePathPrefix } from '../src/coverage/index.js';
import { getMetadata, setMetadata } from '../src/db/queries-metadata.js';

const byName = (a: string, b: string): number => a.localeCompare(b);

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-coverage-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('lcov parser', () => {
  it('parses a minimal record', () => {
    const body = ['TN:', 'SF:src/foo.ts', 'DA:1,5', 'DA:2,5', 'DA:3,0', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe('src/foo.ts');
    expect(out[0]!.lineHits.get(1)).toBe(5);
    expect(out[0]!.lineHits.get(3)).toBe(0);
  });

  it('parses multiple records and branch data', () => {
    const body = [
      'SF:a.ts',
      'DA:1,1',
      'BRDA:1,0,0,2',
      'BRDA:1,0,1,-',
      'end_of_record',
      'SF:b.ts',
      'DA:5,3',
      'end_of_record',
    ].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(2);
    expect(out[0]!.branches.get(1)).toEqual({ taken: 1, total: 2 });
    expect(out[1]!.lineHits.get(5)).toBe(3);
  });

  it('tolerates a missing trailing end_of_record', () => {
    const body = ['SF:c.ts', 'DA:10,7'].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.lineHits.get(10)).toBe(7);
  });

  it('skips DA records with negative hit counts (Istanbul excluded-line sentinel)', () => {
    const body = ['SF:x.ts', 'DA:1,5', 'DA:2,-1', 'DA:3,0', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    // Line 2 (hits=-1) should NOT appear in lineHits — treated as
    // non-executable rather than uncovered.
    expect(out[0]!.lineHits.has(1)).toBe(true);
    expect(out[0]!.lineHits.has(2)).toBe(false);
    expect(out[0]!.lineHits.has(3)).toBe(true);
  });

  it('skips records before the first SF: line', () => {
    const body = ['TN:something', 'DA:1,5', 'SF:real.ts', 'DA:2,2', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    expect(out).toHaveLength(1);
    expect(out[0]!.filePath).toBe('real.ts');
  });

  it('resolves FN/FNDA into functionHits keyed by declaration line (#20)', () => {
    const body = ['SF:f.ts', 'FN:1,f', 'FNDA:3,f', 'DA:1,0', 'DA:2,3', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    // The arrow signature line (1) was scored 0 by lcov, but FNDA shows
    // the function ran 3×, so functionHits carries the truth.
    expect(out[0]!.functionHits.get(1)).toBe(3);
  });

  it('tolerates the LCOV 2.0 `FN:start,end,name` form', () => {
    const body = ['SF:g.ts', 'FN:4,9,handler', 'FNDA:2,handler', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    // start line is 4; the end-line field (9) is dropped, name is `handler`.
    expect(out[0]!.functionHits.get(4)).toBe(2);
  });

  it('records a zero-hit function so an uncalled fn stays uncovered (#20)', () => {
    const body = ['SF:h.ts', 'FN:1,never', 'FNDA:0,never', 'DA:1,0', 'end_of_record'].join('\n');
    const out = parseLcov(body);
    expect(out[0]!.functionHits.get(1)).toBe(0);
  });

  it('resolves FN/FNDA for a record lacking a trailing end_of_record', () => {
    const body = ['SF:i.ts', 'FN:2,late', 'FNDA:1,late', 'DA:2,0'].join('\n');
    const out = parseLcov(body);
    expect(out[0]!.functionHits.get(2)).toBe(1);
  });
});

describe('summariseSpan', () => {
  it('counts only lines inside the span', () => {
    const fc = parseLcov(['SF:x.ts', 'DA:1,1', 'DA:5,0', 'DA:8,2', 'DA:20,0', 'end_of_record'].join('\n'))[0]!;
    // Span 1..10 includes lines 1, 5, 8 — line 20 is outside.
    const s = summariseSpan(fc, { startLine: 1, endLine: 10 });
    expect(s.totalLines).toBe(3);
    expect(s.coveredLines).toBe(2); // lines 1 and 8 hit
  });

  it('reports 0/0 when the span has no executable lines', () => {
    const fc = parseLcov(['SF:x.ts', 'DA:50,1', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 10 });
    expect(s.totalLines).toBe(0);
    expect(s.coveredLines).toBe(0);
  });

  it('rolls up branch data inside the span', () => {
    const fc = parseLcov(['SF:x.ts', 'DA:5,1', 'BRDA:5,0,0,1', 'BRDA:5,0,1,-', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 10 });
    expect(s.totalBranches).toBe(2);
    expect(s.coveredBranches).toBe(1);
  });

  it('counts a DA:0 declaration line as covered when FNDA shows it ran (#20)', () => {
    // Multi-line single-statement arrow: lcov scores the signature line
    // (1) as 0 but emits FNDA:2,f; the body line (2) is correctly hit.
    // Raw DA would be 1/2=50% (a false low_coverage) — FNDA lifts it to
    // 2/2=100%.
    const fc = parseLcov(['SF:f.ts', 'FN:1,f', 'FNDA:2,f', 'DA:1,0', 'DA:2,2', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2 });
    expect(s.totalLines).toBe(2);
    expect(s.coveredLines).toBe(2);
  });

  it('does NOT lift a declaration line whose function never ran (FNDA:0)', () => {
    const fc = parseLcov(['SF:f.ts', 'FN:1,f', 'FNDA:0,f', 'DA:1,0', 'DA:2,0', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2 });
    expect(s.coveredLines).toBe(0);
  });

  it('only lifts the declaration line, leaving real body gaps uncovered (#20)', () => {
    // A called function (FNDA:1) with a genuinely-unhit body line (3).
    // Only the signature line (1) is lifted; line 3 stays uncovered.
    const fc = parseLcov(
      ['SF:f.ts', 'FN:1,f', 'FNDA:1,f', 'DA:1,0', 'DA:2,1', 'DA:3,0', 'end_of_record'].join('\n'),
    )[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 3 });
    expect(s.totalLines).toBe(3);
    expect(s.coveredLines).toBe(2); // lines 1 (lifted) + 2 (hit); line 3 still uncovered
  });

  // ---- #21: reporter-agnostic structural signature-line fold ----

  it('folds the DA:0 signature line of a callable when NO FN/FNDA exists — bun (#21)', () => {
    // bun emits only DA records (no FN/FNDA). A multi-line arrow scores
    // its signature line (1) at 0; the body (2) is hit. Without the fold
    // this is 1/2=50% (false low_coverage); folding the signature line
    // out of the denominator gives 1/1=100%.
    const fc = parseLcov(['SF:f.ts', 'DA:1,0', 'DA:2,5', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2, isCallable: true });
    expect(s.totalLines).toBe(1);
    expect(s.coveredLines).toBe(1);
  });

  it('folds the signature line when no FNDA is keyed to the declaration line — v8 anon arrow (#21)', () => {
    // @vitest/coverage-v8 names const-arrows `FN:<line>,(anonymous_N)`
    // with no usable FNDA at the declaration line, and DA:<sig>,0. Since
    // nothing lifts line 1, the structural fold drops it: 1/1 body → 100%.
    // (Were a matching FNDA present, the #20 lift would cover line 1
    // instead — both paths converge on no false positive.)
    const fc = parseLcov(['SF:g.ts', 'FN:1,(anonymous_0)', 'DA:1,0', 'DA:2,3', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2, isCallable: true });
    expect(s.coveredLines).toBe(1);
    expect(s.totalLines).toBe(1);
  });

  it('does NOT fold for a non-callable symbol (fold is gated on kind) (#21)', () => {
    const fc = parseLcov(['SF:f.ts', 'DA:1,0', 'DA:2,5', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2, isCallable: false });
    expect(s.totalLines).toBe(2); // line 1 still counted
    expect(s.coveredLines).toBe(1);
  });

  it('does NOT fold a single-line callable (fold needs >1 line) (#21)', () => {
    const fc = parseLcov(['SF:f.ts', 'DA:1,0', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 1, isCallable: true });
    expect(s.totalLines).toBe(1);
    expect(s.coveredLines).toBe(0);
  });

  it('still reports 0% for a genuinely-uncalled multi-line callable (#21)', () => {
    // Signature folded, but the body line is also unhit → 0/1 = 0%, so a
    // truly under-tested function is still flagged.
    const fc = parseLcov(['SF:f.ts', 'DA:1,0', 'DA:2,0', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2, isCallable: true });
    expect(s.totalLines).toBe(1);
    expect(s.coveredLines).toBe(0);
  });

  it('counts a positively-covered signature line normally (no spurious fold) (#21)', () => {
    // When the reporter DOES hit the signature line (real bun behaviour
    // in many cases), it counts as a covered line like any other.
    const fc = parseLcov(['SF:f.ts', 'DA:1,7', 'DA:2,5', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2, isCallable: true });
    expect(s.totalLines).toBe(2);
    expect(s.coveredLines).toBe(2);
  });

  // Regression fixtures captured from REAL reporters (bun 1.3.14 +
  // @vitest/coverage-v8), for `export const f = (x) =>\n  build(...)` —
  // the arrow occupies the last two lines. Both must read the called
  // arrow at 100%, never a false low_coverage.
  it('reads a called arrow at 100% from real bun lcov — no FN/FNDA records (#21)', () => {
    const fc = parseLcov(
      [
        'TN:',
        'SF:util.ts',
        'FNF:2',
        'FNH:2',
        'DA:1,7',
        'DA:2,23',
        'DA:4,22',
        'DA:5,14',
        'LF:4',
        'LH:4',
        'end_of_record',
      ].join('\n'),
    )[0]!;
    expect(fc.functionHits.size).toBe(0); // bun emits no FN/FNDA
    const s = summariseSpan(fc, { startLine: 4, endLine: 5, isCallable: true });
    expect(s.coveredLines).toBe(s.totalLines);
    expect(s.totalLines).toBeGreaterThanOrEqual(1);
  });

  it('reads a called arrow at 100% from real vitest-v8 lcov — anonymous FN/FNDA (#21)', () => {
    const fc = parseLcov(
      [
        'TN:',
        'SF:src/util.ts',
        'FN:1,build',
        'FN:4,(anonymous_1)',
        'FNF:2',
        'FNH:2',
        'FNDA:1,build',
        'FNDA:1,(anonymous_1)',
        'DA:2,1',
        'DA:4,1',
        'DA:5,1',
        'LF:3',
        'LH:3',
        'end_of_record',
      ].join('\n'),
    )[0]!;
    // The anonymously-named arrow's FNDA is keyed to its declaration line.
    expect(fc.functionHits.get(4)).toBe(1);
    const s = summariseSpan(fc, { startLine: 4, endLine: 5, isCallable: true });
    expect(s.coveredLines).toBe(s.totalLines);
    expect(s.totalLines).toBeGreaterThanOrEqual(1);
  });
});

describe('lcov parser + summariseSpan — edge/robustness (mutation-hardening)', () => {
  it('drops malformed DA records (missing field or non-numeric)', () => {
    const fc = parseLcov(['SF:x.ts', 'DA:5', 'DA:abc,1', 'DA:6,xyz', 'DA:7,3', 'end_of_record'].join('\n'))[0]!;
    expect([...fc.lineHits.keys()]).toEqual([7]); // only the valid record survives
    expect(fc.lineHits.get(7)).toBe(3);
  });

  it('drops malformed BRDA records and keeps no spurious entries', () => {
    const fc = parseLcov(
      ['SF:x.ts', 'BRDA:5', 'BRDA:abc,0,0,1', 'BRDA:6,0,0,xyz', 'BRDA:8,0,0,2', 'end_of_record'].join('\n'),
    )[0]!;
    expect(fc.branches.size).toBe(1);
    expect(fc.branches.get(8)).toEqual({ taken: 1, total: 1 });
  });

  it('counts every positively-taken branch on a line (taken > 0, not <= 0)', () => {
    const fc = parseLcov(['SF:x.ts', 'BRDA:5,0,0,2', 'BRDA:5,0,1,3', 'end_of_record'].join('\n'))[0]!;
    expect(fc.branches.get(5)).toEqual({ taken: 2, total: 2 });
  });

  it('trims surrounding whitespace before classifying a record', () => {
    const fc = parseLcov(['SF:x.ts', '   DA:5,1   ', 'end_of_record'].join('\n'))[0]!;
    expect(fc.lineHits.get(5)).toBe(1);
  });

  it('ignores FN records with an empty name or non-numeric start line', () => {
    const fc = parseLcov(
      ['SF:f.ts', 'FN:1,', 'FNDA:2,', 'FN:abc,x', 'FNDA:2,x', 'FN:3,real', 'FNDA:4,real', 'end_of_record'].join('\n'),
    )[0]!;
    expect(fc.functionHits.size).toBe(1); // only the valid FN resolves
    expect(fc.functionHits.get(3)).toBe(4);
  });

  it('summariseSpan does not fold the signature line when isCallable defaults to false', () => {
    const fc = parseLcov(['SF:f.ts', 'DA:1,0', 'DA:2,5', 'end_of_record'].join('\n'))[0]!;
    const s = summariseSpan(fc, { startLine: 1, endLine: 2 }); // no isCallable → default false
    expect(s.totalLines).toBe(2); // line 1 still counted (not folded)
    expect(s.coveredLines).toBe(1);
  });

  it('summariseSpan branch rollup includes the span endpoints and excludes outside lines', () => {
    const fc = parseLcov(
      ['SF:x.ts', 'BRDA:1,0,0,1', 'BRDA:5,0,0,1', 'BRDA:10,0,0,1', 'BRDA:15,0,0,1', 'end_of_record'].join('\n'),
    )[0]!;
    const s = summariseSpan(fc, { startLine: 5, endLine: 10 });
    expect(s.totalBranches).toBe(2); // lines 5 (start) and 10 (end) only
    expect(s.coveredBranches).toBe(2);
  });
});

describe('coveragePathPrefix (#19)', () => {
  const root = '/repo';
  it('derives the package prefix from a nested per-package report', () => {
    expect(coveragePathPrefix(root, '/repo/packages/b/coverage/lcov.info')).toBe('packages/b');
  });
  it('handles the lcov-report nesting without mistaking it for the prefix', () => {
    expect(coveragePathPrefix(root, '/repo/apps/web/coverage/lcov-report/lcov.info')).toBe('apps/web');
  });
  it('returns empty for a repo-root report', () => {
    expect(coveragePathPrefix(root, '/repo/coverage/lcov.info')).toBe('');
    expect(coveragePathPrefix(root, '/repo/lcov.info')).toBe('');
  });
  it('accepts project-relative report paths', () => {
    expect(coveragePathPrefix(root, 'packages/a/coverage/lcov.info')).toBe('packages/a');
  });
  it('returns empty for a report outside the project or an unknown layout', () => {
    expect(coveragePathPrefix(root, '/tmp/merged.info')).toBe('');
    expect(coveragePathPrefix(root, '/repo/weird/path.txt')).toBe('');
  });
});

describe('end-to-end ingestion through Cartograph', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('ingests an lcov report and exposes coverage on the joined graph', async () => {
    // Project: a single file with two functions on different lines.
    const src = `export function alpha(): number {
  return 1;
}

export function beta(x: number): number {
  if (x > 0) {
    return x;
  }
  return -x;
}
`;
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'sample.ts'), src);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-test', version: '0.0.0' }));

    // alpha (lines 1-3) fully covered; beta (lines 5-10) partially:
    // line 6 if-test taken; line 7 (return x) hit; line 9 (return -x) not hit.
    const lcov = [
      'SF:src/sample.ts',
      'DA:1,1',
      'DA:2,1',
      'DA:5,1',
      'DA:6,1',
      'DA:7,1',
      'DA:9,0',
      'BRDA:6,0,0,1',
      'BRDA:6,0,1,-',
      'end_of_record',
    ].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      const idx = await cg.indexAll({ summarize: false });
      expect(idx.success).toBe(true);

      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);
      expect(result.filesUnmatched).toBe(0);
      expect(result.symbolsUpdated).toBeGreaterThanOrEqual(2);

      const ranked = getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 });
      const byName = new Map(ranked.map((r) => [r.name, r]));
      const alpha = byName.get('alpha');
      const beta = byName.get('beta');
      expect(alpha).toBeDefined();
      expect(beta).toBeDefined();
      // alpha: 2/2 covered; beta: 3/4 covered (line 9 missed).
      expect(alpha!.pct).toBe(1);
      expect(beta!.pct).toBeLessThan(1);
      expect(beta!.coveredLines).toBe(3);
      expect(beta!.totalLines).toBe(4);

      const stats = getCoverageStats(cg.queries);
      expect(stats.symbolsWithCoverage).toBeGreaterThanOrEqual(2);
      expect(stats.weightedPct).toBeGreaterThan(0.5);
      expect(stats.weightedPct).toBeLessThan(1);
    } finally {
      cg.close();
    }
  });

  it('scores a called multi-line arrow at 100%, not low, via FNDA (#20)', async () => {
    // A multi-line single-statement arrow whose declaration line lcov
    // scores 0 even though the function is exercised. Before the fix the
    // symbol read 50% (or 0%) and tripped low_coverage; the FNDA record
    // proves it ran.
    const src = ['export const f = (x: number): number => {', '  return x * 2;', '};', ''].join('\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), src);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-arrow', version: '0.0.0' }));

    // Signature line (1) scored 0 by lcov; body line (2) hit; FNDA shows
    // the function ran twice.
    const lcov = ['SF:src/helper.ts', 'FN:1,f', 'FNDA:2,f', 'DA:1,0', 'DA:2,2', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);

      const node = cg.queries.db
        .prepare(`SELECT id FROM nodes WHERE name = 'f' AND start_line IS NOT NULL LIMIT 1`)
        .get() as { id: string } | undefined;
      expect(node).toBeDefined();
      const cov = cg.queries.db
        .prepare(`SELECT covered_lines AS c, total_lines AS t FROM node_coverage WHERE node_id = ?`)
        .get(node!.id) as { c: number; t: number } | undefined;
      expect(cov).toBeDefined();
      expect(cov!.t).toBeGreaterThanOrEqual(1);
      // Every line in the arrow's span counts as covered — no false gap.
      expect(cov!.c).toBe(cov!.t);
    } finally {
      cg.close();
    }
  });

  it('scores a called arrow at 100% from a bun-style lcov with NO FN/FNDA (#21)', async () => {
    // bun emits only DA records — no FN/FNDA to lift the signature line.
    // The structural fold (kind-gated in applyFileCoverage) must still
    // clear the false low_coverage on a multi-line arrow whose signature
    // line scored 0.
    const src = ['export const f = (x: number): number => {', '  return x * 2;', '};', ''].join('\n');
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'helper.ts'), src);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-bun-arrow', version: '0.0.0' }));

    // Signature line (1) scored 0; body (2) hit; NO FN/FNDA (bun shape).
    const lcov = ['SF:src/helper.ts', 'DA:1,0', 'DA:2,2', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);

      const node = cg.queries.db
        .prepare(`SELECT id, kind FROM nodes WHERE name = 'f' AND start_line IS NOT NULL LIMIT 1`)
        .get() as { id: string; kind: string } | undefined;
      expect(node).toBeDefined();
      expect(node!.kind).toBe('function'); // arrow-const promoted → fold applies
      const cov = cg.queries.db
        .prepare(`SELECT covered_lines AS c, total_lines AS t FROM node_coverage WHERE node_id = ?`)
        .get(node!.id) as { c: number; t: number } | undefined;
      expect(cov).toBeDefined();
      // Signature line folded out; the hit body line is the whole span.
      expect(cov!.c).toBe(cov!.t);
    } finally {
      cg.close();
    }
  });

  it('matches a per-package report that emits package-relative SF paths (#19)', async () => {
    // Monorepo workspace: source at packages/b/src/foo.ts, but the
    // report (vitest/v8 style) lives under the package and emits
    // package-relative `SF:src/foo.ts`. The report's location supplies
    // the `packages/b` prefix so the path resolves to the right file.
    const pkgDir = path.join(dir, 'packages', 'b');
    fs.mkdirSync(path.join(pkgDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(pkgDir, 'src', 'foo.ts'), `export function foo(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-monorepo', version: '0.0.0' }));

    fs.mkdirSync(path.join(pkgDir, 'coverage'), { recursive: true });
    const reportPath = path.join(pkgDir, 'coverage', 'lcov.info');
    fs.writeFileSync(reportPath, ['SF:src/foo.ts', 'DA:1,1', 'end_of_record'].join('\n'));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(reportPath);
      // The package-relative `src/foo.ts` resolved to packages/b/src/foo.ts.
      expect(result.filesMatched).toBe(1);
      expect(result.filesUnmatched).toBe(0);
      expect(result.symbolsUpdated).toBeGreaterThanOrEqual(1);
    } finally {
      cg.close();
    }
  });

  it('honors includeTests:false in ranked coverage results', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'prod.ts'), `export function prodFn(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'prod.test.ts'), `export function testHelper(): number { return 2; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-ranked-tests', version: '0.0.0' }));
    const lcov = ['SF:src/prod.ts', 'DA:1,1', 'end_of_record', 'SF:src/prod.test.ts', 'DA:1,1', 'end_of_record'].join(
      '\n',
    );
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath);

      const withTests = getCoverageRanked(cg.queries, { kinds: ['function'], includeTests: true, limit: 10 });
      expect(withTests.map((r) => r.name).toSorted(byName)).toEqual(['prodFn', 'testHelper']);

      const prodOnly = getCoverageRanked(cg.queries, { kinds: ['function'], includeTests: false, limit: 10 });
      expect(prodOnly.map((r) => r.name)).toEqual(['prodFn']);
    } finally {
      cg.close();
    }
  });

  it('honors pathFilter in ranked coverage results', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'lib'));
    fs.writeFileSync(path.join(dir, 'src', 'prod.ts'), `export function prodFn(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'lib', 'libFn.ts'), `export function libFn(): number { return 2; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-ranked-path', version: '0.0.0' }));
    const lcov = ['SF:src/prod.ts', 'DA:1,1', 'end_of_record', 'SF:lib/libFn.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath);

      const ranked = getCoverageRanked(cg.queries, { kinds: ['function'], pathFilter: 'lib/', limit: 10 });
      expect(ranked.map((r) => r.name)).toEqual(['libFn']);
    } finally {
      cg.close();
    }
  });

  it('re-applies coverage after a sync re-extracts an edited file (FRICTION-6)', async () => {
    // Re-extraction mints new node ids → node_coverage rows cascade-
    // delete. The coverage-reapply index hook must re-derive them from
    // the persisted lcov report so coverage doesn't silently erode.
    const src = `export function alpha(): number {
  return 1;
}

export function beta(x: number): number {
  if (x > 0) {
    return x;
  }
  return -x;
}
`;
    fs.mkdirSync(path.join(dir, 'src'));
    const srcPath = path.join(dir, 'src', 'sample.ts');
    fs.writeFileSync(srcPath, src);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-reapply', version: '0.0.0' }));
    const lcov = ['SF:src/sample.ts', 'DA:1,1', 'DA:2,1', 'DA:5,1', 'DA:6,1', 'DA:7,1', 'DA:9,0', 'end_of_record'].join(
      '\n',
    );
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath);
      const before = getCoverageStats(cg.queries).symbolsWithCoverage;
      expect(before).toBeGreaterThanOrEqual(2);

      // Edit alpha's BODY (return 1 -> return 2) without shifting any
      // line numbers — alpha gets a fresh content-addressed node id,
      // so its old node_coverage row cascade-deletes on re-extraction.
      fs.writeFileSync(srcPath, src.replace('return 1;', 'return 2;'));
      const sync = await cg.sync();
      expect(sync.filesModified).toBe(1);

      // With the coverage-reapply hook, the count is fully restored;
      // without it, alpha's row would be gone (before - 1).
      const after = getCoverageStats(cg.queries).symbolsWithCoverage;
      expect(after).toBe(before);
      const ranked = getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 });
      expect(ranked.map((r) => r.name).toSorted(byName)).toEqual(['alpha', 'beta']);
    } finally {
      cg.close();
    }
  });

  it('is idempotent under the same source key', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function f(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-idem', version: '0.0.0' }));
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const r1 = await cg.ingestCoverage(lcovPath);
      const r2 = await cg.ingestCoverage(lcovPath);
      expect(r1.symbolsUpdated).toBe(r2.symbolsUpdated);
      const stats = getCoverageStats(cg.queries);
      // Re-running same source overwrites — count unchanged.
      expect(stats.symbolsWithCoverage).toBe(r1.symbolsUpdated);
    } finally {
      cg.close();
    }
  });

  it('matches monorepo-style paths via suffix lookup', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function f(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-monorepo', version: '0.0.0' }));
    // Report uses `packages/api/src/a.ts` but project is rooted at
    // `packages/api`, so the indexed path is `src/a.ts`.
    const lcov = ['SF:packages/api/src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(lcovPath);
      expect(result.filesMatched).toBe(1);
      expect(result.filesUnmatched).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('clearSource drops stale rows from prior ingestions', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      `export function f(): number { return 1; }\nexport function g(): number { return 2; }\n`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-clear', version: '0.0.0' }));

    // First report covers both functions.
    const fullLcov = ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n');
    // Second report only covers the first function (file was excluded
    // from the run from line 2 onward) — simulates a scope narrowing.
    const partialLcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const fullPath = path.join(dir, 'full.info');
    const partialPath = path.join(dir, 'partial.info');
    fs.writeFileSync(fullPath, fullLcov);
    fs.writeFileSync(partialPath, partialLcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(fullPath);
      const beforeStats = getCoverageStats(cg.queries);
      const beforeCount = beforeStats.symbolsWithCoverage;
      expect(beforeCount).toBeGreaterThanOrEqual(2);

      // Second ingestion WITHOUT clearSource: stale row for second
      // function persists.
      await cg.ingestCoverage(partialPath);
      const afterStats = getCoverageStats(cg.queries);
      expect(afterStats.symbolsWithCoverage).toBe(beforeCount);

      // With clearSource: stale rows dropped.
      await cg.ingestCoverage(partialPath, { clearSource: true });
      const clearedStats = getCoverageStats(cg.queries);
      expect(clearedStats.symbolsWithCoverage).toBeLessThan(beforeCount);
    } finally {
      cg.close();
    }
  });

  it('never writes empty-span (0/0) rows; counts them separately under symbolsEmpty', async () => {
    // Project with three top-level constants on lines 1, 2, 3 and one
    // function on lines 5-7. Lcov covers ONLY line 5 (inside the
    // function) — the three constants have no DA: records intersecting
    // their single-line span, so they MUST be skipped, not written as
    // 0/0 rows. Regression for the friction observed during the
    // 2026-05-14 nllc workout: 2545 / 4041 symbols were getting empty
    // coverage rows.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'mixed.ts'),
      [
        'export const A = 1;',
        'export const B = 2;',
        'export const C = 3;',
        '',
        'export function run(): number {',
        '  return A + B + C;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-empty-span', version: '0.0.0' }));
    // Lcov covers ONLY line 5 (the function declaration). The three
    // constants on lines 1-3 have NO intersecting DA: records.
    const lcov = ['SF:src/mixed.ts', 'DA:5,1', 'DA:6,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      const result = await cg.ingestCoverage(lcovPath);

      // At least the three constants should have been skipped.
      expect(result.symbolsEmpty).toBeGreaterThanOrEqual(3);
      // The function (`run`) should have written a real row.
      expect(result.symbolsUpdated).toBeGreaterThanOrEqual(1);

      // INVARIANT: no row may have total_lines = 0. Caching tools and
      // ranking queries depend on the denominator being non-zero.
      const emptyRows = (
        cg.queries.db as unknown as {
          prepare: (sql: string) => { get: () => { n: number } };
        }
      )
        .prepare('SELECT COUNT(*) AS n FROM node_coverage WHERE total_lines = 0')
        .get();
      expect(emptyRows.n).toBe(0);

      // And the function row should be there with the expected span.
      const ranked = getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 });
      const run = ranked.find((r) => r.name === 'run');
      expect(run).toBeDefined();
      expect(run!.totalLines).toBeGreaterThan(0);
    } finally {
      cg.close();
    }
  });

  it('keeps independent rows for different source keys', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function f(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-multi', version: '0.0.0' }));
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath, { source: 'unit' });
      await cg.ingestCoverage(lcovPath, { source: 'e2e' });
      const stats = getCoverageStats(cg.queries);
      expect(stats.sources.toSorted(byName)).toEqual(['e2e', 'unit']);

      // When a source is requested, the rollup AND the source list
      // both narrow to that source — surfacing all sources here would
      // mislead the MCP `mode='stats', source='unit'` output.
      const unitOnly = getCoverageStats(cg.queries, 'unit');
      expect(unitOnly.sources).toEqual(['unit']);
    } finally {
      cg.close();
    }
  });

  it('Task #6 — multi-source coverage dedups per node_id in ranked + stats', async () => {
    // node_coverage is keyed (node_id, source); a symbol covered by N
    // suites holds N rows. Without per-node dedup, getCoverageRanked
    // emits the symbol N times and getCoverageStats N-counts both the
    // symbol total and the summed lines. The dedup keeps the best-
    // coverage row per node.
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      'export function f(): number { return 1; }\n' + 'export function g(): number { return 2; }\n',
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-dedup', version: '0.0.0' }));
    // Same lcov ingested under three distinct source labels → every
    // covered symbol ends up with exactly three node_coverage rows.
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'DA:2,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath, { source: 'unit' });
      await cg.ingestCoverage(lcovPath, { source: 'e2e' });
      await cg.ingestCoverage(lcovPath, { source: 'integration' });

      // Ranked: each node must appear AT MOST once despite three sources.
      const ranked = getCoverageRanked(cg.queries, { kinds: ['function'], limit: 50 });
      const ids = ranked.map((r) => r.nodeId);
      expect(new Set(ids).size).toBe(ids.length);

      // Stats with no source filter: symbol count is the DISTINCT node
      // count, not 3× it; line totals are not triple-summed.
      const allStats = getCoverageStats(cg.queries);
      const oneSource = getCoverageStats(cg.queries, 'unit');
      expect(allStats.symbolsWithCoverage).toBe(oneSource.symbolsWithCoverage);
      expect(allStats.totalLines).toBe(oneSource.totalLines);
      expect(allStats.coveredLines).toBe(oneSource.coveredLines);
      expect(allStats.sources.toSorted(byName)).toEqual(['e2e', 'integration', 'unit']);
    } finally {
      cg.close();
    }
  });

  it('listCoverageSources reports each source with a row count + age; clearCoverageSource drops one', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function f(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-sources', version: '0.0.0' }));
    const lcov = ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n');
    const lcovPath = path.join(dir, 'lcov.info');
    fs.writeFileSync(lcovPath, lcov);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(lcovPath, { source: 'unit' });
      await cg.ingestCoverage(lcovPath, { source: 'stray' });

      const sources = listCoverageSources(cg.queries);
      expect(sources.map((s) => s.source).toSorted(byName)).toEqual(['stray', 'unit']);
      for (const s of sources) {
        expect(s.rowCount).toBeGreaterThan(0);
        expect(s.newestIngestedAt).toBeGreaterThan(0);
      }

      // Drop the stray source — only `unit` should remain.
      const removed = clearCoverageSource(cg.queries, 'stray');
      expect(removed).toBeGreaterThan(0);
      const after = listCoverageSources(cg.queries);
      expect(after.map((s) => s.source)).toEqual(['unit']);
    } finally {
      cg.close();
    }
  });
});

// ─── #18: same-label reports union instead of clobber ──────────────────────
describe('same-source-label coverage union (#18)', () => {
  let dir: string;
  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  // Two functions, each fully covered by ONE of the two reports and
  // only partially by the other — so loading both under the same label
  // exercises BOTH conflict arms (keep-existing and replace-with-incoming).
  const TWO_FN_SRC = [
    'export function alpha(x: number): number {', // 1
    '  if (x > 0) {', //                              2
    '    return x;', //                               3
    '  }', //                                          4
    '  return -x;', //                                5
    '}', //                                            6
    '', //                                             7
    'export function beta(y: number): number {', //   8
    '  if (y > 0) {', //                               9
    '    return y;', //                               10
    '  }', //                                         11
    '  return -y;', //                                12
    '}', //                                           13
    '',
  ].join('\n');
  // alpha exec lines 1,2,3,5 ; beta exec lines 8,9,10,12.
  const REPORT_ALPHA_FULL = [
    'SF:src/two.ts',
    'DA:1,1',
    'DA:2,1',
    'DA:3,1',
    'DA:5,1', // alpha 4/4
    'DA:8,1',
    'DA:9,1',
    'DA:10,1',
    'DA:12,0', // beta 3/4
    'end_of_record',
  ].join('\n');
  const REPORT_BETA_FULL = [
    'SF:src/two.ts',
    'DA:1,1',
    'DA:2,1',
    'DA:3,1',
    'DA:5,0', // alpha 3/4
    'DA:8,1',
    'DA:9,1',
    'DA:10,1',
    'DA:12,1', // beta 4/4
    'end_of_record',
  ].join('\n');

  function writeTwoFnProject(): void {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'two.ts'), TWO_FN_SRC);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-union', version: '0.0.0' }));
  }
  function rankedByName(cg: Cartograph): Map<string, ReturnType<typeof getCoverageRanked>[number]> {
    return new Map(getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 }).map((r) => [r.name, r]));
  }

  it('max-merges multiple reports sharing one source label (keep + replace)', async () => {
    writeTwoFnProject();
    const aPath = path.join(dir, 'a.info');
    const bPath = path.join(dir, 'b.info');
    fs.writeFileSync(aPath, REPORT_ALPHA_FULL);
    fs.writeFileSync(bPath, REPORT_BETA_FULL);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      // Both loads use the DEFAULT source label — exactly the monorepo
      // collision that produced false positives before the fix.
      await cg.ingestCoverage(aPath); // alpha 100%, beta 75%
      await cg.ingestCoverage(bPath); // alpha 75%, beta 100%

      const byName = rankedByName(cg);
      // alpha: existing 100% kept against incoming 75% (keep arm).
      expect(byName.get('alpha')!.pct).toBe(1);
      // beta: existing 75% replaced by incoming 100% (replace arm).
      expect(byName.get('beta')!.pct).toBe(1);
      // Collapsed under ONE label, not two.
      expect(getCoverageStats(cg.queries).sources).toEqual(['lcov']);
    } finally {
      cg.close();
    }
  });

  it('a thin 100% report does not shrink a fuller report under the same label (tie-break)', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(
      path.join(dir, 'src', 'g.ts'),
      [
        'export function gamma(x: number): number {',
        '  const a = x + 1;',
        '  const b = a + 1;',
        '  return b;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-tiebreak', version: '0.0.0' }));
    // gamma exec lines 1,2,3,4.
    const full = ['SF:src/g.ts', 'DA:1,1', 'DA:2,1', 'DA:3,1', 'DA:4,1', 'end_of_record'].join('\n');
    const thin = ['SF:src/g.ts', 'DA:1,1', 'end_of_record'].join('\n'); // 1/1, also 100%
    const fullPath = path.join(dir, 'full.info');
    const thinPath = path.join(dir, 'thin.info');
    fs.writeFileSync(fullPath, full);
    fs.writeFileSync(thinPath, thin);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(fullPath);
      const fullTotal = getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 })[0]!.totalLines;
      expect(fullTotal).toBeGreaterThan(1);

      // Thin report is also 100% but over fewer lines — must NOT replace
      // the fuller view just because the fractions tie.
      await cg.ingestCoverage(thinPath);
      expect(getCoverageRanked(cg.queries, { kinds: ['function'], limit: 10 })[0]!.totalLines).toBe(fullTotal);
    } finally {
      cg.close();
    }
  });

  it('coverage-reapply re-unions every report under a label after a sync re-extracts a file', async () => {
    writeTwoFnProject();
    const aPath = path.join(dir, 'a.info');
    const bPath = path.join(dir, 'b.info');
    fs.writeFileSync(aPath, REPORT_ALPHA_FULL);
    fs.writeFileSync(bPath, REPORT_BETA_FULL);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(aPath);
      await cg.ingestCoverage(bPath);
      expect(rankedByName(cg).get('alpha')!.pct).toBe(1);

      // Edit alpha's body without shifting line numbers → fresh node id,
      // its node_coverage row cascade-deletes on re-extraction.
      const srcPath = path.join(dir, 'src', 'two.ts');
      fs.writeFileSync(srcPath, TWO_FN_SRC.replace('return -x;', 'return 0 - x;'));
      const sync = await cg.sync();
      expect(sync.filesModified).toBe(1);

      // Both reports were persisted under the label, so reapply re-unions
      // them — alpha stays 100%. With only the LAST path persisted it
      // would erode to report B's 75%.
      const byName = rankedByName(cg);
      expect(byName.get('alpha')!.pct).toBe(1);
      expect(byName.get('beta')!.pct).toBe(1);
    } finally {
      cg.close();
    }
  });

  it('dropping a source forgets its report paths so a later sync does not resurrect it', async () => {
    writeTwoFnProject();
    const aPath = path.join(dir, 'a.info');
    fs.writeFileSync(aPath, REPORT_ALPHA_FULL);

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      await cg.ingestCoverage(aPath);
      expect(getCoverageStats(cg.queries).symbolsWithCoverage).toBeGreaterThan(0);

      // Simulate `mode: 'drop'`: clear the rows AND forget the path.
      clearCoverageSource(cg.queries, 'lcov');
      removeCoverageReportPath(cg.queries, 'lcov');
      expect(getCoverageStats(cg.queries).symbolsWithCoverage).toBe(0);

      // A sync that re-extracts a file must NOT bring coverage back.
      fs.writeFileSync(path.join(dir, 'src', 'two.ts'), TWO_FN_SRC.replace('return -x;', 'return 0 - x;'));
      const sync = await cg.sync();
      expect(sync.filesModified).toBe(1);
      expect(getCoverageStats(cg.queries).symbolsWithCoverage).toBe(0);
    } finally {
      cg.close();
    }
  });

  it('getCoverageReportPaths promotes the legacy single-string shape to a list', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function f(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-legacy', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      // Pre-fix DBs stored `{ [source]: absPath }` (a bare string).
      setMetadata(
        cg.queries,
        'coverage_report_paths',
        JSON.stringify({ lcov: '/abs/legacy.info', unit: '/abs/unit.info' }),
      );
      expect(getCoverageReportPaths(cg.queries)).toEqual({
        lcov: ['/abs/legacy.info'],
        unit: ['/abs/unit.info'],
      });
      // And a fresh append on top of the legacy value yields a list.
      const reportPath = path.join(dir, 'fresh.info');
      fs.writeFileSync(reportPath, ['SF:src/a.ts', 'DA:1,1', 'end_of_record'].join('\n'));
      await cg.ingestCoverage(reportPath, { source: 'lcov' });
      const paths = getCoverageReportPaths(cg.queries);
      expect(paths['lcov']).toContain('/abs/legacy.info');
      expect(paths['lcov']).toContain(reportPath);
      expect(getMetadata(cg.queries, 'coverage_report_paths')).toBeTruthy();
    } finally {
      cg.close();
    }
  });

  it('getCoverageReportPaths ignores malformed array metadata roots', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function f(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-bad-root', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      setMetadata(cg.queries, 'coverage_report_paths', JSON.stringify(['/abs/not-a-source.info']));

      expect(getCoverageReportPaths(cg.queries)).toEqual({});
    } finally {
      cg.close();
    }
  });

  it('getCoverageReportPaths keeps special source labels as own keys', async () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function f(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cov-proto-source', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });
      setMetadata(cg.queries, 'coverage_report_paths', '{"__proto__":["/abs/proto.info"],"lcov":"/abs/ok.info"}');

      const paths = getCoverageReportPaths(cg.queries);

      expect(Object.getPrototypeOf(paths)).toBe(null);
      expect(Object.hasOwn(paths, '__proto__')).toBe(true);
      expect(Object.getOwnPropertyDescriptor(paths, '__proto__')?.value).toEqual(['/abs/proto.info']);
      expect(paths['lcov']).toEqual(['/abs/ok.info']);
    } finally {
      cg.close();
    }
  });
});
