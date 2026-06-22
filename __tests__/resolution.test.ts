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
  extractReExports,
  stripJsComments,
} from '../src/resolution/import-resolver.js';
import type { ImportMapping, UnresolvedRef } from '../src/resolution/types.js';
import type { AliasMap } from '../src/resolution/path-aliases.js';
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

    describe('matchReference strategy coverage', () => {
      const node = (overrides: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>): Node => ({
        qualifiedName: `${overrides.filePath}::${overrides.name}`,
        language: 'typescript',
        startLine: 1,
        endLine: 1,
        startColumn: 0,
        endColumn: 0,
        updatedAt: Date.now(),
        ...overrides,
      });

      const ref = (
        overrides: Partial<Parameters<typeof matchReference>[0]> = {},
      ): Parameters<typeof matchReference>[0] => ({
        fromNodeId: 'func:src/app.ts:run:1',
        referenceName: 'missing',
        referenceKind: 'calls',
        line: 10,
        column: 2,
        filePath: 'src/app.ts',
        language: 'typescript',
        ...overrides,
      });

      const contextWithNodes = (nodes: Node[], extra: Partial<ResolutionContext> = {}): ResolutionContext => ({
        getNodesInFile: (filePath) => nodes.filter((n) => n.filePath === filePath),
        getNodesByName: (name) => nodes.filter((n) => n.name === name),
        getNodesByQualifiedName: (qualifiedName) => nodes.filter((n) => n.qualifiedName === qualifiedName),
        getNodesByLowerName: (lowerName) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
        getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
        getImportMappings: () => [],
        fileExists: () => true,
        readFile: () => null,
        getProjectRoot: () => '/test',
        getAllFiles: () => [...new Set(nodes.map((n) => n.filePath))],
        ...extra,
      });

      it('resolves path-like references to file nodes by exact path, suffix, then filename-only fallback', () => {
        const exactFile = node({
          id: 'file:snippets/drawer-menu.liquid',
          kind: 'file',
          name: 'drawer-menu.liquid',
          qualifiedName: 'snippets/drawer-menu.liquid',
          filePath: 'snippets/drawer-menu.liquid',
          language: 'liquid',
        });
        const nestedFile = node({
          id: 'file:src/snippets/card.liquid',
          kind: 'file',
          name: 'card.liquid',
          qualifiedName: 'src/snippets/card.liquid',
          filePath: 'src/snippets/card.liquid',
          language: 'liquid',
        });
        const singleFilename = node({
          id: 'file:theme/sections/hero.liquid',
          kind: 'file',
          name: 'hero.liquid',
          qualifiedName: 'theme/sections/hero.liquid',
          filePath: 'theme/sections/hero.liquid',
          language: 'liquid',
        });
        const ctx = contextWithNodes([exactFile, nestedFile, singleFilename]);

        expect(matchReference(ref({ referenceName: 'snippets/drawer-menu.liquid' }), ctx)).toMatchObject({
          targetNodeId: exactFile.id,
          confidence: 0.95,
          resolvedBy: 'file-path',
        });
        expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), ctx)).toMatchObject({
          targetNodeId: nestedFile.id,
          confidence: 0.85,
          resolvedBy: 'file-path',
        });
        expect(matchReference(ref({ referenceName: 'blocks/hero.liquid' }), ctx)).toMatchObject({
          targetNodeId: singleFilename.id,
          confidence: 0.7,
          resolvedBy: 'file-path',
        });
      });

      it('uses receiver-qualified method resolution before exact-name fallback', () => {
        const serviceClass = node({
          id: 'class:src/services/UserService.ts:UserService',
          kind: 'class',
          name: 'UserService',
          qualifiedName: 'src/services/UserService.ts::UserService',
          filePath: 'src/services/UserService.ts',
          startLine: 1,
          endLine: 20,
        });
        const saveMethod = node({
          id: 'method:src/services/UserService.ts:UserService.save',
          kind: 'method',
          name: 'save',
          qualifiedName: 'src/services/UserService.ts::UserService::save',
          filePath: 'src/services/UserService.ts',
          startLine: 5,
          endLine: 8,
        });
        const unrelatedSave = node({
          id: 'method:src/db/Repo.ts:Repo.save',
          kind: 'method',
          name: 'save',
          qualifiedName: 'src/db/Repo.ts::Repo::save',
          filePath: 'src/db/Repo.ts',
        });
        const result = matchReference(
          ref({ referenceName: 'UserService.save' }),
          contextWithNodes([serviceClass, saveMethod, unrelatedSave]),
        );

        expect(result).toMatchObject({
          targetNodeId: saveMethod.id,
          confidence: 0.85,
          resolvedBy: 'qualified-name',
        });
      });

      it('infers TypeScript field receiver types from annotations and new expressions', () => {
        const cacheClass = node({
          id: 'class:src/cache/TinyCache.ts:TinyCache',
          kind: 'class',
          name: 'TinyCache',
          qualifiedName: 'src/cache/TinyCache.ts::TinyCache',
          filePath: 'src/cache/TinyCache.ts',
          startLine: 1,
          endLine: 20,
        });
        const getMethod = node({
          id: 'method:src/cache/TinyCache.ts:TinyCache.get',
          kind: 'method',
          name: 'get',
          qualifiedName: 'src/cache/TinyCache.ts::TinyCache::get',
          filePath: 'src/cache/TinyCache.ts',
          startLine: 3,
          endLine: 5,
        });
        const manager = node({
          id: 'class:src/app.ts:Manager',
          kind: 'class',
          name: 'Manager',
          qualifiedName: 'src/app.ts::Manager',
          filePath: 'src/app.ts',
          startLine: 1,
          endLine: 20,
        });
        const annotatedField = node({
          id: 'field:src/app.ts:Manager.cache',
          kind: 'field',
          name: 'cache',
          qualifiedName: 'src/app.ts::Manager::cache',
          filePath: 'src/app.ts',
          startLine: 2,
          endLine: 2,
        });
        const constructedField = node({
          id: 'field:src/app.ts:Manager.store',
          kind: 'field',
          name: 'store',
          qualifiedName: 'src/app.ts::Manager::store',
          filePath: 'src/app.ts',
          startLine: 3,
          endLine: 3,
        });
        const source = [
          'class Manager {',
          '  private cache: TinyCache;',
          '  private store = new TinyCache();',
          '  run() {',
          '    cache.get();',
          '    store.get();',
          '  }',
          '}',
        ].join('\n');
        const ctx = contextWithNodes([cacheClass, getMethod, manager, annotatedField, constructedField], {
          readFile: (filePath) => (filePath === 'src/app.ts' ? source : null),
        });

        expect(matchReference(ref({ referenceName: 'cache.get', line: 5 }), ctx)).toMatchObject({
          targetNodeId: getMethod.id,
          confidence: 0.8,
          resolvedBy: 'instance-method',
        });
        expect(matchReference(ref({ referenceName: 'store.get', line: 6 }), ctx)).toMatchObject({
          targetNodeId: getMethod.id,
          confidence: 0.8,
          resolvedBy: 'instance-method',
        });
      });

      it('prefers the same-language fuzzy candidate and reports fuzzy confidence', () => {
        const tsCandidate = node({
          id: 'func:src/app.ts:CalculateTotal',
          kind: 'function',
          name: 'CalculateTotal',
          qualifiedName: 'src/app.ts::CalculateTotal',
          filePath: 'src/app.ts',
          language: 'typescript',
        });
        const pyCandidate = node({
          id: 'func:tools/calc.py:calculateTotal',
          kind: 'function',
          name: 'calculateTotal',
          qualifiedName: 'tools/calc.py::calculateTotal',
          filePath: 'tools/calc.py',
          language: 'python',
        });
        const result = matchReference(
          ref({ referenceName: 'calculatetotal' }),
          contextWithNodes([pyCandidate, tsCandidate], {
            getNodesByName: () => [],
          }),
        );

        expect(result).toMatchObject({
          targetNodeId: tsCandidate.id,
          confidence: 0.5,
          resolvedBy: 'fuzzy',
        });
      });

      it('surfaces tieMargin on multi-candidate exact-name matches', () => {
        const local = node({
          id: 'func:src/feature/refresh.ts:refresh',
          kind: 'function',
          name: 'refresh',
          qualifiedName: 'src/feature/refresh.ts::refresh',
          filePath: 'src/feature/refresh.ts',
          startLine: 12,
        });
        const neighbor = node({
          id: 'func:tools/refresh.ts:refresh',
          kind: 'function',
          name: 'refresh',
          qualifiedName: 'tools/refresh.ts::refresh',
          filePath: 'tools/refresh.ts',
          startLine: 1,
        });
        const result = matchReference(
          ref({ referenceName: 'refresh', filePath: 'src/feature/app.ts', line: 11 }),
          contextWithNodes([neighbor, local]),
        );

        expect(result?.targetNodeId).toBe(local.id);
        expect(result?.resolvedBy).toBe('exact-match');
        expect(result?.tieMargin).toBeGreaterThan(0);
      });
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

    it('resolves SAP XSJS JavaScript imports', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByLowerName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'server/lib/session.xsjslib' || p === 'server/services/index.xsjs',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['server/lib/session.xsjslib', 'server/services/index.xsjs'],
        getImportMappings: () => [],
      };

      expect(
        resolveImportPath({
          importPath: './lib/session',
          fromFile: 'server/bootstrap.xsjs',
          language: 'javascript',
          context,
        }),
      ).toBe('server/lib/session.xsjslib');
      expect(
        resolveImportPath({
          importPath: './services',
          fromFile: 'server/bootstrap.ts',
          language: 'typescript',
          context,
        }),
      ).toBe('server/services/index.xsjs');
    });

    it('resolves Python dotted package imports to project files', () => {
      const context: ResolutionContext = {
        getNodesInFile: () => [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByLowerName: () => [],
        getNodesByKind: () => [],
        fileExists: (p) => p === 'pkg/helpers.py' || p === 'app/models.py',
        readFile: () => null,
        getProjectRoot: () => '',
        getAllFiles: () => ['pkg/helpers.py', 'app/models.py'],
        getImportMappings: () => [],
      };

      expect(
        resolveImportPath({
          importPath: 'pkg.helpers',
          fromFile: 'app/main.py',
          language: 'python',
          context,
        }),
      ).toBe('pkg/helpers.py');
      expect(
        resolveImportPath({
          importPath: '.models',
          fromFile: 'app/main.py',
          language: 'python',
          context,
        }),
      ).toBe('app/models.py');
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

    it('extractImportMappings — normalizes TypeScript type-only import specifiers', () => {
      const content = `
import type DefaultShape from './default-shape.js';
import type { Foo, Bar as LocalBar } from './types.js';
import { type Baz, type Qux as LocalQux, Runtime } from './mixed.js';
`;

      const mappings = extractImportMappings('src/index.ts', content, 'typescript');

      expect(mappings.find((m) => m.localName === 'DefaultShape')).toMatchObject({
        exportedName: 'default',
        source: './default-shape.js',
        isDefault: true,
      });
      expect(mappings.find((m) => m.localName === 'Foo')).toMatchObject({ exportedName: 'Foo' });
      expect(mappings.find((m) => m.localName === 'LocalBar')).toMatchObject({ exportedName: 'Bar' });
      expect(mappings.find((m) => m.localName === 'Baz')).toMatchObject({ exportedName: 'Baz' });
      expect(mappings.find((m) => m.localName === 'LocalQux')).toMatchObject({ exportedName: 'Qux' });
      expect(mappings.find((m) => m.localName === 'Runtime')).toMatchObject({ exportedName: 'Runtime' });
      expect(mappings.some((m) => m.localName === 'type' || m.localName.startsWith('type '))).toBe(false);
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

    // ---- Mutation-hardening: decision-logic coverage (2026-06-14) ----
    // These drive the pure resolution helpers (workspace-package exports,
    // external classification, Python path normalization, fallback
    // aliases, ES6/CJS clause parsing, re-export parsing, and the
    // pickMatchingImport / findDirectExportInFile branches inside
    // resolveViaImport) through the public entry points. Expected values
    // were probed against the live functions.

    interface MockCtxOpts {
      files?: Record<string, string>;
      nodesInFile?: Record<string, Node[]>;
      imports?: Record<string, ImportMapping[]>;
      reExports?: Record<string, ReturnType<typeof extractReExports>>;
      aliases?: AliasMap | null;
      root?: string;
    }

    const mkResCtx = (opts: MockCtxOpts): ResolutionContext => {
      const files = opts.files ?? {};
      return {
        getNodesInFile: (p) => opts.nodesInFile?.[p] ?? [],
        getNodesByName: () => [],
        getNodesByQualifiedName: () => [],
        getNodesByKind: () => [],
        getNodesByLowerName: () => [],
        fileExists: (p) => Object.hasOwn(files, p),
        readFile: (p) => files[p] ?? null,
        getProjectRoot: () => opts.root ?? '/proj',
        getAllFiles: () => Object.keys(files),
        getImportMappings: (p) => opts.imports?.[p] ?? [],
        getProjectAliases: () => opts.aliases ?? null,
        getReExports: (p) => opts.reExports?.[p] ?? [],
      };
    };

    const mkNode = (p: Partial<Node>): Node =>
      ({
        id: p.id ?? 'n',
        kind: p.kind ?? 'function',
        name: p.name ?? 'x',
        qualifiedName: p.qualifiedName ?? `${p.filePath}::${p.name}`,
        filePath: p.filePath ?? 'f.ts',
        language: p.language ?? 'typescript',
        startLine: 1,
        endLine: 2,
        startColumn: 0,
        endColumn: 0,
        updatedAt: 0,
        ...p,
      }) as Node;

    const mkRef = (p: Partial<UnresolvedRef>): UnresolvedRef =>
      ({
        fromNodeId: 'caller',
        referenceName: p.referenceName ?? 'X',
        referenceKind: 'calls',
        line: p.line ?? 5,
        column: 0,
        filePath: p.filePath ?? 'src/main.ts',
        language: p.language ?? 'typescript',
        ...p,
      }) as UnresolvedRef;

    describe('workspace-package exports resolution', () => {
      it('resolves a scoped workspace package (@scope/ui) via its `exports` map', () => {
        const ctx = mkResCtx({
          files: {
            'packages/ui/package.json': JSON.stringify({ name: '@scope/ui', exports: { '.': './src/index.ts' } }),
            'packages/ui/src/index.ts': '',
          },
        });
        expect(
          resolveImportPath({ importPath: '@scope/ui', fromFile: 'app/main.ts', language: 'typescript', context: ctx }),
        ).toBe('packages/ui/src/index.ts');
      });

      it('resolves a bare workspace package subpath import (myutil/helpers)', () => {
        const ctx = mkResCtx({
          files: {
            'packages/util/package.json': JSON.stringify({
              name: 'myutil',
              exports: { './helpers': './lib/helpers.ts' },
            }),
            'packages/util/lib/helpers.ts': '',
          },
        });
        expect(
          resolveImportPath({ importPath: 'myutil/helpers', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBe('packages/util/lib/helpers.ts');
      });

      it('a scoped specifier missing its second segment (`@scope`) is not a package name', () => {
        const ctx = mkResCtx({
          files: {
            'packages/ui/package.json': JSON.stringify({ name: '@scope/ui', exports: { '.': './src/index.ts' } }),
            'packages/ui/src/index.ts': '',
          },
        });
        // packageNameFromSpecifier returns null for a lone `@scope`, so no
        // workspace match; classified external -> null.
        expect(
          resolveImportPath({ importPath: '@scope', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBeNull();
      });

      it('a string `exports` field only satisfies the `.` subpath (subpath import is null)', () => {
        const ctx = mkResCtx({
          files: {
            'packages/s/package.json': JSON.stringify({ name: 's', exports: './main.ts' }),
            'packages/s/main.ts': '',
          },
        });
        expect(resolveImportPath({ importPath: 's', fromFile: 'a/m.ts', language: 'typescript', context: ctx })).toBe(
          'packages/s/main.ts',
        );
        expect(
          resolveImportPath({ importPath: 's/sub', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBeNull();
      });

      it('a package with no `exports` field falls back to ./index', () => {
        const ctx = mkResCtx({
          files: {
            'packages/noexp/package.json': JSON.stringify({ name: 'noexp' }),
            'packages/noexp/index.ts': '',
          },
        });
        expect(
          resolveImportPath({ importPath: 'noexp', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBe('packages/noexp/index.ts');
      });

      it('conditional exports prefer `types`/`import` over `default`', () => {
        const ctxImport = mkResCtx({
          files: {
            'packages/c/package.json': JSON.stringify({
              name: 'c',
              exports: { '.': { import: './esm.ts', default: './cjs.ts' } },
            }),
            'packages/c/esm.ts': '',
            'packages/c/cjs.ts': '',
          },
        });
        expect(
          resolveImportPath({ importPath: 'c', fromFile: 'a/m.ts', language: 'typescript', context: ctxImport }),
        ).toBe('packages/c/esm.ts');

        const ctxTypes = mkResCtx({
          files: {
            'packages/d/package.json': JSON.stringify({
              name: 'd',
              exports: { '.': { types: './t.d.ts', default: './cjs.ts' } },
            }),
            'packages/d/t.d.ts': '',
            'packages/d/cjs.ts': '',
          },
        });
        expect(
          resolveImportPath({ importPath: 'd', fromFile: 'a/m.ts', language: 'typescript', context: ctxTypes }),
        ).toBe('packages/d/t.d.ts');
      });

      it('resolves root conditional exports without an explicit dot subpath', () => {
        const ctx = mkResCtx({
          files: {
            'packages/rootcond/package.json': JSON.stringify({
              name: 'rootcond',
              exports: { import: './esm.ts', default: './cjs.ts' },
            }),
            'packages/rootcond/esm.ts': '',
            'packages/rootcond/cjs.ts': '',
            'packages/rootcond/index.ts': '',
          },
        });

        expect(
          resolveImportPath({ importPath: 'rootcond', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBe('packages/rootcond/esm.ts');
      });

      it('resolves array export targets instead of falling back to package index', () => {
        const ctx = mkResCtx({
          files: {
            'packages/arr/package.json': JSON.stringify({
              name: 'arr',
              exports: { '.': ['./src/entry.ts'] },
            }),
            'packages/arr/src/entry.ts': '',
            'packages/arr/index.ts': '',
          },
        });

        expect(resolveImportPath({ importPath: 'arr', fromFile: 'a/m.ts', language: 'typescript', context: ctx })).toBe(
          'packages/arr/src/entry.ts',
        );
      });

      it('resolves wildcard subpath exports before falling back to a same-named package file', () => {
        const ctx = mkResCtx({
          files: {
            'packages/pat/package.json': JSON.stringify({
              name: 'pat',
              exports: { './features/*': './src/features/*.ts' },
            }),
            'packages/pat/src/features/button.ts': '',
            'packages/pat/features/button.ts': '',
          },
        });

        expect(
          resolveImportPath({
            importPath: 'pat/features/button',
            fromFile: 'a/m.ts',
            language: 'typescript',
            context: ctx,
          }),
        ).toBe('packages/pat/src/features/button.ts');
      });

      it('package.json inside node_modules is ignored for workspace resolution', () => {
        const ctx = mkResCtx({
          files: {
            'node_modules/pkg/package.json': JSON.stringify({ name: 'pkg', exports: { '.': './idx.ts' } }),
            'node_modules/pkg/idx.ts': '',
          },
        });
        // Not a workspace package; bare specifier -> external -> null.
        expect(
          resolveImportPath({ importPath: 'pkg', fromFile: 'a/m.ts', language: 'typescript', context: ctx }),
        ).toBeNull();
      });
    });

    describe('external-import classification', () => {
      it('Node builtins (fs) are external and resolve to null', () => {
        expect(
          resolveImportPath({
            importPath: 'fs',
            fromFile: 'a.ts',
            language: 'typescript',
            context: mkResCtx({ files: {} }),
          }),
        ).toBeNull();
      });

      it('a bare npm specifier (react) is external even when a same-named file exists', () => {
        expect(
          resolveImportPath({
            importPath: 'react',
            fromFile: 'a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { react: '' } }),
          }),
        ).toBeNull();
      });

      it('conventional aliases (@/, ~/, src/) are treated as local', () => {
        expect(
          resolveImportPath({
            importPath: '@/foo',
            fromFile: 'a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/foo.ts': '' } }),
          }),
        ).toBe('src/foo.ts');
        expect(
          resolveImportPath({
            importPath: 'src/bar',
            fromFile: 'a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/bar.ts': '' } }),
          }),
        ).toBe('src/bar.ts');
      });

      it('a project tsconfig alias prefix escapes the external heuristic', () => {
        const aliases: AliasMap = {
          baseUrl: '/proj',
          patterns: [{ prefix: '@components/', suffix: '', hasWildcard: true, replacements: ['src/components/*'] }],
        };
        expect(
          resolveImportPath({
            importPath: '@components/Button',
            fromFile: 'a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/components/Button.tsx': '' }, aliases }),
          }),
        ).toBe('src/components/Button.tsx');
      });

      it('Python stdlib (os) is external; a non-stdlib dotted package resolves', () => {
        expect(
          resolveImportPath({
            importPath: 'os',
            fromFile: 'a.py',
            language: 'python',
            context: mkResCtx({ files: {} }),
          }),
        ).toBeNull();
        expect(
          resolveImportPath({
            importPath: 'mypkg.mod',
            fromFile: 'a.py',
            language: 'python',
            context: mkResCtx({ files: { 'mypkg/mod.py': '' } }),
          }),
        ).toBe('mypkg/mod.py');
      });

      it('Go /internal/ packages are local; other non-relative paths are external', () => {
        expect(
          resolveImportPath({
            importPath: 'github.com/x/y/internal/z',
            fromFile: 'a.go',
            language: 'go',
            context: mkResCtx({ files: { 'github.com/x/y/internal/z.go': '' } }),
          }),
        ).toBe('github.com/x/y/internal/z.go');
        expect(
          resolveImportPath({
            importPath: 'github.com/x/y',
            fromFile: 'a.go',
            language: 'go',
            context: mkResCtx({ files: { 'github.com/x/y.go': '' } }),
          }),
        ).toBeNull();
      });
    });

    describe('Python relative-import normalization', () => {
      it('`from .models import` probes ./models.py', () => {
        expect(
          resolveImportPath({
            importPath: '.models',
            fromFile: 'pkg/a.py',
            language: 'python',
            context: mkResCtx({ files: { 'pkg/models.py': '' } }),
          }),
        ).toBe('pkg/models.py');
      });

      it('`from ..models import` walks one directory up', () => {
        expect(
          resolveImportPath({
            importPath: '..models',
            fromFile: 'pkg/sub/a.py',
            language: 'python',
            context: mkResCtx({ files: { 'pkg/models.py': '' } }),
          }),
        ).toBe('pkg/models.py');
      });

      it('a bare `.` resolves to the package __init__.py', () => {
        expect(
          resolveImportPath({
            importPath: '.',
            fromFile: 'pkg/a.py',
            language: 'python',
            context: mkResCtx({ files: { 'pkg/__init__.py': '' } }),
          }),
        ).toBe('pkg/__init__.py');
      });

      it('a deeper `...a.b` walks up two directories and converts dotted submodule to a path', () => {
        // dotCount=3 -> `../../` up; rest `a.b` -> `a/b`.
        expect(
          resolveImportPath({
            importPath: '...a.b',
            fromFile: 'x/y/z/m.py',
            language: 'python',
            context: mkResCtx({ files: { 'x/a/b.py': '' } }),
          }),
        ).toBe('x/a/b.py');
      });
    });

    describe('relative + NodeNext shim resolution', () => {
      it('a `.js`-suffixed relative import resolves to the `.ts` source (NodeNext shim)', () => {
        expect(
          resolveImportPath({
            importPath: './util.js',
            fromFile: 'src/a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/util.ts': '' } }),
          }),
        ).toBe('src/util.ts');
      });

      it('a `.js`-suffixed import that has a real `.js` file on disk keeps it', () => {
        expect(
          resolveImportPath({
            importPath: './util.js',
            fromFile: 'src/a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/util.js': '' } }),
          }),
        ).toBe('src/util.js');
      });

      it('a parent-directory relative import resolves with an extension', () => {
        expect(
          resolveImportPath({
            importPath: '../shared/util',
            fromFile: 'src/feature/a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/shared/util.ts': '' } }),
          }),
        ).toBe('src/shared/util.ts');
      });

      it('an import that already carries its exact extension resolves via the try-without-extension path', () => {
        // No ext-list candidate (`./util.ts.ts`) exists; only the bare
        // `./util.ts` does — exercises the `fileExists(relativePath)` branch.
        expect(
          resolveImportPath({
            importPath: './util.ts',
            fromFile: 'src/a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/util.ts': '' } }),
          }),
        ).toBe('src/util.ts');
      });

      it('the NodeNext shim picks the real extension even when it is not first in the list (.js -> .tsx)', () => {
        // `.tsx` follows `.ts` in the TS extension order — proves the shim
        // loop probes each extension rather than forcing the first.
        expect(
          resolveImportPath({
            importPath: './comp.js',
            fromFile: 'src/a.ts',
            language: 'typescript',
            context: mkResCtx({ files: { 'src/comp.tsx': '' } }),
          }),
        ).toBe('src/comp.tsx');
      });
    });

    describe('extractReExports', () => {
      it('parses bare, aliased, default-as, and wildcard re-exports', () => {
        expect(extractReExports("export { foo } from './a';", 'typescript')).toEqual([
          { kind: 'named', exportedName: 'foo', originalName: 'foo', source: './a' },
        ]);
        expect(extractReExports("export { foo as bar } from './a';", 'typescript')).toEqual([
          { kind: 'named', exportedName: 'bar', originalName: 'foo', source: './a' },
        ]);
        expect(extractReExports("export { default as Foo } from './a';", 'typescript')).toEqual([
          { kind: 'named', exportedName: 'Foo', originalName: 'default', source: './a' },
        ]);
        expect(extractReExports("export * from './a';", 'typescript')).toEqual([{ kind: 'wildcard', source: './a' }]);
        expect(extractReExports("export * as ns from './a';", 'typescript')).toEqual([
          { kind: 'wildcard', source: './a' },
        ]);
      });

      it('strips per-specifier and leading `type` markers', () => {
        expect(extractReExports("export type { T } from './a';", 'typescript')).toEqual([
          { kind: 'named', exportedName: 'T', originalName: 'T', source: './a' },
        ]);
        expect(extractReExports("export { type T, value } from './a';", 'typescript')).toEqual([
          { kind: 'named', exportedName: 'T', originalName: 'T', source: './a' },
          { kind: 'named', exportedName: 'value', originalName: 'value', source: './a' },
        ]);
      });

      it('returns [] for non-JS-family languages', () => {
        expect(extractReExports("export { foo } from './a';", 'python')).toEqual([]);
      });

      it('ignores a commented-out re-export', () => {
        expect(extractReExports("// export { foo } from './a';", 'typescript')).toEqual([]);
      });

      it('skips brace items that are not bare identifiers', () => {
        // `foo-bar` / `foo.bar` are not `\w+`; nothing should be emitted.
        expect(extractReExports("export { foo-bar } from './a';", 'typescript')).toEqual([]);
        expect(extractReExports("export { foo.bar } from './a';", 'typescript')).toEqual([]);
      });

      it('rejects an alias item with trailing junk (anchored full-item match)', () => {
        // `a as b extra` is not a clean `(\w+) as (\w+)` end-to-end match.
        expect(extractReExports("export { a as b extra } from './a';", 'typescript')).toEqual([]);
      });
    });

    describe('ES6 / CJS import clause parsing', () => {
      it('captures a default + named import together', () => {
        const m = extractImportMappings('f.ts', "import React, { useState } from 'react';", 'typescript');
        expect(m).toEqual([
          {
            localName: 'React',
            exportedName: 'default',
            source: 'react',
            isDefault: true,
            isNamespace: false,
            line: 1,
          },
          {
            localName: 'useState',
            exportedName: 'useState',
            source: 'react',
            isDefault: false,
            isNamespace: false,
            line: 1,
          },
        ]);
      });

      it('captures a namespace import alias', () => {
        const m = extractImportMappings('f.ts', "import * as ns from './a';", 'typescript');
        expect(m).toEqual([
          { localName: 'ns', exportedName: '*', source: './a', isDefault: false, isNamespace: true, line: 1 },
        ]);
      });

      it('captures an aliased named import (a as b)', () => {
        const m = extractImportMappings('f.ts', "import { a as b } from './a';", 'typescript');
        expect(m).toEqual([
          { localName: 'b', exportedName: 'a', source: './a', isDefault: false, isNamespace: false, line: 1 },
        ]);
      });

      it('captures a CJS default require and a destructured require with rename', () => {
        expect(extractImportMappings('f.ts', "const x = require('./a');", 'typescript')).toEqual([
          { localName: 'x', exportedName: 'default', source: './a', isDefault: true, isNamespace: false, line: 1 },
        ]);
        expect(extractImportMappings('f.ts', "const { a, b: c } = require('./a');", 'typescript')).toEqual([
          { localName: 'a', exportedName: 'a', source: './a', isDefault: false, isNamespace: false, line: 1 },
          { localName: 'c', exportedName: 'b', source: './a', isDefault: false, isNamespace: false, line: 1 },
        ]);
      });

      it('reports the 1-based line of the import statement', () => {
        const m = extractImportMappings('f.ts', "\n\nimport { X } from './a';", 'typescript');
        expect(m[0]?.line).toBe(3);
      });

      it('does not treat an identifier that merely starts with `import` as an import keyword', () => {
        const m = extractImportMappings('f.ts', "importFoo();\nimport { Y } from './b';", 'typescript');
        expect(m).toEqual([
          { localName: 'Y', exportedName: 'Y', source: './b', isDefault: false, isNamespace: false, line: 2 },
        ]);
      });

      it('does not emit a default mapping for `import { A } from` (lone `type` is not a name)', () => {
        const m = extractImportMappings('f.ts', "import type { A } from './a';", 'typescript');
        expect(m).toEqual([
          { localName: 'A', exportedName: 'A', source: './a', isDefault: false, isNamespace: false, line: 1 },
        ]);
      });

      it('captures a combined default + namespace import (`import def, * as ns`)', () => {
        // The `*` is no longer at clause position 0 — exercises indexOf('*')
        // and the default-before-comma split together.
        const m = extractImportMappings('f.ts', "import def, * as ns from 'x';", 'typescript');
        expect(m).toEqual([
          { localName: 'def', exportedName: 'default', source: 'x', isDefault: true, isNamespace: false, line: 1 },
          { localName: 'ns', exportedName: '*', source: 'x', isDefault: false, isNamespace: true, line: 1 },
        ]);
      });

      it("requires whitespace on BOTH sides of the `from` keyword (`}xfrom 'y'` is not a real from-clause)", () => {
        // The `from` in `xfrom` has a non-whitespace char (`x`) before it,
        // so it must not be treated as the keyword — otherwise a spurious
        // `X from y` mapping leaks in. Guards the isFromKeywordAt boundary.
        const m = extractImportMappings('f.ts', "import { X }xfrom 'y';\nimport { Z } from 'z';", 'typescript');
        expect(m).toEqual([
          { localName: 'Z', exportedName: 'Z', source: 'z', isDefault: false, isNamespace: false, line: 2 },
        ]);
      });

      it('parses a multi-line braced named import (brace-depth tracking)', () => {
        const m = extractImportMappings('f.ts', "import {\n  A,\n  B,\n} from './m';", 'typescript');
        expect(m.map((x) => x.localName)).toEqual(['A', 'B']);
        expect(m.every((x) => x.source === './m' && x.line === 1)).toBe(true);
      });

      it('treats `from` inside the brace as a binding, not the from keyword (only the real keyword ends the clause)', () => {
        // If the in-brace `from` were treated as the keyword (braceDepth
        // guard removed), parsing would break and never reach `./m`.
        const m = extractImportMappings('f.ts', "import { a, from, b } from './m';", 'typescript');
        expect(m.map((x) => x.localName)).toEqual(['a', 'from', 'b']);
        expect(m.every((x) => x.source === './m')).toBe(true);
      });

      it('reads a double-quoted module source', () => {
        const m = extractImportMappings('f.ts', 'import { Q } from "dq";', 'typescript');
        expect(m).toEqual([
          { localName: 'Q', exportedName: 'Q', source: 'dq', isDefault: false, isNamespace: false, line: 1 },
        ]);
      });
    });

    describe('resolveViaImport decision logic', () => {
      it('direct named import resolves to the exported symbol by name (a different-named export is not picked)', () => {
        const ctx = mkResCtx({
          files: { 'src/a.ts': '' },
          nodesInFile: {
            // A different-named exported decoy precedes the target — the
            // lookup must match on NAME, not just on `isExported`.
            'src/a.ts': [
              mkNode({ id: 'decoy', name: 'Other', filePath: 'src/a.ts', isExported: true }),
              mkNode({ id: 'foo-id', name: 'Foo', filePath: 'src/a.ts', isExported: true }),
            ],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'Foo', source: './a', isDefault: false, isNamespace: false },
            ],
          },
        });
        const r = resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx);
        expect(r?.targetNodeId).toBe('foo-id');
        expect(r?.confidence).toBe(0.9);
        expect(r?.resolvedBy).toBe('import');
      });

      it('an aliased import resolves by local name (Bar -> exported Foo)', () => {
        const ctx = mkResCtx({
          files: { 'src/a.ts': '' },
          nodesInFile: { 'src/a.ts': [mkNode({ id: 'foo-id', name: 'Foo', filePath: 'src/a.ts', isExported: true })] },
          imports: {
            'src/main.ts': [
              { localName: 'Bar', exportedName: 'Foo', source: './a', isDefault: false, isNamespace: false },
            ],
          },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'Bar' }), ctx)?.targetNodeId).toBe('foo-id');
        // The non-local name (Foo) must NOT match pass 1 here.
        expect(resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx)).toBeNull();
      });

      it('a namespace member reference (ns.foo) resolves to the named member, not just any export', () => {
        const ctx = mkResCtx({
          files: { 'src/a.ts': '' },
          nodesInFile: {
            // Decoy export first — the member lookup must match `foo` by name.
            'src/a.ts': [
              mkNode({ id: 'decoy', name: 'other', filePath: 'src/a.ts', isExported: true }),
              mkNode({ id: 'foo-id', name: 'foo', filePath: 'src/a.ts', isExported: true }),
            ],
          },
          imports: {
            'src/main.ts': [{ localName: 'ns', exportedName: '*', source: './a', isDefault: false, isNamespace: true }],
          },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'ns.foo' }), ctx)?.targetNodeId).toBe('foo-id');
      });

      it('a default import resolves to an exported function/class, but a variable export falls back to the import node', () => {
        const cls = mkResCtx({
          files: { 'src/a.ts': '', 'src/main.ts': 'x' },
          nodesInFile: {
            'src/a.ts': [
              mkNode({ id: 'def-id', name: 'Whatever', kind: 'class', filePath: 'src/a.ts', isExported: true }),
            ],
            'src/main.ts': [mkNode({ id: 'imp', kind: 'import', name: './a', filePath: 'src/main.ts' })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'default', source: './a', isDefault: true, isNamespace: false },
            ],
          },
        });
        const rCls = resolveViaImport(mkRef({ referenceName: 'Foo' }), cls);
        expect(rCls?.targetNodeId).toBe('def-id');
        expect(rCls?.confidence).toBe(0.9);

        // A default export that is a FUNCTION must also resolve (the
        // function/class disjunction — not class-only).
        const fnCtx = mkResCtx({
          files: { 'src/a.ts': '' },
          nodesInFile: {
            'src/a.ts': [mkNode({ id: 'fn-id', name: 'go', kind: 'function', filePath: 'src/a.ts', isExported: true })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'default', source: './a', isDefault: true, isNamespace: false },
            ],
          },
        });
        const rFn = resolveViaImport(mkRef({ referenceName: 'Foo' }), fnCtx);
        expect(rFn?.targetNodeId).toBe('fn-id');
        expect(rFn?.confidence).toBe(0.9);

        // Only a `variable` is exported — default lookup (function/class)
        // misses, so the F#33 fallback resolves to the local import node.
        const varCtx = mkResCtx({
          files: { 'src/a.ts': '', 'src/main.ts': 'x' },
          nodesInFile: {
            'src/a.ts': [
              mkNode({ id: 'var-id', name: 'val', kind: 'variable', filePath: 'src/a.ts', isExported: true }),
            ],
            'src/main.ts': [mkNode({ id: 'imp', kind: 'import', name: './a', filePath: 'src/main.ts' })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'default', source: './a', isDefault: true, isNamespace: false },
            ],
          },
        });
        const rVar = resolveViaImport(mkRef({ referenceName: 'Foo' }), varCtx);
        expect(rVar?.targetNodeId).toBe('imp');
        expect(rVar?.confidence).toBe(0.4);
        expect(rVar?.resolvedBy).toBe('external-import');
      });

      it('a named lookup requires the target to be exported (non-exported falls back to import node)', () => {
        const ctx = mkResCtx({
          files: { 'src/a.ts': '', 'src/main.ts': 'x' },
          nodesInFile: {
            'src/a.ts': [mkNode({ id: 'foo-id', name: 'Foo', filePath: 'src/a.ts', isExported: false })],
            'src/main.ts': [mkNode({ id: 'imp', kind: 'import', name: './a', filePath: 'src/main.ts' })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'Foo', source: './a', isDefault: false, isNamespace: false },
            ],
          },
        });
        const r = resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx);
        expect(r?.targetNodeId).toBe('imp');
        expect(r?.confidence).toBe(0.4);
      });

      it('aliased same-line fallback (pass 2) disambiguates N same-name imports by line', () => {
        const ctx = mkResCtx({
          files: { 'src/a.ts': '', 'src/b.ts': '' },
          nodesInFile: {
            'src/a.ts': [mkNode({ id: 'a-mig', name: 'MIGRATION', filePath: 'src/a.ts', isExported: true })],
            'src/b.ts': [mkNode({ id: 'b-mig', name: 'MIGRATION', filePath: 'src/b.ts', isExported: true })],
          },
          imports: {
            'src/main.ts': [
              {
                localName: 'mA',
                exportedName: 'MIGRATION',
                source: './a',
                isDefault: false,
                isNamespace: false,
                line: 1,
              },
              {
                localName: 'mB',
                exportedName: 'MIGRATION',
                source: './b',
                isDefault: false,
                isNamespace: false,
                line: 2,
              },
            ],
          },
        });
        // The ref carries the EXPORTED name and pins to line 2 -> the ./b import.
        expect(resolveViaImport(mkRef({ referenceName: 'MIGRATION', line: 2 }), ctx)?.targetNodeId).toBe('b-mig');
        expect(resolveViaImport(mkRef({ referenceName: 'MIGRATION', line: 1 }), ctx)?.targetNodeId).toBe('a-mig');
      });

      it('an unresolved RELATIVE import returns null (not the external-import fallback)', () => {
        const ctx = mkResCtx({
          files: { 'src/main.ts': 'x' },
          nodesInFile: {
            'src/main.ts': [mkNode({ id: 'imp', kind: 'import', name: './missing', filePath: 'src/main.ts' })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'Foo', source: './missing', isDefault: false, isNamespace: false },
            ],
          },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx)).toBeNull();
      });

      it('an unresolved stdlib/external import keeps the edge via the import node (F#33)', () => {
        const ctx = mkResCtx({
          files: { 'src/main.py': 'x' },
          nodesInFile: {
            'src/main.py': [
              mkNode({ id: 'imp-id', kind: 'import', name: 'typing', filePath: 'src/main.py', language: 'python' }),
            ],
          },
          imports: {
            'src/main.py': [
              {
                localName: 'Protocol',
                exportedName: 'Protocol',
                source: 'typing',
                isDefault: false,
                isNamespace: false,
              },
            ],
          },
        });
        const r = resolveViaImport(
          mkRef({ referenceName: 'Protocol', language: 'python', filePath: 'src/main.py' }),
          ctx,
        );
        expect(r?.targetNodeId).toBe('imp-id');
        expect(r?.confidence).toBe(0.4);
        expect(r?.resolvedBy).toBe('external-import');
      });

      it('Python `from pkg import mod; mod.func()` resolves to the module member', () => {
        const ctx = mkResCtx({
          files: { 'pkg/helpers.py': '' },
          nodesInFile: {
            'pkg/helpers.py': [mkNode({ id: 'run-id', name: 'run', filePath: 'pkg/helpers.py', language: 'python' })],
          },
          imports: {
            'src/main.py': [
              { localName: 'helpers', exportedName: 'helpers', source: 'pkg', isDefault: false, isNamespace: false },
            ],
          },
        });
        const r = resolveViaImport(
          mkRef({ referenceName: 'helpers.run', language: 'python', filePath: 'src/main.py' }),
          ctx,
        );
        expect(r?.targetNodeId).toBe('run-id');
        expect(r?.confidence).toBe(0.9);
      });

      it('follows a named re-export chain through a barrel file', () => {
        const ctx = mkResCtx({
          files: { 'src/index.ts': '', 'src/a.ts': '' },
          nodesInFile: {
            'src/index.ts': [],
            'src/a.ts': [mkNode({ id: 'foo-real', name: 'Foo', filePath: 'src/a.ts', isExported: true })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'Foo', source: './index', isDefault: false, isNamespace: false },
            ],
          },
          reExports: { 'src/index.ts': [{ kind: 'named', exportedName: 'Foo', originalName: 'Foo', source: './a' }] },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx)?.targetNodeId).toBe('foo-real');
      });

      it('follows a wildcard re-export chain through a barrel file', () => {
        const ctx = mkResCtx({
          files: { 'src/index.ts': '', 'src/a.ts': '' },
          nodesInFile: {
            'src/index.ts': [],
            'src/a.ts': [mkNode({ id: 'foo-real', name: 'Foo', filePath: 'src/a.ts', isExported: true })],
          },
          imports: {
            'src/main.ts': [
              { localName: 'Foo', exportedName: 'Foo', source: './index', isDefault: false, isNamespace: false },
            ],
          },
          reExports: { 'src/index.ts': [{ kind: 'wildcard', source: './a' }] },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'Foo' }), ctx)?.targetNodeId).toBe('foo-real');
      });

      it('returns null when no import matches the referenced name', () => {
        const ctx = mkResCtx({
          files: { 'src/main.ts': 'x' },
          imports: {
            'src/main.ts': [
              { localName: 'Other', exportedName: 'Other', source: './a', isDefault: false, isNamespace: false },
            ],
          },
        });
        expect(resolveViaImport(mkRef({ referenceName: 'Nope' }), ctx)).toBeNull();
      });

      it.each([
        ['..'],
        ['.foo'],
        ['..foo'],
      ])('treats an unresolved Python relative source (%s) as intra-project and returns null (no external fallback)', (source) => {
        const ctx = mkResCtx({
          files: { 'src/main.py': 'x' },
          nodesInFile: {
            'src/main.py': [
              mkNode({ id: 'imp', kind: 'import', name: source, filePath: 'src/main.py', language: 'python' }),
            ],
          },
          imports: {
            'src/main.py': [{ localName: 'X', exportedName: 'X', source, isDefault: false, isNamespace: false }],
          },
        });
        // Contrast with the stdlib case above which DOES fall back — a
        // dot-leading source must stay unresolved for pass-B re-resolution.
        expect(
          resolveViaImport(mkRef({ referenceName: 'X', language: 'python', filePath: 'src/main.py' }), ctx),
        ).toBeNull();
      });

      it('Python module-member lookup skips import/file nodes and binds to the real definition', () => {
        const ctx = mkResCtx({
          files: { 'pkg/helpers.py': '' },
          nodesInFile: {
            // An `import` node named `run` precedes the real function `run`;
            // findPythonModuleMember must skip the import and bind the function.
            'pkg/helpers.py': [
              mkNode({ id: 'imp-run', kind: 'import', name: 'run', filePath: 'pkg/helpers.py', language: 'python' }),
              mkNode({ id: 'fn-run', kind: 'function', name: 'run', filePath: 'pkg/helpers.py', language: 'python' }),
            ],
          },
          imports: {
            'src/main.py': [
              { localName: 'helpers', exportedName: 'helpers', source: 'pkg', isDefault: false, isNamespace: false },
            ],
          },
        });
        const r = resolveViaImport(
          mkRef({ referenceName: 'helpers.run', language: 'python', filePath: 'src/main.py' }),
          ctx,
        );
        expect(r?.targetNodeId).toBe('fn-run');
      });
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
      // package.json is now indexable via parser-only JSON support.
      expect(stats.fileCount).toBe(3);
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

    it('resolves Python `from pkg import module; module.func()` calls to the imported module file', async () => {
      fs.mkdirSync(path.join(tempDir, 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'pkg', '__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'pkg', 'helpers.py'), 'def run():\n    return 1\n');
      fs.writeFileSync(
        path.join(tempDir, 'app', 'main.py'),
        'from pkg import helpers\n\n\ndef main():\n    return helpers.run()\n',
      );

      cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

      const runNode = getNodesByKind(cg.queries, 'function').find(
        (n) => n.name === 'run' && n.filePath === 'pkg/helpers.py',
      );
      expect(runNode).toBeDefined();
      const callers = cg.internals.traverser.getCallers(runNode!.id);
      expect(callers.some((c) => c.node.name === 'main' && c.node.filePath === 'app/main.py')).toBe(true);
    });

    it('resolves Python imported-module aliases to module member calls', async () => {
      fs.mkdirSync(path.join(tempDir, 'pkg'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'app'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'pkg', '__init__.py'), '');
      fs.writeFileSync(path.join(tempDir, 'pkg', 'helpers.py'), 'def run():\n    return 1\n');
      fs.writeFileSync(
        path.join(tempDir, 'app', 'main.py'),
        [
          'import pkg.helpers as helper_mod',
          'from pkg import helpers as from_helper',
          '',
          'def via_import_alias():',
          '    return helper_mod.run()',
          '',
          'def via_from_alias():',
          '    return from_helper.run()',
          '',
        ].join('\n'),
      );

      cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

      const runNode = getNodesByKind(cg.queries, 'function').find(
        (n) => n.name === 'run' && n.filePath === 'pkg/helpers.py',
      );
      expect(runNode).toBeDefined();
      const callers = cg.internals.traverser.getCallers(runNode!.id);
      expect(callers.some((c) => c.node.name === 'via_import_alias' && c.node.filePath === 'app/main.py')).toBe(true);
      expect(callers.some((c) => c.node.name === 'via_from_alias' && c.node.filePath === 'app/main.py')).toBe(true);
    });

    it('resolves call-chain methods through the intermediate method return type', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src', 'chain.ts'),
        `class Builder {
  build(): Committer { return new Committer(); }
}
class Committer {
  commit(): void {}
}
class Wrong {
  commit(): void {}
}
export function go(): void {
  const b = new Builder();
  b.build().commit();
}
`,
      );

      cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

      const commitNodes = getNodesByKind(cg.queries, 'method').filter((n) => n.name === 'commit');
      expect(commitNodes).toHaveLength(2);
      const target = commitNodes.find((n) => n.qualifiedName === 'Committer::commit');
      const wrong = commitNodes.find((n) => n.qualifiedName === 'Wrong::commit');
      expect(target).toBeDefined();
      expect(wrong).toBeDefined();

      const targetCallers = cg.internals.traverser.getCallers(target!.id);
      const wrongCallers = cg.internals.traverser.getCallers(wrong!.id);
      expect(targetCallers.some((c) => c.node.name === 'go')).toBe(true);
      expect(wrongCallers.some((c) => c.node.name === 'go')).toBe(false);
    });

    it('resolves C# generic and nullable returned-receiver call chains', async () => {
      fs.writeFileSync(
        path.join(tempDir, 'Sample.cs'),
        `public class Box<T> {
  public static Box<T> Create(T x) { return new Box<T>(); }
  public void Unwrap() {}
}
public class Foo {
  public static Foo? MaybeCreate() { return new Foo(); }
  public void Bar() {}
}
public class Wrong {
  public void Bar() {}
}
public class Runner {
  public void Go() {
    Foo.MaybeCreate().Bar();
    Box<Foo>.Create(new Foo()).Unwrap();
  }
}
`,
      );

      cg = await Cartograph.init(tempDir, {
        index: true,
        config: { llm: { endpoint: '' }, include: ['**/*.cs'], exclude: [] },
      });

      const methods = getNodesByKind(cg.queries, 'method');
      const fooBar = methods.find((n) => n.qualifiedName === 'Foo::Bar');
      const wrongBar = methods.find((n) => n.qualifiedName === 'Wrong::Bar');
      const boxUnwrap = methods.find((n) => n.qualifiedName === 'Box::Unwrap');
      const boxCreate = methods.find((n) => n.qualifiedName === 'Box::Create');
      expect(fooBar).toBeDefined();
      expect(wrongBar).toBeDefined();
      expect(boxUnwrap).toBeDefined();
      expect(boxCreate).toBeDefined();

      const fooBarCallers = cg.internals.traverser.getCallers(fooBar!.id);
      const wrongBarCallers = cg.internals.traverser.getCallers(wrongBar!.id);
      const boxUnwrapCallers = cg.internals.traverser.getCallers(boxUnwrap!.id);
      const boxCreateCallers = cg.internals.traverser.getCallers(boxCreate!.id);
      expect(fooBarCallers.some((c) => c.node.qualifiedName === 'Runner::Go')).toBe(true);
      expect(wrongBarCallers.some((c) => c.node.qualifiedName === 'Runner::Go')).toBe(false);
      expect(boxUnwrapCallers.some((c) => c.node.qualifiedName === 'Runner::Go')).toBe(true);
      expect(boxCreateCallers.some((c) => c.node.qualifiedName === 'Runner::Go')).toBe(true);
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

    it('reloads tsconfig path aliases across sync without restarting', async () => {
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

      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@utils/*': ['legacy/*'] },
          },
        }),
      );
      const syncResult = await cg.sync({ summarize: false });
      expect(syncResult.changedFilePaths).toContain('src/main.ts');

      const all = getNodesByKind(cg.queries, 'function').filter((n) => n.name === 'pickMe');
      const utilsNode = all.find((n) => n.filePath === 'src/utils/format.ts');
      const legacyNode = all.find((n) => n.filePath === 'src/legacy/format.ts');
      expect(utilsNode).toBeDefined();
      expect(legacyNode).toBeDefined();

      const utilsCallers = cg.internals.traverser.getCallers(utilsNode!.id);
      const legacyCallers = cg.internals.traverser.getCallers(legacyNode!.id);
      expect(legacyCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
      expect(utilsCallers.some((c) => c.node.filePath === 'src/main.ts')).toBe(false);
    });

    it('resolves aliases inherited from an extended tsconfig', async () => {
      fs.mkdirSync(path.join(tempDir, 'src/shared'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/shared/format.ts'),
        `export function inheritedPick(): number { return 1; }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { inheritedPick } from '@shared/format';\nexport function go(): number { return inheritedPick(); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'tsconfig.base.json'),
        JSON.stringify({
          compilerOptions: {
            baseUrl: './src',
            paths: { '@shared/*': ['shared/*'] },
          },
        }),
      );
      fs.writeFileSync(path.join(tempDir, 'tsconfig.json'), JSON.stringify({ extends: './tsconfig.base.json' }));

      cg = await Cartograph.init(tempDir, { index: true });
      cg.internals.resolver.resolveAndPersist(getUnresolvedReferences(cg.queries));

      const target = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'inheritedPick');
      expect(target).toBeDefined();
      const callers = cg.internals.traverser.getCallers(target!.id);
      expect(callers.some((c) => c.node.filePath === 'src/main.ts')).toBe(true);
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
