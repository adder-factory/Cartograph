import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  classifyImport,
  readGoModuleAlias,
  readTsPathAliases,
  buildTsPathAliasResolver,
} from '../src/import-classifier.js';

function withObjectPrototypeProperty<T>(key: string, value: unknown, run: () => T): T {
  const previous = Object.getOwnPropertyDescriptor(Object.prototype, key);
  Object.defineProperty(Object.prototype, key, {
    configurable: true,
    enumerable: false,
    value,
  });
  try {
    return run();
  } finally {
    if (previous) Object.defineProperty(Object.prototype, key, previous);
    else Reflect.deleteProperty(Object.prototype, key);
  }
}

describe('classifyImport', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-classify-'));
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('returns kind=bare for non-relative specifiers', () => {
    const c = classifyImport({ importingFileAbs: path.join(dir, 'a.ts'), spec: 'lodash', projectRootAbs: dir });
    expect(c.kind).toBe('bare');
    expect(c.resolvedFile).toBeUndefined();
  });

  it('resolves direct file hit and exposes resolvedFile', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const target = path.join(dir, 'src', 'helper.ts');
    fs.writeFileSync(target, 'export {};');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './helper.ts',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
  });

  it('resolves NodeNext .js → .ts rewrite (regression for the long-standing gap)', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const target = path.join(dir, 'src', 'helper.ts');
    fs.writeFileSync(target, 'export {};');
    // Source-style spec ends in .js; on-disk file is .ts
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './helper.js',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
  });

  it('resolves NodeNext .jsx → .tsx rewrite', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const target = path.join(dir, 'src', 'comp.tsx');
    fs.writeFileSync(target, 'export {};');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.tsx'),
      spec: './comp.jsx',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
  });

  it('resolves extension-less spec via permutation', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const target = path.join(dir, 'src', 'helper.ts');
    fs.writeFileSync(target, 'export {};');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './helper',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
    expect(c.extMissing).toBe(true);
  });

  it('resolves directory import to its index file', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'mod'));
    const target = path.join(dir, 'src', 'mod', 'index.ts');
    fs.writeFileSync(target, 'export {};');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './mod',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('directory');
    expect(c.resolvedFile).toBe(target);
  });

  it('reports kind=directory with no resolvedFile when dir has no index', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'mod'));
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './mod',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('directory');
    expect(c.resolvedFile).toBeUndefined();
  });

  it('reports unresolvable when nothing matches', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './missing.js',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('unresolvable');
    expect(c.resolvedFile).toBeUndefined();
  });

  it('prefers literal .js if it exists on disk over .ts rewrite', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const literalJs = path.join(dir, 'src', 'helper.js');
    const tsSibling = path.join(dir, 'src', 'helper.ts');
    fs.writeFileSync(literalJs, 'export {};');
    fs.writeFileSync(tsSibling, 'export {};');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'a.ts'),
      spec: './helper.js',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(literalJs);
  });

  // ollama bug-hunt FN-2: 1365 Go intra-module imports
  // (`github.com/ollama/ollama/api`, etc.) were classified as `bare`
  // because the classifier knew only JS-style relative paths. With
  // goModuleAlias passed through, they re-anchor against the project
  // root and resolve to `directory`.
  it('Go intra-module spec resolves to directory when goModuleAlias matches', () => {
    fs.mkdirSync(path.join(dir, 'api'));
    fs.writeFileSync(path.join(dir, 'api', 'client.go'), 'package api');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'cmd', 'main.go'),
      spec: 'github.com/ollama/ollama/api',
      projectRootAbs: dir,
      opts: { goModuleAlias: 'github.com/ollama/ollama' },
    });
    expect(c.kind).toBe('directory');
    expect(c.extMissing).toBe(false);
  });

  it('Go spec exactly equal to goModuleAlias (module-root package) resolves to directory', () => {
    // Go permits `import "github.com/foo/bar"` for the package at the
    // module root. Re-anchors to projectRootAbs which is always a directory.
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'sub', 'a.go'),
      spec: 'github.com/ollama/ollama',
      projectRootAbs: dir,
      opts: { goModuleAlias: 'github.com/ollama/ollama' },
    });
    expect(c.kind).toBe('directory');
    expect(c.extMissing).toBe(false);
  });

  it('Go intra-module spec for missing local dir reports unresolvable, not bare', () => {
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'main.go'),
      spec: 'github.com/ollama/ollama/nope',
      projectRootAbs: dir,
      opts: { goModuleAlias: 'github.com/ollama/ollama' },
    });
    expect(c.kind).toBe('unresolvable');
  });

  it('Go spec for a non-matching module stays bare (external dep)', () => {
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'main.go'),
      spec: 'github.com/spf13/cobra',
      projectRootAbs: dir,
      opts: { goModuleAlias: 'github.com/ollama/ollama' },
    });
    expect(c.kind).toBe('bare');
  });

  it('classifyImport without goModuleAlias treats every Go spec as bare (back-compat)', () => {
    fs.mkdirSync(path.join(dir, 'api'));
    fs.writeFileSync(path.join(dir, 'api', 'client.go'), 'package api');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'cmd', 'main.go'),
      spec: 'github.com/ollama/ollama/api',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('bare');
  });

  // ollama bug-hunt FN-4: `#include "header.h"` was classified as
  // bare because the classifier knew only JS-style relative paths.
  // The C preprocessor's "quoted = local-first" search order means
  // the spec should resolve against the importing file's directory
  // (and projectRootAbs) before falling back to bare.
  it('C/C++ quoted include resolves to a sibling file when present', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    const target = path.join(dir, 'src', 'webview.h');
    fs.writeFileSync(target, '// header');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'glue.c'),
      spec: 'webview.h',
      projectRootAbs: dir,
      opts: { cIncludeStyle: 'quoted' },
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
  });

  it('C/C++ quoted include falls back to projectRoot when no sibling exists', () => {
    const target = path.join(dir, 'shared.h');
    fs.writeFileSync(target, '// header');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'main.c'),
      spec: 'shared.h',
      projectRootAbs: dir,
      opts: { cIncludeStyle: 'quoted' },
    });
    expect(c.kind).toBe('file');
    expect(c.resolvedFile).toBe(target);
  });

  it('C/C++ quoted include for a missing header reports unresolvable, not bare', () => {
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'main.c'),
      spec: 'missing.h',
      projectRootAbs: dir,
      opts: { cIncludeStyle: 'quoted' },
    });
    expect(c.kind).toBe('unresolvable');
  });

  it('C/C++ angled include stays bare (system header)', () => {
    fs.writeFileSync(path.join(dir, 'stdio.h'), 'fake');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'main.c'),
      spec: 'stdio.h',
      projectRootAbs: dir,
      opts: { cIncludeStyle: 'angled' },
    });
    expect(c.kind).toBe('bare');
  });

  it('C/C++ classification without cIncludeStyle stays bare (back-compat)', () => {
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'webview.h'), '// header');
    const c = classifyImport({
      importingFileAbs: path.join(dir, 'src', 'glue.c'),
      spec: 'webview.h',
      projectRootAbs: dir,
    });
    expect(c.kind).toBe('bare');
  });

  describe('readGoModuleAlias', () => {
    it('parses the module line from go.mod', () => {
      fs.writeFileSync(
        path.join(dir, 'go.mod'),
        ['module github.com/ollama/ollama', '', 'go 1.22', '', 'require ('].join('\n'),
      );
      expect(readGoModuleAlias(dir)).toBe('github.com/ollama/ollama');
    });

    it('returns null when go.mod is missing', () => {
      expect(readGoModuleAlias(dir)).toBeNull();
    });

    it('returns null when go.mod has no module line', () => {
      fs.writeFileSync(path.join(dir, 'go.mod'), 'go 1.22\n');
      expect(readGoModuleAlias(dir)).toBeNull();
    });
  });

  // ollama bug-hunt FN-3: TS `@/...` path aliases classified as bare
  // because classifyImport knew only relative-path resolution. With
  // tsPathAliases provided, aliased specs resolve to file/directory.
  describe('TypeScript path aliases', () => {
    it('resolves a wildcard alias to a file target', () => {
      fs.mkdirSync(path.join(dir, 'src', 'contexts'), { recursive: true });
      const target = path.join(dir, 'src', 'contexts', 'StreamingContext.tsx');
      fs.writeFileSync(target, 'export const x = 1;');
      const c = classifyImport({
        importingFileAbs: path.join(dir, 'src', 'App.tsx'),
        spec: '@/contexts/StreamingContext',
        projectRootAbs: dir,
        opts: { tsPathAliases: { baseUrl: dir, paths: { '@/*': ['src/*'] } } },
      });
      expect(c.kind).toBe('file');
      expect(c.resolvedFile).toBe(target);
    });

    it('resolves an exact alias (no wildcard)', () => {
      fs.mkdirSync(path.join(dir, 'codegen'), { recursive: true });
      const target = path.join(dir, 'codegen', 'gotypes.gen.ts');
      fs.writeFileSync(target, 'export const x = 1;');
      const c = classifyImport({
        importingFileAbs: path.join(dir, 'src', 'App.tsx'),
        spec: '@/gotypes',
        projectRootAbs: dir,
        opts: { tsPathAliases: { baseUrl: dir, paths: { '@/gotypes': ['codegen/gotypes.gen.ts'] } } },
      });
      expect(c.kind).toBe('file');
      expect(c.resolvedFile).toBe(target);
    });

    it('falls through to bare when no alias matches', () => {
      const c = classifyImport({
        importingFileAbs: path.join(dir, 'src', 'App.tsx'),
        spec: 'react',
        projectRootAbs: dir,
        opts: { tsPathAliases: { baseUrl: dir, paths: { '@/*': ['src/*'] } } },
      });
      expect(c.kind).toBe('bare');
    });

    it('back-compat: no opts.tsPathAliases leaves the aliased spec as bare', () => {
      fs.mkdirSync(path.join(dir, 'src', 'contexts'), { recursive: true });
      fs.writeFileSync(path.join(dir, 'src', 'contexts', 'StreamingContext.tsx'), 'export const x = 1;');
      const c = classifyImport({
        importingFileAbs: path.join(dir, 'src', 'App.tsx'),
        spec: '@/contexts/StreamingContext',
        projectRootAbs: dir,
      });
      expect(c.kind).toBe('bare');
    });
  });

  describe('readTsPathAliases', () => {
    it('returns null when no tsconfig.json is found up to projectRoot', () => {
      fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
      expect(readTsPathAliases(path.join(dir, 'src'), dir)).toBeNull();
    });

    it('parses tsconfig with JSONC // comments', () => {
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        '{\n  // some comment\n  "compilerOptions": {\n    "baseUrl": ".",\n    "paths": { "@/*": ["src/*"] }\n  }\n}\n',
      );
      const aliases = readTsPathAliases(dir, dir);
      expect(aliases).not.toBeNull();
      expect(aliases!.paths['@/*']).toEqual(['src/*']);
    });

    it('walks up from a nested directory to find the nearest tsconfig', () => {
      fs.mkdirSync(path.join(dir, 'src', 'deep', 'nested'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      const aliases = readTsPathAliases(path.join(dir, 'src', 'deep', 'nested'), dir);
      expect(aliases).not.toBeNull();
      expect(aliases!.baseUrl).toBe(dir);
    });

    it('prefers the nearest tsconfig over an ancestor one (monorepo pattern)', () => {
      fs.mkdirSync(path.join(dir, 'app', 'ui', 'src'), { recursive: true });
      // Root tsconfig — would be the only hit if walk-up stopped at the project root.
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['root-src/*'] } } }),
      );
      // Nested tsconfig — should win for files under app/ui/.
      fs.writeFileSync(
        path.join(dir, 'app', 'ui', 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      const aliases = readTsPathAliases(path.join(dir, 'app', 'ui', 'src'), dir);
      expect(aliases!.paths['@/*']).toEqual(['src/*']);
      expect(aliases!.baseUrl).toBe(path.join(dir, 'app', 'ui'));
    });

    it('returns null when tsconfig has no paths', () => {
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true } }));
      expect(readTsPathAliases(dir, dir)).toBeNull();
    });

    it('ignores inherited compilerOptions while parsing tsconfig aliases', () => {
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({}));

      withObjectPrototypeProperty('compilerOptions', { baseUrl: '.', paths: { '@/*': ['src/*'] } }, () => {
        expect(readTsPathAliases(dir, dir)).toBeNull();
      });
    });

    it('ignores inherited compilerOptions fields while parsing tsconfig aliases', () => {
      fs.writeFileSync(path.join(dir, 'tsconfig.json'), JSON.stringify({ compilerOptions: {} }));

      withObjectPrototypeProperty('baseUrl', '.', () => {
        withObjectPrototypeProperty('paths', { '@/*': ['src/*'] }, () => {
          expect(readTsPathAliases(dir, dir)).toBeNull();
        });
      });
    });

    it('uses own compilerOptions fields over polluted prototype fields', () => {
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '#/*': ['lib/*'] } } }),
      );

      let aliases: ReturnType<typeof readTsPathAliases> = null;
      withObjectPrototypeProperty('paths', { '@/*': ['src/*'] }, () => {
        aliases = readTsPathAliases(dir, dir);
      });

      expect(aliases).not.toBeNull();
      expect(aliases!.paths).toEqual({ '#/*': ['lib/*'] });
    });

    it('filters malformed path entries while keeping valid aliases', () => {
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: '.',
            paths: {
              '@/*': 'src/*',
              '#/*': ['lib/*'],
            },
          },
        }),
      );
      const aliases = readTsPathAliases(dir, dir);
      expect(aliases).not.toBeNull();
      expect(aliases!.paths).toEqual({ '#/*': ['lib/*'] });
    });
  });

  describe('buildTsPathAliasResolver', () => {
    it('caches per-directory lookups (one FS walk per unique dir)', () => {
      fs.mkdirSync(path.join(dir, 'src', 'a'), { recursive: true });
      fs.mkdirSync(path.join(dir, 'src', 'b'), { recursive: true });
      fs.writeFileSync(
        path.join(dir, 'tsconfig.json'),
        JSON.stringify({ compilerOptions: { baseUrl: '.', paths: { '@/*': ['src/*'] } } }),
      );
      const resolve = buildTsPathAliasResolver(dir);
      const a1 = resolve(path.join(dir, 'src', 'a', 'foo.ts'));
      const a2 = resolve(path.join(dir, 'src', 'a', 'bar.ts'));
      // Same dir → cache hit returns the same reference (or at least an equivalent value).
      expect(a1).toBe(a2);
      const b = resolve(path.join(dir, 'src', 'b', 'baz.ts'));
      // Different dir → a fresh lookup, but the result is structurally equal
      // (both walk up to the same root tsconfig).
      expect(b!.paths['@/*']).toEqual(['src/*']);
    });
  });
});
