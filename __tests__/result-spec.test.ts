/**
 * `result-spec.ts` — `MarkdownTableSpec` + `renderMarkdownTable`
 * contract tests, plus a wording-alignment lint that checks the spec's
 * user-visible strings match the tool's `.describe()` text.
 *
 * Structural fix #32. The renderer is total in the sense that no
 * user-facing string is hand-assembled outside the spec — these tests
 * are the contract that keeps the renderer honest.
 */
import { describe, it, expect } from 'vitest';
import {
  bulletListSpecStrings,
  cardListSpecStrings,
  keyValueCardSpecStrings,
  renderMarkdownBulletList,
  renderMarkdownCardList,
  renderMarkdownKeyValueCard,
  renderMarkdownTable,
  specStrings,
  type MarkdownBulletListSpec,
  type MarkdownCardListSpec,
  type MarkdownKeyValueCardSpec,
  type MarkdownTableColumn,
  type MarkdownTableSpec,
} from '../src/rendering/result-spec.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

describe('renderMarkdownTable — output shape', () => {
  it('renders a minimal one-row table with H2 title + header row + separator + body row', () => {
    const spec: MarkdownTableSpec<{ name: string; count: number }> = {
      title: 'Stuff',
      columns: [
        { header: 'Name', cell: (r) => r.name },
        { header: 'N', align: 'right', cell: (r) => String(r.count) },
      ],
      rows: [{ name: 'alpha', count: 7 }],
      emptyState: 'No stuff.',
    };
    const out = renderMarkdownTable(spec);
    expect(out).toBe(['## Stuff', '', '| Name | N |', '|---|---:|', '| alpha | 7 |'].join('\n'));
  });

  it('returns the emptyState message verbatim when rows is empty — no table chrome', () => {
    const spec: MarkdownTableSpec<unknown> = {
      title: 'Stuff',
      columns: [{ header: 'Name', cell: () => '' }],
      rows: [],
      emptyState: 'No stuff at all.',
    };
    expect(renderMarkdownTable(spec)).toBe('No stuff at all.');
  });

  it('appends footers after the table with a blank-line separator', () => {
    const spec: MarkdownTableSpec<{ name: string }> = {
      title: 'X',
      columns: [{ header: 'Name', cell: (r) => r.name }],
      rows: [{ name: 'one' }],
      emptyState: 'empty',
      footers: ['First footer.', '_second footer_'],
    };
    const out = renderMarkdownTable(spec);
    expect(out).toBe(['## X', '', '| Name |', '|---|', '| one |', '', 'First footer.', '_second footer_'].join('\n'));
  });

  it('honors per-column alignment in the separator row', () => {
    const spec: MarkdownTableSpec<{ a: string; b: string; c: string }> = {
      title: 'Aligned',
      columns: [
        { header: 'left', align: 'left', cell: (r) => r.a },
        { header: 'right', align: 'right', cell: (r) => r.b },
        { header: 'center', align: 'center', cell: (r) => r.c },
      ],
      rows: [{ a: 'x', b: 'y', c: 'z' }],
      emptyState: 'empty',
    };
    const out = renderMarkdownTable(spec);
    expect(out).toContain('|---|---:|:-:|');
  });

  it('does not emit a footer block when footers is undefined / empty', () => {
    const spec: MarkdownTableSpec<{ n: number }> = {
      title: 'X',
      columns: [{ header: 'N', cell: (r) => String(r.n) }],
      rows: [{ n: 1 }],
      emptyState: 'empty',
    };
    const out = renderMarkdownTable(spec);
    // No trailing blank-line then footer.
    expect(out.endsWith('| 1 |')).toBe(true);
  });
});

describe('specStrings — collects every user-visible string for lint use', () => {
  it('returns title, every column header, emptyState, and every footer', () => {
    const spec: MarkdownTableSpec<unknown> = {
      title: 'Stuff (top 3)',
      columns: [
        { header: 'A', cell: () => '' },
        { header: 'B', cell: () => '' },
      ],
      rows: [],
      emptyState: 'No stuff.',
      footers: ['One.', 'Two.'],
    };
    expect(specStrings(spec)).toEqual(['Stuff (top 3)', 'A', 'B', 'No stuff.', 'One.', 'Two.']);
  });
});

// ── Wording-alignment lint ──────────────────────────────────────────
// Each migrated tool exports a pure spec builder so the lint imports
// the actual MarkdownTableSpec instance and walks `specStrings(spec)`
// for the user-visible strings. Pre-#32, the #17 "Config keys" /
// "env vars" drift was possible because the description and the
// rendered header were independent hand-written strings. After #32
// they're both pinned to the spec, and this lint asserts the live
// spec output against the tool's domain word — renaming the title
// in `env-refs.ts` to "Config keys" again would fail here.
import { buildEnvKeysTableSpec } from '../src/mcp/tools/env-refs.js';
import { buildSqlTablesSpec } from '../src/mcp/tools/sql-refs.js';
import { buildCoverageRankedSpec, buildCoverageSourcesSpec } from '../src/mcp/tools/coverage.js';
import {
  buildHotspotsRiskSpec,
  buildHotspotsCategorySpec,
  buildHotspotsAllRiskSpec,
  buildHotspotsAllCategorySpec,
} from '../src/mcp/tools/hotspots.js';
import { buildRoleDistributionSpec } from '../src/mcp/tools/role.js';
import {
  DEPS_ALL_CLEAN_NOTE,
  buildDepsUnusedSpec,
  buildDepsUndeclaredSpec,
  buildDepsImportedPackagesSpec,
} from '../src/mcp/tools/deps.js';
import {
  DIGEST_BIOMARKER_STATE_NOTES,
  DIGEST_ENTRY_POINTS_EMPTY_NOTE,
  DIGEST_ROUTES_PREFIX,
  DIGEST_PUBLIC_EXPORTS_PREFIX_FN,
  buildDigestHotspotsSpec,
  buildDigestBiomarkersSpec,
  buildDigestRecentChurnSpec,
  buildDigestSuggestedQueriesSpec,
} from '../src/mcp/tools/digest.js';
import {
  STATUS_BIOMARKERS_CLEAN_NOTE,
  STATUS_BIOMARKERS_PENDING_NOTE,
  buildStatusInlineHotspotsSpec,
  buildStatusInlineBiomarkersSpec,
} from '../src/features/status/rollups.js';
import { buildDiscoverContextsSpec } from '../src/mcp/tools/discover.js';
import {
  buildBiomarkerStatsByBiomarkerSpec,
  buildBiomarkerStatsBySeveritySpec,
  buildBiomarkerStatsBySurfaceSpec,
} from '../src/mcp/tools/biomarkers.js';
import { buildEntryPointsBucketSpec } from '../src/mcp/tools/entry-points.js';
import {
  TESTS_FOR_NO_RESULTS_NOTE,
  TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX,
  TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX,
  buildTestsForBucketSpec,
  buildTestsForDispatchSpec,
  buildTestsForDescribeNameSpec,
  buildTestsForSameFileExplainer,
  buildTestsForDescribeNameExplainer,
} from '../src/mcp/tools/tests-for.js';
import {
  buildBlameEarliestSpec,
  buildBlameMostRecentSpec,
  buildBlameRecentActivitySpec,
  buildBlameAuthorsSpec,
} from '../src/mcp/tools/blame.js';
import {
  CHANGED_SINCE_CONTENT_LABEL,
  CHANGED_SINCE_THRESHOLD_LABEL,
  CHANGED_SINCE_ADDED_LABEL,
  CHANGED_SINCE_DELETED_LABEL,
  buildChangedSinceBucketSpec,
} from '../src/mcp/tools/changed-since.js';
import {
  buildDeadCodeJudgeSpec,
  buildDeadCodeStaticSpec,
  buildDeadCodeUncertainTopSpec,
} from '../src/mcp/tools/dead-code.js';
import type { DeadCodeCandidate } from '../src/llm/dead-code.js';
import { buildImportsGroupSpec } from '../src/mcp/tools/imports.js';
import { buildSearchFuzzySpec } from '../src/mcp/tools/_search-fuzzy.js';
import { buildSearchSemanticConceptSpec, buildSearchSemanticSymbolSpec } from '../src/mcp/tools/_search-semantic.js';
import { buildModuleReportSpec, buildModuleSummariesSpec } from '../src/features/module/runtime.js';
import { buildGrepFileSpec } from '../src/mcp/tools/_grep.js';
import { buildCalleesGroupSpec } from '../src/mcp/tools/_callees.js';
import { CALLERS_CONSTRUCTOR_HINT, CALLERS_NO_CALLERS_NOTE, buildCallersGroupSpec } from '../src/mcp/tools/_callers.js';
import {
  REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE,
  buildReviewNeighborsChangedSymbolsSpec,
  buildReviewNeighborsLookalikesSpec,
} from '../src/mcp/tools/review-neighbors.js';
import {
  MACROS_EMPTY_NOTE,
  SESSIONS_EMPTY_NOTE,
  buildSavedMacrosSpec,
  buildSessionRecentSpec,
} from '../src/mcp/tools/_session-specs.js';
import {
  TRACE_CULPRITS_EMPTY_NOTE,
  buildTraceCulpritsSpec,
  buildTraceGapFramesSpec,
  buildTraceUnmappedFramesSpec,
} from '../src/mcp/tools/trace-to-culprits.js';
import { buildCoChangeHistorySpec, buildFileLevelCoChangeSpec } from '../src/mcp/tools/history.js';
import {
  REVIEW_CONTEXT_COCHANGE_PREAMBLE,
  buildReviewContextCoChangeWarningsSpec,
} from '../src/mcp/tools/review-context.js';
import { buildImpactConcentrationSpec, buildImpactSourceSymbolsSpec } from '../src/mcp/tools/_impact.js';
import type { Edge, Node, SearchResult } from '../src/types.js';
import type { SymbolDescription } from '../src/db/queries-summaries.js';

