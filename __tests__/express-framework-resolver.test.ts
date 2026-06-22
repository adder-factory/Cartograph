import { describe, expect, it } from 'vitest';
import { expressResolver } from '../src/resolution/frameworks/express.js';
import type { Language, Node, NodeKind } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';

function context(files: Record<string, string>, nodes: Node[] = []): ResolutionContext {
  return {
    getNodesInFile: (filePath: string) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name: string) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: (qualifiedName: string) => nodes.filter((n) => n.qualifiedName === qualifiedName),
    getNodesByKind: (kind: NodeKind) => nodes.filter((n) => n.kind === kind),
    fileExists: (filePath: string) => Object.hasOwn(files, filePath),
    readFile: (filePath: string) => files[filePath] ?? null,
    getProjectRoot: () => '/tmp/express-project',
    getAllFiles: () => Object.keys(files),
    getNodesByLowerName: (lowerName: string) => nodes.filter((n) => n.name.toLowerCase() === lowerName),
    getImportMappings: (_filePath: string, _language: Language) => [],
  };
}

function node(overrides: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>): Node {
  return {
    qualifiedName: `${overrides.filePath}::${overrides.name}`,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function ref(name: string, filePath = 'src/routes.ts'): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName: name,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath,
    language: 'typescript',
  };
}

const names = (nodes: Node[]): string[] => nodes.map((n) => n.name);

describe('expressResolver metadata', () => {
  it('exposes the resolver name "express"', () => {
    expect(expressResolver.name).toBe('express');
  });

  it('declares languages: [typescript, javascript, tsx, jsx]', () => {
    // The orchestrator gates extractNodes on this set; a wrong/empty set
    // would silently run the Express route regex on non-JS files.
    expect(expressResolver.languages).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
  });
});

describe('expressResolver.detect', () => {
  it('detects Express from a package.json dependency', () => {
    expect(expressResolver.detect(context({ 'package.json': '{"dependencies":{"express":"4"}}' }))).toBe(true);
  });

  it('detects the other Node web frameworks fastify/koa/hapi (deps OR-chain)', () => {
    // Each disjunct of the `deps.express || deps.fastify || deps.koa || deps.hapi`
    // chain must independently trip detection.
    expect(expressResolver.detect(context({ 'package.json': '{"dependencies":{"fastify":"4"}}' }))).toBe(true);
    expect(expressResolver.detect(context({ 'package.json': '{"devDependencies":{"koa":"2"}}' }))).toBe(true);
    expect(expressResolver.detect(context({ 'package.json': '{"dependencies":{"hapi":"1"}}' }))).toBe(true);
  });

  it('merges devDependencies into the dependency scan', () => {
    // express living only in devDependencies must still be seen — proves the
    // `{ ...pkg.dependencies, ...pkg.devDependencies }` spread, not just `.dependencies`.
    expect(expressResolver.detect(context({ 'package.json': '{"devDependencies":{"express":"4"}}' }))).toBe(true);
  });

  it('returns false for a package.json with only unrelated deps', () => {
    expect(expressResolver.detect(context({ 'package.json': '{"dependencies":{"lodash":"1"}}' }))).toBe(false);
  });

  it('ignores dependency entries whose versions are not strings', () => {
    expect(expressResolver.detect(context({ 'package.json': '{"dependencies":{"express":1}}' }))).toBe(false);
  });

  it('swallows invalid package.json JSON (no throw, falls through to false)', () => {
    // The try/catch around JSON.parse must not let a parse error escape;
    // with no other signal the result is false.
    expect(expressResolver.detect(context({ 'package.json': '{ not json' }))).toBe(false);
  });

  it('detects Express from an express signal inside a routes/controllers/middleware file', () => {
    // Each convention directory token (routes|controllers|middleware) must be
    // honored, and the content signal must be one of express|app.get|router.get.
    expect(expressResolver.detect(context({ 'src/routes/users.ts': "app.get('/x')" }))).toBe(true);
    expect(expressResolver.detect(context({ 'src/controllers/u.ts': "import express from 'express'" }))).toBe(true);
    expect(expressResolver.detect(context({ 'src/middleware/auth.ts': "router.get('/x')" }))).toBe(true);
  });

  it('requires an express-shaped signal even in a routes file (filename alone is not enough)', () => {
    // The file is in routes/ but its content has none of express|app.get|router.get.
    expect(expressResolver.detect(context({ 'src/routes/users.ts': 'const x = 1;' }))).toBe(false);
  });

  it('ignores an express signal in a file that is not under a convention directory', () => {
    // app.get lives in src/app.ts (no routes/controllers/middleware token) so
    // the per-file scan never opens it.
    expect(expressResolver.detect(context({ 'src/app.ts': "app.get('/x')" }))).toBe(false);
  });

  it('returns false with no package.json and no matching files', () => {
    expect(expressResolver.detect(context({}))).toBe(false);
  });
});

