import { beforeEach, describe, expect, it, vi } from 'vitest';

const state = {
  hotspots: [] as Array<{
    filePath: string;
    commitCount: number;
    loc: number | null;
    fileCentrality: number;
    riskScore: number;
  }>,
  hotspotsThrow: false,
  findings: [] as Array<{
    name: string;
    kind: string;
    biomarker: string;
    severity: string;
    metric: number;
    centrality: number | null;
    filePath: string;
  }>,
  findingsThrow: false,
  totalFindings: 0,
  pending: false,
  shallowClone: false,
  summaryCoverage: null as null | { summarised: number; total: number },
  weightedSummaryCoverage: null as null | { weightedRatio: number | null },
  pendingSummaries: 0,
  summaryBreakdown: null as null | { structural: number; neighborProp: number; llm: number; skippedByFloor: number },
  detachedRunning: false,
  embeddingsTotal: undefined as number | undefined,
  coverageStats: undefined as undefined | { symbolsWithCoverage: number; sources: string[] },
  roleCounts: undefined as Map<string, number> | undefined,
  dirSummaries: undefined as unknown[] | undefined,
  reuseRows: 0,
  unresolvedRefs: 0,
};

vi.mock('../src/db/queries-history.js', () => ({
  getHotspots: vi.fn(() => {
    if (state.hotspotsThrow) throw new Error('no hotspots table');
    return state.hotspots;
  }),
}));

vi.mock('../src/db/queries-findings.js', () => ({
  getFindingsRanked: vi.fn(() => {
    if (state.findingsThrow) throw new Error('no findings table');
    return state.findings;
  }),
  getFindingsStats: vi.fn(() => ({ totalFindings: state.totalFindings })),
}));

vi.mock('../src/mcp/tools/biomarkers.js', () => ({
  areBiomarkersPending: vi.fn(() => state.pending),
}));

vi.mock('../src/git-utils.js', () => ({
  isCartographMetaPath: vi.fn((filePath: string) => filePath.startsWith('.cartograph/')),
  isShallowClone: vi.fn(() => state.shallowClone),
  shortSha: vi.fn((sha: string, len = 12) => sha.slice(0, len)),
  getCurrentHeadSha: vi.fn(() => null),
  gitWorktreeRoot: vi.fn(() => null),
  detectBorrowedWorktreeIndex: vi.fn(() => null),
  borrowedWorktreeBanner: vi.fn(() => ''),
  gitCommitCount: vi.fn(() => null),
  hasUncommittedChanges: vi.fn(() => false),
  getChangeBreakdownSince: vi.fn(() => null),
  countCommitsAhead: vi.fn(() => null),
  getLineRangeHistory: vi.fn(() => []),
  fileWasEverRenamed: vi.fn(() => false),
  getFileFollowEarliestTs: vi.fn(() => null),
  isShaReachable: vi.fn(() => false),
  getFileAtRef: vi.fn(() => null),
  listChangedFilesSince: vi.fn(() => null),
  getCommitSubjects: vi.fn(() => new Map()),
}));

vi.mock('../src/db/queries-summaries.js', () => ({
  MS_PER_DAY: 24 * 60 * 60 * 1000,
  PRUNE_STORE_DEFAULT_DAYS: 30,
  getSummarizableNodes: vi.fn(() => []),
  getSummaryCoverage: vi.fn(() => state.summaryCoverage),
  getWeightedSummaryCoverage: vi.fn(() => state.weightedSummaryCoverage),
  countPendingSummarizable: vi.fn(() => state.pendingSummaries),
  getSummaryBreakdown: vi.fn(() => state.summaryBreakdown),
  pruneOrphanSummaries: vi.fn(() => ({ summariesDeleted: 0, embeddingsDeleted: 0 })),
  pruneOrphanStoreRows: vi.fn(() => 0),
  getSymbolSummary: vi.fn(() => null),
  getSummaryByContentHash: vi.fn(() => null),
  getSymbolDescriptions: vi.fn(() => new Map()),
  getTestDerivedDescriptions: vi.fn(() => new Map()),
  getSymbolSummaries: vi.fn(() => new Map()),
  countSymbolSummaries: vi.fn(() => 0),
  upsertSymbolSummary: vi.fn(() => true),
}));

vi.mock('../src/llm/detached-summarize.js', () => ({
  getDetachedSummarizeState: vi.fn(() => (state.detachedRunning ? { running: true, pid: 1234 } : { running: false })),
}));

vi.mock('../src/db/queries-embeddings.js', () => ({
  getEmbeddingsTotal: vi.fn(() => state.embeddingsTotal),
}));

