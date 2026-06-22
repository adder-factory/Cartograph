import { describe, expect, it } from 'vitest';
import { vueResolver } from '../src/resolution/frameworks/vue.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Node } from '../src/types.js';

function node(id: string, name: string, kind: Node['kind'], filePath: string): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: filePath.endsWith('.vue') ? 'vue' : 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
  };
}

function context(files: string[], nodes: Node[] = [], packageJson: string | null = null): ResolutionContext {
  return {
    readFile: (filePath: string) => (filePath === 'package.json' ? packageJson : null),
    getAllFiles: () => files,
    fileExists: (filePath: string) => files.includes(filePath),
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    getProjectRoot: () => '/repo',
  };
}

function ref(
  referenceName: string,
  referenceKind: 'calls' | 'imports' = 'calls',
  filePath = 'pages/index.vue',
): UnresolvedRef {
  return {
    fromNodeId: 'component:pages/index.vue:Page:1',
    referenceName,
    referenceKind,
    line: 1,
    column: 1,
    filePath,
    language: filePath.endsWith('.vue') ? 'vue' : 'typescript',
  };
}

describe('Vue framework resolver', () => {
  it('detects Vue and Nuxt projects', () => {
    expect(vueResolver.detect(context([], [], JSON.stringify({ dependencies: { vue: '^3.0.0' } })))).toBe(true);
    expect(vueResolver.detect(context([], [], JSON.stringify({ devDependencies: { nuxt: '^4.0.0' } })))).toBe(true);
    expect(vueResolver.detect(context(['app.vue'], [], '{bad json'))).toBe(true);
    expect(vueResolver.detect(context(['src/main.ts'], [], JSON.stringify({ dependencies: {} })))).toBe(false);
  });

  it('resolves compiler macros, Nuxt virtual imports, aliases, and components', () => {
    const card = node('component:card', 'Card', 'component', 'src/components/Card.vue');
    const rootUtil = node('function:root-util', 'format', 'function', 'utils/format.ts');
    const localButton = node('component:local-button', 'Button', 'component', 'pages/Button.vue');
    const libraryButton = node('component:library-button', 'Button', 'component', 'components/Button.vue');
    const ctx = context(['src/components/Card.vue', 'utils/format.ts'], [card, rootUtil, libraryButton, localButton]);

    expect(vueResolver.resolve(ref('defineProps'), ctx)?.targetNodeId).toBe(ref('defineProps').fromNodeId);
    expect(vueResolver.resolve(ref('useRoute'), ctx)?.confidence).toBe(1);
    expect(vueResolver.resolve(ref('#imports', 'imports'), ctx)?.targetNodeId).toBe(ref('#imports').fromNodeId);

    expect(vueResolver.resolve(ref('@/components/Card', 'imports'), ctx)?.targetNodeId).toBe('component:card');
    expect(vueResolver.resolve(ref('~/utils/format', 'imports'), ctx)?.targetNodeId).toBe('function:root-util');
    expect(vueResolver.resolve(ref('Button', 'calls', 'pages/index.vue'), ctx)?.targetNodeId).toBe(
      'component:local-button',
    );
    expect(vueResolver.resolve(ref('button', 'calls'), ctx)).toBeNull();
  });

  it('extracts Nuxt page, API, and middleware route nodes', () => {
    expect(vueResolver.extractNodes?.('pages/blog/[slug].vue', '')[0]).toMatchObject({
      kind: 'route',
      name: '/blog/:slug',
      language: 'vue',
    });
    expect(vueResolver.extractNodes?.('src/pages/docs/[...rest].vue', '')[0]?.name).toBe('/docs/*rest');
    expect(vueResolver.extractNodes?.('server/api/users/[id].ts', '')[0]).toMatchObject({
      name: '/api/users/:id',
      language: 'typescript',
    });
    expect(vueResolver.extractNodes?.('middleware/auth.global.ts', '')[0]).toMatchObject({
      kind: 'function',
      name: 'auth.global',
    });
    expect(vueResolver.extractNodes?.('components/Button.vue', '')).toEqual([]);
  });
});