describe('expressResolver.extractNodes routes', () => {
  it('extracts every supported HTTP method verb on app and router receivers', () => {
    const nodes = expressResolver.extractNodes!(
      'src/routes.ts',
      [
        'const app = express();',
        "app.get('/g', h);",
        "app.post('/p', h);",
        "app.put('/u', h);",
        "app.patch('/pa', h);",
        "app.delete('/d', h);",
        "app.all('/a', h);",
        "router.get('/rg', h);",
      ].join('\n'),
    );
    expect(names(nodes).sort()).toEqual(['ALL /a', 'DELETE /d', 'GET /g', 'GET /rg', 'PATCH /pa', 'POST /p', 'PUT /u']);
  });

  it('captures the full route path string, not just the method', () => {
    expect(names(expressResolver.extractNodes!('src/r.ts', "app.get('/api/users/:id', h);"))).toEqual([
      'GET /api/users/:id',
    ]);
  });

  it('uppercases the method token (post -> POST)', () => {
    // Distinguishes the `.toUpperCase()` on the method from a raw passthrough.
    const [n] = expressResolver.extractNodes!('src/r.ts', "app.post('/x', h);");
    expect(n!.name).toBe('POST /x');
  });

  it('matches both single- and double-quoted path arguments', () => {
    expect(names(expressResolver.extractNodes!('src/r.ts', 'app.get("/dq", h);'))).toEqual(['GET /dq']);
  });

  it('extracts app.use only when its argument is a slash-rooted path', () => {
    // `app.use('/api', router)` is a mount (kept); `app.use(express.json())`
    // and `app.use('cors', m)` are pathless middleware (dropped).
    expect(names(expressResolver.extractNodes!('src/r.ts', "app.use('/api', router);"))).toEqual(['USE /api']);
    expect(expressResolver.extractNodes!('src/r.ts', 'app.use(express.json());')).toEqual([]);
    expect(expressResolver.extractNodes!('src/r.ts', "app.use('cors', m);")).toEqual([]);
  });

  it('does NOT drop a slash-rooted use() (the pathless-middleware guard is use-only and slash-gated)', () => {
    // Guards against a mutated `method === 'use'` condition or an inverted
    // path.startsWith('/') that would wrongly discard a real mount.
    expect(names(expressResolver.extractNodes!('src/r.ts', "router.use('/admin', sub);"))).toEqual(['USE /admin']);
  });

  it('keeps a non-slash path on a non-use verb (only use() is path-gated)', () => {
    // The slash guard is scoped to `method === 'use'`; a GET with a non-slash
    // path string is still a route. Kills the `method === 'use'` -> `true`
    // mutant that would extend the slash gate to every verb.
    expect(names(expressResolver.extractNodes!('src/r.ts', "app.get('health', h);"))).toEqual(['GET health']);
  });

  it('ignores receivers other than app/router', () => {
    // `foo.get(...)` and a bare HTTP call must not be attributed to express.
    expect(expressResolver.extractNodes!('src/r.ts', "foo.get('/x', h);")).toEqual([]);
    expect(expressResolver.extractNodes!('src/r.ts', "service.post('/y', h);")).toEqual([]);
  });

  it('ignores an unsupported verb on an express receiver (e.g. options)', () => {
    // The verb alternation lists get|post|put|patch|delete|all|use — `options`
    // is deliberately absent, so it must not produce a route.
    expect(expressResolver.extractNodes!('src/r.ts', "app.options('/o', h);")).toEqual([]);
  });

  it('requires the open paren to immediately follow the method (no space allowed)', () => {
    // Unlike some resolvers, the regex has `\(` directly after the verb, so
    // `app.get ('/x')` (space before paren) does not match.
    expect(expressResolver.extractNodes!('src/r.ts', "app.get ('/ws', h);")).toEqual([]);
  });

  it('matches the app/router token as a bare substring (no left identifier boundary)', () => {
    // The regex `(app|router)\.(...)` has no `\b`/lookbehind on the left, so a
    // receiver whose name merely ENDS in app/router still matches. This pins
    // the (current, lenient) behavior; a receiver containing neither token
    // does not match.
    expect(names(expressResolver.extractNodes!('src/r.ts', "myrouter.get('/x', h);"))).toEqual(['GET /x']);
    expect(names(expressResolver.extractNodes!('src/r.ts', "snapp.get('/z', h);"))).toEqual(['GET /z']);
    // `service` contains neither "app" nor "router" -> no match.
    expect(expressResolver.extractNodes!('src/r.ts', "service.post('/y', h);")).toEqual([]);
  });

  it('emits a fully-formed route node (id/kind/qualifiedName/lines/columns/language)', () => {
    const [n] = expressResolver.extractNodes!('src/routes.ts', "const app = express();\napp.get('/health', handler);");
    expect(n).toMatchObject({
      id: 'route:src/routes.ts:GET:/health:2',
      kind: 'route',
      name: 'GET /health',
      qualifiedName: 'src/routes.ts::GET:/health',
      filePath: 'src/routes.ts',
      startLine: 2,
      endLine: 2,
      startColumn: 0,
      // endColumn = match[0].length = length of "app.get('/health'" = 17
      endColumn: 17,
      language: 'typescript',
    });
  });

  it('places the route on the line where the call appears', () => {
    // makeLineIndex maps the match offset to a 1-based line.
    const nodes = expressResolver.extractNodes!('src/r.ts', ['', '', "app.get('/third', h);"].join('\n'));
    expect(nodes[0]!.startLine).toBe(3);
    expect(nodes[0]!.endLine).toBe(3);
    expect(nodes[0]!.id).toBe('route:src/r.ts:GET:/third:3');
  });

  it('tags node language from the file extension (.js -> javascript, .tsx -> typescript)', () => {
    expect(expressResolver.extractNodes!('src/r.js', "app.get('/j', h);")[0]?.language).toBe('javascript');
    expect(expressResolver.extractNodes!('src/r.jsx', "app.get('/jx', h);")[0]?.language).toBe('javascript');
    expect(expressResolver.extractNodes!('src/r.tsx', "app.get('/t', h);")[0]?.language).toBe('typescript');
  });

  it('strips line and block comments before matching (commented routes are not extracted)', () => {
    const nodes = expressResolver.extractNodes!(
      'src/r.ts',
      ["// app.get('/commented', h);", "/* app.post('/block', h); */", "app.get('/real', h);"].join('\n'),
    );
    expect(names(nodes)).toEqual(['GET /real']);
  });

  it('uses the shared getStripped buffer when provided, ignoring the raw content', () => {
    // The orchestrator passes a memoised comment-stripped buffer; when present
    // it must be the scanned source, not the raw `content` argument.
    const nodes = expressResolver.extractNodes!('src/r.ts', "app.get('/raw', h);", () => "app.post('/stripped', h);");
    expect(names(nodes)).toEqual(['POST /stripped']);
  });

  it('returns no nodes for empty content', () => {
    expect(expressResolver.extractNodes!('src/r.ts', '')).toEqual([]);
  });

  it('keeps same method+path routes on different lines as distinct nodes', () => {
    const nodes = expressResolver.extractNodes!('src/r.ts', ["app.get('/x', a);", "app.get('/x', b);"].join('\n'));
    expect(nodes.map((n) => n.id)).toEqual(['route:src/r.ts:GET:/x:1', 'route:src/r.ts:GET:/x:2']);
  });
});