vi.mock('../src/db/queries-coverage.js', () => ({
  getCoverageStats: vi.fn(() => state.coverageStats),
}));

vi.mock('../src/db/queries-roles.js', () => ({
  getRoleCounts: vi.fn(() => state.roleCounts),
}));

vi.mock('../src/db/queries-directory-summaries.js', () => ({
  getAllDirectorySummaries: vi.fn(() => state.dirSummaries),
}));

const {
  STATUS_BIOMARKERS_CLEAN_NOTE,
  STATUS_BIOMARKERS_PENDING_NOTE,
  appendFeatureReadiness,
  appendInlineBiomarkers,
  appendInlineHotspots,
  buildStatusInlineBiomarkersSpec,
  buildStatusInlineHotspotsSpec,
  parseInlineTopN,
  resolveStatusRollups,
} = await import('../src/mcp/tools/status.js');

function cg(overrides: Record<string, unknown> = {}) {
  const db = {
    prepare: () => ({
      get: () => ({ c: state.reuseRows, n: state.unresolvedRefs }),
    }),
  };
  return {
    projectRoot: '/repo',
    queries: { db },
    db: { getDb: () => db },
    llm: { bgCtrl: { progress: null } },
    ...overrides,
  } as never;
}

describe('status inline rollups', () => {
  beforeEach(() => {
    state.hotspots = [];
    state.hotspotsThrow = false;
    state.findings = [];
    state.findingsThrow = false;
    state.totalFindings = 0;
    state.pending = false;
    state.shallowClone = false;
    state.summaryCoverage = null;
    state.weightedSummaryCoverage = null;
    state.pendingSummaries = 0;
    state.summaryBreakdown = null;
    state.detachedRunning = false;
    state.embeddingsTotal = undefined;
    state.coverageStats = undefined;
    state.roleCounts = undefined;
    state.dirSummaries = undefined;
    state.reuseRows = 0;
    state.unresolvedRefs = 0;
    vi.clearAllMocks();
  });

  it('suppresses hotspots for non-positive topN and missing hotspot data', () => {
    const lines: string[] = [];
    appendInlineHotspots(lines, cg(), 0);
    expect(lines).toEqual([]);

    state.hotspotsThrow = true;
    appendInlineHotspots(lines, cg(), 5);
    expect(lines).toEqual([]);
  });

  it('renders hotspot rows', () => {
    state.hotspots = [
      { filePath: 'src/a.ts', commitCount: 0, loc: 12, fileCentrality: 0.25, riskScore: 0 },
      { filePath: 'src/b.ts', commitCount: 0, loc: null, fileCentrality: 0.5, riskScore: 0 },
    ];
    const lines: string[] = [];

    appendInlineHotspots(lines, cg(), 5);
    const text = lines.join('\n');

    expect(text).toContain('all 2 hotspots');
    expect(text).toContain('src/a.ts');
    expect(text).toContain('centrality: 0.2500');
  });

  it('renders the shallow-clone hotspot diagnostic when zero churn dominates', () => {
    state.shallowClone = true;
    state.hotspots = [
      { filePath: 'src/a.ts', commitCount: 0, loc: 12, fileCentrality: 0.25, riskScore: 0 },
      { filePath: 'src/b.ts', commitCount: 1, loc: 7, fileCentrality: 0.5, riskScore: 0.5 },
    ];
    const lines: string[] = [];

    appendInlineHotspots(lines, cg(), 2);

    expect(lines.join('\n')).toContain('Shallow clone detected');
  });

  it('renders populated biomarker findings', () => {
    state.findings = [
      {
        name: 'bigMethod',
        kind: 'function',
        biomarker: 'large_method',
        severity: 'warning',
        metric: 120,
        centrality: 0.125,
        filePath: 'src/big.ts',
      },
    ];
    const lines: string[] = [];

    appendInlineBiomarkers(lines, cg(), 5);
    const text = lines.join('\n');

    expect(text).toContain('1 biomarker finding');
    expect(text).toContain('large_method warning');
    expect(text).toContain('centrality: 0.1250');
  });

  it('renders pending, clean, and info-only empty biomarker states', () => {
    let lines: string[] = [];
    state.pending = true;
    appendInlineBiomarkers(lines, cg(), 5);
    expect(lines.join('\n')).toContain(STATUS_BIOMARKERS_PENDING_NOTE);

    lines = [];
    state.pending = false;
    state.totalFindings = 0;
    appendInlineBiomarkers(lines, cg(), 5);
    expect(lines.join('\n')).toContain(STATUS_BIOMARKERS_CLEAN_NOTE);

    lines = [];
    state.totalFindings = 3;
    appendInlineBiomarkers(lines, cg(), 5);
    expect(lines.join('\n')).toContain('3 info-level finding(s) present');
  });

  it('normalizes inline rollup limits and builds singular/plural rollup specs', () => {
    expect([undefined, null, -1, 0, Number.NaN, 'nope'].map(parseInlineTopN)).toEqual([0, 0, 0, 0, 0, 0]);
    expect(parseInlineTopN('1.9')).toBe(1);
    expect(parseInlineTopN(99)).toBe(30);
    expect(resolveStatusRollups({ verbose: true })).toEqual({
      topHotspots: 5,
      topBiomarkers: 5,
      summaryBreakdown: true,
    });
    expect(resolveStatusRollups({ verbose: true, topHotspots: 1, topBiomarkers: 0, summaryBreakdown: false })).toEqual({
      topHotspots: 1,
      topBiomarkers: 5,
      summaryBreakdown: false,
    });

    const hotspot = buildStatusInlineHotspotsSpec(
      [{ filePath: 'src/a.ts', commitCount: 3, loc: null, fileCentrality: 0.1, riskScore: 0.2 }],
      1,
    );
    expect(hotspot.title).toContain('Top 1 hotspot');
    expect(hotspot.formatRow(hotspot.rows[0]!)).toContain('LOC: null');

    const biomarkers = buildStatusInlineBiomarkersSpec({
      rows: [
        {
          name: 'fn',
          kind: 'function',
          biomarker: 'large_method',
          severity: 'warning',
          metric: 99,
          centrality: null,
          filePath: 'src/a.ts',
        },
      ],
      totalFindings: -1,
      topN: 1,
      pending: false,
    });
    expect(biomarkers.title).toContain('Top 1 biomarker finding');
    expect(biomarkers.formatRow(biomarkers.rows[0]!)).not.toContain('centrality:');
  });

  it('renders feature readiness lenses with actions, reuse caches, background progress, and breakdowns', () => {
    state.summaryCoverage = { summarised: 2, total: 4 };
    state.weightedSummaryCoverage = { weightedRatio: 0.75 };
    state.pendingSummaries = 1;
    state.summaryBreakdown = { structural: 1, neighborProp: 2, llm: 3, skippedByFloor: 1 };
    state.embeddingsTotal = 0;
    state.coverageStats = { symbolsWithCoverage: 7, sources: ['unit', 'integration'] };
    state.roleCounts = new Map([
      ['api', 2],
      ['utility', 3],
    ]);
    state.dirSummaries = [{ path: 'src' }];
    state.reuseRows = 2;
    state.unresolvedRefs = 1_500;
    const lines: string[] = [];

    appendFeatureReadiness(lines, cg({ llm: { bgCtrl: { progress: { phase: 'summarise', done: 1, total: 4 } } } }), {
      summaryBreakdown: true,
    });
    const text = lines.join('\n');

    expect(text).toContain('### 🚦 Feature Readiness');
    expect(text).toContain('**Summaries:** 2 / 4 (50%)');
    expect(text).toContain('centrality-weighted: 75%');
    expect(text).toContain('2 reuse-cached');
    expect(text).toContain('1 pending');
    expect(text).toContain('summarization running in the background');
    expect(text).toContain('skipped-by-floor: 1');
    expect(text).toContain('**Embeddings:** 0 rows');
    expect(text).toContain('**Coverage:** 7 symbols (2 sources: unit, integration)');
    expect(text).toContain('**Roles:** 5 classified');
    expect(text).toContain('**Directory summaries:** 1');
    expect(text).toContain('**Unresolved refs:** 1500');
  });

  it('renders empty readiness actions and detached summarizer state', () => {
    state.summaryCoverage = { summarised: 0, total: 3 };
    state.weightedSummaryCoverage = { weightedRatio: null };
    state.detachedRunning = true;
    state.embeddingsTotal = 5;
    state.coverageStats = { symbolsWithCoverage: 0, sources: [] };
    state.roleCounts = new Map();
    state.dirSummaries = [];
    const lines: string[] = [];

    appendFeatureReadiness(lines, cg(), { summaryBreakdown: false });
    const text = lines.join('\n');

    expect(text).toContain('run `cartograph summarize`');
    expect(text).toContain('detached summarizer running');
    expect(text).toContain('**Embeddings:** 5 rows');
    expect(text).toContain('run `cartograph coverage --mode load');
    expect(text).toContain('**Roles:** 0 classified');
    expect(text).toContain('**Directory summaries:** 0');
  });
});
