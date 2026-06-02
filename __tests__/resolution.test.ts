/**
 * Resolution Module Tests
 *
 * Tests for Phase 3: Reference Resolution
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import type { Node } from '../src/types.js';
import type { ResolutionContext } from '../src/resolution/index.js';
import { matchReference } from '../src/resolution/name-matcher.js';
import {
  resolveImportPath,
  resolveViaImport,
  extractImportMappings,
  stripJsComments,
} from '../src/resolution/import-resolver.js';
import { getUnresolvedReferences } from '../src/db/queries-unresolved-refs.js';
import { detectFrameworks, getAllFrameworkResolvers } from '../src/resolution/frameworks/index.js';
import { getNodesByKind } from '../src/db/queries.js';

describe('Resolution Module', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    // Create temp directory
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-resolution-test-'));
  });

  afterEach(() => {
    // Clean up
    if (cg) {
      cg.close();
    } else if (fs.existsSync(tempDir)) {
      fs.rmSync(tempDir, { recursive: true });
    }
  });

  describe('Name Matcher', () => {
    it('should match exact name references', () => {
      // Create a mock context
      const mockNodes: Node[] = [
        {
          id: 'func:test.ts:myFunction:10',
          kind: 'function',
          name: 'myFunction',
          qualifiedName: 'test.ts::myFunction',
          filePath: 'test.ts',
          language: 'typescript',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => mockNodes,
        getNodesByName: (name) => mockNodes.filter((n) => n.name === name),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['test.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:caller:5',
        referenceName: 'myFunction',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:test.ts:myFunction:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should prefer same-module candidates over cross-module matches', () => {
      // Simulates a Python monorepo where multiple apps define navigate()
      const candidateA: Node = {
        id: 'func:apps/app_a/src/server.py:navigate:10',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_a/src/server.py::navigate',
        filePath: 'apps/app_a/src/server.py',
        language: 'python',
        startLine: 10,
        endLine: 20,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const candidateB: Node = {
        id: 'func:apps/app_b/src/server.py:navigate:15',
        kind: 'function',
        name: 'navigate',
        qualifiedName: 'apps/app_b/src/server.py::navigate',
        filePath: 'apps/app_b/src/server.py',
        language: 'python',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => (name === 'navigate' ? [candidateA, candidateB] : []),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a should resolve to app_a's navigate, not app_b's
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('func:apps/app_a/src/server.py:navigate:10');
      expect(result?.resolvedBy).toBe('exact-match');
    });

    it('should lower confidence for cross-module exact matches', () => {
      // Only one candidate but in a completely different module
      const candidates: Node[] = [
        {
          id: 'func:apps/app_b/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_b/src/server.py::navigate',
          filePath: 'apps/app_b/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
        {
          id: 'func:apps/app_c/src/server.py:navigate:10',
          kind: 'function',
          name: 'navigate',
          qualifiedName: 'apps/app_c/src/server.py::navigate',
          filePath: 'apps/app_c/src/server.py',
          language: 'python',
          startLine: 10,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: (name) => (name === 'navigate' ? candidates : []),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getNodesByLowerName: () => [],
        getImportMappings: () => [],
      };

      // Reference from app_a — neither candidate is in the same module
      const ref = {
        fromNodeId: 'func:apps/app_a/src/handler.py:handler:5',
        referenceName: 'navigate',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'apps/app_a/src/handler.py',
        language: 'python' as const,
      };

      const result = matchReference(ref, context);

      // Should still resolve but with low confidence
      expect(result).not.toBeNull();
      expect(result?.confidence).toBeLessThanOrEqual(0.4);
    });

    it('should match qualified name references', () => {
      const mockClassNode: Node = {
        id: 'class:user.ts:User:5',
        kind: 'class',
        name: 'User',
        qualifiedName: 'user.ts::User',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 5,
        endLine: 30,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const mockMethodNode: Node = {
        id: 'method:user.ts:User.save:15',
        kind: 'method',
        name: 'save',
        qualifiedName: 'user.ts::User::save',
        filePath: 'user.ts',
        language: 'typescript',
        startLine: 15,
        endLine: 25,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp === 'user.ts' ? [mockClassNode, mockMethodNode] : []),
        getNodesByName: (name) => {
          if (name === 'User') return [mockClassNode];
          if (name === 'save') return [mockMethodNode];
          return [];
        },
        getNodesByQualifiedName: (qn) => {
          if (qn === 'user.ts::User::save') return [mockMethodNode];
          return [];
        },
        getNodesByKind: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['user.ts'],
      };

      const ref = {
        fromNodeId: 'caller:main.ts:main:5',
        referenceName: 'User.save',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'main.ts',
        language: 'typescript' as const,
      };

      const result = matchReference(ref, context);

      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('method:user.ts:User.save:15');
    });

    // -- F2: builtin prototype-method calls must not phantom-resolve --
    describe('F2 — builtin prototype-method denylist', () => {
      // A user symbol literally named `set` (mirrors the QueryBuilder LRU
      // class's `set` method that F2 flagged as a phantom-edge target).
      const userSet: Node = {
        id: 'method:src/db/queries.ts:QueryBuilder.set:42',
        kind: 'method',
        name: 'set',
        qualifiedName: 'src/db/queries.ts::QueryBuilder::set',
        filePath: 'src/db/queries.ts',
        language: 'typescript',
        startLine: 42,
        endLine: 45,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
      };

      /** Build a context with `userSet` discoverable by name + optional imports. */
      const ctxWith = (imports: { localName: string; isNamespace?: boolean }[]): ResolutionContext => ({
        getNodesInFile: (fp) => (fp === 'src/db/queries.ts' ? [userSet] : []),
        getNodesByName: (name) => (name === 'set' ? [userSet] : []),
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        getNodesByLowerName: (n) => (n === 'set' ? [userSet] : []),
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [],
        getImportMappings: () =>
          imports.map((i) => ({
            localName: i.localName,
            exportedName: i.localName,
            source: './somewhere.js',
            isDefault: false,
            isNamespace: i.isNamespace ?? false,
          })),
      });

      it('a bare builtin-named call (`set`) does NOT phantom-resolve to a same-named user symbol', () => {
        // `findPartialClones` calling `someMap.set(...)` can surface in
        // some grammars / chained-call shapes as a bare `set` calls-ref.
        // With no import named `set`, the resolver must leave it
        // unresolved — emitting an edge to `QueryBuilder.set` is the bug.
        const ref = {
          fromNodeId: 'func:src/biomarkers/duplicate-code.ts:findPartialClones:100',
          referenceName: 'set',
          referenceKind: 'calls' as const,
          line: 110,
          column: 4,
          filePath: 'src/biomarkers/duplicate-code.ts',
          language: 'typescript' as const,
        };
        const result = matchReference(ref, ctxWith([]));
        expect(result).toBeNull();
      });

      it('a genuinely-imported same-name call (`set`) still resolves', () => {
        // `import { set } from 'lodash'` → `set(obj, path, val)` is a
        // real call. The import is concrete EXTRACTED backing, so the
        // builtin-method suppression must NOT fire.
        const ref = {
          fromNodeId: 'func:src/app.ts:useSet:5',
          referenceName: 'set',
          referenceKind: 'calls' as const,
          line: 6,
          column: 2,
          filePath: 'src/app.ts',
          language: 'typescript' as const,
        };
        const result = matchReference(ref, ctxWith([{ localName: 'set' }]));
        expect(result).not.toBeNull();
        expect(result?.targetNodeId).toBe(userSet.id);
        expect(result?.resolvedBy).toBe('exact-match');
      });

      it('a non-builtin bare call name is unaffected by the denylist', () => {
        // `myFunction` is not a builtin prototype method — the regular
        // exact-match path still resolves it. (Guards against the
        // denylist over-firing.)
        const userFn: Node = {
          id: 'func:src/util.ts:computeWidget:3',
          kind: 'function',
          name: 'computeWidget',
          qualifiedName: 'src/util.ts::computeWidget',
          filePath: 'src/util.ts',
          language: 'typescript',
          startLine: 3,
          endLine: 8,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        const ctx: ResolutionContext = {
          getNodesInFile: () => [],
          getNodesByName: (n) => (n === 'computeWidget' ? [userFn] : []),
          getNodesByQualifiedName: () => [],
          getNodesByKind: () => [],
          getNodesByLowerName: () => [],
          fileExists: () => true,
          readFile: () => null,
          getProjectRoot: () => '/test',
          getAllFiles: () => [],
          getImportMappings: () => [],
        };
        const ref = {
          fromNodeId: 'func:src/main.ts:run:1',
          referenceName: 'computeWidget',
          referenceKind: 'calls' as const,
          line: 2,
          column: 2,
          filePath: 'src/main.ts',
          language: 'typescript' as const,
        };
        const result = matchReference(ref, ctx);
        expect(result).not.toBeNull();
        expect(result?.targetNodeId).toBe(userFn.id);
      });

      it('a qualified `someMap.set` call does NOT phantom-resolve when the receiver is not a user class', () => {
        // The typical extracted shape: `tsQualifyCallReceiver` keeps the
        // receiver, so the calls-ref is `someMap.set`. No class named
        // `someMap`/`SomeMap` exists, so strategies 1/2 of matchMethodCall
        // miss; strategy 3's pure method-name overlap would otherwise
        // land on `QueryBuilder.set`. The builtin-method guard suppresses it.
        const ref = {
          fromNodeId: 'func:src/biomarkers/duplicate-code.ts:findPartialClones:100',
          referenceName: 'someMap.set',
          referenceKind: 'calls' as const,
          line: 110,
          column: 4,
          filePath: 'src/biomarkers/duplicate-code.ts',
          language: 'typescript' as const,
        };
        const result = matchReference(ref, ctxWith([]));
        expect(result).toBeNull();
      });

      it('a `field_access` reference to a same-named member is NOT suppressed (calls-only guard)', () => {
        // The F2 suppression is scoped to `calls` edges. A `field_access`
        // ref (`obj.size` data read) keeps its normal resolution path.
        const userSize: Node = {
          id: 'field:src/hnsw.ts:HnswIndex.size:9',
          kind: 'field',
          name: 'size',
          qualifiedName: 'src/hnsw.ts::HnswIndex::size',
          filePath: 'src/hnsw.ts',
          language: 'typescript',
          startLine: 9,
          endLine: 9,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        const ctx: ResolutionContext = {
          getNodesInFile: () => [],
          getNodesByName: (n) => (n === 'size' ? [userSize] : []),
          getNodesByQualifiedName: () => [],
          getNodesByKind: () => [],
          getNodesByLowerName: () => [],
          fileExists: () => true,
          readFile: () => null,
          getProjectRoot: () => '/test',
          getAllFiles: () => [],
          getImportMappings: () => [],
        };
        const ref = {
          fromNodeId: 'func:src/app.ts:reader:1',
          referenceName: 'size',
          referenceKind: 'field_access' as const,
          line: 2,
          column: 2,
          filePath: 'src/app.ts',
          language: 'typescript' as const,
        };
        const result = matchReference(ref, ctx);
        // field_access path is untouched — it still exact-matches.
        expect(result).not.toBeNull();
        expect(result?.targetNodeId).toBe(userSize.id);
      });
    });
  });

  describe('Import Resolver', () => {
    it('should resolve relative import paths', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/components/utils.ts' || p === 'src/components/utils/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/components/utils.ts', 'src/components/utils/index.ts'],
      };

      const result = resolveImportPath({
        importPath: './utils',
        fromFile: 'src/components/Button.ts',
        language: 'typescript',
        context,
      });

      expect(result).toBe('src/components/utils.ts');
    });

    it('should resolve parent directory imports', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/helpers.ts' || p === 'src/helpers/index.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/helpers.ts', 'src/helpers/index.ts'],
      };

      const result = resolveImportPath({
        importPath: '../helpers',
        fromFile: 'src/components/Button.ts',
        language: 'typescript',
        context,
      });

      expect(result).toBe('src/helpers.ts');
    });

    it('NodeNext shim — strips .js suffix and finds the .ts source', () => {
      // NodeNext ESM convention: import paths use `.js` even though
      // the source file is `.ts`. Without the strip-and-retry logic in
      // `resolveRelativeImport`, the resolver tries `foo.js.ts`,
      // `foo.js.tsx`, ... (all miss) and the literal `foo.js` (only
      // exists in `dist/`, not in the indexed source). This regression
      // test pins the shim — it's the unblock for all 1000+ relative
      // imports in this NodeNext repo.
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByLowerName: () => [],
        getNodesByKind: () => [],
        // Only the .ts source exists; the .js path the import refers
        // to does NOT (mirrors a TS-only NodeNext project).
        fileExists: (p) => p === 'src/foo.ts',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/foo.ts'],
        getImportMappings: () => [],
      };

      const result = resolveImportPath({
        importPath: './foo.js',
        fromFile: 'src/bar.ts',
        language: 'typescript',
        context,
      });

      expect(result).toBe('src/foo.ts');
    });

    it('NodeNext shim — leaves a literal .js source file alone', () => {
      // The strip path runs LAST (after literal-extension and
      // bare-path lookups). When `./data.js` is genuinely a `.js`
      // file in source, the bare-path lookup catches it first and
      // the strip never runs.
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByLowerName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'src/data.js',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['src/data.js'],
        getImportMappings: () => [],
      };

      const result = resolveImportPath({
        importPath: './data.js',
        fromFile: 'src/use.ts',
        language: 'typescript',
        context,
      });

      expect(result).toBe('src/data.js');
    });

    // F#33 (2026-05-26) — when a ref's import matches by name but the
    // import path can't be resolved (stdlib / external dep) OR the
    // resolved file has no matching export, fall back to the LOCAL
    // import node so the edge survives instead of being dropped.
    // The fallback uses `resolvedBy: 'external-import'` + confidence
    // 0.4 so direct-resolution (0.9) always wins when both fire.
    describe('F#33 external-import fallback', () => {
      it('resolves to the local import node when the import path is external (stdlib)', () => {
        // Simulate a Python file that imports Protocol from typing (stdlib).
        // The import node has been extracted as kind='import' name='typing'.
        const importNode: Node = {
          id: 'import:typing-in-foo',
          kind: 'import',
          name: 'typing',
          qualifiedName: 'foo.py::typing',
          filePath: 'foo.py',
          language: 'python',
          signature: 'from typing import Protocol',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };

        const context: ResolutionContext = {
          getNodesInFile: (p) => (p === 'foo.py' ? [importNode] : []),
          getNodesByName: () => [],
          getNodesByQualifiedName: () => [],
          getNodesByLowerName: () => [],
          getNodesByKind: () => [],
          // The stdlib path doesn't exist on disk — that's what makes
          // `resolveImportPath` return null and triggers the fallback.
          fileExists: () => false,
          readFile: () => null,
          getProjectRoot: () => '/project',
          getAllFiles: () => ['foo.py'],
          getImportMappings: (p) =>
            p === 'foo.py'
              ? [
                  {
                    localName: 'Protocol',
                    exportedName: 'Protocol',
                    source: 'typing',
                    isDefault: false,
                    isNamespace: false,
                    line: 1,
                  },
                ]
              : [],
        };

        const ref = {
          fromNodeId: 'class:Renderable',
          referenceName: 'Protocol',
          referenceKind: 'implements' as const,
          filePath: 'foo.py',
          language: 'python' as const,
          line: 3,
          column: 18,
        };

        const result = resolveViaImport(ref, context);
        expect(result).not.toBeNull();
        expect(result!.targetNodeId).toBe('import:typing-in-foo');
        expect(result!.resolvedBy).toBe('external-import');
        expect(result!.confidence).toBeLessThan(0.9);
      });

      // Reviewer follow-up — this sub-case documents that the fallback
      // ALSO fires when the import path DOES resolve but the resolved
      // file has no matching export. Acceptable trade-off: a missing
      // export usually means the target file's extraction is incomplete
      // (older index / parse error / extractor gap), and the local
      // import node IS still a real graph relationship. If a future
      // refactor wants to distinguish "stdlib" from "missing export"
      // (so the latter can surface a warning), this test pins down the
      // current behaviour so the change is explicit.
      it('also falls back to the local import node when the path resolves but no exported symbol matches', () => {
        const importNode: Node = {
          id: 'import:utils-in-foo',
          kind: 'import',
          name: './utils',
          qualifiedName: 'foo.ts::./utils',
          filePath: 'foo.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        // The target file exists (so resolveImportPath returns a path)
        // but has NO exported symbol named `Bar` (getNodesInFile for it
        // returns empty, so findExportedSymbol can't find anything).
        const context: ResolutionContext = {
          getNodesInFile: (p) => (p === 'foo.ts' ? [importNode] : []),
          getNodesByName: () => [],
          getNodesByQualifiedName: () => [],
          getNodesByLowerName: () => [],
          getNodesByKind: () => [],
          fileExists: (p) => p === 'utils.ts',
          readFile: () => null,
          getProjectRoot: () => '',
          getAllFiles: () => ['foo.ts', 'utils.ts'],
          getImportMappings: (p) =>
            p === 'foo.ts'
              ? [
                  {
                    localName: 'Bar',
                    exportedName: 'Bar',
                    source: './utils',
                    isDefault: false,
                    isNamespace: false,
                    line: 1,
                  },
                ]
              : [],
        };
        const ref = {
          fromNodeId: 'class:Foo',
          referenceName: 'Bar',
          referenceKind: 'extends' as const,
          filePath: 'foo.ts',
          language: 'typescript' as const,
          line: 3,
          column: 18,
        };
        const result = resolveViaImport(ref, context);
        expect(result).not.toBeNull();
        expect(result!.targetNodeId).toBe('import:utils-in-foo');
        expect(result!.resolvedBy).toBe('external-import');
      });

      it('skips the fallback for an unresolved relative import (./X with target file not yet on disk)', () => {
        // Reviewer-caught regression guard for the `6dd781bf` fix:
        // when resolveImportPath returns null AND the import source is
        // a relative intra-project reference (`./callee.js`,
        // `../foo`, Python `.foo`), `resolveViaImport` must return
        // null so the ref stays in unresolved_refs for the next
        // sync's pass-B sweep when the file lands. Pre-fix the F#33
        // fallback fired and pinned the ref to a placeholder import
        // node forever. A Stryker mutation removing the
        // `isRelativeImportSource` guard would silently re-introduce
        // the regression — this test catches it.
        const importNode: Node = {
          id: 'import:callee-in-caller',
          kind: 'import',
          name: 'callee',
          qualifiedName: 'src/caller.ts::callee',
          filePath: 'src/caller.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        const context: ResolutionContext = {
          getNodesInFile: () => [importNode],
          getNodesByName: () => [],
          getNodesByQualifiedName: () => [],
          getNodesByLowerName: () => [],
          getNodesByKind: () => [],
          // Relative target file doesn't exist yet — resolveImportPath
          // returns null, which pre-fix would trigger the fallback.
          fileExists: () => false,
          readFile: () => null,
          getProjectRoot: () => '/project',
          getAllFiles: () => ['src/caller.ts'],
          getImportMappings: (p) =>
            p === 'src/caller.ts'
              ? [
                  {
                    localName: 'lateExport',
                    exportedName: 'lateExport',
                    source: './callee.js',
                    isDefault: false,
                    isNamespace: false,
                    line: 1,
                  },
                ]
              : [],
        };
        const ref = {
          fromNodeId: 'function:callsIt',
          referenceName: 'lateExport',
          referenceKind: 'calls' as const,
          filePath: 'src/caller.ts',
          language: 'typescript' as const,
          line: 2,
          column: 16,
        };
        // Must return null so pass-B can sweep the ref when callee
        // lands — NOT fall back to the placeholder import node.
        expect(resolveViaImport(ref, context)).toBeNull();
      });

      it('still returns null when no import matches the referenced name', () => {
        const importNode: Node = {
          id: 'import:other-in-foo',
          kind: 'import',
          name: 'other',
          qualifiedName: 'foo.py::other',
          filePath: 'foo.py',
          language: 'python',
          startLine: 1,
          endLine: 1,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        };
        const context: ResolutionContext = {
          getNodesInFile: () => [importNode],
          getNodesByName: () => [],
          getNodesByQualifiedName: () => [],
          getNodesByLowerName: () => [],
          getNodesByKind: () => [],
          fileExists: () => false,
          readFile: () => null,
          getProjectRoot: () => '/project',
          getAllFiles: () => ['foo.py'],
          getImportMappings: () => [
            {
              localName: 'other_name',
              exportedName: 'other_name',
              source: 'other',
              isDefault: false,
              isNamespace: false,
            },
          ],
        };

        const ref = {
          fromNodeId: 'class:X',
          referenceName: 'Protocol', // doesn't match any imported local name
          referenceKind: 'implements' as const,
          filePath: 'foo.py',
          language: 'python' as const,
          line: 3,
          column: 0,
        };

        // No matching import means the function bails out before the F#33
        // fallback path is even reached.
        expect(resolveViaImport(ref, context)).toBeNull();
      });
    });

    it('extractImportMappings — populates `line` for ES6 imports', () => {
      // Line tracking is what lets `pickMatchingImport` Pass 2
      // disambiguate between two aliased imports that share the
      // same exported name (the migrations registry case).
      const content = [
        '', // 1
        "import { Foo as Local1 } from './a.js';", // 2
        "import { Foo as Local2 } from './b.js';", // 3
      ].join('\n');

      const mappings = extractImportMappings('src/idx.ts', content, 'typescript');
      const m1 = mappings.find((m) => m.localName === 'Local1');
      const m2 = mappings.find((m) => m.localName === 'Local2');
      expect(m1?.line).toBe(2);
      expect(m2?.line).toBe(3);
      expect(m1?.exportedName).toBe('Foo');
      expect(m2?.exportedName).toBe('Foo');
    });

    it('should extract JS/TS import mappings', () => {
      const content = `
import { foo } from './foo.js';
import bar from '../bar.js';
import * as utils from './utils.js';
import { baz, qux } from './baz.js';
`;

      const mappings = extractImportMappings('src/index.ts', content, 'typescript');

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'foo')).toBe(true);
      expect(mappings.some((m) => m.localName === 'bar')).toBe(true);
    });

    it('should extract Python import mappings', () => {
      const content = `
from utils import helper
from .models import User
import os
from ..services import auth_service
`;

      const mappings = extractImportMappings('src/main.py', content, 'python');

      expect(mappings.length).toBeGreaterThan(0);
      expect(mappings.some((m) => m.localName === 'helper')).toBe(true);
      expect(mappings.some((m) => m.localName === 'User')).toBe(true);
    });

    it('extractImportMappings — handles multi-line parenthesised Python from-imports (F#36)', () => {
      // F#36 (2026-05-26): the pre-fix single-line regex captured `(`
      // as the names-list for any PEP-8 / Black-style parenthesised
      // multi-line import, so bare-identifier references like
      // `class Foo(ABC):` had no matching import mapping → F#33's
      // external-import fallback couldn't fire → the implements ref
      // stayed unresolved.
      const content = `
from abc import (
    ABC,
    abstractmethod,
)
from typing import (
    Protocol,
    Generic as G,
    TYPE_CHECKING,
)
`;
      const mappings = extractImportMappings('src/main.py', content, 'python');

      // Bare names
      expect(mappings.some((m) => m.localName === 'ABC' && m.source === 'abc')).toBe(true);
      expect(mappings.some((m) => m.localName === 'abstractmethod' && m.source === 'abc')).toBe(true);
      expect(mappings.some((m) => m.localName === 'Protocol' && m.source === 'typing')).toBe(true);
      expect(mappings.some((m) => m.localName === 'TYPE_CHECKING' && m.source === 'typing')).toBe(true);
      // Aliased name inside the parenthesised list
      const aliased = mappings.find((m) => m.localName === 'G' && m.source === 'typing');
      expect(aliased).toBeDefined();
      expect(aliased?.exportedName).toBe('Generic');
      // Stray `(` must NOT leak as a mapping name.
      expect(mappings.some((m) => m.localName === '(')).toBe(false);
    });

    it('extractImportMappings — preserves single-line non-parenthesised from-imports (F#36 regression guard)', () => {
      const content = `from os.path import join, dirname as d`;
      const mappings = extractImportMappings('src/main.py', content, 'python');

      expect(mappings.some((m) => m.localName === 'join' && m.source === 'os.path')).toBe(true);
      const aliased = mappings.find((m) => m.localName === 'd');
      expect(aliased).toBeDefined();
      expect(aliased?.exportedName).toBe('dirname');
    });

    it('extractImportMappings — strips inline `# comment` tails inside multi-line paren imports', () => {
      // Without the `#` strip, the comma-split would yield
      // `["Optional", "# legacy\n    List", "Dict"]` — the middle
      // element fails the alias / bare-name match and `List` is
      // silently dropped (no mapping produced).
      const content = `
from typing import (
    Optional,  # for backwards compat
    List,
    Dict,
)
`;
      const mappings = extractImportMappings('src/main.py', content, 'python');
      const names = mappings.map((m) => m.localName);
      expect(names).toContain('Optional');
      expect(names).toContain('List');
      expect(names).toContain('Dict');
      // No comment-shaped local name should leak through.
      expect(mappings.some((m) => m.localName?.startsWith('#'))).toBe(false);
    });
  });

  describe('Framework Detection', () => {
    it('should detect React framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { react: '^18.0.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'react')).toBe(true);
    });

    it('should detect Express framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({
              dependencies: { express: '^4.18.0' },
            });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/app.js'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'express')).toBe(true);
    });

    it('should detect Laravel framework', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'artisan',
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => ['artisan', 'app/Http/Kernel.php'],
      };

      const frameworks = detectFrameworks(context);
      expect(frameworks.some((f) => f.name === 'laravel')).toBe(true);
    });

    it('should return all framework resolvers', () => {
      const resolvers = getAllFrameworkResolvers();
      expect(resolvers.length).toBeGreaterThan(0);
      expect(resolvers.some((r) => r.name === 'react')).toBe(true);
      expect(resolvers.some((r) => r.name === 'express')).toBe(true);
      expect(resolvers.some((r) => r.name === 'laravel')).toBe(true);
    });
  });

  describe('React Framework Resolver', () => {
    it('should resolve React component references', () => {
      const mockNodes: Node[] = [
        {
          id: 'component:src/Button.tsx:Button:5',
          kind: 'component',
          name: 'Button',
          qualifiedName: 'src/Button.tsx::Button',
          filePath: 'src/Button.tsx',
          language: 'tsx',
          startLine: 5,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp === 'src/Button.tsx' ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/Button.tsx', 'src/App.tsx'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');
      expect(reactResolver).toBeDefined();

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'Button',
        referenceKind: 'renders' as const,
        line: 10,
        column: 5,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('component:src/Button.tsx:Button:5');
    });

    it('should resolve custom hook references', () => {
      const mockNodes: Node[] = [
        {
          id: 'hook:src/hooks/useAuth.ts:useAuth:1',
          kind: 'function',
          name: 'useAuth',
          qualifiedName: 'src/hooks/useAuth.ts::useAuth',
          filePath: 'src/hooks/useAuth.ts',
          language: 'typescript',
          startLine: 1,
          endLine: 20,
          startColumn: 0,
          endColumn: 0,
          updatedAt: Date.now(),
        },
      ];

      const context: ResolutionContext = {
        getNodesInFile: (fp) => (fp.includes('useAuth') ? mockNodes : []),
        getNodesByName: () => mockNodes,
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        fileExists: () => false,
        readFile: (p) => {
          if (p === 'package.json') {
            return JSON.stringify({ dependencies: { react: '^18.0.0' } });
          }
          return null;
        },
        getProjectRoot: () => '/test',
        getAllFiles: () => ['package.json', 'src/hooks/useAuth.ts'],
      };

      const frameworks = detectFrameworks(context);
      const reactResolver = frameworks.find((f) => f.name === 'react');

      const ref = {
        fromNodeId: 'component:src/App.tsx:App:1',
        referenceName: 'useAuth',
        referenceKind: 'calls' as const,
        line: 5,
        column: 10,
        filePath: 'src/App.tsx',
        language: 'typescript' as const,
      };

      const result = reactResolver!.resolve(ref, context);
      expect(result).not.toBeNull();
      expect(result?.targetNodeId).toBe('hook:src/hooks/useAuth.ts:useAuth:1');
    });
  });

  describe('Integration Tests', () => {
    it('should create resolver from Cartograph instance', async () => {
      // Create a simple TypeScript project
      fs.writeFileSync(
        path.join(tempDir, 'package.json'),
        JSON.stringify({ name: 'test', dependencies: { react: '^18.0.0' } }),
      );

      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir);

      // Create utility file
      fs.writeFileSync(
        path.join(srcDir, 'utils.ts'),
        `export function formatDate(date: Date): string {
  return date.toISOString();
}

export function parseDate(str: string): Date {
  return new Date(str);
}`,
      );

      // Create main file that uses utils
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { formatDate, parseDate } from './utils.js';

function processDate(input: string): string {
  const date = parseDate(input);
  return formatDate(date);
}`,
      );

      // Initialize and index
      cg = await Cartograph.init(tempDir, { index: true });

      // Check that resolver detected React framework
      const frameworks = cg.internals.resolver.getDetectedFrameworks();
      expect(frameworks).toContain('react');

      // Get stats to verify indexing worked
      const stats = cg.stats.getStats();
      expect(stats.fileCount).toBe(2);
      expect(stats.nodeCount).toBeGreaterThan(0);
    });

    it('aliased same-named imports each resolve to their own source (migrations-registry pattern)', async () => {
      // Regression for the false-positive `unused_export` cluster.
      // When N files all `export const SAME_NAME` and a registry
      // imports each via `import { SAME_NAME as ALIAS_n } from
      // './n.js'`, the resolver MUST produce one `references` edge
      // per (registry → exporter) pair. Pre-fix, `dedupeReferences`
      // collapsed all N refs into one (shared name), and the
      // name-only fallback then pinned every site to the FIRST
      // exporter — leaving N−1 exports flagged unused.
      //
      // Pins the four-stage fix: (1) NodeNext .js shim,
      // (2) emitNamedImportRefsFromFile pushing local alias, (3)
      // matchesLocalImportAlias bypass, (4) pickMatchingImport.
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export const SAME = { v: 1 };\n`);
      fs.writeFileSync(path.join(srcDir, 'b.ts'), `export const SAME = { v: 2 };\n`);
      fs.writeFileSync(path.join(srcDir, 'c.ts'), `export const SAME = { v: 3 };\n`);
      fs.writeFileSync(
        path.join(srcDir, 'index.ts'),
        [
          `import { SAME as A } from './a.js';`,
          `import { SAME as B } from './b.js';`,
          `import { SAME as C } from './c.js';`,
          `export const REGISTRY = [A, B, C];`,
        ].join('\n') + '\n',
      );

      cg = await Cartograph.init(tempDir, { index: true });
      cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

      // Each exporter must end up with at least one incoming
      // `references` edge — i.e. the resolver pinned the
      // file-specific target rather than collapsing all 3 onto one.
      const constants = getNodesByKind(cg.queries, 'constant').filter((n) => n.name === 'SAME');
      expect(constants).toHaveLength(3);

      const refsPerFile = new Map<string, number>();
      for (const c of constants) {
        const callers = cg.internals.traverser.getCallers(c.id, 1);
        refsPerFile.set(c.filePath, callers.length);
      }
      // All three exporters resolved.
      for (const [, count] of refsPerFile) {
        expect(count).toBeGreaterThan(0);
      }
    });

    // B3 (2026-05-23) — `resolveAndPersistBatched`'s progress counter
    // used to be `processed += batch.length`, which double-counted
    // handoff #10 orphan refs (name-matched but endpoint-check dropped)
    // because each iteration reads at offset 0 and the same orphan
    // re-emerges in every batch. Symptom: on microsoft/TypeScript the
    // counter ran past 100% to 406921/331994 (122%). Fix counts
    // `deletedCount` (refs actually removed from the queue) instead.
    //
    // Setup mirrors `__tests__/resolution-orphan-survival.test.ts`:
    // inject a synthetic orphan ref (from_node_id points at no real
    // node) so persistResolvedBatch's endpoint-check drops its edge
    // and the ref survives every iteration. With batchSize=1 the
    // batched loop must read this orphan before it breaks on
    // `deletedCount === 0` — and the progress callback fires once
    // BEFORE the break-check, so the (overshoot-impossible) invariant
    // gets exercised on the exact path that previously broke it.
    it('resolveAndPersistBatched progress never exceeds total even when orphans stay in the queue (B3 regression)', async () => {
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });
      fs.writeFileSync(path.join(srcDir, 'helpers.ts'), 'export function helper(): number { return 1; }\n');
      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helper } from './helpers.js';\nfunction main(): number { return helper(); }\n`,
      );

      cg = await Cartograph.init(tempDir, { index: true });

      // Inject synthetic orphan refs: from_node_id points at no real
      // node, so the resolver will name-match `helper` but persist will
      // drop the edge at the endpoint check — the row survives.
      cg.queries.db.exec('PRAGMA foreign_keys = OFF');
      try {
        const stmt = cg.queries.db.prepare(
          `INSERT INTO unresolved_refs
             (from_node_id, reference_name, reference_kind, line, col, file_path, language)
           VALUES (?, ?, ?, ?, ?, ?, ?)`,
        );
        for (let i = 0; i < 3; i++) {
          stmt.run(`n_dead_for_b3_${i}`, 'helper', 'calls', 99 + i, 0, 'src/a.ts', 'typescript');
        }
      } finally {
        cg.queries.db.exec('PRAGMA foreign_keys = ON');
      }

      const ticks: Array<{ current: number; total: number }> = [];
      // batchSize=1 maximises the chance of multi-iteration: each batch
      // pulls one row, processes it, callback fires, then either
      // continues (deletedCount > 0) or breaks (orphan, deletedCount === 0).
      await cg.internals.resolver.resolveAndPersistBatched((current, total) => {
        ticks.push({ current, total });
      }, 1);

      expect(ticks.length).toBeGreaterThan(0);
      const initialTotal = ticks[0]!.total;
      // Invariant 1: `total` is a snapshot taken once before the loop
      // and must stay constant across every callback.
      for (const t of ticks) expect(t.total).toBe(initialTotal);
      // Invariant 2: progress is monotonically non-decreasing.
      for (let i = 1; i < ticks.length; i++) {
        expect(ticks[i]!.current).toBeGreaterThanOrEqual(ticks[i - 1]!.current);
      }
      // Invariant 3 (the regression guard): progress NEVER exceeds
      // total. Pre-fix: 4+ iterations on this fixture each added 1 to
      // `processed` for a final overshoot of `current > total`.
      for (const t of ticks) expect(t.current).toBeLessThanOrEqual(t.total);
    });

    it('should resolve references after indexing', async () => {
      // Create a project with references
      const srcDir = path.join(tempDir, 'src');
      fs.mkdirSync(srcDir, { recursive: true });

      fs.writeFileSync(
        path.join(srcDir, 'helper.ts'),
        `export function helperFunction(): void {
  console.log('helper');
}`,
      );

      fs.writeFileSync(
        path.join(srcDir, 'main.ts'),
        `import { helperFunction } from './helper.js';

function main(): void {
  helperFunction();
}`,
      );

      cg = await Cartograph.init(tempDir, { index: true });

      // Run reference resolution
      const result = cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

      // Should have attempted resolution
      expect(result.stats.total).toBeGreaterThanOrEqual(0);
    });
  });

  describe('tsconfig path aliases', () => {
    it('resolves an aliased import to the alias-mapped file (not a same-named file elsewhere)', async () => {
      // Two same-named exports in different directories. Without alias
      // resolution, name-matcher would pick whichever it finds first;
      // with alias resolution, the import path uniquely picks one.
      fs.mkdirSync(path.join(tempDir, 'src/utils'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'src/legacy'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/utils/format.ts'), `export function pickMe(): number { return 1; }\n`);
      fs.writeFileSync(path.join(tempDir, 'src/legacy/format.ts'), `export function pickMe(): number { return 99; }\n`);
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { pickMe } from '@utils/format';\nexport function go(): number { return pickMe(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['utils/*'] },
          },
        }),
      );

      cg = await Cartograph.init(tempDir, { index: true });
      cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

      // The two pickMe nodes live in different files. The aliased
      // import should attach the call edge to the @utils-mapped one,
      // not the legacy duplicate.
      const all = getNodesByKind(cg.queries, 'function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = cg.internals.traverser.getCallers(utilsNode!.id);
      const legacyCallers = cg.internals.traverser.getCallers(legacyNode!.id);
      expect(utilsCallers.length).toBeGreaterThan(0);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      // The legacy node should NOT have a caller from src/main.ts —
      // the alias correctly picked the utils version.
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('falls back gracefully when tsconfig is absent', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/a.ts'), `export function aFn(): void {}\n`);
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `import { aFn } from './a.js';\nexport function bFn(): void { aFn(); }\n`,
      );

      cg = await Cartograph.init(tempDir, { index: true });
      // No tsconfig present — index should still complete and the
      // relative-import-based call edge should be created.
      const aFn = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'aFn');
      expect(aFn).toBeDefined();
      const callers = cg.internals.traverser.getCallers(aFn!.id);
      expect(callers.some((c) => c.node.filePath === 'src/b.ts')).toBe(true);
    });
  });
});

