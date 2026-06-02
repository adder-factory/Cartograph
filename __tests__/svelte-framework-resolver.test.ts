import { describe, expect, it } from 'vitest';
import { svelteResolver } from '../src/resolution/frameworks/svelte.js';
import type { Node } from '../src/types.js';

function node(id: string, name: string, kind: Node['kind'], filePath: string): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: filePath.endsWith('.svelte') ? 'svelte' : 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
  };
}

function context(files: string[], nodes: Node[] = [], packageJson: string | null = null) {
  return {
    readFile: (path: string) => (path === 'package.json' ? packageJson : null),
    getAllFiles: () => files,
    fileExists: (path: string) => files.includes(path),
    getNodesInFile: (path: string) => nodes.filter((n) => n.filePath === path),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getProjectRoot: () => '/repo',
  } as any;
}

function ref(referenceName: string, referenceKind: 'calls' | 'imports' = 'calls', filePath = 'src/routes/+page.svelte') {
  return {
    fromNodeId: 'component:src/routes/+page.svelte:Page:1',
    referenceName,
    referenceKind,
    line: 1,
    column: 1,
    filePath,
    language: 'svelte',
  } as any;
}

describe('Svelte framework resolver', () => {
  it('detects Svelte projects from package metadata or files', () => {
    expect(
      svelteResolver.detect(
        context([], [], JSON.stringify({ dependencies: { svelte: '^5.0.0' }, devDependencies: {} })),
      ),
    ).toBe(true);
    expect(
      svelteResolver.detect(
        context([], [], JSON.stringify({ dependencies: {}, devDependencies: { '@sveltejs/kit': '^2.0.0' } })),
      ),
    ).toBe(true);
    expect(svelteResolver.detect(context(['src/App.svelte'], [], '{not json'))).toBe(true);
    expect(svelteResolver.detect(context(['src/App.ts'], [], JSON.stringify({ dependencies: {} })))).toBe(false);
  });

  it('resolves runes, store subscriptions, framework imports, and local components', () => {
    const count = node('var:count', 'count', 'variable', 'src/stores.ts');
    const localButton = node('component:local-button', 'Button', 'component', 'src/routes/Button.svelte');
    const otherButton = node('component:other-button', 'Button', 'component', 'src/lib/Button.svelte');
    const libNode = node('component:lib-card', 'Card', 'component', 'src/lib/Card.svelte');
    const ctx = context(['src/lib/Card.svelte'], [count, otherButton, localButton, libNode]);

    expect(svelteResolver.resolve(ref('$state'), ctx)?.targetNodeId).toBe(ref('$state').fromNodeId);
    expect(svelteResolver.resolve(ref('$derived.by'), ctx)?.confidence).toBe(1);

    const store = svelteResolver.resolve(ref('$count'), ctx);
    expect(store?.targetNodeId).toBe('var:count');
    expect(store?.confidence).toBe(0.85);
    expect(svelteResolver.resolve(ref('$$props'), ctx)).toBeNull();

    expect(svelteResolver.resolve(ref('$app/navigation', 'imports'), ctx)?.targetNodeId).toBe(ref('$app/navigation').fromNodeId);
    const libImport = svelteResolver.resolve(ref('$lib/Card', 'imports'), ctx);
    expect(libImport?.targetNodeId).toBe('component:lib-card');
    expect(libImport?.confidence).toBe(0.9);
    expect(svelteResolver.resolve(ref('$lib/Card', 'calls'), ctx)).toBeNull();

    const component = svelteResolver.resolve(ref('Button', 'calls', 'src/routes/+page.svelte'), ctx);
    expect(component?.targetNodeId).toBe('component:local-button');
    expect(svelteResolver.resolve(ref('button'), ctx)).toBeNull();
    expect(svelteResolver.resolve(ref('Button', 'imports'), ctx)).toBeNull();
  });

  it('extracts SvelteKit routes from route files', () => {
    expect(svelteResolver.extractNodes('src/routes/blog/[slug]/+page.svelte', '')[0]).toMatchObject({
      kind: 'route',
      name: '/blog/:slug',
      language: 'svelte',
    });
    expect(svelteResolver.extractNodes('src/routes/docs/[...rest]/+server.ts', '')[0]).toMatchObject({
      name: '/docs/*rest',
      language: 'typescript',
    });
    expect(svelteResolver.extractNodes('src/routes/[[locale]]/+layout.js', '')[0]?.name).toBe('/:locale?');
    expect(svelteResolver.extractNodes('src/components/Button.svelte', '')).toEqual([]);
    expect(svelteResolver.extractNodes('src/routes/+unknown.svelte', '')).toEqual([]);
  });
});