describe('migrated-tool wording alignment (#32)', () => {
  it("env-refs spec title + emptyState mention 'environment variable' / 'env var', never 'config key'", () => {
    const spec = buildEnvKeysTableSpec([], true);
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/environment\s+variable|env-var|env\s+var/);
    expect(allText).not.toMatch(/config\s+key/);
  });

  it("sql-refs spec title + emptyState mention 'sql table' / 'sql refs'", () => {
    const spec = buildSqlTablesSpec([], true);
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/sql\s+(table|ref)/);
  });

  it('env-refs spec column headers include the user-facing axis terms', () => {
    // Populate with a one-row fixture so `columns` is exercised.
    const spec = buildEnvKeysTableSpec(
      [{ configKey: 'OBSIDIAN_PORT', prodReads: 1, testReads: 0, prodFiles: 1, testFiles: 0 }],
      true,
    );
    const headers = spec.columns
      .map((c) => c.header)
      .join(' | ')
      .toLowerCase();
    expect(headers).toMatch(/env\s+var/);
  });

  it('migrated specs follow the test-only footer hide-pattern', () => {
    const noTests = buildEnvKeysTableSpec([], false);
    const withTests = buildEnvKeysTableSpec([], true);
    const hiddenNote = (s: MarkdownTableSpec<unknown>): string | undefined =>
      s.footers?.find((f) => /test-only/i.test(f));
    expect(hiddenNote(noTests)).toBeDefined();
    expect(hiddenNote(withTests)).toBeUndefined();
  });

  it("coverage ranked spec title + preamble mention 'coverage' / 'untested' / 'centrality'", () => {
    const spec = buildCoverageRankedSpec([
      {
        name: 'foo',
        kind: 'function',
        filePath: 'src/foo.ts',
        pct: 0.42,
        coveredLines: 10,
        totalLines: 24,
        centrality: 0.0123,
      },
    ]);
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/coverage/);
    expect(allText).toMatch(/untested|centrality/);
    expect(allText).not.toMatch(/orphan|biomarker/);
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toContain('Symbol');
    expect(headers).toContain('Coverage');
  });

  it("coverage sources spec title + footer use the 'source' vocabulary", () => {
    const spec = buildCoverageSourcesSpec([{ source: 'lcov.info', rowCount: 42, newestIngestedAt: Date.now() }]);
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/coverage\s+source/);
    expect(allText).toMatch(/drop/);
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toEqual(['Source', 'Rows', 'Newest report']);
  });

  it("hotspots risk spec title + preamble mention 'hotspot' / 'centrality' / 'churn'", () => {
    const spec = buildHotspotsRiskSpec(
      [
        {
          filePath: 'src/foo.ts',
          fileCentrality: 0.1,
          commitCount: 5,
          loc: 100,
          lastTouchedTs: Date.now(),
          riskScore: 0.5,
        },
      ],
      'risk',
      Math.floor(Date.now() / 1000),
    );
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/hotspot/);
    expect(allText).toMatch(/centrality/);
    expect(allText).toMatch(/churn|risk/);
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toContain('File');
    expect(headers).toContain('Risk');
  });

  it("hotspots risk spec renders null LOC as '—' (not the literal string 'null')", () => {
    // Locks the post-migration null-rendering convention. The
    // pre-migration template-literal printed `null` verbatim, which
    // surfaced as a UX bug in any file row that predates the LOC
    // backfill or carries a binary path. A future migration arc must
    // not silently flip this back without updating both the spec and
    // this test.
    const spec = buildHotspotsRiskSpec(
      [
        {
          filePath: 'src/null-loc.bin',
          fileCentrality: 0.05,
          commitCount: 3,
          loc: null,
          lastTouchedTs: null,
          riskScore: 0.1,
        },
      ],
      'risk',
      Math.floor(Date.now() / 1000),
    );
    const locCol = spec.columns.find((c) => c.header === 'LOC');
    expect(locCol).toBeDefined();
    expect(locCol!.cell({ ...spec.rows[0]!, i: 0 })).toBe('—');
  });

  it("discover spec title + footer use 'cartograph context' / 'projectPath' vocabulary", () => {
    const spec = buildDiscoverContextsSpec(
      [{ path: '/abs/foo', fileCount: 12, nodeCount: 34, indexedAt: '2026-05-22T20:00:00Z' }],
      '/abs',
      [],
    );
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/cartograph\s+context/);
    expect(allText).toMatch(/projectpath/);
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toEqual(['Path', 'Files', 'Nodes', 'Indexed at']);
  });

  it('discover spec renders null fileCount / nodeCount / indexedAt as `—`', () => {
    const spec = buildDiscoverContextsSpec(
      [{ path: '/abs/x', fileCount: null, nodeCount: null, indexedAt: null }],
      '/abs',
      [],
    );
    const row = spec.rows[0]!;
    expect(spec.columns.find((c) => c.header === 'Files')!.cell(row)).toBe('—');
    expect(spec.columns.find((c) => c.header === 'Nodes')!.cell(row)).toBe('—');
    expect(spec.columns.find((c) => c.header === 'Indexed at')!.cell(row)).toBe('—');
  });

  it('discover spec interleaves the projectPath hint + failure footer when failures occurred', () => {
    const failureFooter = ['_Stat read failed for 1 index — em-dashes above..._', '- `/abs/broken` — locked'];
    const spec = buildDiscoverContextsSpec(
      [{ path: '/abs/ok', fileCount: 5, nodeCount: 10, indexedAt: '2026-05-22T20:00:00Z' }],
      '/abs',
      failureFooter,
    );
    expect(spec.footers).toBeDefined();
    // projectPath hint always comes first; failure footer follows after a blank line.
    expect(spec.footers![0]).toMatch(/projectPath/);
    expect(spec.footers).toContain('- `/abs/broken` — locked');
  });

  it("biomarkers-stats by-biomarker sub-spec uses H3 heading and 'Biomarker' / 'Count' headers", () => {
    const spec = buildBiomarkerStatsByBiomarkerSpec([
      { name: 'long_parameter_list', total: 30, breakdown: 'info: 30' },
    ]);
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('By biomarker');
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toEqual(['Biomarker', 'Count']);
    const out = renderMarkdownTable(spec);
    expect(out.startsWith('### By biomarker')).toBe(true);
    // Breakdown is rendered inline next to the count.
    expect(out).toContain('30 (info: 30)');
  });

  it('biomarkers-stats by-biomarker cell omits the parens when breakdown is empty', () => {
    const spec = buildBiomarkerStatsByBiomarkerSpec([{ name: 'magic_number', total: 5, breakdown: '' }]);
    const out = renderMarkdownTable(spec);
    expect(out).toContain('| magic_number | 5 |');
    expect(out).not.toMatch(/\(\s*\)/);
  });

  it('biomarkers-stats by-severity sub-spec uses H3 + Severity/Count headers', () => {
    const spec = buildBiomarkerStatsBySeveritySpec([
      { severity: 'info', count: 30 },
      { severity: 'warning', count: 5 },
    ]);
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('By severity');
    expect(spec.columns.map((c) => c.header)).toEqual(['Severity', 'Count']);
  });

  it('biomarkers-stats by-surface sub-spec carries the surface-reason preamble + H3 heading', () => {
    const spec = buildBiomarkerStatsBySurfaceSpec([
      { surface: 'full-pass', count: 30 },
      { surface: 'partial-rescan', count: 0 },
      { surface: 'cached', count: 0 },
    ]);
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('By surface reason');
    const preamble = (spec.preamble ?? []).join(' ');
    expect(preamble).toMatch(/full-pass/);
    expect(preamble).toMatch(/partial-rescan/);
    expect(preamble).toMatch(/cached/);
  });

  it('renderMarkdownTable honours headingLevel: 3 (H3 prefix instead of H2)', () => {
    const spec: MarkdownTableSpec<{ n: number }> = {
      title: 'Subsection',
      headingLevel: 3,
      columns: [{ header: 'N', cell: (r) => String(r.n) }],
      rows: [{ n: 1 }],
      emptyState: 'empty',
    };
    const out = renderMarkdownTable(spec);
    expect(out.startsWith('### Subsection')).toBe(true);
    // The first line is `### Subsection`; the H2 form `## Subsection` (no
    // leading `#`) must NOT appear at any line start. (`### Subsection`
    // contains `## Subsection` as a substring, so `not.toContain('## ')`
    // would false-fire; anchor on a line boundary.)
    expect(out).not.toMatch(/^## Subsection/m);
  });

  it('renderMarkdownTable defaults to headingLevel: 2 when the field is unset', () => {
    const spec: MarkdownTableSpec<{ n: number }> = {
      title: 'TopLevel',
      columns: [{ header: 'N', cell: (r) => String(r.n) }],
      rows: [{ n: 1 }],
      emptyState: 'empty',
    };
    const out = renderMarkdownTable(spec);
    expect(out.startsWith('## TopLevel')).toBe(true);
    expect(out).not.toMatch(/^### TopLevel/m);
  });

  it("digest hotspots spec title uses 'churn × centrality' / 🔥 emoji", () => {
    const spec = buildDigestHotspotsSpec([{ filePath: 'src/foo.ts', riskScore: 1.5, commitCount: 14, loc: 500 }]);
    expect(spec.title).toBe('🔥 Hotspots (top 1, churn × centrality)');
    const text = bulletListSpecStrings(spec).join(' | ');
    expect(text).toMatch(/🔥/);
    expect(text).toMatch(/churn\s*×\s*centrality|hotspot/i);
  });

  it('digest hotspots spec empty-state names the recovery action', () => {
    const spec = buildDigestHotspotsSpec([]);
    expect(spec.emptyState).toMatch(/`cartograph admin index`/i);
    expect(spec.emptyState).toMatch(/🔥 Hotspots/);
  });

  it('digest biomarkers spec routes through 4 states (populated/never-ran/clean/pending)', () => {
    const noteKeys = Object.keys(DIGEST_BIOMARKER_STATE_NOTES);
    const sortedNoteKeys = [...noteKeys];
    sortedNoteKeys.sort(byString);
    const expectedNoteKeys = ['clean', 'never-ran', 'pending'];
    expectedNoteKeys.sort(byString);
    expect(sortedNoteKeys).toEqual(expectedNoteKeys);
    expect(DIGEST_BIOMARKER_STATE_NOTES['never-ran']).toMatch(/No biomarker data/);
    expect(DIGEST_BIOMARKER_STATE_NOTES.pending).toMatch(/pending/);
    expect(DIGEST_BIOMARKER_STATE_NOTES.clean).toMatch(/Project clean/);
    // Populated path renders rows with severity summary in the title.
    const populated = buildDigestBiomarkersSpec({
      state: 'populated',
      findings: [{ name: 'foo', kind: 'function', biomarker: 'magic_number', filePath: 'src/foo.ts' }],
      stats: { totalFindings: 1, bySeverity: { warning: 1, info: 0, error: 0 } } as ReturnType<
        typeof import('../src/db/queries-findings.js').getFindingsStats
      >,
    });
    // Singular noun for totalFindings === 1 (plural-guard fix).
    expect(populated.title).toMatch(/🩺 Code Health — 1 finding /);
    expect(populated.title).toMatch(/warning/);
  });

  it('digest biomarkers populated path with empty findings still renders count + recovery hint (no silent data-loss)', () => {
    const spec = buildDigestBiomarkersSpec({
      state: 'populated',
      findings: [],
      stats: { totalFindings: 3, bySeverity: { warning: 1, info: 2, error: 0 } } as ReturnType<
        typeof import('../src/db/queries-findings.js').getFindingsStats
      >,
    });
    expect(spec.title).toMatch(/🩺 Code Health — 3 findings/);
    // Empty findings hits emptyState — must not be a bare heading.
    expect(spec.emptyState).toMatch(/🩺 Code Health — 3 findings/);
    expect(spec.emptyState).toMatch(/cartograph admin sync/);
  });

  it('digest entry-points empty note + routes/public-exports prefixes are exported', () => {
    expect(DIGEST_ENTRY_POINTS_EMPTY_NOTE).toMatch(/No HTTP routes or zero-caller public exports/);
    expect(DIGEST_ROUTES_PREFIX).toBe('**Routes');
    expect(DIGEST_PUBLIC_EXPORTS_PREFIX_FN(5)).toBe('**Public exports (zero in-tree callers, top 5):**');
  });

  it('digest recent-churn spec title interpolates the recency-day window', () => {
    const spec = buildDigestRecentChurnSpec(
      [{ filePath: 'src/x.ts', lastTouchedTs: Date.now() / 1000, commitCount: 10, loc: 100 }],
      30,
    );
    expect(spec.title).toMatch(/Recently touched files/);
    expect(spec.title).toMatch(/last 30 days/);
    expect(spec.footers?.[0]).toMatch(/lifetime commit count/);
  });

  it('digest recent-churn empty-state names the no-data branch', () => {
    const spec = buildDigestRecentChurnSpec([], 30);
    expect(spec.emptyState).toMatch(/quiet codebase, or git history not mined yet/);
  });

  it('digest suggested-queries spec title carries the 🧭 emoji', () => {
    const spec = buildDigestSuggestedQueriesSpec([
      '`cartograph_files` — full project layout',
      '`cartograph_entry_points` — full breakdown',
    ]);
    expect(spec.title).toBe('🧭 Suggested next queries');
    expect(spec.formatRow('`cartograph_files` — full project layout')).toBe(
      '- `cartograph_files` — full project layout',
    );
  });

  it("status inline-hotspots rollup uses H3 + 'centrality × churn' vocabulary", () => {
    const spec = buildStatusInlineHotspotsSpec(
      [{ filePath: 'src/x.ts', commitCount: 10, loc: 100, fileCentrality: 0.05, riskScore: 0.5 }],
      5,
    );
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toMatch(/🔥/);
    expect(spec.title).toMatch(/risk = centrality × churn/i);
    expect(spec.footers?.[0]).toMatch(/topHotspots: 0/);
  });

  it("status inline-biomarkers populated path uses H3 + 'warning+' vocabulary", () => {
    const spec = buildStatusInlineBiomarkersSpec({
      rows: [
        {
          name: 'foo',
          kind: 'function',
          biomarker: 'magic_number',
          severity: 'warning',
          metric: 10,
          centrality: 0.05,
          filePath: 'src/x.ts',
        },
      ],
      totalFindings: -1,
      topN: 5,
      pending: false,
    });
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toMatch(/🩺/);
    expect(spec.title).toMatch(/warning\+/);
    expect(spec.footers?.[0]).toMatch(/topBiomarkers: 0/);
  });

  it("status inline-biomarkers clean-state empty-message uses '✓ — 0 biomarker findings'", () => {
    const spec = buildStatusInlineBiomarkersSpec({ rows: [], totalFindings: 0, topN: 5, pending: false });
    expect(spec.emptyState).toContain('### 🩺 Biomarker findings');
    expect(spec.emptyState).toContain(STATUS_BIOMARKERS_CLEAN_NOTE);
    expect(STATUS_BIOMARKERS_CLEAN_NOTE).toMatch(/Project clean ✓/);
  });

  // B2 (2026-05-23) — pending-state wording: must mirror the digest
  // tool's `DIGEST_BIOMARKER_STATE_NOTES.pending` copy so the two
  // surfaces stay in lockstep. Pending wins over clean: even when
  // totalFindings === 0, the pending flag must produce the ⏳ note,
  // not "Project clean ✓".
  it("status inline-biomarkers pending-state empty-message uses '⏳ Biomarker pass pending'", () => {
    const spec = buildStatusInlineBiomarkersSpec({ rows: [], totalFindings: 0, topN: 5, pending: true });
    expect(spec.emptyState).toContain('### 🩺 Biomarker findings');
    expect(spec.emptyState).toContain(STATUS_BIOMARKERS_PENDING_NOTE);
    expect(STATUS_BIOMARKERS_PENDING_NOTE).toMatch(/Biomarker pass pending/);
    // Critical regression guard: pending must NOT also emit the clean
    // note, or both states render together and the agent can't tell
    // which one applies.
    expect(spec.emptyState).not.toContain(STATUS_BIOMARKERS_CLEAN_NOTE);
  });

  it("status inline-biomarkers info-only path mentions 'minSeverity' / info-level finding(s) present'", () => {
    const spec = buildStatusInlineBiomarkersSpec({ rows: [], totalFindings: 7, topN: 5, pending: false });
    expect(spec.emptyState).toMatch(/info-level finding\(s\) present/);
    expect(spec.emptyState).toMatch(/minSeverity/);
  });

  it("deps unused runtime bucket title uses 'Unused runtime dependencies' / H3 heading", () => {
    const spec = buildDepsUnusedSpec('runtime', ['lodash']);
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('Unused runtime dependencies');
    expect(spec.formatRow('lodash')).toBe('- `lodash`');
  });

  it('deps unused dev / optional buckets carry distinct titles', () => {
    expect(buildDepsUnusedSpec('dev', []).title).toBe('Unused dev dependencies');
    expect(buildDepsUnusedSpec('optional', []).title).toBe('Unused optional dependencies');
  });

  it("deps all-clean note is the affirmative '✓ All declared dependencies are used.'", () => {
    expect(DEPS_ALL_CLEAN_NOTE).toBe('✓ All declared dependencies are used.');
  });

  it("deps undeclared spec title includes the '⚠' glyph and footer explains resolution", () => {
    const spec = buildDepsUndeclaredSpec(['react', 'vite']);
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('⚠ Imported but not declared in package.json (2)');
    const footers = spec.footers ?? [];
    expect(footers.join(' ')).toMatch(/Imported in source/);
    expect(footers.join(' ')).toMatch(/Either add it as a dependency or remove the import/);
  });

  it('deps imported-packages spec renders cap-overflow footer when used > displayCap', () => {
    const used = ['a', 'b', 'c', 'd', 'e'];
    const spec = buildDepsImportedPackagesSpec(used, 2);
    expect(spec.title).toBe('Imported packages (5)');
    expect(spec.rows.length).toBe(2);
    const footers = spec.footers ?? [];
    expect(footers).toContain('- ... and 3 more');
  });

  it('deps imported-packages spec omits the overflow footer when used ≤ displayCap', () => {
    const spec = buildDepsImportedPackagesSpec(['a', 'b'], 5);
    expect(spec.footers ?? []).toEqual([]);
  });

  it("hotspots all-risk spec title is 'Risk hotspots' (composite-shorter) + H3 heading", () => {
    const spec = buildHotspotsAllRiskSpec(
      [
        {
          filePath: 'src/foo.ts',
          fileCentrality: 0.1,
          commitCount: 5,
          loc: 100,
          lastTouchedTs: Date.now(),
          riskScore: 0.5,
        },
      ],
      Math.floor(Date.now() / 1000),
    );
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('Risk hotspots');
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/structural\s+centrality/);
    expect(allText).toMatch(/where\s+bugs\s+hide/);
    expect(spec.columns.map((c) => c.header)).toEqual([
      '#',
      'File',
      'Centrality',
      'Commits',
      'LOC',
      'Last touched',
      'Risk',
    ]);
  });

  it("hotspots all-category 'maintenance' title is 'Maintenance burden' + H3 heading", () => {
    const spec = buildHotspotsAllCategorySpec({
      rows: [
        {
          filePath: 'src/x.ts',
          fileCentrality: 0.01,
          commitCount: 20,
          loc: 100,
          lastTouchedTs: Date.now(),
        },
      ],
      category: 'maintenance',
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(spec.headingLevel).toBe(3);
    expect(spec.title).toBe('Maintenance burden');
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/refactor|tooling-debt/);
    expect(spec.columns.map((c) => c.header)).not.toContain('Risk');
  });

  it("hotspots all-category 'brittle' title is 'Brittle dependencies' + H3 heading", () => {
    const spec = buildHotspotsAllCategorySpec({
      rows: [],
      category: 'brittle',
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(spec.title).toBe('Brittle dependencies');
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/outsized\s+impact|tread\s+carefully/);
  });

  it("hotspots all-category empty state is '_No files qualify for this category._' (preserves composite empty wording)", () => {
    const spec = buildHotspotsAllCategorySpec({
      rows: [],
      category: 'maintenance',
      nowSec: Math.floor(Date.now() / 1000),
    });
    expect(spec.emptyState).toBe('_No files qualify for this category._');
  });

  it('hotspots all-risk spec renders null LOC as `—` (matching the standalone risk spec from batch 1)', () => {
    const spec = buildHotspotsAllRiskSpec(
      [
        {
          filePath: 'src/null-loc.bin',
          fileCentrality: 0.05,
          commitCount: 3,
          loc: null,
          lastTouchedTs: null,
          riskScore: 0.1,
        },
      ],
      Math.floor(Date.now() / 1000),
    );
    const locCol = spec.columns.find((c) => c.header === 'LOC');
    expect(locCol).toBeDefined();
    expect(locCol!.cell({ ...spec.rows[0]!, i: 0 })).toBe('—');
  });

  it('entry-points routes bucket title uses HTTP-handler vocabulary, H3 heading', () => {
    const spec = buildEntryPointsBucketSpec({ kind: 'routes', nodes: [], cappedExtra: 0, emptyNote: null });
    expect(spec.headingLevel).toBe(3);
    const allText = bulletListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/routes/);
    expect(allText).toMatch(/http\s+handlers/);
  });

  it("entry-points cli-commands bucket title mentions 'commander' / 'yargs'", () => {
    const spec = buildEntryPointsBucketSpec({ kind: 'cliCommands', nodes: [], cappedExtra: 0, emptyNote: null });
    const allText = bulletListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/cli\s+commands/);
    expect(allText).toMatch(/commander|yargs|caporal|cac/);
  });

  it("entry-points mcp-tools bucket title mentions 'XXX_TOOL constants'", () => {
    const spec = buildEntryPointsBucketSpec({ kind: 'mcpTools', nodes: [], cappedExtra: 0, emptyNote: null });
    const allText = bulletListSpecStrings(spec).join(' | ');
    expect(allText).toMatch(/MCP tools/);
    expect(allText).toMatch(/XXX_TOOL/);
  });

  it("entry-points cli-files bucket title mentions 'bin/' / 'cli/'", () => {
    const spec = buildEntryPointsBucketSpec({ kind: 'cliFiles', nodes: [], cappedExtra: 0, emptyNote: null });
    const allText = bulletListSpecStrings(spec).join(' | ');
    expect(allText).toMatch(/CLI files/);
    expect(allText).toMatch(/bin\/|cli\//);
  });

  it("entry-points public-exports bucket title mentions 'no in-tree callers'", () => {
    const spec = buildEntryPointsBucketSpec({ kind: 'publicExports', nodes: [], cappedExtra: 0, emptyNote: null });
    const allText = bulletListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/public\s+exports/);
    expect(allText).toMatch(/no\s+in-tree\s+callers/);
  });

  it('entry-points MCP-tools bucket uses the override row format (mcp-tool kind + parsed name tag)', () => {
    const fakeNode: Node = {
      id: 'n_1',
      name: 'FIND_TOOL',
      kind: 'constant',
      qualifiedName: 'FIND_TOOL',
      filePath: 'src/mcp/tools/find.ts',
      startLine: 10,
      endLine: 10,
      isExported: true,
      signature: "{ definition: { name: 'cartograph_find' } }",
    } as Node;
    const spec = buildEntryPointsBucketSpec({ kind: 'mcpTools', nodes: [fakeNode], cappedExtra: 0, emptyNote: null });
    const row = spec.formatRow(fakeNode);
    expect(row).toBe('- **FIND_TOOL** (mcp tool) `cartograph_find` — src/mcp/tools/find.ts:10');
  });

  it('entry-points non-MCP bucket row format includes kind + signature', () => {
    const fakeNode: Node = {
      id: 'n_2',
      name: 'cmdAttach',
      kind: 'function',
      qualifiedName: 'cmdAttach',
      filePath: 'apps/cli/src/commands/attach.ts',
      startLine: 82,
      endLine: 90,
      isExported: true,
      signature: '(args: readonly string[]): Promise<void>',
    } as Node;
    const spec = buildEntryPointsBucketSpec({ kind: 'cliFiles', nodes: [fakeNode], cappedExtra: 0, emptyNote: null });
    const row = spec.formatRow(fakeNode);
    expect(row).toBe(
      '- **cmdAttach** (function) — apps/cli/src/commands/attach.ts:82 `(args: readonly string[]): Promise<void>`',
    );
  });

  it("entry-points bucket renders capped overflow as '(+N more, capped)'", () => {
    const fakeNode: Node = {
      id: 'n_3',
      name: 'foo',
      kind: 'function',
      qualifiedName: 'foo',
      filePath: 'src/foo.ts',
      startLine: 1,
      endLine: 1,
      isExported: true,
    } as Node;
    const spec = buildEntryPointsBucketSpec({ kind: 'routes', nodes: [fakeNode], cappedExtra: 53, emptyNote: null });
    expect(spec.title).toBe('Routes (HTTP handlers) (1 (+53 more, capped))');
  });

  it('entry-points bucket with empty rows + emptyNote renders heading + note + blank line', () => {
    const spec = buildEntryPointsBucketSpec({
      kind: 'routes',
      nodes: [],
      cappedExtra: 0,
      emptyNote: '_routes: none in production source — see CLI commands bucket._',
    });
    expect(spec.title).toBe('Routes (HTTP handlers) (0)');
    const out = renderMarkdownBulletList(spec);
    expect(out).toBe(
      ['### Routes (HTTP handlers) (0)', '_routes: none in production source — see CLI commands bucket._', ''].join(
        '\n',
      ),
    );
  });

  it('tests-for direct/transitive/sameFile bucket labels use the confidence vocabulary', () => {
    const direct = buildTestsForBucketSpec('direct', []);
    const transitive = buildTestsForBucketSpec('transitive', []);
    const sameFile = buildTestsForBucketSpec('sameFile', []);
    expect(direct.title).toMatch(/Direct importers \(high confidence\) \(\d+\)/);
    expect(transitive.title).toMatch(/Transitive importers \(one hop\) \(\d+\)/);
    expect(sameFile.title).toMatch(/Tests covering this file \(symbol exercised indirectly\) \(\d+\)/);
    expect(direct.headingLevel).toBe(3);
  });

  it('tests-for dispatch spec interpolates the MCP tool name into the title', () => {
    const spec = buildTestsForDispatchSpec('cartograph_find', ['__tests__/mcp-search-family.test.ts']);
    expect(spec.title).toBe('Tests via MCP tool dispatch (cartograph_find) (1)');
    expect(spec.formatRow('__tests__/mcp-search-family.test.ts')).toBe('- `__tests__/mcp-search-family.test.ts`');
  });

  it('tests-for describe-name spec title uses INFERRED prefix', () => {
    const spec = buildTestsForDescribeNameSpec(['__tests__/foo.test.ts', '__tests__/bar.test.ts']);
    expect(spec.title).toBe('INFERRED (describe-name match) (2)');
  });

  it('tests-for no-results note + sameFile/describe-name explainer prefixes are exported for lint coverage', () => {
    // The no-results note is a fixed string — the lint walks it
    // directly so a rename has to update the constant.
    expect(TESTS_FOR_NO_RESULTS_NOTE).toMatch(/reflective\s+dispatch/);
    expect(TESTS_FOR_NO_RESULTS_NOTE).toMatch(/DI\s+containers/);
    // Explainer prefixes anchor the live-data explainers' static
    // vocabulary (the dynamic halves interpolate node.name /
    // node.filePath; the prefix is the lint-walkable anchor).
    expect(TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX).toBe('covers the file, not provably the symbol');
    expect(TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX).toBe('name-match heuristic');
    // Live-data explainers wrap the prefixes around the symbol's
    // file path / name — verify the prefix appears in the rendered
    // output.
    const fakeNode = { name: 'foo', filePath: 'src/foo.ts' } as Node;
    expect(buildTestsForSameFileExplainer(fakeNode)).toContain(TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX);
    expect(buildTestsForDescribeNameExplainer(fakeNode)).toContain(TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX);
  });

  it('renderMarkdownBulletList: empty rows + emptyNote renders heading + note + blank line (matches pre-migration appendBucket empty path)', () => {
    const spec: MarkdownBulletListSpec<unknown> = {
      title: 'Section (0)',
      headingLevel: 3,
      rows: [],
      formatRow: () => '',
      emptyState: 'fallback empty state',
      emptyNote: '_one-line note_',
    };
    expect(renderMarkdownBulletList(spec)).toBe('### Section (0)\n_one-line note_\n');
  });

  it('renderMarkdownBulletList: empty rows + no emptyNote returns emptyState verbatim', () => {
    const spec: MarkdownBulletListSpec<unknown> = {
      title: 'Section',
      rows: [],
      formatRow: () => '',
      emptyState: 'No items.',
    };
    expect(renderMarkdownBulletList(spec)).toBe('No items.');
  });

  it('renderMarkdownBulletList: formatRow returning string[] flattens multi-line rows in order', () => {
    const spec: MarkdownBulletListSpec<{ file: string; descs: number[] }> = {
      title: 'Items',
      headingLevel: 3,
      rows: [{ file: 'a.ts', descs: [10, 20] }],
      formatRow: (r) => [`- \`${r.file}\``, ...r.descs.map((l) => `  - L${l}: "desc"`)],
      emptyState: 'none',
    };
    const out = renderMarkdownBulletList(spec);
    // Heading directly followed by first bullet (no blank line); trailing
    // blank for inter-section spacing in a composing handler.
    expect(out).toBe(['### Items', '- `a.ts`', '  - L10: "desc"', '  - L20: "desc"', ''].join('\n'));
  });

  it('renderMarkdownBulletList: preamble inserts blank lines on both sides between heading and first bullet', () => {
    const spec: MarkdownBulletListSpec<{ x: string }> = {
      title: 'Items',
      headingLevel: 3,
      preamble: ['Intro line.'],
      rows: [{ x: 'a' }],
      formatRow: (r) => `- ${r.x}`,
      emptyState: 'none',
    };
    const out = renderMarkdownBulletList(spec);
    expect(out).toBe(['### Items', '', 'Intro line.', '', '- a', ''].join('\n'));
  });

  it('renderMarkdownBulletList: trailing blank line matches the pre-migration appendBucket invariant', () => {
    const spec: MarkdownBulletListSpec<string> = {
      title: 'X',
      rows: ['- one', '- two'],
      formatRow: (r) => r,
      emptyState: 'none',
    };
    expect(renderMarkdownBulletList(spec).endsWith('\n')).toBe(true);
  });

  it('bulletListSpecStrings collects title + preamble + emptyState + emptyNote + footers (excludes per-row output)', () => {
    const spec: MarkdownBulletListSpec<unknown> = {
      title: 'Section (1)',
      preamble: ['Pre line one.', 'Pre line two.'],
      rows: [],
      formatRow: () => '',
      emptyState: 'No items.',
      emptyNote: '_empty note_',
      footers: ['_footer one_'],
    };
    expect(bulletListSpecStrings(spec)).toEqual([
      'Section (1)',
      'Pre line one.',
      'Pre line two.',
      'No items.',
      '_empty note_',
      '_footer one_',
    ]);
  });

  it('preamble is included in specStrings so the lint walks user-visible prose', () => {
    const spec: MarkdownTableSpec<unknown> = {
      title: 'X',
      preamble: ['Why this matters.'],
      columns: [{ header: 'A', cell: () => '' }],
      rows: [],
      emptyState: 'empty',
    };
    expect(specStrings(spec)).toEqual(['X', 'Why this matters.', 'A', 'empty']);
  });

  it("hotspots maintenance category spec title + preamble mention 'maintenance' / 'refactor' / 'churn'", () => {
    const spec = buildHotspotsCategorySpec({
      rows: [
        {
          filePath: 'src/x.ts',
          fileCentrality: 0.01,
          commitCount: 20,
          loc: 100,
          lastTouchedTs: Date.now(),
        },
      ],
      category: 'maintenance',
      nowSec: Math.floor(Date.now() / 1000),
      minCommits: 3,
    });
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/maintenance/);
    expect(allText).toMatch(/refactor|churn/);
    // No Risk column in the category=maintenance variant.
    const headers = spec.columns.map((c) => c.header);
    expect(headers).not.toContain('Risk');
    expect(headers).toContain('Last touched');
  });

  it("hotspots brittle category spec title + preamble mention 'brittle' / 'stable critical'", () => {
    const spec = buildHotspotsCategorySpec({
      rows: [
        {
          filePath: 'src/core.ts',
          fileCentrality: 0.5,
          commitCount: 2,
          loc: 50,
          lastTouchedTs: Date.now(),
        },
      ],
      category: 'brittle',
      nowSec: Math.floor(Date.now() / 1000),
      minCommits: 3,
    });
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/brittle/);
    expect(allText).toMatch(/stable\s+critical|outsized\s+impact/);
  });

  it('hotspots brittle preamble carries the minCommits-above-floor warning when applicable', () => {
    const above = buildHotspotsCategorySpec({
      rows: [],
      category: 'brittle',
      nowSec: Math.floor(Date.now() / 1000),
      minCommits: 10,
    });
    const def = buildHotspotsCategorySpec({
      rows: [],
      category: 'brittle',
      nowSec: Math.floor(Date.now() / 1000),
      minCommits: 3,
    });
    const aboveText = (above.preamble ?? []).join(' ');
    const defText = (def.preamble ?? []).join(' ');
    expect(aboveText).toMatch(/SQL floor pre-filters/);
    expect(defText).not.toMatch(/SQL floor pre-filters/);
  });

  it('hotspots category spec renders null LOC as `—` (parity with the risk spec)', () => {
    const spec = buildHotspotsCategorySpec({
      rows: [{ filePath: 'src/null-loc.bin', fileCentrality: 0.05, commitCount: 3, loc: null, lastTouchedTs: null }],
      category: 'maintenance',
      nowSec: Math.floor(Date.now() / 1000),
      minCommits: 3,
    });
    const locCol = spec.columns.find((c) => c.header === 'LOC');
    expect(locCol).toBeDefined();
    expect(locCol!.cell({ ...spec.rows[0]!, i: 0 })).toBe('—');
  });

  it("role distribution spec title + columns use the 'role' vocabulary", () => {
    const spec = buildRoleDistributionSpec(
      [
        { role: 'business_logic', count: 30, isTotal: false },
        { role: 'util', count: 10, isTotal: false },
        { role: 'Total', count: 40, isTotal: true },
      ],
      40,
    );
    const allText = specStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/role/);
    expect(allText).toMatch(/classifier/);
    const headers = spec.columns.map((c) => c.header);
    expect(headers).toEqual(['Role', 'Count', '%']);
  });

  it('role distribution Total row renders with bold markers and 100% pct', () => {
    const spec = buildRoleDistributionSpec(
      [
        { role: 'biz', count: 7, isTotal: false },
        { role: 'Total', count: 7, isTotal: true },
      ],
      7,
    );
    const out = renderMarkdownTable(spec);
    expect(out).toContain('| **Total** | **7** | 100% |');
    // Non-Total rows render as plain text.
    expect(out).toContain('| biz | 7 | 100.0% |');
  });

  it('preamble renders between title and table header with a trailing blank line', () => {
    const spec: MarkdownTableSpec<{ n: number }> = {
      title: 'X',
      preamble: ['First.', 'Second.'],
      columns: [{ header: 'N', cell: (r) => String(r.n) }],
      rows: [{ n: 1 }],
      emptyState: 'empty',
    };
    const out = renderMarkdownTable(spec);
    expect(out).toBe(['## X', '', 'First.', 'Second.', '', '| N |', '|---|', '| 1 |'].join('\n'));
  });

  // ── blame ─────────────────────────────────────────────────────────
  // The blame timeline composes four H3 sub-sections under a top-level
  // `## Blame for ...` heading. Each sub-section's title carries the
  // domain word that distinguishes it (Earliest / Most recent / Recent
  // activity / Authors) so the agent can tell at a glance which window
  // of the line-range history the section reports.
  it("blame H3 section titles use 'Earliest' / 'Most recent' / 'Recent activity' / 'Authors'", () => {
    const fakeRow = {
      commit: {
        sha: '0123456789abcdef0123456789abcdef01234567',
        shortSha: '01234567',
        author: 'Alice',
        subject: 'first commit',
        dateIso: '2026-05-23T00:00:00Z',
      },
      coTouched: [],
      coTouchedTotal: 0,
    };
    expect(buildBlameEarliestSpec(fakeRow).title).toBe('Earliest known');
    expect(buildBlameMostRecentSpec(fakeRow).title).toBe('Most recent');
    expect(buildBlameRecentActivitySpec([fakeRow]).title).toBe('Recent activity (newest first, top 1)');
    expect(buildBlameAuthorsSpec([{ name: 'Alice', commits: 1 }], 3).title).toBe(
      'Authors (across 3 fetched commit(s))',
    );
    // All four are H3 sub-sections under the composite `## Blame for ...` header.
    expect(buildBlameEarliestSpec(fakeRow).headingLevel).toBe(3);
    expect(buildBlameMostRecentSpec(fakeRow).headingLevel).toBe(3);
    expect(buildBlameRecentActivitySpec([fakeRow]).headingLevel).toBe(3);
    expect(buildBlameAuthorsSpec([], 0).headingLevel).toBe(3);
  });

  it("blame authors formatRow distinguishes singular 'commit' from plural 'commits'", () => {
    const spec = buildBlameAuthorsSpec(
      [
        { name: 'Alice', commits: 1 },
        { name: 'Bob', commits: 3 },
      ],
      4,
    );
    const aliceLine = spec.formatRow({ name: 'Alice', commits: 1 });
    const bobLine = spec.formatRow({ name: 'Bob', commits: 3 });
    expect(aliceLine).toBe('- **Alice** — 1 commit');
    expect(bobLine).toBe('- **Bob** — 3 commits');
  });

  // ── changed-since ─────────────────────────────────────────────────
  // The bucket-label distinction is load-bearing: with `since` set the
  // tool measures wall-clock mtime, not SHA drift, so the bucket can't
  // claim "content" (audit Group 2 #3). The labels are exported so a
  // future renamer can't drop the distinction without tripping this
  // assertion + the bucket-spec interpolation tests below.
  it('changed-since bucket labels carry the content-vs-mtime distinction', () => {
    expect(CHANGED_SINCE_CONTENT_LABEL).toBe('Content-changed');
    expect(CHANGED_SINCE_THRESHOLD_LABEL).toBe('Modified after threshold (by mtime)');
    expect(CHANGED_SINCE_ADDED_LABEL).toBe('Added');
    expect(CHANGED_SINCE_DELETED_LABEL).toBe('Deleted');
  });

  it('changed-since bucket spec interpolates paths.length into the H3 title', () => {
    const spec = buildChangedSinceBucketSpec({
      label: CHANGED_SINCE_CONTENT_LABEL,
      paths: ['src/a.ts', 'src/b.ts'],
      truncated: false,
    });
    expect(spec.title).toBe('Content-changed (2)');
    expect(spec.headingLevel).toBe(3);
    expect(spec.rows).toEqual(['- `src/a.ts`', '- `src/b.ts`']);
  });

  it("changed-since bucket spec appends a '+N more' hint when paths exceeds MAX_INLINE_PATHS", () => {
    // MAX_INLINE_PATHS is 20 in changed-since.ts; 25 inputs => 20
    // shown + a '+5 more' hint row, byte-parity with the pre-migration
    // `appendBucket` overflow rendering.
    const paths = Array.from({ length: 25 }, (_, i) => `src/${i}.ts`);
    const spec = buildChangedSinceBucketSpec({
      label: CHANGED_SINCE_ADDED_LABEL,
      paths,
      truncated: false,
    });
    expect(spec.title).toBe('Added (25)');
    expect(spec.rows).toHaveLength(21);
    const lastRow = spec.rows.at(-1)!;
    expect(lastRow).toMatch(/^- _… \+5 more not shown/);
    expect(lastRow).toMatch(/Pass a more recent `since`/);
  });

  it('changed-since bucket spec surfaces the cap hint in the title when truncated', () => {
    const spec = buildChangedSinceBucketSpec({
      label: CHANGED_SINCE_CONTENT_LABEL,
      paths: ['src/a.ts'],
      truncated: true,
    });
    // Truncation is independent of paths.length — it signals the
    // scanIndexedFiles walk bailed out, not the inline-overflow cap.
    // The cap hint nests inside the count parens (byte-parity with
    // the pre-migration `appendBucket` template literal — the closing
    // `)` from the count and the cap segment's leading space + `(`
    // produce `(1 (capped at 100; …))` rather than `(1) (capped…)`).
    expect(spec.title).toBe('Content-changed (1 (capped at 100; pass since=<recent> to narrow))');
  });

  // ── dead-code (static) ───────────────────────────────────────────
  // The static-graph orphan candidates section. All three dead-code
  // paths — static (batch 8) + judge (batch 10) + uncertain-top
  // (batch 10) — are now fully migrated to spec. Linted in three
  // sub-blocks below.
  it("dead-code static spec title + preamble mention 'dead-code' / 'graph-only' / 'LLM judge'", () => {
    const fakeNode = {
      id: 'n1',
      name: 'foo',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
      endLine: 50,
      // Other Node fields aren't read by the spec; the lint walks
      // only static strings (title + preamble + emptyState).
    } as unknown as Node;
    const spec = buildDeadCodeStaticSpec({ candidates: [fakeNode], includeTests: false });
    const allText = bulletListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/dead[-\s]code/);
    expect(allText).toMatch(/graph[-\s]only|graph orphan/);
    expect(allText).toMatch(/no llm judge|llm/);
    expect(spec.title).toMatch(/^Static dead-code candidates \(1, no LLM judge\)$/);
  });

  it('dead-code static spec preamble switches phrasing on includeTests', () => {
    const fakeNode = {
      id: 'n1',
      name: 'foo',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const off = buildDeadCodeStaticSpec({ candidates: [fakeNode], includeTests: false });
    const on = buildDeadCodeStaticSpec({ candidates: [fakeNode], includeTests: true });
    const offText = (off.preamble ?? []).join(' ');
    const onText = (on.preamble ?? []).join(' ');
    // Locks the audit-friction split between "test/script paths
    // excluded" (default) and "test/script paths INCLUDED" (opt-in).
    expect(offText).toMatch(/not in test\/script paths/);
    expect(onText).toMatch(/test\/script paths INCLUDED/);
  });

  it('dead-code static spec formatRow renders the canonical orphan bullet with graph evidence', () => {
    const fakeNode = {
      id: 'n1',
      name: 'foo',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const spec = buildDeadCodeStaticSpec({ candidates: [fakeNode], includeTests: false });
    expect(spec.formatRow(fakeNode)).toBe(
      '- `foo` (function) — src/foo.ts:42 — Graph evidence: no incoming usage edges; not exported; outside test/script paths.',
    );
  });

  // ── dead-code (judge, heading-per-row card-list) ─────────────────
  // formatJudgeRows migrated to MarkdownCardListSpec in batch 10.
  // Each card heading carries the verdict tier + confidence percent +
  // optional hedge phrase when a definite DEAD/LIVE pairs with low
  // confidence (the "false-clean heading" risk the hedge mitigates).
  it("dead-code judge spec title + preamble mention 'Dead-code candidates' + graph evidence + 'LLM verdict'", () => {
    const fakeCand: DeadCodeCandidate = {
      node: {
        id: 'n1',
        name: 'foo',
        kind: 'function',
        filePath: 'src/a.ts',
        startLine: 1,
      } as unknown as Node,
      verdict: 'dead',
      confidence: 0.9,
      reason: 'No callers; not exported.',
    };
    const spec = buildDeadCodeJudgeSpec([fakeCand], 5);
    const allText = cardListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/dead-code candidates/);
    expect(allText).toMatch(/no incoming usage edges/);
    expect(allText).toMatch(/llm verdict/);
    expect(spec.title).toBe('Dead-code candidates (1 of 5 judged)');
  });

  it("dead-code judge spec rowHeading carries '[VERDICT CONF%] name (kind)' shape", () => {
    const cand: DeadCodeCandidate = {
      node: { id: 'n1', name: 'foo', kind: 'function', filePath: 'src/a.ts', startLine: 1 } as unknown as Node,
      verdict: 'dead',
      confidence: 0.87,
      reason: '',
    };
    const spec = buildDeadCodeJudgeSpec([cand], 1);
    // toFixed(0) on 0.87 * 100 → "87".
    expect(spec.rowHeading(cand)).toBe('[DEAD 87%] foo (function)');
  });

  it('dead-code judge spec appends hedge on definite verdict + low confidence', () => {
    // LOW_CONFIDENCE_HEDGE_THRESHOLD = 0.25; 0.10 * 100 → "10" — DEAD
    // at 10% confidence is the self-contradictory shape the hedge
    // catches. Locks the audit-friction "false-clean heading" fix.
    const lowDead: DeadCodeCandidate = {
      node: { id: 'n1', name: 'foo', kind: 'function', filePath: 'src/a.ts', startLine: 1 } as unknown as Node,
      verdict: 'dead',
      confidence: 0.1,
      reason: '',
    };
    const lowLive: DeadCodeCandidate = { ...lowDead, verdict: 'live' };
    const lowUncertain: DeadCodeCandidate = { ...lowDead, verdict: 'uncertain' };
    const highDead: DeadCodeCandidate = { ...lowDead, confidence: 0.5 };
    const spec = buildDeadCodeJudgeSpec([lowDead], 1);
    expect(spec.rowHeading(lowDead)).toMatch(/low confidence — treat as uncertain/);
    expect(spec.rowHeading(lowLive)).toMatch(/low confidence — treat as uncertain/);
    // Uncertain verdict is not "self-contradictory" with low confidence
    // — they agree. No hedge.
    expect(spec.rowHeading(lowUncertain)).not.toMatch(/low confidence/);
    // High confidence dead is clean — no hedge.
    expect(spec.rowHeading(highDead)).not.toMatch(/low confidence/);
  });

  it('dead-code judge spec rowBody emits file:line + graph evidence + optional > reason blockquote', () => {
    const withReason: DeadCodeCandidate = {
      node: { id: 'n1', name: 'foo', kind: 'function', filePath: 'src/a.ts', startLine: 5 } as unknown as Node,
      verdict: 'dead',
      confidence: 0.9,
      reason: 'Only call site is in a deleted test fixture.',
    };
    const withoutReason: DeadCodeCandidate = { ...withReason, reason: '' };
    const spec = buildDeadCodeJudgeSpec([withReason], 1);
    expect(spec.rowBody(withReason)).toEqual([
      'src/a.ts:5',
      'Graph evidence: no incoming usage edges; not exported; path filters already applied before judging.',
      '> Only call site is in a deleted test fixture.',
    ]);
    expect(spec.rowBody(withoutReason)).toEqual([
      'src/a.ts:5',
      'Graph evidence: no incoming usage edges; not exported; path filters already applied before judging.',
    ]);
  });

  it("dead-code judge spec rowBody drops ':line' segment when startLine is falsy", () => {
    const cand: DeadCodeCandidate = {
      node: {
        id: 'n1',
        name: 'fileLevel',
        kind: 'file',
        filePath: 'src/x.ts',
        startLine: 0,
      } as unknown as Node,
      verdict: 'dead',
      confidence: 0.9,
      reason: '',
    };
    const spec = buildDeadCodeJudgeSpec([cand], 1);
    expect(spec.rowBody(cand)).toEqual([
      'src/x.ts',
      'Graph evidence: no incoming usage edges; not exported; path filters already applied before judging.',
    ]);
  });

  // ── dead-code (uncertain top, bullet-list) ───────────────────────
  // formatJudgeEmpty's `appendUncertainTop` migrated to
  // MarkdownBulletListSpec in batch 10. Multi-line formatRow returns
  // [bullet, '  > reason'] so the optional reason blockquote stays
  // indented under its parent bullet.
  it("dead-code uncertain-top spec title pins the 'closest to dead, verify manually' hint", () => {
    const spec = buildDeadCodeUncertainTopSpec([]);
    expect(spec.title).toBe('Top uncertain candidates (closest to "dead", verify manually)');
    expect(spec.headingLevel).toBe(3);
  });

  it('dead-code uncertain-top spec formatRow renders a bullet + optional indented reason continuation', () => {
    const withReason: DeadCodeCandidate = {
      node: { id: 'n1', name: 'maybe', kind: 'function', filePath: 'src/a.ts', startLine: 12 } as unknown as Node,
      verdict: 'uncertain',
      confidence: 0.6,
      reason: 'Might be a framework hook.',
    };
    const withoutReason: DeadCodeCandidate = { ...withReason, reason: '' };
    const spec = buildDeadCodeUncertainTopSpec([withReason, withoutReason]);
    expect(spec.formatRow(withReason)).toEqual([
      '- [60% confidence uncertain] maybe (function) — src/a.ts:12',
      '  > Might be a framework hook.',
    ]);
    // No reason → single-line bullet (the string, not an array of one
    // string — preserves the bullet-list spec's string|string[] return
    // discrimination so the renderer's `else out.push(...formatted)`
    // path doesn't see a one-element array for the common case).
    expect(spec.formatRow(withoutReason)).toBe('- [60% confidence uncertain] maybe (function) — src/a.ts:12');
  });

  // ── imports (per-group, partial migration) ────────────────────────
  // The per-kind H3 group section uses MarkdownBulletListSpec; the
  // composite top-level (## Imports title + **Matched:** line + filter
  // chips + exclusion notes + empty-state) stays hand-built. The
  // target-filter case also stays hand-built (no H3 subheading, which
  // the heading-required bullet-list spec can't model).
  it('imports group spec title carries the resolution-kind + count label', () => {
    const fakeHit = {
      file: 'src/a.ts',
      line: 1,
      spec: './b',
      signature: "import './b'",
      kind: 'file' as const,
      extMissing: false,
      isDynamic: false,
      origin: 'static' as const,
    };
    const spec = buildImportsGroupSpec({ key: 'file', hits: [fakeHit], countLabel: '1', source: 'static' });
    expect(spec.title).toBe('file (1)');
    expect(spec.headingLevel).toBe(3);
  });

  it('imports group spec formatRow renders `file:line` arrow `spec` with optional flag suffix', () => {
    const baseHit = {
      file: 'src/a.ts',
      line: 12,
      spec: './b',
      signature: "import './b'",
      kind: 'file' as const,
      extMissing: false,
      isDynamic: false,
      origin: 'static' as const,
    };
    const plain = buildImportsGroupSpec({ key: 'file', hits: [baseHit], countLabel: '1', source: 'static' });
    expect(plain.formatRow(baseHit)).toBe('- `src/a.ts:12` → "./b"');

    const flaggedHit = { ...baseHit, extMissing: true, isDynamic: true };
    const flagged = buildImportsGroupSpec({ key: 'file', hits: [flaggedHit], countLabel: '1', source: 'static' });
    expect(flagged.formatRow(flaggedHit)).toBe('- `src/a.ts:12` → "./b" [ext-missing, dynamic]');
  });

  it('imports group spec surfaces the `N, showing M` cap label when slice truncated', () => {
    const fakeHit = {
      file: 'src/a.ts',
      line: 1,
      spec: './b',
      signature: "import './b'",
      kind: 'file' as const,
      extMissing: false,
      isDynamic: false,
      origin: 'static' as const,
    };
    // Locks the audit Group 2 #2 finding-fix: when the slice truncates
    // before grouping, each bucket header reports the pre-slice total
    // alongside the shown count (`file (17, showing 9)`) — verified
    // here through the countLabel parameter that flows from
    // formatGroupCountLabel.
    const spec = buildImportsGroupSpec({
      key: 'file',
      hits: [fakeHit],
      countLabel: '17, showing 9',
      source: 'static',
    });
    expect(spec.title).toBe('file (17, showing 9)');
  });

  // ── _search-fuzzy (heading-per-row canary for MarkdownCardListSpec) ──
  // First consumer of the card-list spec. Validates the spec design:
  // an H2 outer heading + one H3 card per hit (heading + body lines)
  // is byte-parity (modulo a trailing-newline drift we strip via
  // .trimEnd() at the call site) with the pre-migration hand-built
  // formatFuzzyRows output.
  it("search-fuzzy spec title carries 'Fuzzy search for' + the query string + hit count", () => {
    const spec = buildSearchFuzzySpec('handleX', [
      { name: 'handleX', dist: 0, kind: 'function', filePath: 'src/x.ts', line: 12, signature: 'handleX()' },
    ]);
    expect(spec.title).toBe('Fuzzy search for "handleX" (1 hit)');
    const allText = cardListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/fuzzy search/);
    expect(allText).toMatch(/"handlex"/);
  });

  it("search-fuzzy spec title uses plural 'hits' for >1 row", () => {
    const spec = buildSearchFuzzySpec('foo', [
      { name: 'foo', dist: 0, kind: 'function', filePath: 'src/a.ts', line: 1, signature: null },
      { name: 'foo', dist: 0, kind: 'method', filePath: 'src/b.ts', line: 2, signature: null },
    ]);
    expect(spec.title).toBe('Fuzzy search for "foo" (2 hits)');
  });

  it('search-fuzzy spec rowHeading carries match-strength annotation per FuzzyEditDistMax tier', () => {
    const spec = buildSearchFuzzySpec('foo', [
      { name: 'foo', dist: 0, kind: 'function', filePath: 'src/a.ts', line: 1, signature: null },
      { name: 'foo', dist: 3, kind: 'function', filePath: 'src/b.ts', line: 2, signature: null },
      { name: 'foo', dist: 100, kind: 'function', filePath: 'src/c.ts', line: 3, signature: null },
    ]);
    // (exact) for dist=0, (edit-dist N) within FUZZY_EDIT_DIST_MAX,
    // (token match) beyond — the rendered output reads as a stable
    // signal regardless of the underlying tier offsets in the
    // suggester's `dist` value.
    expect(spec.rowHeading(spec.rows[0]!)).toBe('foo (function) (exact)');
    expect(spec.rowHeading(spec.rows[1]!)).toBe('foo (function) (edit-dist 3)');
    expect(spec.rowHeading(spec.rows[2]!)).toBe('foo (function) (token match)');
  });

  it('search-fuzzy spec rowBody emits file:line + optional signature backticks', () => {
    const spec = buildSearchFuzzySpec('foo', [
      { name: 'foo', dist: 0, kind: 'function', filePath: 'src/a.ts', line: 12, signature: 'function foo()' },
      { name: 'foo', dist: 0, kind: 'function', filePath: 'src/b.ts', line: 5, signature: null },
    ]);
    expect(spec.rowBody(spec.rows[0]!)).toEqual(['src/a.ts:12', '`function foo()`']);
    expect(spec.rowBody(spec.rows[1]!)).toEqual(['src/b.ts:5']);
  });

  // ── _search-semantic (heading-per-row, concept branch) ────────────
  // Free-text concept search via on-the-fly embedding. The H2 outer
  // heading interpolates the query string + hit count; per-card score
  // uses toFixed(3) (raw decimal, not *100 — the in-memory cache path
  // can return raw dot products exceeding 1.0 when embeddings aren't
  // L2-normalised, so *100 would yield "12439%" labels).
  it("search-semantic concept spec title carries 'Concept cluster for' + query + hit count", () => {
    const fakeHit: SearchResult = {
      node: {
        id: 'n1',
        name: 'foo',
        kind: 'function',
        filePath: 'src/a.ts',
        startLine: 1,
        signature: 'foo()',
        language: 'typescript',
      } as unknown as Node,
      score: 0.8231,
      snippets: [],
    };
    const spec = buildSearchSemanticConceptSpec('auth flow', [fakeHit]);
    expect(spec.title).toBe('Concept cluster for "auth flow" (1 hits)');
    const allText = cardListSpecStrings(spec).join(' | ').toLowerCase();
    expect(allText).toMatch(/concept cluster/);
    expect(allText).toMatch(/"auth flow"/);
  });

  it('search-semantic concept spec rowHeading renders score via toFixed(3) (raw decimal, not *100)', () => {
    const hit: SearchResult = {
      node: {
        id: 'n1',
        name: 'foo',
        kind: 'function',
        filePath: 'src/a.ts',
        startLine: 1,
        signature: null,
        language: 'typescript',
      } as unknown as Node,
      score: 0.8231,
      snippets: [],
    };
    const spec = buildSearchSemanticConceptSpec('x', [hit]);
    expect(spec.rowHeading(hit)).toBe('foo (function) — score 0.823');
    // Locks the no-*100 invariant: a 0.8231 score must NOT render as "82%"
    // or "82.31%" — the in-memory cache returns raw dot products that can
    // exceed 1.0, so percent display would surface absurd values.
    expect(spec.rowHeading(hit)).not.toMatch(/%/);
  });

  it('search-semantic concept spec rowBody emits file:line + optional signature backticks', () => {
    const withSig: SearchResult = {
      node: {
        id: 'n1',
        name: 'foo',
        kind: 'function',
        filePath: 'src/a.ts',
        startLine: 12,
        signature: 'function foo()',
        language: 'typescript',
      } as unknown as Node,
      score: 0.5,
      snippets: [],
    };
    const withoutSig: SearchResult = {
      ...withSig,
      node: { ...withSig.node, signature: null } as unknown as Node,
    };
    const spec = buildSearchSemanticConceptSpec('x', [withSig, withoutSig]);
    expect(spec.rowBody(withSig)).toEqual(['src/a.ts:12', '`function foo()`']);
    expect(spec.rowBody(withoutSig)).toEqual(['src/a.ts:12']);
  });

  // ── _search-semantic (heading-per-row, symbol branch) ─────────────
  // Embedding-peer search rooted at one source symbol. The title
  // names the source node + its location; per-card heading carries
  // [score X, lang Y]; body adds optional `> description _(via source)_`
  // blockquote when getSymbolDescriptions returns a match.
  it("search-semantic symbol spec title carries 'Similar to' + source name+kind+file:line", () => {
    const sourceNode = {
      name: 'handleSearch',
      kind: 'function',
      filePath: 'src/search.ts',
      startLine: 42,
    };
    const spec = buildSearchSemanticSymbolSpec({
      sourceNode,
      results: [],
      descriptions: new Map(),
    });
    expect(spec.title).toBe('Similar to handleSearch (function) — src/search.ts:42');
    // Caller short-circuits empty-results via textResult — the empty
    // path is unreachable through the spec's emptyState; lint walks
    // only static title surface.
    expect(cardListSpecStrings(spec).join(' ')).toMatch(/^Similar to handleSearch/);
  });

  it('search-semantic symbol spec rowHeading shape: two spaces before [score X, lang Y]', () => {
    const hit: SearchResult = {
      node: {
        id: 'n1',
        name: 'peer',
        kind: 'method',
        filePath: 'src/b.ts',
        startLine: 5,
        language: 'python',
      } as unknown as Node,
      score: 0.701,
      snippets: [],
    };
    const spec = buildSearchSemanticSymbolSpec({
      sourceNode: { name: 'x', kind: 'function', filePath: 'src/a.ts', startLine: 1 },
      results: [hit],
      descriptions: new Map(),
    });
    // Pre-migration template literal had TWO spaces between `(kind)`
    // and `[score …]`. Byte-parity asserts the spec preserved it.
    expect(spec.rowHeading(hit)).toBe('peer (method)  [score 0.701, lang python]');
  });

  it('search-semantic symbol spec rowBody appends optional description blockquote with source attribution', () => {
    const hit: SearchResult = {
      node: {
        id: 'peer-id',
        name: 'peer',
        kind: 'method',
        filePath: 'src/b.ts',
        startLine: 5,
        language: 'python',
      } as unknown as Node,
      score: 0.7,
      snippets: [],
    };
    const descriptions = new Map<string, SymbolDescription>([
      ['peer-id', { text: 'Handles peer lookup', source: 'summary' }],
    ]);
    const spec = buildSearchSemanticSymbolSpec({
      sourceNode: { name: 'x', kind: 'function', filePath: 'src/a.ts', startLine: 1 },
      results: [hit],
      descriptions,
    });
    expect(spec.rowBody(hit)).toEqual(['src/b.ts:5', '> Handles peer lookup _(via summary)_']);

    // No description in the map → only the file:line body line, no blockquote.
    const withoutDesc = buildSearchSemanticSymbolSpec({
      sourceNode: { name: 'x', kind: 'function', filePath: 'src/a.ts', startLine: 1 },
      results: [hit],
      descriptions: new Map(),
    });
    expect(withoutDesc.rowBody(hit)).toEqual(['src/b.ts:5']);
  });

  it("search-semantic symbol spec rowBody drops the ':line' segment when startLine is 0/falsy", () => {
    const hit: SearchResult = {
      node: {
        id: 'n1',
        name: 'fileLevel',
        kind: 'file',
        filePath: 'src/x.ts',
        startLine: 0,
        language: 'typescript',
      } as unknown as Node,
      score: 0.5,
      snippets: [],
    };
    const spec = buildSearchSemanticSymbolSpec({
      sourceNode: { name: 'x', kind: 'function', filePath: 'src/a.ts', startLine: 1 },
      results: [hit],
      descriptions: new Map(),
    });
    // Pre-migration: `const loc = r.node.startLine ? \`:${r.node.startLine}\` : '';`
    // Locks byte-parity of the file-level (no startLine) rendering.
    expect(spec.rowBody(hit)).toEqual(['src/x.ts']);
  });

  // ── module (list-all path, partial migration — batch 11) ─────────
  // formatAllDirectorySummaries → card-list. The per-dir path
  // (buildModuleReport) stays hand-built (bold-prefix KeyValue card
  // disqualifier) until a KeyValueCardSpec extension lands.
  it("module summaries spec title carries 'Module summaries (showing N of M)'", () => {
    const all = [
      { dirPath: 'src/foo', summary: 'Does foo things.' },
      { dirPath: 'src/bar', summary: 'Does bar things.' },
    ];
    const spec = buildModuleSummariesSpec({ all, limit: 20 });
    expect(spec.title).toBe('Module summaries (showing 2 of 2)');
    expect(spec.rowHeading(all[0]!)).toBe('src/foo');
    // The `audit4-cli` test pins the literal "Module summaries"
    // substring — the spec MUST keep it intact.
    expect(spec.title).toContain('Module summaries');
  });

  it('module summaries spec rowBody pipes summary through tidyTruncatedSummary', () => {
    const all = [
      // Trailing bare `…` after a complete sentence — pre-migration
      // dropped it; locking that pass-through here.
      { dirPath: 'src/clean', summary: 'Clean clip. …' },
      // Trailing bare `…` mid-sentence — pre-migration replaces with
      // explicit `[summary truncated]` marker.
      { dirPath: 'src/midsentence', summary: 'Starts a thought …' },
      // Only TRAILING whitespace is trimmed — tidyTruncatedSummary
      // calls .trimEnd() (not .trim()), so leading indentation
      // (rare but possible if the LLM prefixed a paragraph) survives.
      { dirPath: 'src/whitespace', summary: '  spaced.   ' },
    ];
    const spec = buildModuleSummariesSpec({ all, limit: 20 });
    expect(spec.rowBody(all[0]!)).toEqual(['Clean clip.']);
    expect(spec.rowBody(all[1]!)).toEqual(['Starts a thought [summary truncated]']);
    expect(spec.rowBody(all[2]!)).toEqual(['  spaced.']);
  });

  it('module summaries spec footer fires only on overflow with correct singular/plural', () => {
    const all = Array.from({ length: 22 }, (_, i) => ({
      dirPath: `src/dir${i}`,
      summary: `Summary ${i}.`,
    }));

    // limit=20 → 2 overflow → "directories" (plural).
    const overflowMany = buildModuleSummariesSpec({ all, limit: 20 });
    expect(overflowMany.footers).toBeDefined();
    expect(overflowMany.footers!.join(' ')).toMatch(/2 more directories not shown/);
    // Next-step suggestion doubles the limit, capped at all.length.
    expect(overflowMany.footers!.join(' ')).toMatch(/Pass `limit: 22`/);

    // limit=21 → 1 overflow → "directory" (singular).
    const overflowOne = buildModuleSummariesSpec({ all, limit: 21 });
    expect(overflowOne.footers!.join(' ')).toMatch(/1 more directory not shown/);

    // No overflow → no footer.
    const noOverflow = buildModuleSummariesSpec({ all, limit: 25 });
    expect(noOverflow.footers).toBeUndefined();
  });

  // ── module per-dir KeyValue card (canary for MarkdownKeyValueCardSpec) ──
  // First consumer of the new KeyValueCard spec — shipped together
  // with the spec design. Locks the row LABELS (load-bearing
  // user-facing wording) and the optional preamble + footer logic.
  it("module per-dir spec title is the dirPath verbatim + emptyState is `''` (caller short-circuits)", () => {
    const spec = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 0,
      summarisedHere: 0,
      langCounts: new Map(),
      roleCounts: new Map(),
      exportNodes: [],
      intraDirEdges: 0,
      inboundEdges: 0,
      outboundEdges: 0,
    });
    expect(spec.title).toBe('src/sync');
    expect(spec.emptyState).toBe('');
    expect(spec.headingLevel).toBeUndefined(); // default H2
  });

  it('module per-dir spec always includes Files + Symbols + Coupling rows in that order', () => {
    const spec = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 12,
      summarisedHere: 7,
      langCounts: new Map(), // empty → Languages row omitted
      roleCounts: new Map(), // empty → Role mix row omitted
      exportNodes: [], //         empty → Top exports row omitted
      intraDirEdges: 3,
      inboundEdges: 5,
      outboundEdges: 2,
    });
    expect(spec.rows.map((r) => r.label)).toEqual(['Files', 'Symbols', 'Coupling']);
    expect(spec.rows[0]).toEqual({ label: 'Files', value: '4' });
    // Locks the "N summarisable (M have LLM summaries)" phrasing —
    // refactor that drops the LLM-summary subcount breaks the agent's
    // ability to see how much of the dir is summary-ready.
    expect(spec.rows[1]).toEqual({ label: 'Symbols', value: '12 summarisable (7 have LLM summaries)' });
    // Coupling shape: locks the three labels inline (intra-dir, inbound, outbound).
    expect(spec.rows[2]!.label).toBe('Coupling');
    expect(spec.rows[2]!.value).toMatch(/3 intra-dir, 5 inbound, 2 outbound/);
  });

  it('module per-dir spec conditionally adds Languages / Role mix / Top exports when non-empty', () => {
    const spec = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 12,
      summarisedHere: 7,
      langCounts: new Map([
        ['typescript', 3],
        ['python', 1],
      ]),
      roleCounts: new Map([['business_logic', 8]]),
      exportNodes: [{ name: 'foo', kind: 'function' }],
      intraDirEdges: 3,
      inboundEdges: 5,
      outboundEdges: 2,
    });
    // All 6 rows present, in canonical order.
    expect(spec.rows.map((r) => r.label)).toEqual([
      'Files',
      'Languages',
      'Symbols',
      'Coupling',
      'Role mix',
      'Top exports',
    ]);
  });

  it("module per-dir spec preamble carries tidyTruncatedSummary'd summary; footer fires only when summary missing AND totalSymbols > 0", () => {
    // Has-summary path: preamble set, no footer.
    const withSummary = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: 'The sync module orchestrates incremental indexing. …', // bare trailing …
      totalSymbols: 12,
      summarisedHere: 7,
      langCounts: new Map(),
      roleCounts: new Map(),
      exportNodes: [],
      intraDirEdges: 0,
      inboundEdges: 0,
      outboundEdges: 0,
    });
    // Trailing bare `…` after complete sentence → dropped by
    // tidyTruncatedSummary (no `[summary truncated]` marker because
    // the body ends on a `.`).
    expect(withSummary.preamble).toEqual(['The sync module orchestrates incremental indexing.']);
    expect(withSummary.footers).toBeUndefined();

    // No-summary + totalSymbols > 0 → no preamble, footer fires with the LLM hint.
    const noSummaryWithSymbols = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 12,
      summarisedHere: 7,
      langCounts: new Map(),
      roleCounts: new Map(),
      exportNodes: [],
      intraDirEdges: 0,
      inboundEdges: 0,
      outboundEdges: 0,
    });
    expect(noSummaryWithSymbols.preamble).toBeUndefined();
    expect(noSummaryWithSymbols.footers).toHaveLength(1);
    // Load-bearing pointers in the footer hint: BOTH the LLM path
    // (`cartograph_admin({action: 'summarize'})`) AND the agent-bridge
    // path (`cartograph_summaries({action: 'pending'})`) must be
    // present — the agent's environment may have one or the other.
    expect(noSummaryWithSymbols.footers![0]).toMatch(/cartograph_admin\(\{action: 'summarize'\}\)/);
    expect(noSummaryWithSymbols.footers![0]).toMatch(/cartograph_summaries\(\{action: 'pending'\}\)/);

    // No-summary + totalSymbols === 0 → no preamble, no footer
    // (nothing useful to say about an empty dir's LLM coverage).
    const noSymbols = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 0,
      summarisedHere: 0,
      langCounts: new Map(),
      roleCounts: new Map(),
      exportNodes: [],
      intraDirEdges: 0,
      inboundEdges: 0,
      outboundEdges: 0,
    });
    expect(noSymbols.preamble).toBeUndefined();
    expect(noSymbols.footers).toBeUndefined();
  });

  it('module per-dir spec via keyValueCardSpecStrings exposes title + row labels (lint walks user-facing wording, NOT values)', () => {
    const spec = buildModuleReportSpec({
      dirPath: 'src/sync',
      dirFilesCount: 4,
      summary: null,
      totalSymbols: 12,
      summarisedHere: 7,
      langCounts: new Map([['typescript', 3]]),
      roleCounts: new Map([['business_logic', 8]]),
      exportNodes: [{ name: 'foo', kind: 'function' }],
      intraDirEdges: 0,
      inboundEdges: 0,
      outboundEdges: 0,
    });
    const allText = keyValueCardSpecStrings(spec);
    // Title + 6 labels + emptyState in canonical order.
    expect(allText).toContain('src/sync');
    expect(allText).toContain('Files');
    expect(allText).toContain('Languages');
    expect(allText).toContain('Symbols');
    expect(allText).toContain('Coupling');
    expect(allText).toContain('Role mix');
    expect(allText).toContain('Top exports');
  });

  // ── _grep (per-file bullet-list, partial migration — batch 12) ───
  // formatGrepOutput's per-file H3 group sections migrated; the
  // composite top-level (## Grep results title + optional broad
  // pattern hint) and the trailing truncation / skipped-large
  // blockquote notes stay hand-built (composite report shape with
  // conditional sections).
  it('grep file spec title is `${file} (${count})` at H3', () => {
    const hits = [
      { file: 'src/foo.ts', line: 12, text: 'export function foo() {', enclosing: 'foo' },
      { file: 'src/foo.ts', line: 30, text: 'foo()', enclosing: 'bar' },
    ];
    const spec = buildGrepFileSpec({ file: 'src/foo.ts', hits });
    expect(spec.title).toBe('src/foo.ts (2)');
    expect(spec.headingLevel).toBe(3);
  });

  it("grep file spec formatRow renders 'L${line} — in `enclosing`: `snippet`' with optional enclosing prefix", () => {
    const withEnclosing = { file: 'src/foo.ts', line: 12, text: 'export function foo() {', enclosing: 'foo' };
    const withoutEnclosing = { file: 'src/foo.ts', line: 5, text: 'const X = 1;', enclosing: null };
    const spec = buildGrepFileSpec({ file: 'src/foo.ts', hits: [withEnclosing, withoutEnclosing] });
    expect(spec.formatRow(withEnclosing)).toBe('- L12 — in `foo`: `export function foo() {`');
    // Pre-migration: `const inSym = h.enclosing ? \` — in \\\`${h.enclosing}\\\`\` : '';`
    // No enclosing → no `— in` segment.
    expect(spec.formatRow(withoutEnclosing)).toBe('- L5: `const X = 1;`');
  });

  it('grep file spec formatRow .trim()s the snippet text', () => {
    // The `.trim()` on `h.text` is pre-existing — carried verbatim
    // from the pre-migration formatGrepOutput inner loop, not added
    // by this batch. `clipSnippet` upstream only enforces
    // MAX_SNIPPET_CHARS, so this is where leading indentation gets
    // stripped from the bullet. Locked in the spec so a future
    // cleanup pass can't drop it without tripping this assertion.
    const hit = { file: 'src/foo.ts', line: 1, text: '    indented code', enclosing: null };
    const spec = buildGrepFileSpec({ file: 'src/foo.ts', hits: [hit] });
    expect(spec.formatRow(hit)).toBe('- L1: `indented code`');
  });

  // ── _callees (per-source bullet-list, partial migration — batch 13) ──
  // formatGroupedCallees's inner per-source section migrates;
  // formatGroupedCallees's composite top + handleCalleesBatched's
  // composite top + buildBatchedSymbolSection's H3 wrappers stay
  // hand-built (composite report shape with conditional sections,
  // and the formatNodeList(...) helper they delegate to is shared
  // infrastructure outside the per-source-section scope).
  it('callees group spec title is `${name} (${kind}) — ${filePath}:${startLine}` at H3', () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const spec = buildCalleesGroupSpec({
      node: sourceNode,
      callees: [],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.title).toBe('fooFn (function) — src/foo.ts:42');
    expect(spec.headingLevel).toBe(3);
  });

  it("callees group spec emptyNote is '_No callees._' on empty callees", () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const spec = buildCalleesGroupSpec({
      node: sourceNode,
      callees: [],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.emptyNote).toBe('_No callees._');
    expect(spec.rows).toEqual([]);
  });

  it('callees group spec rowFormat is the identity passthrough on pre-rendered bullet strings', () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const callee = {
      node: {
        id: 'n2',
        name: 'helper',
        kind: 'function',
        filePath: 'src/helpers.ts',
        startLine: 10,
      } as unknown as Node,
      // EXTRACTED is the lowest tier — formatConfidence emits '' for it
      // (no confidence chip), so the rendered bullet stays clean.
      edge: { kind: 'calls', confidence: 'EXTRACTED' } as unknown as Edge,
    };
    const spec = buildCalleesGroupSpec({
      node: sourceNode,
      callees: [callee],
      perSourceLimit: 10,
      refIds: undefined,
    });
    // Pre-rendered bullet — formatRow is identity, so the row string
    // round-trips through the spec verbatim.
    expect(spec.rows).toHaveLength(1);
    expect(spec.rows[0]).toMatch(/^- helper \(function\) - src\/helpers\.ts:10/);
    expect(spec.formatRow(spec.rows[0]!)).toBe(spec.rows[0]);
  });

  it("callees group spec appends '- … (+N more)' overflow row inline with bullets when callees > perSourceLimit", () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    // 5 callees with perSourceLimit=2 → 3 overflow.
    const callees = Array.from({ length: 5 }, (_, i) => ({
      node: {
        id: `n${i + 2}`,
        name: `helper${i}`,
        kind: 'function',
        filePath: `src/h${i}.ts`,
        startLine: 1,
      } as unknown as Node,
      edge: { kind: 'calls', confidence: 'EXTRACTED' } as unknown as Edge,
    }));
    const spec = buildCalleesGroupSpec({
      node: sourceNode,
      callees,
      perSourceLimit: 2,
      refIds: undefined,
    });
    // 2 bullets + 1 overflow row = 3 rows total. The overflow row
    // lives inline as the last row (NOT as a footer — pre-migration
    // shape had no blank-line gap before it).
    expect(spec.rows).toHaveLength(3);
    expect(spec.rows[2]).toBe('- … (+3 more)');
  });

  // ── _callers (per-source bullet-list, partial migration — batch 14) ──
  // Mirror of the callees batch-13 migration in the opposite direction.
  // formatGroupedCallers's per-source H3 sub-section migrates;
  // composite parents (formatGroupedCallers outer, the batched-path
  // wrappers, and the formatNodeList(...) helper they delegate to)
  // stay hand-built.
  it('callers group spec title is `${name} (${kind}) — ${filePath}:${startLine}` at H3', () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const spec = buildCallersGroupSpec({
      node: sourceNode,
      callers: [],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.title).toBe('fooFn (function) — src/foo.ts:42');
    expect(spec.headingLevel).toBe(3);
  });

  it('callers group spec emptyNote uses CALLERS_NO_CALLERS_NOTE for non-constructor empties', () => {
    const sourceNode = {
      id: 'n1',
      name: 'plainFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 1,
    } as unknown as Node;
    const spec = buildCallersGroupSpec({
      node: sourceNode,
      callers: [],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.emptyNote).toBe(CALLERS_NO_CALLERS_NOTE);
    expect(CALLERS_NO_CALLERS_NOTE).toBe('_No callers._');
  });

  it('callers group spec switches emptyNote to CALLERS_CONSTRUCTOR_HINT when source is a constructor method', () => {
    // Locks the audit-friction "_No callers._ on constructor is
    // misleading" fix (Friction comment line 63 in _callers.ts):
    // constructors graph as `instantiates` on the parent class, not
    // `call` on the constructor method.
    const ctor = {
      id: 'n1',
      name: 'constructor',
      kind: 'method',
      filePath: 'src/foo.ts',
      startLine: 5,
    } as unknown as Node;
    const spec = buildCallersGroupSpec({
      node: ctor,
      callers: [],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.emptyNote).toBe(CALLERS_CONSTRUCTOR_HINT);
    // Constant body checks: pin the load-bearing "instantiates"
    // pointer and the "cartograph_callers on the enclosing class"
    // remediation so a refactor can't silently drop them.
    expect(CALLERS_CONSTRUCTOR_HINT).toMatch(/instantiates/);
    expect(CALLERS_CONSTRUCTOR_HINT).toMatch(/cartograph_callers on the enclosing class/);
  });

  it('callers group spec rowFormat is the identity passthrough on pre-rendered bullet strings', () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const caller = {
      node: {
        id: 'n2',
        name: 'callsite',
        kind: 'function',
        filePath: 'src/sites.ts',
        startLine: 7,
      } as unknown as Node,
      edge: { kind: 'calls', confidence: 'EXTRACTED' } as unknown as Edge,
    };
    const spec = buildCallersGroupSpec({
      node: sourceNode,
      callers: [caller],
      perSourceLimit: 10,
      refIds: undefined,
    });
    expect(spec.rows).toHaveLength(1);
    expect(spec.rows[0]).toMatch(/^- callsite \(function\) - src\/sites\.ts:7/);
    expect(spec.formatRow(spec.rows[0]!)).toBe(spec.rows[0]);
  });

  it("callers group spec appends '- … (+N more)' overflow row inline when callers > perSourceLimit", () => {
    const sourceNode = {
      id: 'n1',
      name: 'fooFn',
      kind: 'function',
      filePath: 'src/foo.ts',
      startLine: 42,
    } as unknown as Node;
    const callers = Array.from({ length: 7 }, (_, i) => ({
      node: {
        id: `c${i}`,
        name: `caller${i}`,
        kind: 'function',
        filePath: `src/c${i}.ts`,
        startLine: 1,
      } as unknown as Node,
      edge: { kind: 'calls', confidence: 'EXTRACTED' } as unknown as Edge,
    }));
    const spec = buildCallersGroupSpec({
      node: sourceNode,
      callers,
      perSourceLimit: 3,
      refIds: undefined,
    });
    // 3 bullets + 1 overflow row = 4 rows total.
    expect(spec.rows).toHaveLength(4);
    expect(spec.rows[3]).toBe('- … (+4 more)');
  });

  // ── review-neighbors (changed-symbols bullet-list — batch 15) ────
  // The composite top (# H1 + embedding-model / coverage metadata
  // lines) and the lookalikes card-list section both live in the
  // same render function; the H1+metadata header stays hand-built.
  it("review-neighbors changed-symbols spec title is 'Changed symbols (N)'", () => {
    const spec = buildReviewNeighborsChangedSymbolsSpec({
      changedNodes: [
        { name: 'foo', filePath: 'src/foo.ts', signature: 'foo()' },
        { name: 'bar', filePath: 'src/bar.ts', signature: null },
      ],
    });
    expect(spec.title).toBe('Changed symbols (2)');
    // Default headingLevel 2 — no embedded sub-section context here.
    expect(spec.headingLevel).toBeUndefined();
  });

  it('review-neighbors changed-symbols spec rowFormat is the identity passthrough on pre-rendered bullets', () => {
    const spec = buildReviewNeighborsChangedSymbolsSpec({
      changedNodes: [
        { name: 'foo', filePath: 'src/foo.ts', signature: 'foo(x)' },
        { name: 'bar', filePath: 'src/bar.ts', signature: null },
      ],
    });
    // Bold-prefix name + backtick filePath + optional ` — \`signature\`` suffix.
    expect(spec.rows).toEqual(['- **foo** `src/foo.ts` — `foo(x)`', '- **bar** `src/bar.ts`']);
    expect(spec.formatRow(spec.rows[0]!)).toBe(spec.rows[0]);
  });

  it("review-neighbors changed-symbols spec appends '- _(and N more)_' overflow row when changedNodes > MAX_CHANGED_DISPLAY", () => {
    // MAX_CHANGED_DISPLAY = 20 in review-neighbors.ts — pass 23 to
    // exercise the overflow path. The italic format `_(and N more)_`
    // (NOT `… +N more` like other tools) is byte-parity with the
    // pre-migration template literal.
    const changedNodes = Array.from({ length: 23 }, (_, i) => ({
      name: `sym${i}`,
      filePath: `src/${i}.ts`,
      signature: null,
    }));
    const spec = buildReviewNeighborsChangedSymbolsSpec({ changedNodes });
    expect(spec.title).toBe('Changed symbols (23)');
    // 20 shown bullets + 1 overflow row = 21 total.
    expect(spec.rows).toHaveLength(21);
    expect(spec.rows[20]).toBe('- _(and 3 more)_');
  });

  // ── review-neighbors (lookalikes card-list — batch 15) ───────────
  // Mirror of the _search-semantic concept-branch shape. Title carries
  // the singular/plural lookalike(s) count; preamble carries the load-
  // bearing "semantically similar" explanation plus an optional
  // trivial-constant filter note (friction-23). Card heading uses
  // .toFixed(3) raw-decimal score — no `*100` percent.
  it("review-neighbors lookalikes spec title pluralizes 'lookalike(s)' correctly", () => {
    const oneRow = buildReviewNeighborsLookalikesSpec({
      ranked: [
        {
          name: 'foo',
          kind: 'function',
          filePath: 'src/a.ts',
          startLine: 1,
          signature: null,
          score: 0.9,
        },
      ],
      trivialFiltered: 0,
    });
    expect(oneRow.title).toBe('Top 1 lookalike');
    const twoRows = buildReviewNeighborsLookalikesSpec({
      ranked: [
        {
          name: 'foo',
          kind: 'function',
          filePath: 'src/a.ts',
          startLine: 1,
          signature: null,
          score: 0.9,
        },
        {
          name: 'bar',
          kind: 'function',
          filePath: 'src/b.ts',
          startLine: 1,
          signature: null,
          score: 0.8,
        },
      ],
      trivialFiltered: 0,
    });
    expect(twoRows.title).toBe('Top 2 lookalikes');
  });

  it('review-neighbors lookalikes spec preamble carries REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE', () => {
    const spec = buildReviewNeighborsLookalikesSpec({ ranked: [], trivialFiltered: 0 });
    expect(spec.preamble).toEqual([REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE]);
    // Load-bearing phrase pin: the "semantically similar" framing is
    // what tells the agent the section is a similarity result, not a
    // structural one. Refactor that drops this would silently change
    // the section's meaning.
    expect(REVIEW_NEIGHBORS_LOOKALIKES_PREAMBLE).toMatch(/semantically similar/);
  });

  it('review-neighbors lookalikes spec appends a trivial-constant filter note when trivialFiltered > 0', () => {
    const oneFiltered = buildReviewNeighborsLookalikesSpec({ ranked: [], trivialFiltered: 1 });
    expect(oneFiltered.preamble).toHaveLength(3);
    expect(oneFiltered.preamble![1]).toBe('>');
    expect(oneFiltered.preamble![2]).toMatch(/Filtered 1 trivial constant /); // singular
    const manyFiltered = buildReviewNeighborsLookalikesSpec({ ranked: [], trivialFiltered: 4 });
    expect(manyFiltered.preamble![2]).toMatch(/Filtered 4 trivial constants /); // plural
    expect(manyFiltered.preamble![2]).toMatch(/embed near-identically/);
  });

  it('review-neighbors lookalikes spec rowHeading renders score via toFixed(3) (raw decimal, no `*100`)', () => {
    const row = {
      name: 'foo',
      kind: 'function',
      filePath: 'src/a.ts',
      startLine: 5,
      signature: null,
      score: 0.7234,
    };
    const spec = buildReviewNeighborsLookalikesSpec({ ranked: [row], trivialFiltered: 0 });
    expect(spec.rowHeading(row)).toBe('foo (function) — score 0.723');
    expect(spec.rowHeading(row)).not.toMatch(/%/);
  });

  it('review-neighbors lookalikes spec rowBody emits backticked `file:line` + optional `signature`', () => {
    const withSig = {
      name: 'foo',
      kind: 'function',
      filePath: 'src/a.ts',
      startLine: 12,
      signature: 'function foo()',
      score: 0.5,
    };
    const withoutSig = { ...withSig, signature: null };
    const noStartLine = { ...withSig, startLine: 0 };
    const spec = buildReviewNeighborsLookalikesSpec({
      ranked: [withSig, withoutSig, noStartLine],
      trivialFiltered: 0,
    });
    expect(spec.rowBody(withSig)).toEqual(['`src/a.ts:12`', '`function foo()`']);
    expect(spec.rowBody(withoutSig)).toEqual(['`src/a.ts:12`']);
    // Pre-migration `const loc = r.startLine ? \`:${r.startLine}\` : '';`
    // → falsy startLine drops the `:line` suffix. Lock the same shape.
    expect(spec.rowBody(noStartLine)).toEqual(['`src/a.ts`', '`function foo()`']);
  });

  // ── session (Recent sessions bullet-list — batch 16) ─────────────
  // Two list sections in `_session.ts` migrated together: Recent
  // sessions (handleList) and Saved macros (handleMacroList). The
  // other paths (create / resume / delete / macro_save / macro_run)
  // use bold-prefix KeyValue cards or composite-with-recursive-body
  // shapes — queued for a future batch (the KeyValueCard spec exists
  // as of the canary-shipping commit; deferral is workload, not
  // blocker).
  it("session recent spec title is 'Recent sessions (N)' when not truncated", () => {
    const sessions = [
      { id: 'sess-1', startedTs: 1_700_000_000_000, lastActivityTs: 1_700_000_001_000, toolCount: 3, label: 'init' },
    ];
    const spec = buildSessionRecentSpec({ sessions, total: 1 });
    expect(spec.title).toBe('Recent sessions (1)');
    // No truncation → no footer block (undefined).
    expect(spec.footers).toBeUndefined();
  });

  it("session recent spec title shows '(showing N of M)' + truncation footer when capped", () => {
    const sessions = [
      { id: 'sess-1', startedTs: 1_700_000_000_000, lastActivityTs: 1_700_000_001_000, toolCount: 3, label: null },
      { id: 'sess-2', startedTs: 1_700_000_002_000, lastActivityTs: 1_700_000_003_000, toolCount: 1, label: null },
    ];
    const spec = buildSessionRecentSpec({ sessions, total: 7 });
    expect(spec.title).toBe('Recent sessions (showing 2 of 7)');
    expect(spec.footers).toHaveLength(1);
    expect(spec.footers![0]).toMatch(/^_5 older sessions not shown — raise `limit` \(cap 100\)/);
    // Singular grammar at exactly one older session: 7 - 6 = 1 →
    // "older session" without trailing s.
    const oneOlder = buildSessionRecentSpec({
      sessions: sessions
        .concat({
          id: 'sess-3',
          startedTs: 1_700_000_004_000,
          lastActivityTs: 1_700_000_005_000,
          toolCount: 2,
          label: null,
        } as (typeof sessions)[number])
        .concat(
          Array.from({ length: 3 }, (_, i) => ({
            id: `sess-${i + 4}`,
            startedTs: 1_700_000_006_000 + i,
            lastActivityTs: 1_700_000_007_000 + i,
            toolCount: 0,
            label: null,
          })),
        ),
      total: 7,
    });
    expect(oneOlder.footers![0]).toMatch(/^_1 older session not shown/);
  });

  it("session recent spec formatRow renders 'YYYY-MM-DD HH:MM — `id` `label` • N call(s)'", () => {
    const withLabel = {
      id: 'sess-a',
      // Pick a value that's easy to assert against in UTC.
      startedTs: Date.UTC(2026, 4, 23, 8, 30, 0),
      lastActivityTs: Date.UTC(2026, 4, 23, 8, 35, 0),
      toolCount: 5,
      label: 'auth-debug',
    };
    const withoutLabel = { ...withLabel, label: null };
    const onlyOneCall = { ...withLabel, toolCount: 1 };
    const spec = buildSessionRecentSpec({ sessions: [withLabel], total: 1 });
    // YYYY-MM-DD HH:MM UTC formatting per fmtTs's ISO slice.
    expect(spec.formatRow(withLabel)).toBe('- 2026-05-23 08:30 — `sess-a` `auth-debug` • 5 calls');
    expect(spec.formatRow(withoutLabel)).toBe('- 2026-05-23 08:30 — `sess-a` • 5 calls');
    expect(spec.formatRow(onlyOneCall)).toBe('- 2026-05-23 08:30 — `sess-a` `auth-debug` • 1 call');
  });

  it('session recent spec emptyState pins SESSIONS_EMPTY_NOTE', () => {
    const spec = buildSessionRecentSpec({ sessions: [], total: 0 });
    expect(spec.emptyState).toBe(SESSIONS_EMPTY_NOTE);
    expect(SESSIONS_EMPTY_NOTE).toBe('_No sessions recorded yet._');
  });

  // ── session (Saved macros bullet-list — batch 16) ────────────────
  it('saved-macros spec title interpolates the macro count', () => {
    const macros = [{ name: 'find-callers', steps: [{}, {}], createdTs: Date.UTC(2026, 4, 1), lastRunTs: null }];
    const spec = buildSavedMacrosSpec({ macros });
    expect(spec.title).toBe('Saved macros (1)');
  });

  it("saved-macros spec formatRow renders 'name — N step(s), created TS, last run / never run'", () => {
    const created = Date.UTC(2026, 4, 1, 12, 0, 0);
    const lastRun = Date.UTC(2026, 4, 20, 9, 30, 0);
    const ran = { name: 'find-callers', steps: [{}, {}, {}], createdTs: created, lastRunTs: lastRun };
    const neverRan = { name: 'tidy', steps: [{}], createdTs: created, lastRunTs: null };
    const spec = buildSavedMacrosSpec({ macros: [ran, neverRan] });
    expect(spec.formatRow(ran)).toBe('- `find-callers` — 3 steps, created 2026-05-01 12:00, last run 2026-05-20 09:30');
    expect(spec.formatRow(neverRan)).toBe('- `tidy` — 1 step, created 2026-05-01 12:00, never run');
  });

  it('saved-macros spec emptyState pins MACROS_EMPTY_NOTE', () => {
    const spec = buildSavedMacrosSpec({ macros: [] });
    expect(spec.emptyState).toBe(MACROS_EMPTY_NOTE);
    expect(MACROS_EMPTY_NOTE).toBe('_No saved macros._');
  });

  // ── trace-to-culprits (card-list + two bullet-lists — batch 17) ──
  // formatReport's three sections all migrated: top-level "## Trace
  // analysis" card-list (one card per culprit with reasons as bullet
  // body lines) plus two H3 sub-section bullet-lists (Frames not
  // mapped + Frames in module-level / unenclosed lines).
  it('trace-culprits spec title interpolates frame counts with singular/plural', () => {
    const oneFrame = buildTraceCulpritsSpec({ candidates: [], totalParsed: 1, limit: 5 });
    expect(oneFrame.title).toBe('Trace analysis — 1 frame parsed, 0 mapped to indexed symbols');
    const manyFrames = buildTraceCulpritsSpec({ candidates: [], totalParsed: 4, limit: 5 });
    expect(manyFrames.title).toBe('Trace analysis — 4 frames parsed, 0 mapped to indexed symbols');
  });

  it('trace-culprits spec emptyState pre-renders the H2 title + TRACE_CULPRITS_EMPTY_NOTE', () => {
    // Empty-candidates path: the renderer returns emptyState verbatim
    // (no heading chrome). Pre-migration emitted the H2 title BEFORE
    // the empty note so the parsed/mapped diagnostic counts stayed
    // visible. The spec embeds the title in emptyState to preserve
    // that — flagged as a regression in batch 17 reviewer round 1,
    // fixed in the same commit. Lock both halves:
    const spec = buildTraceCulpritsSpec({ candidates: [], totalParsed: 5, limit: 5 });
    expect(spec.emptyState).toBe(
      `## Trace analysis — 5 frames parsed, 0 mapped to indexed symbols\n\n${TRACE_CULPRITS_EMPTY_NOTE}`,
    );
    // Load-bearing diagnostic phrases inside the note: `node_modules/`
    // + "out of date" tell the agent the two most-likely causes.
    // Refactor that drops either silently degrades empty-result triage.
    expect(TRACE_CULPRITS_EMPTY_NOTE).toMatch(/node_modules\//);
    expect(TRACE_CULPRITS_EMPTY_NOTE).toMatch(/index is out of date/);
  });

  it('trace-culprits spec emptyState handles singular frame count + zero-parsed edge', () => {
    // Singular grammar at totalParsed=1.
    const one = buildTraceCulpritsSpec({ candidates: [], totalParsed: 1, limit: 5 });
    expect(one.emptyState).toMatch(/^## Trace analysis — 1 frame parsed, 0 mapped/);
    // totalParsed=0 (degenerate but reachable on empty trace input).
    const zero = buildTraceCulpritsSpec({ candidates: [], totalParsed: 0, limit: 5 });
    expect(zero.emptyState).toMatch(/^## Trace analysis — 0 frames parsed, 0 mapped/);
  });

  it('trace-culprits spec rowHeading carries `(score X.XX)` annotation with TWO-space gap', () => {
    const culprit = {
      node: {
        id: 'n1',
        name: 'handleErr',
        kind: 'function',
        filePath: 'src/err.ts',
        startLine: 42,
      } as unknown as Node,
      topRank: 0,
      score: 0.87,
      reasons: ['top-of-stack match', 'has callers'],
    };
    const spec = buildTraceCulpritsSpec({ candidates: [culprit], totalParsed: 3, limit: 5 });
    // toFixed(2) — score 0.87 → "0.87". TWO spaces between `)` and
    // `_(score …)` per pre-migration template literal.
    expect(spec.rowHeading(culprit)).toBe('handleErr (function) — `src/err.ts:42`  _(score 0.87)_');
  });

  it('trace-culprits spec rowBody emits each reason as a `- ${reason}` bullet line', () => {
    const culprit = {
      node: { id: 'n1', name: 'foo', kind: 'function', filePath: 'src/foo.ts', startLine: 1 } as unknown as Node,
      topRank: 0,
      score: 0.5,
      reasons: ['matches top frame', 'declared in changed file', 'has 3 callers'],
    };
    const spec = buildTraceCulpritsSpec({ candidates: [culprit], totalParsed: 1, limit: 5 });
    expect(spec.rowBody(culprit)).toEqual(['- matches top frame', '- declared in changed file', '- has 3 callers']);
  });

  it('trace-culprits spec appends truncation footer only when candidates.length > limit', () => {
    const make = (n: number) =>
      Array.from({ length: n }, (_, i) => ({
        node: {
          id: `n${i}`,
          name: `c${i}`,
          kind: 'function',
          filePath: `src/c${i}.ts`,
          startLine: 1,
        } as unknown as Node,
        topRank: i,
        score: 1 - i * 0.01,
        reasons: ['r'],
      }));
    const noTrunc = buildTraceCulpritsSpec({ candidates: make(3), totalParsed: 3, limit: 5 });
    expect(noTrunc.footers).toBeUndefined();
    const trunc = buildTraceCulpritsSpec({ candidates: make(8), totalParsed: 10, limit: 5 });
    expect(trunc.footers).toHaveLength(1);
    expect(trunc.footers![0]).toMatch(/^> _Showing top 5 of 8 candidates\./);
    expect(trunc.footers![0]).toMatch(/Pass a higher `limit`/);
  });

  // ── trace-to-culprits frame sub-sections ────────────────────────
  it('trace unmapped-frames spec title + bullets + 5-cap overflow hint', () => {
    const frames = Array.from({ length: 7 }, (_, i) => ({
      raw: `at ${i}`,
      file: `n_modules/dep${i}/index.js`,
      line: i + 1,
      rank: i,
    }));
    const spec = buildTraceUnmappedFramesSpec(frames);
    expect(spec.title).toBe('Frames not mapped to indexed code (7)');
    expect(spec.headingLevel).toBe(3);
    // 5 bullets + 1 overflow with the node_modules / generated /
    // unindexed hint preserved verbatim.
    expect(spec.rows).toHaveLength(6);
    expect(spec.rows[0]).toBe('- `n_modules/dep0/index.js:1`');
    expect(spec.rows[5]).toBe('- … and 2 more (likely `node_modules/` / generated / unindexed)');
  });

  it('trace unmapped-frames spec omits overflow row when frames <= 5', () => {
    const frames = Array.from({ length: 5 }, (_, i) => ({ raw: '', file: `a${i}.js`, line: i, rank: i }));
    const spec = buildTraceUnmappedFramesSpec(frames);
    expect(spec.rows).toHaveLength(5);
    // No "… and N more" tail.
    expect(spec.rows.some((r) => r.startsWith('- … and'))).toBe(false);
  });

  it('trace gap-frames spec emits the module-level hint inline with each bullet', () => {
    const frames = [{ raw: '', file: 'src/init.ts', line: 7, rank: 0 }];
    const spec = buildTraceGapFramesSpec(frames);
    expect(spec.title).toBe('Frames in module-level / unenclosed lines (1)');
    expect(spec.headingLevel).toBe(3);
    expect(spec.rows[0]).toMatch(/^- `src\/init\.ts:7`/);
    // Load-bearing hint that distinguishes the gap case from the
    // unmapped case: file IS indexed, just line is between symbol
    // bodies. Locked here so a future refactor doesn't conflate the
    // two messages.
    expect(spec.rows[0]).toMatch(/file is indexed/);
    expect(spec.rows[0]).toMatch(/module-level top-level code/);
  });

  // ── history (symbol-level co-change — batch 18) ─────────────────
  // Two render targets: renderCoChangeReport (symbol-level, bullet
  // list with the two-line `[bullet, '  N shared commits: shas]`
  // per-row shape) and renderFileLevelFallback (file-level fallback
  // with dynamic preamble + optional ambiguous-name warning).
  it('co-change history spec title carries `Co-change history for ${symbol}` and binds preamble to ownModifiedCount + minCount', () => {
    const spec = buildCoChangeHistorySpec({
      symbol: 'handleClick',
      ownModifiedCount: 7,
      minCount: 2,
      rows: [{ name: 'handleHover', kind: 'function', filePath: 'src/ui.ts', line: 12, coOccurrences: 4, shared: [] }],
    });
    expect(spec.title).toBe('Co-change history for `handleClick`');
    expect(spec.preamble).toEqual([
      '_Source has 7 modification(s) in tracked history. Showing symbols modified in ≥ 2 of the same commits._',
    ]);
  });

  it("co-change history spec formatRow returns two-line `[bullet, '  N shared commits: shas]` per row", () => {
    const row = {
      name: 'foo',
      kind: 'function',
      filePath: 'src/foo.ts',
      line: 42,
      coOccurrences: 3,
      shared: ['abc1234deadbeef', 'def5678cafebabe', '7890123fedcba98'],
    };
    const spec = buildCoChangeHistorySpec({ symbol: 'x', ownModifiedCount: 5, minCount: 2, rows: [row] });
    // SHARED_SHA_PREVIEW=3, SHORT_SHA_LEN=7 — at exactly the preview
    // cap, no overflow tail (`(+N more)` absent).
    const formatted = spec.formatRow(row);
    expect(Array.isArray(formatted)).toBe(true);
    expect(formatted).toEqual([
      '- **foo** (function) — src/foo.ts:42',
      '  3 shared commits: abc1234, def5678, 7890123',
    ]);
  });

  it('co-change history spec formatRow handles singular `commit` + overflow `+N more`', () => {
    const singular = {
      name: 'foo',
      kind: 'function',
      filePath: 'src/foo.ts',
      line: 1,
      coOccurrences: 1,
      shared: ['abc1234deadbeef'],
    };
    const overflow = {
      name: 'bar',
      kind: 'function',
      filePath: 'src/bar.ts',
      line: 1,
      coOccurrences: 5,
      shared: ['a'.repeat(40), 'b'.repeat(40), 'c'.repeat(40), 'd'.repeat(40), 'e'.repeat(40)],
    };
    const spec = buildCoChangeHistorySpec({
      symbol: 'x',
      ownModifiedCount: 5,
      minCount: 2,
      rows: [singular, overflow],
    });
    expect(spec.formatRow(singular)).toEqual(['- **foo** (function) — src/foo.ts:1', '  1 shared commit: abc1234']);
    // 5 SHAs - 3-preview = 2 overflow → `(+2 more)` tail.
    expect(spec.formatRow(overflow)).toEqual([
      '- **bar** (function) — src/bar.ts:1',
      '  5 shared commits: aaaaaaa, bbbbbbb, ccccccc (+2 more)',
    ]);
  });

  it("co-change history spec footer carries the load-bearing 'pre-edit check' pointer", () => {
    const spec = buildCoChangeHistorySpec({
      symbol: 'handleClick',
      ownModifiedCount: 5,
      minCount: 2,
      rows: [],
    });
    expect(spec.footers).toHaveLength(1);
    expect(spec.footers![0]).toMatch(/^> _Pre-edit check: when you change `handleClick`/);
    // Load-bearing phrase pin: "Worth grep-ing before you ship" is the
    // friction guidance that captures the tool's intended use.
    expect(spec.footers![0]).toMatch(/Worth grep-ing before you ship/);
  });

  // ── history (file-level fallback — batch 18) ────────────────────
  it('file-level co-change spec title names both the file (keyed) and the symbol (queried)', () => {
    const spec = buildFileLevelCoChangeSpec({
      symbol: 'handleClick',
      filePath: 'src/ui.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [],
      nameAmbiguous: false,
    });
    expect(spec.title).toBe('File-level co-change for `src/ui.ts` (fallback for `handleClick`)');
  });

  it("file-level co-change spec preamble computes 3 distinct 'why' clauses for the fallback trigger", () => {
    // Case 1: repo has no issue-tagged commits at all.
    const noIssues = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'a.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [],
      nameAmbiguous: false,
    });
    expect(noIssues.preamble![0]).toMatch(/no issue-tagged \(`Fixes #N` \/ `Closes #N` \/ `Resolves #N`\) commits/);

    // Case 2: mining ran but this symbol has no issue-tagged modifications.
    const symbolNoMods = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'a.ts',
      ownModifiedCount: 0,
      repoIssueCount: 10,
      minCount: 2,
      rows: [],
      nameAmbiguous: false,
    });
    expect(symbolNoMods.preamble![0]).toMatch(/`x` has no modifications in issue-tagged commits/);

    // Case 3: symbol has modifications but no co-changes ≥ minCount.
    const thresholdNotMet = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'a.ts',
      ownModifiedCount: 3,
      repoIssueCount: 10,
      minCount: 5,
      rows: [],
      nameAmbiguous: false,
    });
    expect(thresholdNotMet.preamble![0]).toMatch(/`x` has no symbol-level co-changes ≥ 5/);
  });

  it('file-level co-change spec preamble appends ambiguous-name warning when nameAmbiguous is true', () => {
    const clean = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'a.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [],
      nameAmbiguous: false,
    });
    expect(clean.preamble).toHaveLength(1);

    const ambiguous = buildFileLevelCoChangeSpec({
      symbol: 'commonName',
      filePath: 'a.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [],
      nameAmbiguous: true,
    });
    expect(ambiguous.preamble).toHaveLength(3);
    expect(ambiguous.preamble![1]).toBe('');
    expect(ambiguous.preamble![2]).toMatch(/^> ⚠ `commonName` is an ambiguous name/);
    // Locks the load-bearing pointer to `n_` UID re-query.
    expect(ambiguous.preamble![2]).toMatch(/re-query with an `n_` UID/);
  });

  it('file-level co-change spec formatRow renders `- file — N shared commit(s) (jaccard X.XX, Y% of anchor)`', () => {
    const oneCommit = { path: 'src/peer.ts', count: 1, jaccard: 0.45, anchorRatio: 0.123 };
    const manyCommits = { path: 'src/peer.ts', count: 7, jaccard: 0.5, anchorRatio: 0.8 };
    const spec = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'a.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [oneCommit, manyCommits],
      nameAmbiguous: false,
    });
    // jaccard via toFixed(2); anchorRatio via Math.round(_ * 100).
    expect(spec.formatRow(oneCommit)).toBe('- `src/peer.ts` — 1 shared commit (jaccard 0.45, 12% of anchor)');
    expect(spec.formatRow(manyCommits)).toBe('- `src/peer.ts` — 7 shared commits (jaccard 0.50, 80% of anchor)');
  });

  it('file-level co-change spec footer pins the `cartograph_at_range` scope-hint pointer', () => {
    const spec = buildFileLevelCoChangeSpec({
      symbol: 'x',
      filePath: 'src/ui.ts',
      ownModifiedCount: 0,
      repoIssueCount: 0,
      minCount: 2,
      rows: [],
      nameAmbiguous: false,
    });
    expect(spec.footers).toHaveLength(1);
    expect(spec.footers![0]).toMatch(/^> _Pre-edit check: when you change `src\/ui\.ts`/);
    expect(spec.footers![0]).toMatch(/cartograph_at_range/);
  });

  // ── review-context (co-change warnings — batch 19) ──────────────
  // PARTIAL migration: only the H2 "Co-change warnings" section is
  // spec-shaped. The per-file `renderReviewedFile` section is shape-
  // disqualified (each file is an H3 card without an outer H2
  // container — same family as `_walk.ts`'s flat-text-header).
  it("review-context co-change warnings spec title pins 'Co-change warnings' + preamble carries the load-bearing phrasing", () => {
    const spec = buildReviewContextCoChangeWarningsSpec([]);
    expect(spec.title).toBe('Co-change warnings');
    expect(spec.preamble).toEqual([REVIEW_CONTEXT_COCHANGE_PREAMBLE]);
    // Load-bearing phrases: "historically change together" + "NOT
    // touched in this diff" — these define what the section means.
    // A refactor that loses either silently changes the meaning.
    expect(REVIEW_CONTEXT_COCHANGE_PREAMBLE).toMatch(/historically change together/);
    expect(REVIEW_CONTEXT_COCHANGE_PREAMBLE).toMatch(/NOT touched in this diff/);
  });

  it('review-context co-change formatRow renders bullet + optional anchor-ratio + singular/plural commit', () => {
    const minimal = {
      changedFile: 'src/handler.ts',
      expectedToChange: 'src/peer.ts',
      jaccard: 0.43,
      historicalCount: 1,
      note: '',
    };
    const withAnchor = {
      ...minimal,
      anchorRatio: 0.621,
      historicalCount: 5,
    };
    const spec = buildReviewContextCoChangeWarningsSpec([minimal, withAnchor]);
    // Singular commit, no anchor-ratio segment.
    expect(spec.formatRow(minimal)).toBe(
      '- `src/peer.ts` — co-changes with `src/handler.ts` (jaccard 0.43, 1 shared commit)',
    );
    // Plural commits + anchor-ratio via toFixed(2).
    expect(spec.formatRow(withAnchor)).toBe(
      '- `src/peer.ts` — co-changes with `src/handler.ts` (jaccard 0.43, anchor-ratio 0.62, 5 shared commits)',
    );
  });

  it('review-context co-change formatRow appends `  - ${note}` indented continuation when note is non-empty', () => {
    const withNote = {
      changedFile: 'src/handler.ts',
      expectedToChange: 'src/peer.ts',
      jaccard: 0.5,
      historicalCount: 3,
      note: 'symbol-level co-change found — see `cartograph_history`',
    };
    const spec = buildReviewContextCoChangeWarningsSpec([withNote]);
    expect(spec.formatRow(withNote)).toEqual([
      '- `src/peer.ts` — co-changes with `src/handler.ts` (jaccard 0.50, 3 shared commits)',
      '  - symbol-level co-change found — see `cartograph_history`',
    ]);
  });

  // ── _impact (Source symbols + Concentration by file — batch 20) ──
  // PARTIAL migration: two clean H3 bullet-list sub-sections move
  // onto the spec; the per-source-impact's `### Concentration by file
  // per source` (with `**file:**` bold-prefix sub-headers per source)
  // and the per-file detail's `**file:**` comma-list bodies stay
  // hand-built. Both are KeyValueCard-shape; queued for a future
  // batch now that MarkdownKeyValueCardSpec exists (deferral is
  // workload, not blocker).
  it("impact source-symbols spec title is 'Source symbols' at H3", () => {
    const fakeNode = (n: string, k: string, p: string, l: number): Node =>
      ({ id: n, name: n, kind: k, filePath: p, startLine: l }) as unknown as Node;
    const spec = buildImpactSourceSymbolsSpec([{ node: fakeNode('a', 'function', 'src/a.ts', 1), nodes: new Map() }]);
    expect(spec.title).toBe('Source symbols');
    expect(spec.headingLevel).toBe(3);
  });

  it('impact source-symbols spec formatRow renders `- file:line (kind) → N symbols`', () => {
    const node = { id: 'n1', name: 'foo', kind: 'function', filePath: 'src/foo.ts', startLine: 42 } as unknown as Node;
    const noLineNode = {
      id: 'n2',
      name: 'top',
      kind: 'file',
      filePath: 'src/index.ts',
      startLine: 0,
    } as unknown as Node;
    const sources = [
      { node, nodes: new Map([['x', node]]) },
      { node: noLineNode, nodes: new Map() },
    ];
    const spec = buildImpactSourceSymbolsSpec(sources);
    // The non-zero startLine adds the `:line` suffix; falsy startLine
    // (0/undefined) drops it — pre-migration `node.startLine ? :line : ''`.
    expect(spec.formatRow(sources[0]!)).toBe('- `src/foo.ts:42` (function) → 1 symbols');
    expect(spec.formatRow(sources[1]!)).toBe('- `src/index.ts` (file) → 0 symbols');
  });

  it("impact concentration spec title is 'Concentration by file' at H3", () => {
    const spec = buildImpactConcentrationSpec([{ file: 'src/a.ts', count: 5 }]);
    expect(spec.title).toBe('Concentration by file');
    expect(spec.headingLevel).toBe(3);
  });

  it('impact concentration spec pre-renders bullets `- \\`file\\` — N` with identity passthrough', () => {
    const spec = buildImpactConcentrationSpec([
      { file: 'src/queries.ts', count: 57 },
      { file: 'src/index.ts', count: 12 },
    ]);
    expect(spec.rows).toEqual(['- `src/queries.ts` — 57', '- `src/index.ts` — 12']);
    expect(spec.formatRow(spec.rows[0]!)).toBe(spec.rows[0]);
  });

  it('impact concentration spec appends `- … and N more files` overflow at 10-cap', () => {
    // IMPACT_CONCENTRATION_ROLLUP_TOP = 10 — pass 13 to exercise overflow.
    const rollup = Array.from({ length: 13 }, (_, i) => ({ file: `src/${i}.ts`, count: 13 - i }));
    const spec = buildImpactConcentrationSpec(rollup);
    expect(spec.rows).toHaveLength(11); // 10 shown + 1 overflow
    expect(spec.rows[10]).toBe('- … and 3 more files');
  });

  it('impact concentration spec omits overflow row when rollup <= 10', () => {
    const rollup = Array.from({ length: 10 }, (_, i) => ({ file: `src/${i}.ts`, count: 10 - i }));
    const spec = buildImpactConcentrationSpec(rollup);
    expect(spec.rows).toHaveLength(10);
    expect(spec.rows.some((r) => r.startsWith('- … and'))).toBe(false);
  });
});

