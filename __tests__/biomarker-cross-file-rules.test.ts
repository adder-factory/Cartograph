import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  unusedExports: [] as Array<{ id: string; kind: string; name: string }>,
  godClasses: [] as Array<{ id: string; name: string; memberCount: number }>,
  featureEnvy: [] as Array<{
    id: string;
    name: string;
    atfd: number;
    fdp: number;
    laa: number;
    ownAccesses: number;
    foreignAccesses: number;
  }>,
  illegalImports: [] as unknown[],
  lowCoverage: [] as unknown[],
  duplicates: [] as unknown[],
  cleared: [] as string[],
  appended: [] as Array<{ findings: unknown[]; passKind: string }>,
  transactions: 0,
};

vi.mock('../src/db/queries-findings.js', () => ({
  appendFindings: vi.fn((_queries: unknown, findings: unknown[], passKind: string) => {
    state.appended.push({ findings, passKind });
  }),
  clearFindingsByKind: vi.fn((_queries: unknown, kind: string) => {
    state.cleared.push(kind);
  }),
  demoteFullPassRowsToCached: vi.fn(),
  promoteFullPassCachedToFullPass: vi.fn(),
  replaceFindingsForFile: vi.fn(),
}));

vi.mock('../src/db/queries-biomarkers-graph.js', () => ({
  findUnusedExports: vi.fn(() => state.unusedExports),
  findGodClasses: vi.fn(() => state.godClasses),
  findFeatureEnvy: vi.fn(() => state.featureEnvy),
}));

vi.mock('../src/config.js', () => ({
  loadConfig: vi.fn(() => ({
    layers: [{ name: 'ui', allowImportsFrom: ['core'] }],
    layerExceptions: [{ file: 'tools/biomarkers.ts', canImport: ['core'] }],
  })),
}));

vi.mock('../src/biomarkers/layering.js', () => ({
  computeIllegalImports: vi.fn(() => state.illegalImports),
}));

vi.mock('../src/biomarkers/low-coverage.js', () => ({
  findLowCoverage: vi.fn(() => state.lowCoverage),
}));

vi.mock('../src/biomarkers/duplicate-code.js', () => ({
  findDuplicateCode: vi.fn(() => state.duplicates),
}));

const { CROSS_FILE_RULES, reconcileCrossFileRuleResult } = await import('../src/biomarkers/index.js');

function queries(nodePaths = new Map<string, string>()) {
  return {
    getNodesByIds(ids: string[]) {
      return new Map(ids.map((id) => [id, { id, filePath: nodePaths.get(id) ?? 'src/app.ts' }]));
    },
    db: {
      prepare: () => ({ get: () => ({ n: 0 }) }),
      transaction: (fn: () => void) => () => {
        state.transactions++;
        fn();
      },
    },
  } as never;
}

beforeEach(() => {
  state.unusedExports = [];
  state.godClasses = [];
  state.featureEnvy = [];
  state.illegalImports = [];
  state.lowCoverage = [];
  state.duplicates = [];
  state.cleared = [];
  state.appended = [];
  state.transactions = 0;
  vi.clearAllMocks();
});

describe('cross-file biomarker rule registry', () => {
  it('maps every registered cross-file rule into code-health findings', () => {
    state.unusedExports = [{ id: 'export:1', kind: 'function', name: 'unused' }];
    state.godClasses = [
      { id: 'class:info', name: 'InfoFacade', memberCount: 15 },
      { id: 'class:warn', name: 'LargeFacade', memberCount: 40 },
      { id: 'class:error', name: 'HugeFacade', memberCount: 60 },
    ];
    state.featureEnvy = [
      { id: 'method:info', name: 'visit', atfd: 6, fdp: 2, laa: 0.12345, ownAccesses: 1, foreignAccesses: 8 },
      { id: 'method:warn', name: 'scrape', atfd: 12, fdp: 1, laa: 0.2, ownAccesses: 2, foreignAccesses: 20 },
    ];
    state.illegalImports = [{ nodeId: 'import:1', biomarker: 'illegal_import', severity: 'warning', metric: 1 }];
    state.lowCoverage = [{ nodeId: 'coverage:1', biomarker: 'low_coverage', severity: 'warning', metric: 0.2 }];
    state.duplicates = [{ nodeId: 'clone:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 }];

    const byKind = new Map(CROSS_FILE_RULES.map((rule) => [rule.kind, rule.produce(queries(), '/repo')]));

    expect([...byKind.keys()]).toEqual([
      'unused_export',
      'god_class',
      'feature_envy',
      'illegal_import',
      'low_coverage',
      'duplicate_code',
    ]);
    expect(byKind.get('unused_export')).toEqual([
      {
        nodeId: 'export:1',
        biomarker: 'unused_export',
        severity: 'info',
        metric: 0,
        detail: { kind: 'function', name: 'unused' },
      },
    ]);
    expect(byKind.get('god_class')?.map((finding) => finding.severity)).toEqual(['info', 'warning', 'error']);
    expect(byKind.get('feature_envy')).toEqual([
      {
        nodeId: 'method:info',
        biomarker: 'feature_envy',
        severity: 'info',
        metric: 6,
        detail: { name: 'visit', atfd: 6, fdp: 2, laa: 0.123, ownAccesses: 1, foreignAccesses: 8 },
      },
      {
        nodeId: 'method:warn',
        biomarker: 'feature_envy',
        severity: 'warning',
        metric: 12,
        detail: { name: 'scrape', atfd: 12, fdp: 1, laa: 0.2, ownAccesses: 2, foreignAccesses: 20 },
      },
    ]);
    expect(byKind.get('illegal_import')).toEqual(state.illegalImports);
    expect(byKind.get('low_coverage')).toEqual(state.lowCoverage);
    expect(byKind.get('duplicate_code')).toEqual(state.duplicates);
  });

  it('filters diagnostic findings on success and preserves prior findings on rule failure', () => {
    const success = reconcileCrossFileRuleResult({
      queries: queries(
        new Map([
          ['prod:1', 'src/app.ts'],
          ['script:1', 'scripts/check.ts'],
        ]),
      ),
      kind: 'duplicate_code',
      passKind: 'full-pass',
      outcome: {
        ok: true,
        raw: [
          { nodeId: 'prod:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 },
          { nodeId: 'script:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 },
          { nodeId: 'missing:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 },
        ],
      },
      source: 'serial',
    });

    expect(success).toEqual({ findingsEmitted: 2, errored: false });
    expect(state.transactions).toBe(1);
    expect(state.cleared).toEqual(['duplicate_code']);
    expect(state.appended).toHaveLength(1);
    expect(state.appended[0]!.passKind).toBe('full-pass');
    expect(state.appended[0]!.findings).toEqual([
      { nodeId: 'prod:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 },
      { nodeId: 'missing:1', biomarker: 'duplicate_code', severity: 'warning', metric: 2 },
    ]);

    state.cleared = [];
    state.appended = [];
    const failed = reconcileCrossFileRuleResult({
      queries: queries(),
      kind: 'god_class',
      passKind: 'full-pass',
      outcome: { ok: false, error: 'worker timeout' },
      source: 'worker',
    });

    expect(failed).toEqual({ findingsEmitted: 0, errored: true });
    expect(state.cleared).toEqual([]);
    expect(state.appended).toEqual([]);
  });
});
