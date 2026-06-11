import { describe, expect, it } from 'vitest';
import { matchReference } from '../src/resolution/name-matcher.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Node } from '../src/types.js';

function node(overrides: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>): Node {
  return {
    qualifiedName: overrides.name,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 1,
    ...overrides,
  } as Node;
}

function ref(overrides: Partial<UnresolvedRef>): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName: 'target',
    referenceKind: 'calls',
    filePath: 'src/app.ts',
    language: 'typescript',
    line: 10,
    col: 1,
    ...overrides,
  } as UnresolvedRef;
}

function context(nodes: Node[], extras: Partial<ResolutionContext> = {}): ResolutionContext {
  return {
    getNodesByName(name: string) {
      return nodes.filter((n) => n.name === name);
    },
    getNodesByQualifiedName(name: string) {
      return nodes.filter((n) => n.qualifiedName === name);
    },
    getNodesByLowerName(name: string) {
      return nodes.filter((n) => n.name.toLowerCase() === name);
    },
    getNodesInFile(filePath: string) {
      return nodes.filter((n) => n.filePath === filePath);
    },
    getImportMappings() {
      return [];
    },
    readFile() {
      return null;
    },
    ...extras,
  } as ResolutionContext;
}

describe('name matcher focused resolver branches', () => {
  it('resolves path references by exact, suffix, and filename-only file-node matches', () => {
    const exact = node({
      id: 'file:exact',
      name: 'drawer-menu.liquid',
      kind: 'file',
      qualifiedName: 'snippets/drawer-menu.liquid',
      filePath: 'snippets/drawer-menu.liquid',
    });
    const suffix = node({
      id: 'file:suffix',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'src/theme/snippets/card.liquid',
      filePath: 'src/theme/snippets/card.liquid',
    });
    const only = node({
      id: 'file:only',
      name: 'hero.liquid',
      kind: 'file',
      qualifiedName: 'src/blocks/hero.liquid',
      filePath: 'src/blocks/hero.liquid',
    });
    const ctx = context([exact, suffix, only]);

    expect(matchReference(ref({ referenceName: 'snippets/drawer-menu.liquid' }), ctx)).toMatchObject({
      targetNodeId: 'file:exact',
      confidence: 0.95,
      resolvedBy: 'file-path',
    });
    expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), ctx)).toMatchObject({
      targetNodeId: 'file:suffix',
      confidence: 0.85,
    });
    expect(matchReference(ref({ referenceName: 'other/hero.liquid' }), ctx)).toMatchObject({
      targetNodeId: 'file:only',
      confidence: 0.7,
    });
  });

  it('uses JVM import aliases to disambiguate same-named classes before resolving a method', () => {
    const callerImport = node({
      id: 'import:service',
      name: 'com.example.impl.Service',
      kind: 'import',
      signature: 'import com.example.impl.Service as Backend',
      language: 'kotlin',
      filePath: 'src/main/kotlin/App.kt',
    });
    const wrongClass = node({
      id: 'class:wrong',
      name: 'Service',
      kind: 'class',
      qualifiedName: 'other.Service',
      language: 'java',
      filePath: 'src/main/java/com/other/Service.java',
    });
    const rightClass = node({
      id: 'class:right',
      name: 'Service',
      kind: 'class',
      qualifiedName: 'impl.Service',
      language: 'java',
      filePath: 'src/main/java/com/example/impl/Service.java',
    });
    const wrongRun = node({
      id: 'method:wrong',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service.run',
      language: 'java',
      filePath: wrongClass.filePath,
    });
    const rightRun = node({
      id: 'method:right',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service.run',
      language: 'java',
      filePath: rightClass.filePath,
    });

    expect(
      matchReference(
        ref({
          referenceName: 'backend.run',
          filePath: 'src/main/kotlin/App.kt',
          language: 'kotlin',
          line: 20,
        }),
        context([callerImport, wrongClass, wrongRun, rightClass, rightRun]),
      ),
    ).toMatchObject({ targetNodeId: 'method:right', resolvedBy: 'fqn-disambiguated', confidence: 0.9 });
  });

  it('infers Java and TypeScript field receiver types when receiver capitalization is insufficient', () => {
    const javaNodes = [
      node({
        id: 'class:controller',
        name: 'Controller',
        kind: 'class',
        qualifiedName: 'Controller',
        language: 'java',
        filePath: 'src/Controller.java',
        startLine: 1,
        endLine: 40,
      }),
      node({
        id: 'field:userbo',
        name: 'userbo',
        kind: 'field',
        signature: 'com.example.UserBO userbo',
        language: 'java',
        filePath: 'src/Controller.java',
        startLine: 3,
        endLine: 3,
      }),
      node({
        id: 'class:userbo',
        name: 'UserBO',
        kind: 'class',
        qualifiedName: 'UserBO',
        language: 'java',
        filePath: 'src/UserBO.java',
      }),
      node({
        id: 'method:login',
        name: 'toLogin2',
        kind: 'method',
        qualifiedName: 'UserBO.toLogin2',
        language: 'java',
        filePath: 'src/UserBO.java',
      }),
    ];
    expect(
      matchReference(
        ref({ referenceName: 'userbo.toLogin2', filePath: 'src/Controller.java', language: 'java', line: 20 }),
        context(javaNodes),
      ),
    ).toMatchObject({ targetNodeId: 'method:login', resolvedBy: 'instance-method' });

    const tsNodes = [
      node({
        id: 'class:repo',
        name: 'Repo',
        kind: 'class',
        qualifiedName: 'Repo',
        filePath: 'src/repo.ts',
        startLine: 1,
        endLine: 30,
      }),
      node({
        id: 'field:cache',
        name: 'cache',
        kind: 'field',
        filePath: 'src/repo.ts',
        startLine: 3,
        endLine: 3,
      }),
      node({
        id: 'class:tiny',
        name: 'TinyCache',
        kind: 'class',
        qualifiedName: 'TinyCache',
        filePath: 'src/cache.ts',
      }),
      node({
        id: 'method:remember',
        name: 'remember',
        kind: 'method',
        qualifiedName: 'TinyCache.remember',
        filePath: 'src/cache.ts',
      }),
    ];
    expect(
      matchReference(ref({ referenceName: 'cache.remember', filePath: 'src/repo.ts', line: 12 }), {
        ...context(tsNodes),
        readFile: () => ['class Repo {', '  value = 1;', '  private cache: TinyCache;', '  run() {}'].join('\n'),
      } as ResolutionContext),
    ).toMatchObject({ targetNodeId: 'method:remember', resolvedBy: 'instance-method' });
  });

  it('suppresses unbacked builtin method calls but keeps imported or same-file callable names', () => {
    const remoteSet = node({
      id: 'method:remote-set',
      name: 'set',
      kind: 'method',
      qualifiedName: 'Cache.set',
      filePath: 'src/cache.ts',
    });
    expect(matchReference(ref({ referenceName: 'set' }), context([remoteSet]))).toBeNull();

    const sameFileSet = node({
      id: 'function:local-set',
      name: 'set',
      kind: 'function',
      qualifiedName: 'set',
      filePath: 'src/app.ts',
    });
    expect(matchReference(ref({ referenceName: 'set' }), context([remoteSet, sameFileSet]))).toMatchObject({
      targetNodeId: 'function:local-set',
    });

    expect(
      matchReference(
        ref({ referenceName: 'set' }),
        context([remoteSet], {
          getImportMappings: () => [{ localName: 'set', importedName: 'set', source: './cache' }] as never,
        }),
      ),
    ).toMatchObject({ targetNodeId: 'method:remote-set' });
  });

  it('uses fuzzy fallback only for callable singletons and lowers confidence for cross-language matches', () => {
    const pyTarget = node({
      id: 'function:py',
      name: 'HandleRequest',
      kind: 'function',
      qualifiedName: 'HandleRequest',
      language: 'python',
      filePath: 'service.py',
    });
    expect(matchReference(ref({ referenceName: 'handlerequest' }), context([pyTarget]))).toMatchObject({
      targetNodeId: 'function:py',
      resolvedBy: 'fuzzy',
      confidence: 0.3,
    });

    const variable = node({
      id: 'var:thing',
      name: 'thing',
      kind: 'variable',
      qualifiedName: 'thing',
      filePath: 'src/a.ts',
    });
    expect(matchReference(ref({ referenceName: 'THING' }), context([variable]))).toBeNull();
  });

  it('suppresses incompatible cross-language matches when the bare name is import-backed', () => {
    // The describe-hub bug: `import { describe } from 'bun:test'` in a TS
    // file + one ObjC method named `describe` in the project produced a
    // phantom cross-language exact-match edge per test file.
    const objcDescribe = node({
      id: 'method:objc-describe',
      name: 'describe',
      kind: 'method',
      qualifiedName: 'Fixture.describe',
      language: 'objc',
      filePath: 'docs/test-beds/objc/fixture.m',
    });
    const bunTestImport = [{ localName: 'describe', importedName: 'describe', source: 'bun:test' }] as never;
    const importBacked = context([objcDescribe], { getImportMappings: () => bunTestImport });
    expect(
      matchReference(ref({ referenceName: 'describe', filePath: '__tests__/foo.test.ts' }), importBacked),
    ).toBeNull();

    // The fuzzy path must not re-create the edge at lower confidence
    // either: exact-name lookup misses (node is `Describe`), the
    // case-insensitive fuzzy lookup hits, and the same gate fires.
    const objcDescribeUpper = node({
      id: 'method:objc-describe-upper',
      name: 'Describe',
      kind: 'method',
      qualifiedName: 'Fixture.Describe',
      language: 'objc',
      filePath: 'docs/test-beds/objc/fixture.m',
    });
    const fuzzyImportBacked = context([objcDescribeUpper], { getImportMappings: () => bunTestImport });
    expect(
      matchReference(ref({ referenceName: 'describe', filePath: '__tests__/foo.test.ts' }), fuzzyImportBacked),
    ).toBeNull();

    // Without import backing the cross-language single match still resolves
    // at the penalized confidence — unchanged behavior.
    expect(matchReference(ref({ referenceName: 'describe' }), context([objcDescribe]))).toMatchObject({
      targetNodeId: 'method:objc-describe',
      confidence: 0.5,
      resolvedBy: 'exact-match',
    });
  });

  it('keeps import-backed JVM cross-language exact matches (kotlin -> java)', () => {
    const javaClass = node({
      id: 'class:java-bar',
      name: 'Bar',
      kind: 'class',
      qualifiedName: 'com.foo.Bar',
      language: 'java',
      filePath: 'src/main/java/com/foo/Bar.java',
    });
    const kotlinRef = ref({ referenceName: 'Bar', filePath: 'src/main/kotlin/com/foo/App.kt', language: 'kotlin' });
    const ctx = context([javaClass], {
      getImportMappings: () => [{ localName: 'Bar', importedName: 'Bar', source: 'com.foo.Bar' }] as never,
    });
    expect(matchReference(kotlinRef, ctx)).toMatchObject({ targetNodeId: 'class:java-bar' });
  });
});