describe('MarkdownTableColumn type — declarations compose cleanly', () => {
  it('supports cell extractors that read computed indices', () => {
    interface Row {
      name: string;
      rank: number;
    }
    const cols: ReadonlyArray<MarkdownTableColumn<Row>> = [
      { header: '#', align: 'right', cell: (r) => String(r.rank) },
      { header: 'Name', cell: (r) => r.name },
    ];
    expect(cols[0]!.cell({ name: 'a', rank: 1 })).toBe('1');
    expect(cols[1]!.cell({ name: 'a', rank: 1 })).toBe('a');
  });
});

describe('renderMarkdownCardList — output shape', () => {
  interface Hit {
    name: string;
    kind: string;
    file: string;
    line: number;
    signature?: string;
  }

  it('renders a minimal one-card list with H2 title + H3 row heading + body line', () => {
    const spec: MarkdownCardListSpec<Hit> = {
      title: 'Stuff',
      rows: [{ name: 'foo', kind: 'function', file: 'src/foo.ts', line: 42 }],
      rowHeading: (r) => `${r.name} (${r.kind})`,
      rowBody: (r) => [`${r.file}:${r.line}`],
      emptyState: 'No stuff.',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['## Stuff', '', '### foo (function)', 'src/foo.ts:42', ''].join('\n'));
  });

  it('returns the emptyState message verbatim when rows is empty — no title, no chrome', () => {
    const spec: MarkdownCardListSpec<unknown> = {
      title: 'Stuff',
      rows: [],
      rowHeading: () => '',
      rowBody: () => [],
      emptyState: 'No stuff at all.',
    };
    expect(renderMarkdownCardList(spec)).toBe('No stuff at all.');
  });

  it('separates multiple cards with one blank line', () => {
    const spec: MarkdownCardListSpec<Hit> = {
      title: 'Stuff',
      rows: [
        { name: 'foo', kind: 'function', file: 'src/a.ts', line: 1 },
        { name: 'bar', kind: 'class', file: 'src/b.ts', line: 2 },
      ],
      rowHeading: (r) => `${r.name} (${r.kind})`,
      rowBody: (r) => [`${r.file}:${r.line}`],
      emptyState: 'empty',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(
      ['## Stuff', '', '### foo (function)', 'src/a.ts:1', '', '### bar (class)', 'src/b.ts:2', ''].join('\n'),
    );
  });

  it('supports multi-line rowBody — file:line, signature, blockquote', () => {
    const spec: MarkdownCardListSpec<Hit> = {
      title: 'Stuff',
      rows: [{ name: 'foo', kind: 'function', file: 'src/a.ts', line: 1, signature: 'foo(x)' }],
      rowHeading: (r) => `${r.name} (${r.kind})`,
      rowBody: (r) => {
        const lines: string[] = [`${r.file}:${r.line}`];
        if (r.signature) lines.push(`\`${r.signature}\``);
        return lines;
      },
      emptyState: 'empty',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['## Stuff', '', '### foo (function)', 'src/a.ts:1', '`foo(x)`', ''].join('\n'));
  });

  it('handles heading-only cards (empty rowBody)', () => {
    const spec: MarkdownCardListSpec<{ name: string }> = {
      title: 'Bare',
      rows: [{ name: 'one' }, { name: 'two' }],
      rowHeading: (r) => r.name,
      rowBody: () => [],
      emptyState: 'empty',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['## Bare', '', '### one', '', '### two', ''].join('\n'));
  });

  it('preamble renders between title and first card with a trailing blank line', () => {
    const spec: MarkdownCardListSpec<{ name: string }> = {
      title: 'X',
      preamble: ['First.', 'Second.'],
      rows: [{ name: 'one' }],
      rowHeading: (r) => r.name,
      rowBody: () => [],
      emptyState: 'empty',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['## X', '', 'First.', 'Second.', '', '### one', ''].join('\n'));
  });

  it('appends footers after the last card with a blank-line separator', () => {
    const spec: MarkdownCardListSpec<{ name: string }> = {
      title: 'X',
      rows: [{ name: 'one' }],
      rowHeading: (r) => r.name,
      rowBody: () => ['body'],
      emptyState: 'empty',
      footers: ['_footer 1_', '_footer 2_'],
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['## X', '', '### one', 'body', '', '_footer 1_', '_footer 2_', ''].join('\n'));
  });

  it('honors outer headingLevel: 3 + rowHeadingLevel: 4 for embedded sub-sections', () => {
    const spec: MarkdownCardListSpec<{ name: string }> = {
      title: 'X',
      headingLevel: 3,
      rowHeadingLevel: 4,
      rows: [{ name: 'one' }],
      rowHeading: (r) => r.name,
      rowBody: () => [],
      emptyState: 'empty',
    };
    const out = renderMarkdownCardList(spec);
    expect(out).toBe(['### X', '', '#### one', ''].join('\n'));
  });
});

describe('cardListSpecStrings — collects every user-visible string for lint use', () => {
  it('returns title, every preamble line, emptyState, and every footer', () => {
    const spec: MarkdownCardListSpec<unknown> = {
      title: 'Stuff (top 3)',
      preamble: ['Pre 1', 'Pre 2'],
      rows: [],
      rowHeading: () => '',
      rowBody: () => [],
      emptyState: 'No stuff.',
      footers: ['Foot 1', 'Foot 2'],
    };
    expect(cardListSpecStrings(spec)).toEqual(['Stuff (top 3)', 'Pre 1', 'Pre 2', 'No stuff.', 'Foot 1', 'Foot 2']);
  });

  it('excludes per-row content (rowHeading/rowBody see dynamic data, not static wording)', () => {
    const spec: MarkdownCardListSpec<{ secret: string }> = {
      title: 'X',
      rows: [{ secret: 'should-not-appear' }],
      rowHeading: (r) => r.secret,
      rowBody: (r) => [r.secret],
      emptyState: 'empty',
    };
    expect(cardListSpecStrings(spec)).toEqual(['X', 'empty']);
  });
});

describe('renderMarkdownKeyValueCard — output shape', () => {
  it('renders a minimal one-row card with H2 title + `**Label:** value` row', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'Stuff',
      rows: [{ label: 'Files', value: '42' }],
      emptyState: 'No stuff.',
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toBe(['## Stuff', '', '**Files:** 42', ''].join('\n'));
  });

  it('returns the emptyState message verbatim when rows is empty — no title, no chrome', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'Stuff',
      rows: [],
      emptyState: 'No stuff at all.',
    };
    expect(renderMarkdownKeyValueCard(spec)).toBe('No stuff at all.');
  });

  it('renders multiple rows FLUSH (no blank line between them)', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'Stats',
      rows: [
        { label: 'Files', value: '42' },
        { label: 'Languages', value: 'ts 12, py 4' },
        { label: 'Symbols', value: '120 summarisable' },
      ],
      emptyState: 'empty',
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toBe(
      ['## Stats', '', '**Files:** 42', '**Languages:** ts 12, py 4', '**Symbols:** 120 summarisable', ''].join('\n'),
    );
  });

  it('renders the value verbatim (no escaping) — caller controls inline markdown', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'X',
      rows: [
        { label: 'id', value: '`sess-abc`' },
        { label: 'Top exports', value: '`foo` (function), `bar` (class)' },
      ],
      emptyState: 'empty',
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toContain('**id:** `sess-abc`');
    expect(out).toContain('**Top exports:** `foo` (function), `bar` (class)');
  });

  it('preamble renders between title and first row with a trailing blank line', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'X',
      preamble: ['First.', 'Second.'],
      rows: [{ label: 'Key', value: 'val' }],
      emptyState: 'empty',
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toBe(['## X', '', 'First.', 'Second.', '', '**Key:** val', ''].join('\n'));
  });

  it('appends footers after the rows with a blank-line separator', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'X',
      rows: [{ label: 'Key', value: 'val' }],
      emptyState: 'empty',
      footers: ['_First footer._', '> Second footer'],
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toBe(['## X', '', '**Key:** val', '', '_First footer._', '> Second footer', ''].join('\n'));
  });

  it('honors headingLevel: 3 for embedded sub-section cards', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'X',
      headingLevel: 3,
      rows: [{ label: 'Key', value: 'val' }],
      emptyState: 'empty',
    };
    const out = renderMarkdownKeyValueCard(spec);
    expect(out).toBe(['### X', '', '**Key:** val', ''].join('\n'));
  });
});

describe('keyValueCardSpecStrings — collects every user-visible string for lint use', () => {
  it('returns title, every preamble line, every row LABEL, emptyState, and every footer', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'Stats (top 3)',
      preamble: ['Pre 1', 'Pre 2'],
      rows: [
        { label: 'Files', value: '42' },
        { label: 'Languages', value: 'ts 12' },
      ],
      emptyState: 'No stuff.',
      footers: ['Foot 1', 'Foot 2'],
    };
    expect(keyValueCardSpecStrings(spec)).toEqual([
      'Stats (top 3)',
      'Pre 1',
      'Pre 2',
      'Files',
      'Languages',
      'No stuff.',
      'Foot 1',
      'Foot 2',
    ]);
  });

  it('excludes row VALUES (dynamic data) — labels-only lint surface', () => {
    const spec: MarkdownKeyValueCardSpec = {
      title: 'X',
      rows: [{ label: 'id', value: 'should-not-appear-in-lint-walk' }],
      emptyState: 'empty',
    };
    // Value `should-not-appear-in-lint-walk` is dynamic data; only the
    // label `id` is user-facing wording the lint pins.
    expect(keyValueCardSpecStrings(spec)).toEqual(['X', 'id', 'empty']);
  });
});
