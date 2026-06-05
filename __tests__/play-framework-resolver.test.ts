import { describe, expect, it } from 'vitest';
import { detectLanguage, isPlayRoutesFile } from '../src/extraction/grammars.js';
import { playResolver } from '../src/resolution/frameworks/play.js';
import type { Node } from '../src/types.js';

function node(id: string, name: string, kind: Node['kind'], filePath: string): Node {
  return {
    id,
    name,
    kind,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: filePath.endsWith('.scala') ? 'scala' : 'java',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: 1,
  };
}

function context(files: string[], nodes: Node[] = [], reads: Record<string, string | null> = {}) {
  return {
    readFile: (filePath: string) => reads[filePath] ?? null,
    getAllFiles: () => files,
    fileExists: (filePath: string) => files.includes(filePath),
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
    getProjectRoot: () => '/repo',
  } as any;
}

describe('Play framework resolver', () => {
  it('recognizes Play route files without opening all extensionless files', () => {
    expect(isPlayRoutesFile('conf/routes')).toBe(true);
    expect(isPlayRoutesFile('service/conf/admin.routes')).toBe(true);
    expect(isPlayRoutesFile('routes')).toBe(false);
    expect(detectLanguage('conf/routes')).toBe('yaml');
  });

  it('extracts Play route nodes and handler references', () => {
    const extracted = playResolver.extract?.(
      'conf/routes',
      `
# comment
GET   /users/:id       controllers.Users.show(id: Long)
POST  /users           controllers.Users.create()
->    /admin           admin.Routes
`,
    );

    expect(extracted?.nodes.map((n) => n.name)).toEqual(['GET /users/:id', 'POST /users']);
    expect(extracted?.references.map((r) => r.referenceName)).toEqual(['Users.show', 'Users.create']);
  });

  it('resolves route handler references to controller methods', () => {
    const cls = node('class:users', 'Users', 'class', 'app/controllers/Users.scala');
    const show = node('method:show', 'show', 'method', 'app/controllers/Users.scala');
    const ctx = context(['conf/routes', 'app/controllers/Users.scala'], [cls, show]);

    const resolved = playResolver.resolve(
      {
        fromNodeId: 'route:conf/routes:1:GET:/users/:id',
        referenceName: 'Users.show',
        referenceKind: 'references',
        line: 1,
        column: 0,
        filePath: 'conf/routes',
        language: 'yaml',
      },
      ctx,
    );

    expect(resolved?.targetNodeId).toBe('method:show');
    expect(playResolver.claimsReference?.('Users.show')).toBe(true);
    expect(playResolver.claimsReference?.('users.show.extra')).toBe(false);
  });
});
