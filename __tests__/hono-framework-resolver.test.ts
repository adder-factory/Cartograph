import { describe, expect, it } from 'vitest';
import { honoResolver } from '../src/resolution/frameworks/hono.js';
import type { Language, Node, NodeKind } from '../src/types.js';
import type { ResolutionContext } from '../src/resolution/types.js';

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qualifiedName: string) => nodes.filter((n) => n.qualifiedName === qualifiedName),
    getNodesByKind: (kind: NodeKind) => nodes.filter((n) => n.kind === kind),
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? null,
    getProjectRoot: () => '/tmp/hono-project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName: string) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
    getImportMappings: (_filePath: string, _language: Language) => [],
  };
}

describe('Hono framework resolver', () => {
  it('declares languages: [typescript, javascript, tsx, jsx]', () => {
    expect(honoResolver.languages).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
  });

  it('detects Hono from package metadata and imports', () => {
    expect(honoResolver.detect(context({ 'package.json': '{"dependencies":{"hono":"latest"}}' }))).toBe(true);
    expect(honoResolver.detect(context({ 'src/app.ts': "import { Hono } from 'hono';\n" }))).toBe(true);
    expect(honoResolver.detect(context({ 'src/app.ts': 'export const x = 1;\n' }))).toBe(false);
  });

  it('extracts routes from arbitrary Hono receiver variables', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        "import { Hono } from 'hono';",
        'const api = new Hono();',
        "api.get('/health', health);",
        "api.post('/users', createUser);",
        "cache.get('/not-a-route');",
      ].join('\n'),
    );

    expect(nodes.map((n) => n.name).sort()).toEqual(['GET /health', 'POST /users']);
  });

  it('extracts mounted sub-router paths', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        "import { Hono } from 'hono';",
        'const app = new Hono();',
        'const users = new Hono();',
        "users.get('/:id', showUser);",
        "app.route('/api/users', users);",
      ].join('\n'),
    );

    expect(nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['GET /:id', 'GET /api/users/:id']));
  });

  it('supports Hono .on(method, path) routes and ignores comments', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        'const app = new Hono();',
        '// app.get("/comment", h);',
        '/* app.post("/block", h); */',
        "app.on('PURGE', '/cache', purgeCache);",
      ].join('\n'),
    );

    expect(nodes.map((n) => n.name)).toEqual(['PURGE /cache']);
  });
});