describe('expressResolver.resolve middleware (Pattern 1)', () => {
  it('resolves a known middleware name to a same-named node at confidence 0.8', () => {
    const nodes = [node({ id: 'auth1', kind: 'function', name: 'authenticate', filePath: 'src/middleware/auth.ts' })];
    expect(expressResolver.resolve(ref('authenticate'), context({}, nodes))).toMatchObject({
      targetNodeId: 'auth1',
      confidence: 0.8,
      resolvedBy: 'framework',
    });
  });

  it('recognizes each middleware-name pattern variant', () => {
    // One representative per isMiddlewareName regex: exact (auth/cors/helmet/
    // logger/errorHandler/notFound/authenticate/authorization), prefix
    // (validate*/sanitize*/rateLimit*), and the *Middleware suffix.
    for (const name of [
      'auth',
      'authenticate',
      'authorization',
      'validateBody',
      'sanitizeInput',
      'rateLimit',
      'cors',
      'helmet',
      'logger',
      'errorHandler',
      'notFound',
      'requireMiddleware',
    ]) {
      const nodes = [node({ id: 'm', kind: 'function', name, filePath: 'a.ts' })];
      expect(expressResolver.resolve(ref(name), context({}, nodes))?.targetNodeId).toBe('m');
    }
  });

  it('does NOT treat a name that merely starts with a middleware word as middleware', () => {
    // `Authentic` does not match `^authenticate$`, `authx` does not match
    // `^auth$`, and `randomFn` matches no pattern — all fall through Pattern 1.
    for (const name of ['Authentic', 'authx', 'randomFn']) {
      const nodes = [node({ id: 'm', kind: 'function', name, filePath: 'a.ts' })];
      expect(expressResolver.resolve(ref(name), context({}, nodes))).toBeNull();
    }
  });

  it('strips the Middleware suffix when matching the node name', () => {
    // ref `authMiddleware` matches a node named `auth` via the
    // `name.replace(/Middleware$/i, '')` compare in resolveMiddleware.
    const nodes = [node({ id: 'b', kind: 'function', name: 'auth', filePath: 'a.ts' })];
    expect(expressResolver.resolve(ref('authMiddleware'), context({}, nodes))?.targetNodeId).toBe('b');
  });

  it('prefers a middleware-directory candidate when matching by the stripped base name', () => {
    // `rateMiddleware` -> base `rate`. Two `rate` nodes: only the one under
    // /middleware/ should win via the MIDDLEWARE_DIRS preference.
    const nodes = [
      node({ id: 'plain', kind: 'function', name: 'rate', filePath: 'src/utils/rate.ts' }),
      node({ id: 'inmw', kind: 'function', name: 'rate', filePath: 'src/middleware/rate.ts' }),
    ];
    expect(expressResolver.resolve(ref('rateMiddleware'), context({}, nodes))?.targetNodeId).toBe('inmw');
  });

  it('honors the /middlewares/ (plural) directory preference as well', () => {
    const nodes = [
      node({ id: 'plain', kind: 'function', name: 'rate', filePath: 'src/utils/rate.ts' }),
      node({ id: 'inmw', kind: 'function', name: 'rate', filePath: 'src/middlewares/rate.ts' }),
    ];
    expect(expressResolver.resolve(ref('rateMiddleware'), context({}, nodes))?.targetNodeId).toBe('inmw');
  });

  it('falls back to the first base-name candidate when none is in a middleware dir', () => {
    const nodes = [
      node({ id: 'first', kind: 'function', name: 'rate', filePath: 'src/a.ts' }),
      node({ id: 'second', kind: 'function', name: 'rate', filePath: 'src/b.ts' }),
    ];
    expect(expressResolver.resolve(ref('rateMiddleware'), context({}, nodes))?.targetNodeId).toBe('first');
  });

  it('returns null for a middleware-shaped ref with no matching node', () => {
    expect(expressResolver.resolve(ref('logger'), context({}, []))).toBeNull();
  });
});

