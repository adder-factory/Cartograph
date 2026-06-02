import { describe, expect, it } from 'vitest';
import {
  buildBiomarkerStatsByBiomarkerSpec,
  buildBiomarkerStatsBySeveritySpec,
  buildBiomarkerStatsBySurfaceSpec,
} from '../src/mcp/tools/biomarkers.js';
import {
  buildTestsForBucketSpec,
  buildTestsForDescribeNameExplainer,
  buildTestsForDescribeNameSpec,
  buildTestsForDispatchSpec,
  buildTestsForSameFileExplainer,
  TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX,
  TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX,
} from '../src/mcp/tools/tests-for.js';
import { renderMarkdownBulletList, renderMarkdownTable } from '../src/mcp/tools/_result-spec.js';
import type { Node } from '../src/types.js';

describe('cartograph_biomarkers render specs', () => {
  it('renders biomarker totals with severity breakdowns and right-aligned counts', () => {
    const spec = buildBiomarkerStatsByBiomarkerSpec([
      { name: 'large_method', total: 3, breakdown: 'warning: 2, info: 1' },
      { name: 'unused_export', total: 1, breakdown: '' },
    ]);

    expect(renderMarkdownTable(spec)).toBe(
      [
        '### By biomarker',
        '',
        '| Biomarker | Count |',
        '|---|---:|',
        '| large_method | 3 (warning: 2, info: 1) |',
        '| unused_export | 1 |',
      ].join('\n'),
    );
  });

  it('keeps severity and surface rollups explicit when rendered', () => {
    const severity = renderMarkdownTable(
      buildBiomarkerStatsBySeveritySpec([
        { severity: 'warning', count: 2 },
        { severity: 'info', count: 7 },
      ]),
    );
    const surface = renderMarkdownTable(
      buildBiomarkerStatsBySurfaceSpec([
        { surface: 'full-pass', count: 5 },
        { surface: 'partial-rescan', count: 1 },
        { surface: 'cached', count: 0 },
      ]),
    );

    expect(severity).toContain('### By severity');
    expect(severity).toContain('| Severity | Count |');
    expect(severity).toContain('| warning | 2 |');
    expect(surface).toContain('### By surface reason');
    expect(surface).toContain('partial-rescan');
    expect(surface).toContain('| cached | 0 |');
  });

  it('returns the owned empty states for empty rollups', () => {
    expect(renderMarkdownTable(buildBiomarkerStatsByBiomarkerSpec([]))).toBe('_No biomarker breakdown available._');
    expect(renderMarkdownTable(buildBiomarkerStatsBySeveritySpec([]))).toBe('_No severity breakdown available._');
    expect(renderMarkdownTable(buildBiomarkerStatsBySurfaceSpec([]))).toBe('_No surface-reason breakdown available._');
  });
});

describe('cartograph_tests_for render specs', () => {
  it('renders test rows with symbols, descriptions, and truncation', () => {
    const descriptions = Array.from({ length: 10 }, (_, i) => ({
      line: i + 10,
      description: `case ${i + 1}`,
    }));
    const rendered = renderMarkdownBulletList(
      buildTestsForBucketSpec('direct', [
        {
          filePath: '__tests__/target.test.ts',
          testSymbols: ['testTarget', 'describeTarget'],
          testDescriptions: descriptions,
          hops: 1,
        },
      ]),
    );

    expect(rendered).toContain('### Direct importers (high confidence) (1)');
    expect(rendered).toContain('- `__tests__/target.test.ts` — `testTarget`, `describeTarget` _(10 covering test blocks)_');
    expect(rendered).toContain('  - L10: "case 1"');
    expect(rendered).toContain('  - L17: "case 8"');
    expect(rendered).toContain('  - _…and 2 more covering blocks_');
    expect(rendered).not.toContain('case 9');
  });

  it('renders the no-symbol heuristic row when a test file has no extracted tests', () => {
    const rendered = renderMarkdownBulletList(
      buildTestsForBucketSpec('sameFile', [
        {
          filePath: '__tests__/fixture.test.ts',
          testSymbols: [],
          testDescriptions: [],
          hops: 1,
        },
      ]),
    );

    expect(rendered).toContain('### Tests covering this file (symbol exercised indirectly) (1)');
    expect(rendered).toContain('- `__tests__/fixture.test.ts` _(no test-shaped symbols matched the heuristic)_');
  });

  it('renders dispatch and describe-name fallback buckets', () => {
    const dispatch = renderMarkdownBulletList(
      buildTestsForDispatchSpec('cartograph_widget', ['__tests__/widget.test.ts']),
    );
    const describeName = renderMarkdownBulletList(buildTestsForDescribeNameSpec(['__tests__/class.test.ts']));

    expect(dispatch).toContain('### Tests via MCP tool dispatch (cartograph_widget) (1)');
    expect(dispatch).toContain('- `__tests__/widget.test.ts`');
    expect(describeName).toContain('### INFERRED (describe-name match) (1)');
    expect(describeName).toContain('- `__tests__/class.test.ts`');
  });

  it('includes live symbol context in fallback explainers', () => {
    const node = {
      id: 'n1',
      name: 'privateHelper',
      kind: 'function',
      filePath: 'src/service.ts',
      startLine: 12,
      endLine: 20,
    } as Node;

    const sameFile = buildTestsForSameFileExplainer(node);
    const describeName = buildTestsForDescribeNameExplainer(node);

    expect(sameFile).toContain('`privateHelper`');
    expect(sameFile).toContain('`src/service.ts`');
    expect(sameFile).toContain(TESTS_FOR_SAME_FILE_EXPLAIN_PREFIX);
    expect(describeName).toContain('`privateHelper`');
    expect(describeName).toContain(TESTS_FOR_DESCRIBE_NAME_EXPLAIN_PREFIX);
  });
});