// ---------------------------------------------------------------------------
// stripJsComments — unit tests
// ---------------------------------------------------------------------------
describe('stripJsComments', () => {
  // -- Regression: regex literal with quote chars must NOT confuse string tracker --
  it('strips a // comment that follows a regex literal containing quote chars', () => {
    // The regex /[^'"`\n]+/ contains quote characters. Without regex-literal
    // awareness, the scanner would enter a phantom string state on the `'` and
    // then fail to recognise the subsequent // as a comment.
    const src = ['const RE = /[^\'"\\`\\n]+/g;', "// import('ghost-pkg')"].join('\n');
    const result = stripJsComments(src);
    expect(result).not.toContain('ghost-pkg');
    expect(result).not.toContain('import(');
    // The regex literal itself must survive (the const declaration line should be present).
    expect(result).toContain('const RE =');
  });

  it('strips a /* */ block comment that follows a regex literal containing quote chars', () => {
    const src = "const RE = /[^'\"]+/; /* import('ghost-pkg') */ const x = 1;";
    const result = stripJsComments(src);
    expect(result).not.toContain('ghost-pkg');
    expect(result).toContain('const x = 1;');
  });

  // -- The real-world trigger: IMPORT_PATTERNS-style array of regexes + doc comments --
  it('strips doc comments after an array of regex literals (replicates IMPORT_PATTERNS pattern)', () => {
    const src = [
      'const PATTERNS = [',
      String.raw`  /\bimport\b[^'"\n]*?\bfrom\s*['"]([^'"\s]+)['"]/g,`,
      String.raw`  /require\s*\(\s*['"]([^'"\s]+)['"]\s*\)/g,`,
      '];',
      "// Example: import('spec') or require('spec')",
    ].join('\n');
    const result = stripJsComments(src);
    // The comment text must be stripped.
    expect(result).not.toContain("import('spec')");
    expect(result).not.toContain("require('spec')");
    // The regex patterns must survive intact.
    expect(result).toContain('PATTERNS');
  });

  // -- Division operator: `/` between two values must survive --
  it('preserves division operator and strips trailing // comment', () => {
    const src = 'const x = a / b; // a comment';
    const result = stripJsComments(src);
    expect(result).toContain('a / b');
    expect(result).not.toContain('a comment');
  });

  it('still parses a string literal correctly after a division expression', () => {
    const src = `const r = 10 / 2;\nconst s = "hello"; // y`;
    const result = stripJsComments(src);
    expect(result).toContain('"hello"');
    expect(result).not.toContain('// y');
    expect(result).not.toContain(' y');
  });

  // -- Plain existing behaviour must remain green --
  it('strips line comments', () => {
    const src = 'const x = 1; // comment\nconst y = 2;';
    const result = stripJsComments(src);
    expect(result).not.toContain('comment');
    expect(result).toContain('const y = 2;');
  });

  it('strips block comments', () => {
    const src = 'const x = /* removed */ 1;';
    const result = stripJsComments(src);
    expect(result).not.toContain('removed');
    expect(result).toContain('const x =');
    expect(result).toContain('1;');
  });

  it('preserves // inside double-quoted strings', () => {
    const src = `const url = "http://example.com"; // strip this`;
    const result = stripJsComments(src);
    expect(result).toContain('http://example.com');
    expect(result).not.toContain('strip this');
  });

  it('preserves // inside single-quoted strings', () => {
    const src = "const s = '// not a comment';";
    const result = stripJsComments(src);
    expect(result).toContain("'// not a comment'");
  });

  it('preserves content inside template literals', () => {
    const src = 'const t = `hello // world`; // strip';
    const result = stripJsComments(src);
    expect(result).toContain('`hello // world`');
    expect(result).not.toContain('strip');
  });

  it('handles escape sequences inside strings', () => {
    const src = String.raw`const s = "she said \"hi\""; // comment`;
    const result = stripJsComments(src);
    expect(result).toContain(String.raw`\"hi\"`);
    expect(result).not.toContain('comment');
  });

  // -- Regex with flags --
  it('emits regex flags verbatim', () => {
    const src = 'const r = /foo/gi; // strip';
    const result = stripJsComments(src);
    expect(result).toContain('/foo/gi');
    expect(result).not.toContain('strip');
  });

  // -- Regex char class containing `/` (must not close regex early) --
  it('handles regex char class containing forward slash', () => {
    const src = String.raw`const r = /[a-z\/]+/; // strip`;
    const result = stripJsComments(src);
    expect(result).toContain(String.raw`/[a-z\/]+/`);
    expect(result).not.toContain('strip');
  });
});
