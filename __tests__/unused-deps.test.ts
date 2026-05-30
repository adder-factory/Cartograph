import { describe, it, expect, beforeAll, afterEach } from 'vitest';
import { Cartograph } from '../src/index.js';
import { analyzeUnusedDeps } from '../src/deps/unused.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-unused-deps-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('unused deps analyzer', () => {
  it('returns empty result when package.json is missing', () => {
    const tmpDir = tempDir();
    try {
      const cg = Cartograph.initSync(tmpDir);
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toEqual([]);
      expect(result.declaredDev).toEqual([]);
      expect(result.declaredOptional).toEqual([]);
      expect(result.used).toEqual([]);
      expect(result.packageJsonPath).toBe('');
      // No nested manifests in an empty tree.
      expect(result.nestedManifests).toBeUndefined();
    } finally {
      cleanup(tmpDir);
    }
  });

  it('discovers nested package.json files when no root manifest exists', () => {
    // ollama bug-hunt UX-1: a Go-dominant repo with an embedded JS sub-app
    // at `app/ui/app/package.json` got a terse "no package.json" with no
    // hint that there was something to audit nested. The discover step
    // surfaces the candidate paths so the agent can re-target.
    const tmpDir = tempDir();
    try {
      // Embedded JS sub-app at depth 3.
      fs.mkdirSync(path.join(tmpDir, 'app', 'ui', 'app'), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, 'app', 'ui', 'app', 'package.json'),
        JSON.stringify({ name: 'ui', dependencies: { react: '^19.0.0' } }),
      );
      // node_modules manifest at any depth must NOT surface.
      fs.mkdirSync(path.join(tmpDir, 'node_modules', 'react'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, 'node_modules', 'react', 'package.json'), JSON.stringify({ name: 'react' }));
      // Dot-dir (.tmp/) manifest must NOT surface.
      fs.mkdirSync(path.join(tmpDir, '.tmp'), { recursive: true });
      fs.writeFileSync(path.join(tmpDir, '.tmp', 'package.json'), JSON.stringify({ name: 'tmp' }));

      const cg = Cartograph.initSync(tmpDir);
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.packageJsonPath).toBe('');
      expect(result.nestedManifests).toEqual(['app/ui/app/package.json']);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a declared-and-imported dep as unused', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import pm from 'lodash';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('lodash');
      expect(result.used).toContain('lodash');
      expect(result.unusedRuntime).not.toContain('lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('flags a declared-but-not-imported dep as unused', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredRuntime).toContain('lodash');
      expect(result.used).not.toContain('lodash');
      expect(result.unusedRuntime).toContain('lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('counts subpath imports as the parent package', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import debounce from 'lodash/debounce';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('lodash');
      expect(result.unusedRuntime).not.toContain('lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('counts scoped subpath imports', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { '@scope/pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import x from '@scope/pkg/sub/path';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('@scope/pkg');
      expect(result.unusedRuntime).not.toContain('@scope/pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('ignores node built-in modules', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: {},
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import fs from 'fs'; import path from 'path'; import x from 'node:os';`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).not.toContain('fs');
      expect(result.used).not.toContain('path');
      expect(result.used).not.toContain('os');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('retains @types/X when X is used', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
          devDependencies: { '@types/lodash': '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import pm from 'lodash';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('lodash');
      expect(result.unusedDev).not.toContain('@types/lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('flags @types/X when X is not used', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@types/lodash': '^4.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).not.toContain('lodash');
      expect(result.unusedDev).toContain('@types/lodash');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('handles scoped @types packages with __ mapping', async () => {
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { '@scope/pkg': '^1.0.0' },
          devDependencies: { '@types/scope__pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import x from '@scope/pkg';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('@scope/pkg');
      expect(result.unusedDev).not.toContain('@types/scope__pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a dynamically-imported OPTIONAL dep as unused', async () => {
    // Regression for FRICTION-W (2026-05-14): `node-llama-cpp` is in
    // `optionalDependencies` and imported only via
    // `await import('node-llama-cpp' as any)`. The optional bucket
    // shares the same `usedSet` as runtime/dev, so the source-scan
    // signal must reach it too.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          optionalDependencies: { 'lazy-opt-pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `export async function load(){\n` +
          `  const m = await import('lazy-opt-pkg' as any);\n` +
          `  return m;\n` +
          `}\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredOptional).toContain('lazy-opt-pkg');
      expect(result.used).toContain('lazy-opt-pkg');
      expect(result.unusedOptional).not.toContain('lazy-opt-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('source-scan recovers a dynamic import when the graph extraction is stale', async () => {
    // Regression for FRICTION-W (2026-05-14): the live index may have
    // been built before `tsUnwrapStringArg` landed, so the graph has
    // no import node for `await import('pkg' as any)` even though
    // the source line exists. The source-scan fallback in
    // `collectImportsFromSourceScan` must close the gap.
    //
    // Simulate the stale state by indexing and then DELETING every
    // import node from the graph before running the audit — the deps
    // analyzer must still mark the dynamically-imported dep as used.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'stale-graph-pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `export async function load(){\n` +
          `  const m = await import('stale-graph-pkg' as any);\n` +
          `  return m;\n` +
          `}\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      // Wipe every import node — emulates a stale extraction where the
      // AST scan missed the dynamic import.
      cg.queries.db.prepare(`DELETE FROM nodes WHERE kind = 'import'`).run();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('stale-graph-pkg');
      expect(result.unusedRuntime).not.toContain('stale-graph-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a dep imported via `import("pkg" as any)` as unused', async () => {
    // Acceptance test for the `node-llama-cpp` false-positive — the
    // package is loaded lazily as `await import('node-llama-cpp' as any)`,
    // which wraps the string in an `as_expression` AST node. Before the
    // `tsUnwrapStringArg` fix in `src/extraction/tree-sitter.ts`, the
    // extractor emitted no import node and the deps audit recommended
    // removing the package — actively wrong.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'lazy-pkg': '^1.0.0' },
        }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `export async function load(){\n` + `  const m = await import('lazy-pkg' as any);\n` + `  return m;\n` + `}\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('lazy-pkg');
      expect(result.unusedRuntime).not.toContain('lazy-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag @types/node as unused (ambient Node.js type coverage)', async () => {
    // Regression for FRICTION-6 (2026-05-15): @types/node has no importable
    // npm peer — Node builtins are stripped by addSpecToUsedSet before they
    // reach usedSet, so usedSet.has('node') is always false. The fix adds
    // a special-case guard in computeUnusedSets so @types/node is always
    // retained (consumed ambiently by the TS compiler).
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { '@types/node': '^20.0.0' },
        }),
      );

      // Source imports only Node builtins — no third-party package.
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import fs from 'node:fs';\nimport path from 'path';\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('@types/node');
      expect(result.unusedDev).not.toContain('@types/node');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('flags a package imported in source but absent from package.json as undeclared', async () => {
    // Regression for F3 (2026-05-15): `@huggingface/transformers` was imported
    // by `scripts/spikes/*.mjs` but removed from package.json. The deps tool
    // was silently showing it as a plain "imported package", giving the
    // impression it was a declared dependency. The fix adds an `undeclared`
    // bucket: packages in `used` but absent from every declared dep bucket.
    const tmpDir = tempDir();
    try {
      // Only declare lodash — NOT ghost-undeclared-pkg.
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
        }),
      );

      // Production file: imports both lodash (declared) and ghost-undeclared-pkg (not declared).
      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import pm from 'lodash';\nimport ghost from 'ghost-undeclared-pkg';\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // lodash is declared + imported — used, not undeclared.
      expect(result.used).toContain('lodash');
      expect(result.undeclared).not.toContain('lodash');
      expect(result.unusedRuntime).not.toContain('lodash');

      // ghost-undeclared-pkg is imported but not in package.json — must appear in undeclared.
      // Exact-match: no grammar packages or other phantoms must leak into the undeclared list.
      expect(result.used).toContain('ghost-undeclared-pkg');
      expect(result.undeclared).toHaveLength(1);
      expect(result.undeclared).toContain('ghost-undeclared-pkg');
      expect(result.undeclared.some((p) => p.startsWith('tree-sitter'))).toBe(false);

      // Existing unused buckets are unaffected (lodash is used, nothing else declared).
      expect(result.unusedRuntime).toEqual([]);
      expect(result.unusedDev).toEqual([]);
      expect(result.unusedOptional).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a package as undeclared when its @types/ counterpart is declared', async () => {
    // Friction (2026-05-15 round 7): `better-sqlite3` is imported behind a
    // try/catch as an optional native backend and deliberately kept out of
    // package.json, but `@types/better-sqlite3` IS declared. Flagging it
    // "undeclared — add it or remove the import" is wrong: a declared type
    // stub is an affirmative "this package is intended" signal.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0' },
          // @types/optional-backend declared, optional-backend itself is not.
          devDependencies: { '@types/optional-backend': '^1.0.0' },
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import pm from 'lodash';\nimport ob from 'optional-backend';\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // optional-backend is imported + absent from package.json, but its
      // @types/ counterpart is declared — must NOT be flagged undeclared.
      expect(result.used).toContain('optional-backend');
      expect(result.undeclared).not.toContain('optional-backend');
      expect(result.undeclared).toEqual([]);
      // The @types/ stub itself is correctly retained (upstream is used).
      expect(result.unusedDev).not.toContain('@types/optional-backend');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag the node:sqlite builtin as an undeclared package', async () => {
    // Regression (2026-05-15 tool-sweep): `node:sqlite` is an experimental
    // Node core module. `builtinModules` from `node:module` omits
    // experimental cores, so stripping the `node:` prefix and checking
    // list-membership left a phantom `sqlite` package in `used` AND
    // `undeclared`. The fix returns early on the `node:` scheme itself —
    // it is reserved for core modules, no npm package travels through it.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import { DatabaseSync } from 'node:sqlite';\n` +
          `import pm from 'lodash';\n` +
          `export { DatabaseSync, pm };\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).not.toContain('sqlite');
      expect(result.undeclared).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a package named only inside a string literal as undeclared', async () => {
    // Regression (2026-05-15 tool-sweep): the regex source-scan matches
    // `import()`/`require()` text even when it sits INSIDE a string
    // literal (a tool-description string, a binding.gyp fragment). Such a
    // phantom must never reach `undeclared` — that bucket is derived from
    // AST-extracted imports only; the source-scan only suppresses false
    // "unused".
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(path.join(tmpDir, 'package.json'), JSON.stringify({ dependencies: { lodash: '^4.0.0' } }));
      // `phantom-pkg` appears ONLY inside a string literal — not a real
      // import. lodash is the one genuine (declared) import.
      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import pm from 'lodash';\n` +
          `export const help = "load it lazily via await import('phantom-pkg' as any)";\n` +
          `export { pm };\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.undeclared).not.toContain('phantom-pkg');
      expect(result.undeclared).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not count imports from docs/test-beds/ fixture files as used', async () => {
    // Regression for FRICTION-6 (2026-05-15): the import scanner was
    // picking up specifiers like "fmt", "foo", "pkg", "require-cast-pkg"
    // from fixture files under docs/test-beds/. Those specifiers should
    // NOT appear in the used-set and should NOT suppress an "unused dep"
    // finding for a real declared dependency.
    const tmpDir = tempDir();
    try {
      // Declare a real dep (lodash) and a fixture-only dep (fixture-pkg).
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { lodash: '^4.0.0', 'fixture-only-pkg': '^1.0.0' },
        }),
      );

      // Production file — imports lodash only.
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import _ from 'lodash';`);

      // Fixture file that imports "fixture-only-pkg" — should be excluded.
      const fixtureDir = path.join(tmpDir, 'docs', 'test-beds', 'typescript');
      fs.mkdirSync(fixtureDir, { recursive: true });
      fs.writeFileSync(path.join(fixtureDir, 'fixture.ts'), `import x from 'fixture-only-pkg';\nimport y from 'fmt';`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // lodash is imported in production code — should be "used".
      expect(result.used).toContain('lodash');
      expect(result.unusedRuntime).not.toContain('lodash');

      // fixture-only-pkg is ONLY imported from a fixture file — must appear unused.
      expect(result.used).not.toContain('fixture-only-pkg');
      expect(result.unusedRuntime).toContain('fixture-only-pkg');

      // "fmt" is a fixture-only specifier — must NOT appear in used at all.
      expect(result.used).not.toContain('fmt');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not count a commented-out import() or a punctuation-only specifier as used', async () => {
    // Regression for FRICTION-2 (2026-05-15): the source-scan regex
    // matched `import(...)` / `require(...)` patterns inside doc-comments
    // and accepted punctuation-only specifiers like `...` (an ellipsis in
    // example prose). A commented-out import is dead code and an ellipsis
    // is not a package — neither should reach the used-set.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          dependencies: { 'ghost-pkg': '^1.0.0', lodash: '^4.0.0' },
        }),
      );

      // Production file: lodash is genuinely imported; ghost-pkg appears
      // ONLY inside comments (a `//` line and a `/* */` block), and the
      // ellipsis specifier `...` appears in a doc-comment example.
      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import _ from 'lodash';\n` +
          `// dead code: const g = await import('ghost-pkg');\n` +
          `/* example: require('ghost-pkg') and import('...') */\n` +
          `export const x = _.identity(1);\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // lodash is a real import — still used.
      expect(result.used).toContain('lodash');

      // ghost-pkg only appears commented-out — must be flagged unused.
      expect(result.used).not.toContain('ghost-pkg');
      expect(result.unusedRuntime).toContain('ghost-pkg');

      // The ellipsis `...` is not a package — must not leak into used.
      expect(result.used).not.toContain('...');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag `vitest` as undeclared when the project runs under bun test (#8)', async () => {
    // Regression: post-G11 (2026-05-21), `vitest` was removed as a
    // devDependency but the 245-file test suite still imports `from
    // 'vitest'` — bun test's built-in shim resolves the specifier.
    // The pre-fix audit flagged `vitest` as undeclared forever.
    // Fix: a RUNTIME_SHIMMED_SPECIFIERS set recognises vitest when the
    // test script runs `bun test` (or a bunfig.toml exists at root)
    // AND vitest is absent from devDependencies.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          // No vitest in devDeps — the runner shims it.
          devDependencies: {},
          scripts: { test: 'bun test --timeout 30000 __tests__/*.test.ts' },
        }),
      );

      // Source imports `from 'vitest'` — bun's shim resolves it.
      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import { describe, it, expect } from 'vitest';\nexport { describe, it, expect };\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      // The vitest spec IS in the used-set (it appears in source).
      expect(result.used).toContain('vitest');
      // But MUST NOT be flagged as undeclared — the runner provides it.
      expect(result.undeclared).not.toContain('vitest');
      expect(result.undeclared).toEqual([]);
    } finally {
      cleanup(tmpDir);
    }
  });

  it('detects the bunfig.toml signal for the vitest shim (#8)', async () => {
    // Sibling of the previous test — the second detection path. If the
    // project's test script doesn't literally say `bun test` (e.g. it
    // dispatches through a wrapper) but a bunfig.toml exists at root,
    // we still recognise the bun-test shim.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: {},
          scripts: { test: './scripts/run-tests.sh' },
        }),
      );
      fs.writeFileSync(path.join(tmpDir, 'bunfig.toml'), `[test]\ntimeout = 30000\n`);

      fs.writeFileSync(
        path.join(tmpDir, 'index.ts'),
        `import { describe, it } from 'vitest';\nexport { describe, it };\n`,
      );

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('vitest');
      expect(result.undeclared).not.toContain('vitest');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('still flags `vitest` as undeclared on a non-bun project (#8 negative case)', async () => {
    // Negative regression — the shim recognition must NOT short-circuit
    // a real "you imported vitest but didn't declare it" finding on
    // projects that aren't running under bun. A node-runtime project
    // with no bun signal should still see the undeclared report.
    const tmpDir = tempDir();
    try {
      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: {},
          // node-runner — vitest is genuinely missing as a devDep.
          scripts: { test: 'node --test' },
        }),
      );
      // No bunfig.toml.
      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `import { describe } from 'vitest';\nexport { describe };\n`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.used).toContain('vitest');
      expect(result.undeclared).toContain('vitest');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('does not flag a CLI bin invoked from scripts/*.ts as unused (#9)', async () => {
    // Regression: `tree-sitter-cli` declares a `tree-sitter` bin and
    // is invoked by `scripts/build-grammar-wasm.ts` via shell-out
    // (`tree-sitter build --wasm`), NEVER from package.json.scripts.
    // The pre-fix audit only scanned package.json.scripts for bin
    // tokens and flagged tree-sitter-cli as an unused devDependency.
    // Fix: scan scripts/**/*.{ts,js,mjs,sh,bash} for the package's
    // declared bin name with a word-boundary anchor.
    const tmpDir = tempDir();
    try {
      const nmDir = path.join(tmpDir, 'node_modules', 'fake-cli-pkg');
      fs.mkdirSync(nmDir, { recursive: true });
      fs.writeFileSync(
        path.join(nmDir, 'package.json'),
        JSON.stringify({ name: 'fake-cli-pkg', bin: { 'fake-cli-bin': './bin.js' } }),
      );

      fs.writeFileSync(
        path.join(tmpDir, 'package.json'),
        JSON.stringify({
          devDependencies: { 'fake-cli-pkg': '^1.0.0' },
          // No mention in package.json.scripts on purpose.
          scripts: { build: 'tsc' },
        }),
      );

      const scriptsDir = path.join(tmpDir, 'scripts');
      fs.mkdirSync(scriptsDir, { recursive: true });
      fs.writeFileSync(
        path.join(scriptsDir, 'build-thing.ts'),
        `import { execFileSync } from 'child_process';\nexecFileSync('fake-cli-bin', ['build', '--wasm']);\n`,
      );

      // A second, unrelated script must NOT accidentally surface a
      // false-USED for any other declared package.
      fs.writeFileSync(path.join(scriptsDir, 'noop.ts'), `console.log('noop');\n`);

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();
      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.declaredDev).toContain('fake-cli-pkg');
      expect(result.used).toContain('fake-cli-pkg');
      expect(result.unusedDev).not.toContain('fake-cli-pkg');
    } finally {
      cleanup(tmpDir);
    }
  });

  it('the cartograph repo itself does not flag tree-sitter-cli as unused (#9)', async () => {
    // End-to-end assertion against the live repo: tree-sitter-cli is
    // invoked from `scripts/build-grammar-wasm.ts` via `tree-sitter
    // build --wasm` and MUST NOT appear in `unusedDev`. This is the
    // exact scenario the bug was filed against.
    const repoRoot = path.resolve(__dirname, '..');
    const cg = Cartograph.openSync(repoRoot);
    try {
      const result = analyzeUnusedDeps(cg.queries, repoRoot);
      expect(result.declaredDev).toContain('tree-sitter-cli');
      expect(result.unusedDev).not.toContain('tree-sitter-cli');
      // vitest must also not appear in undeclared (Bug #8 verification
      // against the live repo).
      expect(result.undeclared).not.toContain('vitest');
    } finally {
      cg.close();
    }
  });

  it('returns packageJsonPath when present', async () => {
    const tmpDir = tempDir();
    try {
      const packageJsonPath = path.join(tmpDir, 'package.json');
      fs.writeFileSync(
        packageJsonPath,
        JSON.stringify({
          dependencies: {},
        }),
      );

      fs.writeFileSync(path.join(tmpDir, 'index.ts'), `const x = 1;`);

      const cg = Cartograph.initSync(tmpDir);
      await cg.indexAll();

      const result = analyzeUnusedDeps(cg.queries, tmpDir);
      cg.close();

      expect(result.packageJsonPath).toBe(packageJsonPath);
    } finally {
      cleanup(tmpDir);
    }
  });
});
