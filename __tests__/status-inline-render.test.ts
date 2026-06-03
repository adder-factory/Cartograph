import { afterAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as coverageQueries from '../src/db/queries-coverage.js';
import * as directorySummaryQueries from '../src/db/queries-directory-summaries.js';
import * as embeddingQueries from '../src/db/queries-embeddings.js';
import * as findingQueries from '../src/db/queries-findings.js';
import * as historyQueries from '../src/db/queries-history.js';
import * as roleQueries from '../src/db/queries-roles.js';
import * as summaryQueries from '../src/db/queries-summaries.js';
import * as unresolvedRefQueries from '../src/db/queries-unresolved-refs.js';
import * as gitUtils from '../src/git-utils.js';
import * as detachedSummarize from '../src/llm/detached-summarize.js';
import * as biomarkerTool from '../src/mcp/tools/biomarkers.js';

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
  unresolvedBuckets: [] as Array<{ referenceKind: string; language: string; count: number }>,
  unresolvedSamples: [] as Array<{ referenceName: string; referenceKind: string; language: string; count: number }>,
};

vi.spyOn(historyQueries, 'getHotspots').mockImplementation((() => {
  if (state.hotspotsThrow) throw new Error('no hotspots table');
  return state.hotspots;
}) as never);

vi.spyOn(findingQueries, 'getFindingsRanked').mockImplementation((() => {
  if (state.findingsThrow) throw new Error('no findings table');
  return state.findings;
}) as never);
vi.spyOn(findingQueries, 'getFindingsStats').mockImplementation((() => ({
  totalFindings: state.totalFindings,
})) as never);

vi.spyOn(biomarkerTool, 'areBiomarkersPending').mockImplementation((() => state.pending) as never);

vi.spyOn(gitUtils, 'isShallowClone').mockImplementation((() => state.shallowClone) as never);
vi.spyOn(gitUtils, 'shortSha').mockImplementation(((sha: string, len = 12) => sha.slice(0, len)) as never);

vi.spyOn(summaryQueries, 'getSummaryCoverage').mockImplementation((() => state.summaryCoverage) as never);
vi.spyOn(summaryQueries, 'getWeightedSummaryCoverage').mockImplementation(
  (() => state.weightedSummaryCoverage) as never,
);
vi.spyOn(summaryQueries, 'countPendingSummarizable').mockImplementation((() => state.pendingSummaries) as never);
vi.spyOn(summaryQueries, 'getSummaryBreakdown').mockImplementation((() => state.summaryBreakdown) as never);

vi.spyOn(detachedSummarize, 'getDetachedSummarizeState').mockImplementation((() =>
  state.detachedRunning ? { running: true, pid: 1234 } : { running: false }) as never);

vi.spyOn(embeddingQueries, 'getEmbeddingsTotal').mockImplementation((() => state.embeddingsTotal) as never);

vi.spyOn(coverageQueries, 'getCoverageStats').mockImplementation((() => state.coverageStats) as never);

vi.spyOn(roleQueries, 'getRoleCounts').mockImplementation((() => state.roleCounts) as never);

vi.spyOn(directorySummaryQueries, 'getAllDirectorySummaries').mockImplementation((() => state.dirSummaries) as never);

vi.spyOn(unresolvedRefQueries, 'getUnresolvedReferencesCount').mockImplementation(
  (() => state.unresolvedRefs) as never,
);
vi.spyOn(unresolvedRefQueries, 'getUnresolvedReferenceBuckets').mockImplementation(
  (() => state.unresolvedBuckets) as never,
);
vi.spyOn(unresolvedRefQueries, 'getCommonUnresolvedReferenceNames').mockImplementation(
  (() => state.unresolvedSamples) as never,
);

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

afterAll(() => {
  vi.restoreAllMocks();
});

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
    state.unresolvedBuckets = [];
    state.unresolvedSamples = [];
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
    state.unresolvedBuckets = [
      { referenceKind: 'calls', language: 'typescript', count: 1000 },
      { referenceKind: 'field_access', language: 'typescript', count: 500 },
    ];
    state.unresolvedSamples = [
      { referenceName: 'console.log', referenceKind: 'calls', language: 'typescript', count: 900 },
      { referenceName: 'props.value', referenceKind: 'field_access', language: 'typescript', count: 500 },
    ];
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
    expect(text).toContain('**Unresolved refs:** 1,500');
    expect(text).toContain('by kind/language: calls/typescript: 1,000');
    expect(text).toContain('common names: `console.log` (900 calls/typescript)');
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
