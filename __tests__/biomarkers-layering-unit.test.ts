import { beforeEach, describe, expect, it, vi } from 'vitest';
import { computeIllegalImports } from '../src/biomarkers/layering.js';

const state = {
  indexed: [] as string[],
  rows: [] as Array<{ importer_id: string; importer_file: string; import_node_id: string; spec: string }>,
};

vi.mock('../src/db/queries-files.js', () => ({
  getAllFilePaths: vi.fn(() => state.indexed),
}));

function queries() {
  return {
    db: {
      prepare: () => ({
        all: () => state.rows,
      }),
    },
  } as never;
}

beforeEach(() => {
  state.indexed = [];
  state.rows = [];
  vi.clearAllMocks();
});

describe('computeIllegalImports', () => {
  it('returns no findings when no layers are configured', () => {
    state.indexed = ['ui/page.ts', 'core/service.ts'];
    state.rows = [{ importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:core', spec: '../core/service' }];

    expect(
      computeIllegalImports({ queries: queries(), projectRoot: '/repo', layers: undefined, exceptions: undefined }),
    ).toEqual([]);
    expect(computeIllegalImports({ queries: queries(), projectRoot: '/repo', layers: [], exceptions: undefined })).toEqual(
      [],
    );
  });

  it('resolves direct, extensionless, directory-index, absolute, and NodeNext js-to-ts imports', () => {
    state.indexed = [
      'ui/page.ts',
      'ui/local.ts',
      'core/service.ts',
      'core/util.ts',
      'core/routes/index.ts',
      'core/js-source.ts',
      'shared/outside.ts',
    ];
    state.rows = [
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:direct', spec: '../core/service.ts' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:extless', spec: '../core/util' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:index', spec: '../core/routes' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:absolute', spec: '/core/service.ts' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:nodenext', spec: '../core/js-source.js' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:bare', spec: 'react' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:unlayered', spec: '../shared/outside' },
      { importer_id: 'ui:local', importer_file: 'ui/local.ts', import_node_id: 'import:same-layer', spec: './page' },
      { importer_id: 'unknown:entry', importer_file: 'scripts/tool.ts', import_node_id: 'import:unmatched', spec: '../core/service' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings.map((finding) => finding.nodeId)).toEqual([
      'import:direct',
      'import:extless',
      'import:index',
      'import:absolute',
      'import:nodenext',
    ]);
    expect(findings[0]).toMatchObject({
      biomarker: 'illegal_import',
      severity: 'warning',
      detail: {
        fromLayer: 'ui',
        toLayer: 'core',
        importedSpec: '../core/service.ts',
        fromFile: 'ui/page.ts',
        toFile: 'core/service.ts',
      },
    });
  });

  it('enforces allow-lists, deny-list raw globs, and per-file exceptions', () => {
    state.indexed = ['feature/view.ts', 'infra/db.ts', 'infra/cache.ts', 'shared/log.ts'];
    state.rows = [
      { importer_id: 'feature:view', importer_file: 'feature/view.ts', import_node_id: 'import:db', spec: '../infra/db' },
      { importer_id: 'feature:view', importer_file: 'feature/view.ts', import_node_id: 'import:cache', spec: '../infra/cache' },
      { importer_id: 'feature:view', importer_file: 'feature/view.ts', import_node_id: 'import:shared', spec: '../shared/log' },
    ];

    const allowFindings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'feature', paths: ['feature/**'], canImport: ['shared/**'] },
        { name: 'infra', paths: ['infra/**'] },
        { name: 'shared', paths: ['shared/**'] },
      ],
      exceptions: [{ file: 'feature/view.ts', canImport: ['infra/cache.ts'] }],
    });

    expect(allowFindings.map((finding) => finding.nodeId)).toEqual(['import:db']);

    const denyFindings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'feature', paths: ['feature/**'], cannotImport: ['infra/db.ts'] },
        { name: 'infra', paths: ['infra/**'] },
        { name: 'shared', paths: ['shared/**'] },
      ],
      exceptions: undefined,
    });

    expect(denyFindings.map((finding) => finding.nodeId)).toEqual(['import:db']);
  });
});
