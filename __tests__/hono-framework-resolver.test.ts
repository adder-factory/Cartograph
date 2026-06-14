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

  it('recognizes every HTTP method verb (get/post/put/patch/delete/options/all)', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        'const app = new Hono();',
        "app.get('/g', h);",
        "app.post('/p', h);",
        "app.put('/u', h);",
        "app.patch('/pa', h);",
        "app.delete('/d', h);",
        "app.options('/o', h);",
        "app.all('/a', h);",
      ].join('\n'),
    );

    expect(nodes.map((n) => n.name).sort()).toEqual([
      'ALL /a',
      'DELETE /d',
      'GET /g',
      'OPTIONS /o',
      'PATCH /pa',
      'POST /p',
      'PUT /u',
    ]);
  });

  it('emits a fully-formed route node (id/kind/qualifiedName/lines/columns)', () => {
    const [node] = honoResolver.extractNodes!('src/app.ts', "const app = new Hono();\napp.get('/health', handler);");

    expect(node).toMatchObject({
      id: 'route:src/app.ts:GET:/health:2:direct',
      kind: 'route',
      name: 'GET /health',
      qualifiedName: 'src/app.ts::GET:/health',
      filePath: 'src/app.ts',
      startLine: 2,
      endLine: 2,
      startColumn: 0,
      // width = length of "app.get(" = 8 → endColumn = column(0) + width(8)
      endColumn: 8,
      language: 'typescript',
    });
  });

  it('encodes mounted vs direct routes with distinct ids and prefixed paths', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        'const app = new Hono();',
        'const users = new Hono();',
        "users.get('/:id', showUser);",
        "app.route('/api/users', users);",
      ].join('\n'),
    );

    const ids = nodes.map((n) => n.id).sort();
    expect(ids).toEqual(['route:src/app.ts:GET:/:id:3:direct', 'route:src/app.ts:GET:/api/users/:id:3:mounted']);
  });

  it('mounts only the named child sub-router under a prefix, not every sub-router', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        'const app = new Hono();',
        'const a = new Hono();',
        'const b = new Hono();',
        "a.get('/ax', h);",
        "b.get('/bx', h);",
        "app.route('/api', a);", // only `a` is mounted
      ].join('\n'),
    );

    const names = nodes.map((n) => n.name).sort();
    expect(names).toEqual(['GET /api/ax', 'GET /ax', 'GET /bx']);
    // `b`'s route must NOT be re-published under the /api prefix
    expect(names).not.toContain('GET /api/bx');
  });

  it('resolves a bare (non-declared) reassigned Hono receiver', () => {
    const nodes = honoResolver.extractNodes!('src/app.ts', "app = new Hono();\napp.get('/bare', h);");
    expect(nodes.map((n) => n.name)).toEqual(['GET /bare']);
  });

  it('keeps same method+path routes on different lines as separate nodes', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "app.get('/x', a);", "app.get('/x', b);"].join('\n'),
    );

    expect(nodes.map((n) => n.startLine)).toEqual([2, 3]);
    expect(nodes.map((n) => n.id)).toEqual(['route:src/app.ts:GET:/x:2:direct', 'route:src/app.ts:GET:/x:3:direct']);
  });

  it('uppercases the method argument of .on(method, path)', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "app.on('purge', '/cache', h);"].join('\n'),
    );

    expect(nodes.map((n) => n.name)).toEqual(['PURGE /cache']);
  });

  it('normalizes joined paths: collapses slashes and handles root prefixes', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      [
        'const app = new Hono();',
        'const sub = new Hono();',
        "sub.get('/x', h);",
        "app.route('/api/', sub);", // trailing slash on prefix
      ].join('\n'),
    );
    expect(nodes.map((n) => n.name)).toEqual(expect.arrayContaining(['GET /x', 'GET /api/x']));
    expect(nodes.some((n) => n.name === 'GET /api//x')).toBe(false);

    const rootPrefix = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', 'const sub = new Hono();', "sub.get('/x', h);", "app.route('/', sub);"].join('\n'),
    );
    // root '/' prefix leaves the child path untouched
    expect(rootPrefix.filter((n) => n.id.endsWith('mounted')).map((n) => n.name)).toEqual(['GET /x']);

    const rootChild = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', 'const sub = new Hono();', "sub.get('/', h);", "app.route('/api', sub);"].join('\n'),
    );
    // child path '/' under a real prefix yields just the prefix
    expect(rootChild.filter((n) => n.id.endsWith('mounted')).map((n) => n.name)).toEqual(['GET /api']);
  });

  it('preserves escaped quotes inside the route path argument', () => {
    const nodes = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "app.get('/a\\'b', h);"].join('\n'),
    );
    expect(nodes.map((n) => n.name)).toEqual(["GET /a\\'b"]);
  });

  it('matches receivers at content start and respects identifier boundaries', () => {
    // receiver appearing at index 0 (before its own declaration line) still matches
    const atStart = honoResolver.extractNodes!(
      'src/app.ts',
      ["app.get('/zero', h);", 'const app = new Hono();'].join('\n'),
    );
    expect(atStart.map((n) => n.name)).toEqual(['GET /zero']);

    // `myapp.get` must NOT be attributed to the `app` receiver
    const boundary = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "myapp.get('/no', h);", "app.get('/yes', h);"].join('\n'),
    );
    expect(boundary.map((n) => n.name)).toEqual(['GET /yes']);
  });

  it('detects receivers named with uppercase, digits, underscore, and $', () => {
    expect(
      honoResolver.extractNodes!('src/app.ts', "const Api = new Hono();\nApi.get('/u', h);").map((n) => n.name),
    ).toEqual(['GET /u']);
    expect(
      honoResolver.extractNodes!('src/app.ts', "const app2 = new Hono();\napp2.get('/d', h);").map((n) => n.name),
    ).toEqual(['GET /d']);
    expect(
      honoResolver.extractNodes!('src/app.ts', "const _app = new Hono();\n_app.get('/under', h);").map((n) => n.name),
    ).toEqual(['GET /under']);
    expect(
      honoResolver.extractNodes!('src/app.ts', "const $app = new Hono();\n$app.get('/dollar', h);").map((n) => n.name),
    ).toEqual(['GET /dollar']);
  });

  it('accepts the full ASCII letter and digit ranges in receiver identifiers', () => {
    // 'Z' is the top of the uppercase letter range; 'z' the top of the lowercase range
    expect(
      honoResolver.extractNodes!('src/app.ts', "const Zapp = new Hono();\nZapp.get('/z', h);").map((n) => n.name),
    ).toEqual(['GET /z']);
    expect(
      honoResolver.extractNodes!('src/app.ts', "const zapp = new Hono();\nzapp.get('/zz', h);").map((n) => n.name),
    ).toEqual(['GET /zz']);
    // '0' and '9' are the bounds of the digit range; both must count as identifier chars
    expect(
      honoResolver.extractNodes!('src/app.ts', "const app0 = new Hono();\napp0.get('/d0', h);").map((n) => n.name),
    ).toEqual(['GET /d0']);
    expect(
      honoResolver.extractNodes!('src/app.ts', "const app9 = new Hono();\napp9.get('/d9', h);").map((n) => n.name),
    ).toEqual(['GET /d9']);
  });

  it('treats tab, newline, and carriage-return as whitespace between a method and its parens', () => {
    for (const ws of ['\t', '\n', '\r', ' ']) {
      const nodes = honoResolver.extractNodes!('src/app.ts', `const app = new Hono();\napp.get${ws}('/ws', h);`);
      expect(nodes.map((n) => n.name)).toEqual(['GET /ws']);
    }
  });

  it('collapses redundant slashes when joining mount prefixes and child paths', () => {
    // multiple trailing slashes on the prefix
    expect(
      honoResolver.extractNodes!(
        'src/app.ts',
        ['const app = new Hono();', 'const s = new Hono();', "s.get('/x', h);", "app.route('/api//', s);"].join('\n'),
      )
        .filter((n) => n.id.endsWith('mounted'))
        .map((n) => n.name),
    ).toEqual(['GET /api/x']);

    // multiple leading slashes on the child path
    expect(
      honoResolver.extractNodes!(
        'src/app.ts',
        ['const app = new Hono();', 'const s = new Hono();', "s.get('//x', h);", "app.route('/api', s);"].join('\n'),
      )
        .filter((n) => n.id.endsWith('mounted'))
        .map((n) => n.name),
    ).toEqual(['GET /api/x']);
  });

  it('rejects member-expression receivers whose name is not a plain identifier', () => {
    // `this.app`/`obj.api` are member expressions: the interior '.' makes the token an invalid
    // identifier, so no receiver (and therefore no routes) is registered.
    expect(honoResolver.extractNodes!('src/app.ts', "this.app = new Hono();\nthis.app.get('/x', h);")).toEqual([]);
    expect(honoResolver.extractNodes!('src/app.ts', "obj.api = new Hono();\nobj.api.get('/x', h);")).toEqual([]);
  });

  it('extracts routes from OpenAPIHono receivers', () => {
    const nodes = honoResolver.extractNodes!('src/app.ts', "const api = new OpenAPIHono();\napi.get('/spec', h);");
    expect(nodes.map((n) => n.name)).toEqual(['GET /spec']);
  });

  it('tags node language from the file extension (js vs ts)', () => {
    expect(honoResolver.extractNodes!('src/app.js', "const app = new Hono();\napp.get('/j', h);")[0]?.language).toBe(
      'javascript',
    );
    expect(honoResolver.extractNodes!('src/app.tsx', "const app = new Hono();\napp.get('/t', h);")[0]?.language).toBe(
      'typescript',
    );
  });

  it('returns no nodes when there are no Hono receivers', () => {
    expect(honoResolver.extractNodes!('src/app.ts', "const x = 1;\nother.get('/no', h);")).toEqual([]);
  });

  it('detect() covers scoped deps, require imports, double-quoted imports, and new-expressions', () => {
    expect(honoResolver.detect(context({ 'package.json': '{"devDependencies":{"@hono/zod-openapi":"1"}}' }))).toBe(
      true,
    );
    expect(honoResolver.detect(context({ 'src/a.js': "const { Hono } = require('hono');\n" }))).toBe(true);
    expect(honoResolver.detect(context({ 'src/a.ts': 'import { Hono } from "hono";\n' }))).toBe(true);
    expect(honoResolver.detect(context({ 'src/a.ts': 'const app = new OpenAPIHono();\n' }))).toBe(true);
    // a hono signal in a non-JS file is ignored
    expect(honoResolver.detect(context({ 'README.md': 'new Hono(\n' }))).toBe(false);
    // invalid package.json is not a framework signal (and there is no other signal)
    expect(honoResolver.detect(context({ 'package.json': '{ not json' }))).toBe(false);
  });

  it('detect() requires a real Hono dependency, not merely any dependency', () => {
    // deps present but none is hono / @hono/* → not a Hono project
    expect(
      honoResolver.detect(
        context({
          'package.json': '{"dependencies":{"express":"4","lodash":"1"}}',
          'src/a.ts': 'export const x = 1;\n',
        }),
      ),
    ).toBe(false);
    // a scoped @hono/* dep is still detected even when surrounded by unrelated deps
    expect(
      honoResolver.detect(
        context({ 'package.json': '{"dependencies":{"express":"4","@hono/zod-openapi":"1","lodash":"2"}}' }),
      ),
    ).toBe(true);
  });

  it('only emits routes for statically-known string paths, ignoring variable arguments', () => {
    // a method route whose path is a variable/constant rather than a string literal is skipped
    const methodVar = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', 'app.get(ROUTES.health, handler);', "app.get('/ok', h);"].join('\n'),
    );
    expect(methodVar.map((n) => n.name)).toEqual(['GET /ok']);

    // an .on() route whose path argument is not a string literal is skipped
    const onVar = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "app.on('GET', somePath, h);"].join('\n'),
    );
    expect(onVar).toEqual([]);

    // a .route() mount whose prefix is not a string literal is skipped
    const routeVar = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', 'const s = new Hono();', "s.get('/x', h);", 'app.route(prefixVar, s);'].join('\n'),
    );
    expect(routeVar.map((n) => n.name)).toEqual(['GET /x']);
  });

  it('drops .on()/.route() calls whose argument-separating comma is on a later line', () => {
    // nextCommaIndex stops at a newline, so a comma on the following line is not seen
    const onAcrossLine = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', "app.on('PURGE'", ", '/cache', h);"].join('\n'),
    );
    expect(onAcrossLine).toEqual([]);

    const routeAcrossLine = honoResolver.extractNodes!(
      'src/app.ts',
      ['const app = new Hono();', 'const s = new Hono();', "s.get('/x', h);", "app.route('/api'", ', s);'].join('\n'),
    );
    // the sub-router's own route survives, but no mounted (/api/x) route is produced
    expect(routeAcrossLine.map((n) => n.name)).toEqual(['GET /x']);
  });

  it('resolve() always returns null (Hono contributes nodes, not ref resolutions)', () => {
    const ref = {
      name: 'anything',
      filePath: 'src/app.ts',
      line: 1,
      column: 0,
    } as Parameters<typeof honoResolver.resolve>[0];
    expect(honoResolver.resolve(ref, context({}))).toBeNull();
  });

  it('exposes the resolver name "hono"', () => {
    expect(honoResolver.name).toBe('hono');
  });
});