describe('expressResolver.resolve controller methods (Pattern 2)', () => {
  it('resolves XController.method to a method node whose file path includes the controller name (confidence 0.85)', () => {
    const nodes = [node({ id: 'm', kind: 'method', name: 'getUser', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))).toMatchObject({
      targetNodeId: 'm',
      confidence: 0.85,
      resolvedBy: 'framework',
    });
  });

  it('matches a function-kind handler as well as a method-kind one', () => {
    const nodes = [node({ id: 'fn', kind: 'function', name: 'getUser', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('fn');
  });

  it('rejects a same-named non-method/function node (kind filter)', () => {
    // A variable named `getUser` in the controller file must not resolve.
    const nodes = [node({ id: 'v', kind: 'variable', name: 'getUser', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))).toBeNull();
  });

  it('requires the method file to include the controller name (path-includes filter)', () => {
    // method exists but in an unrelated file, and no controller class to fall
    // back to -> null.
    const nodes = [node({ id: 'm', kind: 'method', name: 'getUser', filePath: 'src/other/x.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))).toBeNull();
  });

  it('falls back to the controller class file when no path-matching method exists', () => {
    // No method whose file includes "user", but a UserController class exists;
    // the method is found inside the class file via getNodesInFile.
    const nodes = [
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/handlers/foo.ts' }),
      node({ id: 'm', kind: 'method', name: 'getUser', filePath: 'src/handlers/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('m');
  });

  it('prefers the direct path-match over the controller-class fallback', () => {
    const nodes = [
      node({ id: 'direct', kind: 'method', name: 'getUser', filePath: 'src/usercontroller/x.ts' }),
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/handlers/foo.ts' }),
      node({ id: 'infile', kind: 'function', name: 'getUser', filePath: 'src/handlers/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('direct');
  });

  it('returns null when the controller class is present but its file has no matching method', () => {
    const nodes = [node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/handlers/foo.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))).toBeNull();
  });

  it('does not match the controller pattern when there is no literal "Controller" before the dot', () => {
    // `Order.create` lacks the `Controller` token, so Pattern 2 never fires.
    const nodes = [node({ id: 'm', kind: 'method', name: 'create', filePath: 'src/order/x.ts' })];
    expect(expressResolver.resolve(ref('Order.create'), context({}, nodes))).toBeNull();
  });
});

describe('expressResolver.resolve service/helper methods (Pattern 3)', () => {
  it('resolves each Service/Helper/Util/Utils suffix to a method in the matching file at confidence 0.8', () => {
    for (const suffix of ['Service', 'Helper', 'Util', 'Utils']) {
      const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/mail/x.ts' })];
      const r = expressResolver.resolve(ref(`Mail${suffix}.send`), context({}, nodes));
      expect(r).toMatchObject({ targetNodeId: 's', confidence: 0.8, resolvedBy: 'framework' });
    }
  });

  it('matches the file by the name with the Service/Helper/Util(s) suffix stripped', () => {
    // `MailService.send` -> stripped `mail`; the node lives in src/mail/x.ts.
    const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('MailService.send'), context({}, nodes))?.targetNodeId).toBe('s');
  });

  it('rejects a same-named non-function/method node (kind filter)', () => {
    const nodes = [node({ id: 'v', kind: 'variable', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('MailService.send'), context({}, nodes))).toBeNull();
  });

  it('returns null when the matching method is in a file that does not include the service base name', () => {
    const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/other/x.ts' })];
    expect(expressResolver.resolve(ref('MailService.send'), context({}, nodes))).toBeNull();
  });

  it('does not match a bare X.method that lacks a Service/Helper/Util suffix', () => {
    const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('Mail.send'), context({}, nodes))).toBeNull();
  });
});

describe('expressResolver.resolve fall-through', () => {
  it('returns null for a reference matching no pattern', () => {
    expect(expressResolver.resolve(ref('totallyUnknownThing'), context({}, []))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anchor-precision tests for the middleware-name patterns. Each exact-match
// regex (`/^cors$/i` etc.) is bounded on BOTH ends; a name that adds a char
// before (drop-^) or after (drop-$) the word must NOT be treated as that
// middleware. A node with the off-pattern name is supplied so that, if the
// anchor were dropped, the resolver WOULD resolve it — the asserted null
// kills the loosened-anchor mutant.
// ---------------------------------------------------------------------------
describe('expressResolver middleware-name anchors', () => {
  const offPatternNames = [
    // exact-match words: a leading 'x' (drop-^) or trailing 'X' (drop-$)
    'xauth',
    'authX',
    'xauthenticate',
    'authenticateX',
    'xauthorization',
    'authorizationX',
    'xcors',
    'corsX',
    'xhelmet',
    'helmetX',
    'xlogger',
    'loggerX',
    'xerrorHandler',
    'errorHandlerX',
    'xnotFound',
    'notFoundX',
  ];

  it('does not treat a leading- or trailing-padded exact-word name as middleware', () => {
    for (const name of offPatternNames) {
      const nodes = [node({ id: 't', kind: 'function', name, filePath: 'src/middleware/x.ts' })];
      expect(expressResolver.resolve(ref(name), context({}, nodes))).toBeNull();
    }
  });

  it('keeps the prefix-pattern middlewares anchored at the start (drop-^ would over-match)', () => {
    // validate*/sanitize*/rateLimit* are `^`-anchored prefixes; a name that
    // merely CONTAINS the word mid-string (xvalidate) must not match.
    for (const name of ['xvalidate', 'xsanitize', 'xrateLimit']) {
      const nodes = [node({ id: 't', kind: 'function', name, filePath: 'src/middleware/x.ts' })];
      expect(expressResolver.resolve(ref(name), context({}, nodes))).toBeNull();
    }
  });

  it('keeps the *Middleware suffix anchored at the end (drop-$ would match mid-string)', () => {
    // `/Middleware$/i` must require the word at the END; `MiddlewareFoo`
    // (word at the start) is not a middleware name.
    const nodes = [node({ id: 'mf', kind: 'function', name: 'MiddlewareFoo', filePath: 'src/middleware/x.ts' })];
    expect(expressResolver.resolve(ref('MiddlewareFoo'), context({}, nodes))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Anchor-precision for the controller / service reference regexes. Both are
// `^...$`-anchored; a non-word char before the symbol (drop-^) or a trailing
// non-word char (drop-$) must defeat the match. The matching node is present
// so a loosened anchor would resolve it.
// ---------------------------------------------------------------------------
describe('expressResolver controller/service pattern anchors', () => {
  it('anchors the controller pattern at the start (a leading non-word char defeats it)', () => {
    const nodes = [node({ id: 'm', kind: 'method', name: 'get', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('.UserController.get'), context({}, nodes))).toBeNull();
  });

  it('anchors the controller pattern at the end (a trailing non-word char defeats it)', () => {
    const nodes = [node({ id: 'm', kind: 'method', name: 'get', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('UserController.get!'), context({}, nodes))).toBeNull();
  });

  it('anchors the service pattern at the start (a leading non-word char defeats it)', () => {
    const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('.MailService.send'), context({}, nodes))).toBeNull();
  });

  it('anchors the service pattern at the end (a trailing non-word char defeats it)', () => {
    const nodes = [node({ id: 's', kind: 'function', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('MailService.send!'), context({}, nodes))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Kind-literal precision: the controller-fallback and service finders accept
// exactly `method` OR `function`. Each literal and each side of the `||` must
// matter. Tests provide a single node of one kind so a dropped/empty literal
// or flipped operator changes the outcome.
// ---------------------------------------------------------------------------
describe('expressResolver kind-filter precision', () => {
  it('controller-fallback accepts a method-kind handler in the class file', () => {
    // Kills the `n.kind === 'method'` literal/branch in the fallback finder.
    const nodes = [
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/h/foo.ts' }),
      node({ id: 'm', kind: 'method', name: 'getUser', filePath: 'src/h/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('m');
  });

  it('controller-fallback accepts a function-kind handler in the class file', () => {
    // Kills the `n.kind === 'function'` literal/branch in the fallback finder.
    const nodes = [
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/h/foo.ts' }),
      node({ id: 'fn', kind: 'function', name: 'getUser', filePath: 'src/h/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('fn');
  });

  it('controller-fallback requires BOTH the right kind AND the right name (no kind-only or name-only match)', () => {
    // A variable named getUser (right name, wrong kind) and a method named
    // somethingElse (right kind, wrong name) — neither should resolve. Kills
    // the `&&`->`||` and the dropped-`name===method` mutants.
    const nodesWrongKind = [
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/h/foo.ts' }),
      node({ id: 'v', kind: 'variable', name: 'getUser', filePath: 'src/h/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodesWrongKind))).toBeNull();

    const nodesWrongName = [
      node({ id: 'cls', kind: 'class', name: 'UserController', filePath: 'src/h/foo.ts' }),
      node({ id: 'm', kind: 'method', name: 'wrongName', filePath: 'src/h/foo.ts' }),
    ];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodesWrongName))).toBeNull();
  });

  it('service finder accepts a method-kind handler in the matching file', () => {
    // Kills the `n.kind === 'method'` literal/branch in resolveServiceMethod.
    const nodes = [node({ id: 's', kind: 'method', name: 'send', filePath: 'src/mail/x.ts' })];
    expect(expressResolver.resolve(ref('MailService.send'), context({}, nodes))?.targetNodeId).toBe('s');
  });

  it('controller-direct accepts a method-kind handler whose file includes the controller name', () => {
    // Kills the `n.kind === 'method'` literal in resolveControllerMethod's
    // direct path (the methodNodes filter).
    const nodes = [node({ id: 'm', kind: 'method', name: 'getUser', filePath: 'src/UserController.ts' })];
    expect(expressResolver.resolve(ref('UserController.getUser'), context({}, nodes))?.targetNodeId).toBe('m');
  });
});

describe('expressResolver resolveMiddleware base-candidate guard', () => {
  it('returns null (never throws) for a *Middleware ref whose base name has no candidates', () => {
    // `fooMiddleware` -> base `foo` has zero candidates; the
    // `baseCandidates.length > 0` guard must hold or `baseCandidates[0]!.id`
    // would throw. Kills the `if (true)` and `length >= 0` mutants on line 181.
    expect(expressResolver.resolve(ref('fooMiddleware'), context({}, []))).toBeNull();
  });
});
