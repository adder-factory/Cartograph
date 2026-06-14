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
    state.rows = [
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:core', spec: '../core/service' },
    ];

    expect(
      computeIllegalImports({ queries: queries(), projectRoot: '/repo', layers: undefined, exceptions: undefined }),
    ).toEqual([]);
    expect(
      computeIllegalImports({ queries: queries(), projectRoot: '/repo', layers: [], exceptions: undefined }),
    ).toEqual([]);
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
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:direct',
        spec: '../core/service.ts',
      },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:extless', spec: '../core/util' },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:index', spec: '../core/routes' },
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:absolute',
        spec: '/core/service.ts',
      },
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:nodenext',
        spec: '../core/js-source.js',
      },
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:bare', spec: 'react' },
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:unlayered',
        spec: '../shared/outside',
      },
      { importer_id: 'ui:local', importer_file: 'ui/local.ts', import_node_id: 'import:same-layer', spec: './page' },
      {
        importer_id: 'unknown:entry',
        importer_file: 'scripts/tool.ts',
        import_node_id: 'import:unmatched',
        spec: '../core/service',
      },
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
      {
        importer_id: 'feature:view',
        importer_file: 'feature/view.ts',
        import_node_id: 'import:db',
        spec: '../infra/db',
      },
      {
        importer_id: 'feature:view',
        importer_file: 'feature/view.ts',
        import_node_id: 'import:cache',
        spec: '../infra/cache',
      },
      {
        importer_id: 'feature:view',
        importer_file: 'feature/view.ts',
        import_node_id: 'import:shared',
        spec: '../shared/log',
      },
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

  // ---------------------------------------------------------------------------
  // Spec resolution must try EVERY known extension, and resolve to the exact
  // on-disk path (not just the first extension probed). Asserting `toFile`
  // pins the resolution order: an extensionless spec resolves to the indexed
  // file whatever its language, and a NodeNext `.js`-style spec rewrites to
  // the real source extension.
  // ---------------------------------------------------------------------------
  it('resolves extensionless specs via every known extension to the exact indexed path', () => {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.py', '.go', '.rs', '.java'];
    state.indexed = ['ui/page.ts', ...exts.map((e, i) => `core/mod${i}${e}`)];
    state.rows = exts.map((_, i) => ({
      importer_id: 'ui:page',
      importer_file: 'ui/page.ts',
      import_node_id: `import:ext${i}`,
      spec: `../core/mod${i}`,
    }));

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    // Every extension must resolve (one finding each) to the exact indexed file.
    expect(findings.map((f) => (f.detail as { toFile: string }).toFile)).toEqual(
      exts.map((e, i) => `core/mod${i}${e}`),
    );
  });

  it('resolves directory-index files via every known extension to the exact indexed path', () => {
    const exts = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.svelte', '.py', '.go', '.rs', '.java'];
    state.indexed = ['ui/page.ts', ...exts.map((e, i) => `core/d${i}/index${e}`)];
    state.rows = exts.map((_, i) => ({
      importer_id: 'ui:page',
      importer_file: 'ui/page.ts',
      import_node_id: `import:idx${i}`,
      spec: `../core/d${i}`,
    }));

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => (f.detail as { toFile: string }).toFile)).toEqual(
      exts.map((e, i) => `core/d${i}/index${e}`),
    );
  });

  it('rewrites NodeNext js-style specs to the real source extension (.ts/.tsx/.d.ts)', () => {
    state.indexed = ['ui/page.ts', 'core/a.ts', 'core/b.tsx', 'core/c.d.ts', 'core/root/index.ts'];
    state.rows = [
      // .jsx spec -> .ts source
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:jsx-ts', spec: '../core/a.jsx' },
      // .mjs spec -> .tsx source
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:mjs-tsx', spec: '../core/b.mjs' },
      // .cjs spec -> .d.ts source
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:cjs-dts', spec: '../core/c.cjs' },
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

    expect(findings.map((f) => [f.nodeId, (f.detail as { toFile: string }).toFile])).toEqual([
      ['import:jsx-ts', 'core/a.ts'],
      ['import:mjs-tsx', 'core/b.tsx'],
      ['import:cjs-dts', 'core/c.d.ts'],
    ]);
  });

  it('prefers the indexed source over the first extension probed when a .js spec has no .ts twin', () => {
    // spec ends in .js, no core/mod.ts exists, but core/mod.tsx is indexed.
    // The js->ts probe must land on .tsx, NOT blindly return the first ('.ts') candidate.
    state.indexed = ['ui/page.ts', 'core/mod.tsx'];
    state.rows = [
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:js-tsx', spec: '../core/mod.js' },
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

    expect(findings.map((f) => [f.nodeId, (f.detail as { toFile: string }).toFile])).toEqual([
      ['import:js-tsx', 'core/mod.tsx'],
    ]);
  });

  it('treats a "./"-prefixed spec as relative (resolves and can be flagged)', () => {
    // A leading "./" must mark the spec relative. Importer ui/a.ts imports ./core/secret,
    // which resolves into a different layer and must fire.
    state.indexed = ['ui/a.ts', 'ui/core/secret.ts'];
    state.rows = [
      { importer_id: 'ui:a', importer_file: 'ui/a.ts', import_node_id: 'import:dotslash', spec: './core/secret' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/a.ts'], cannotImport: ['core'] },
        { name: 'core', paths: ['ui/core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => [f.nodeId, (f.detail as { toFile: string }).toFile])).toEqual([
      ['import:dotslash', 'ui/core/secret.ts'],
    ]);
  });

  it('resolves a root-level "." spec to the project-root index file', () => {
    // Importer at the repo root, spec "." → resolved path is "" → directory-index probe
    // must produce "index.ts" (no leading slash), not "/index.ts".
    state.indexed = ['page.ts', 'index.ts'];
    state.rows = [{ importer_id: 'root:page', importer_file: 'page.ts', import_node_id: 'import:rootidx', spec: '.' }];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'pg', paths: ['page.ts'], cannotImport: ['idx'] },
        { name: 'idx', paths: ['index.ts'] },
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => [f.nodeId, (f.detail as { toFile: string }).toFile])).toEqual([
      ['import:rootidx', 'index.ts'],
    ]);
  });

  it('treats an empty canImport array as no policy (not an allow-list that denies everything)', () => {
    // canImport: [] must NOT enforce an allow-list — an empty allow-list would otherwise
    // reject every cross-layer import. The layer has no effective policy here.
    state.indexed = ['ui/page.ts', 'core/secret.ts'];
    state.rows = [
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:emptycan',
        spec: '../core/secret',
      },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], canImport: [] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings).toEqual([]);
  });

  it('resolves "." (importer dir) and ".." (parent dir) specs to their directory index', () => {
    state.indexed = ['a/page.ts', 'a/index.ts', 'ui/sub/page.ts', 'ui/index.ts'];
    state.rows = [
      // "." -> importer's own directory index
      { importer_id: 'a:page', importer_file: 'a/page.ts', import_node_id: 'import:dot', spec: '.' },
      // ".." -> parent directory index
      { importer_id: 'ui:sub', importer_file: 'ui/sub/page.ts', import_node_id: 'import:dotdot', spec: '..' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'page-a', paths: ['a/page.ts'], cannotImport: ['idx-a'] },
        { name: 'idx-a', paths: ['a/index.ts'] },
        { name: 'sub', paths: ['ui/sub/**'], cannotImport: ['idx-ui'] },
        { name: 'idx-ui', paths: ['ui/index.ts'] },
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => [f.nodeId, (f.detail as { toFile: string }).toFile])).toEqual([
      ['import:dot', 'a/index.ts'],
      ['import:dotdot', 'ui/index.ts'],
    ]);
  });

  it('treats a bare (non-relative) spec as a package import even when a same-named file is indexed', () => {
    // importer at repo root; spec "core/secret" is bare (no ./). If it were resolved
    // relative to the importer it would hit the indexed core/secret.ts and fire — it must NOT.
    state.indexed = ['page.ts', 'core/secret.ts'];
    state.rows = [
      { importer_id: 'root:page', importer_file: 'page.ts', import_node_id: 'import:bare-rel', spec: 'core/secret' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'top', paths: ['page.ts'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings).toEqual([]);
  });

  it('does not flag a layer that declares no import policy', () => {
    state.indexed = ['ui/page.ts', 'core/secret.ts'];
    state.rows = [
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:nopolicy',
        spec: '../core/secret',
      },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'] }, // no canImport / cannotImport
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings).toEqual([]);
  });

  it('applies the allow-list when cannotImport is an empty array (empty deny-list is not a policy)', () => {
    // cannotImport: [] must NOT count as an active deny-list — the allow-list governs.
    state.indexed = ['ui/page.ts', 'core/secret.ts'];
    state.rows = [
      {
        importer_id: 'ui:page',
        importer_file: 'ui/page.ts',
        import_node_id: 'import:emptydeny',
        spec: '../core/secret',
      },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: [], canImport: ['nothing/**'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: undefined,
    });

    // core is not in the allow-list -> flagged.
    expect(findings.map((f) => f.nodeId)).toEqual(['import:emptydeny']);
  });

  it('allows an import when the target matches a canImport raw glob (not a layer name)', () => {
    state.indexed = ['feat/v.ts', 'lib/y.ts'];
    state.rows = [
      { importer_id: 'feat:v', importer_file: 'feat/v.ts', import_node_id: 'import:allowglob', spec: '../lib/y' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'feat', paths: ['feat/**'], canImport: ['lib/**'] },
        { name: 'lib', paths: ['lib/**'] },
      ],
      exceptions: undefined,
    });

    expect(findings).toEqual([]);
  });

  it("expands a deny entry that names a layer into that layer's path matchers", () => {
    // The deny entry "svcAlias" is a LAYER NAME whose paths cover the target, but the
    // target's resolved layer is "lib" (an earlier, path-overlapping layer). The deny
    // must still fire by expanding "svcAlias" to its compiled path matchers — compiling
    // the bare name as a literal glob would not match "lib/y.ts".
    state.indexed = ['feat/v.ts', 'lib/y.ts'];
    state.rows = [
      { importer_id: 'feat:v', importer_file: 'feat/v.ts', import_node_id: 'import:denynamed', spec: '../lib/y' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'feat', paths: ['feat/**'], cannotImport: ['svcAlias'] },
        { name: 'lib', paths: ['lib/**'] }, // earlier match -> target's layer is "lib"
        { name: 'svcAlias', paths: ['lib/**'] }, // same paths, different name from the resolved layer
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => f.nodeId)).toEqual(['import:denynamed']);
  });

  it("fires when the target matches ANY one of a multi-path deny layer's globs", () => {
    // Deny entry "multi" expands to two path matchers; the target matches only the first.
    // A single match must be enough (matchesAny, not matchesAll).
    state.indexed = ['feat/v.ts', 'lib/y.ts'];
    state.rows = [
      { importer_id: 'feat:v', importer_file: 'feat/v.ts', import_node_id: 'import:multipath', spec: '../lib/y' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'feat', paths: ['feat/**'], cannotImport: ['multi'] },
        { name: 'lib', paths: ['lib/**'] }, // target's resolved layer
        { name: 'multi', paths: ['lib/**', 'zzz/**'] }, // target matches only the first glob
      ],
      exceptions: undefined,
    });

    expect(findings.map((f) => f.nodeId)).toEqual(['import:multipath']);
  });

  it('never flags same-layer imports even when the layer denies its own name', () => {
    // Both files are in "core"; the same-layer short-circuit must win over the
    // self-referential cannotImport: ['core'] before any policy check runs.
    state.indexed = ['core/a.ts', 'core/b.ts'];
    state.rows = [
      { importer_id: 'core:a', importer_file: 'core/a.ts', import_node_id: 'import:samelayer', spec: './b' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [{ name: 'core', paths: ['core/**'], cannotImport: ['core', 'tools'] }],
      exceptions: undefined,
    });

    expect(findings).toEqual([]);
  });

  it('does not suppress a violation when the matching exception entry covers a different target', () => {
    // An exception exists for this importer, but its canImport entry does not cover the
    // imported target, so the finding must still fire.
    state.indexed = ['ui/page.ts', 'core/secret.ts'];
    state.rows = [
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:excmiss', spec: '../core/secret' },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      exceptions: [{ file: 'ui/page.ts', canImport: ['somethingelse/**'] }],
    });

    expect(findings.map((f) => f.nodeId)).toEqual(['import:excmiss']);
  });

  it('only suppresses the importer named by the exception, not other files', () => {
    state.indexed = ['ui/page.ts', 'ui/other.ts', 'core/secret.ts'];
    state.rows = [
      { importer_id: 'ui:page', importer_file: 'ui/page.ts', import_node_id: 'import:excfile', spec: '../core/secret' },
      {
        importer_id: 'ui:other',
        importer_file: 'ui/other.ts',
        import_node_id: 'import:nofile',
        spec: '../core/secret',
      },
    ];

    const findings = computeIllegalImports({
      queries: queries(),
      projectRoot: '/repo',
      layers: [
        { name: 'ui', paths: ['ui/**'], cannotImport: ['core'] },
        { name: 'core', paths: ['core/**'] },
      ],
      // exception names ui/page.ts via a raw-glob canImport entry
      exceptions: [{ file: 'ui/page.ts', canImport: ['core/**'] }],
    });

    // ui/page.ts suppressed; ui/other.ts still fires.
    expect(findings.map((f) => f.nodeId)).toEqual(['import:nofile']);
  });
});
