/**
 * goResolver.resolve proximity tiebreak — Agent A FP1.
 *
 * When N same-named structs exist across the project, the resolver's
 * preferred-dirs filter could leave many candidates, and the legacy
 * `pool[0]` pick was alphabetical name-index order. For ollama's 14
 * `Options` structs (one per `model/models/<pkg>/`), every model's
 * `*Options` embed resolved to `bert/embed.go:Options` (alphabetical
 * winner) — 13 of 14 edges wrong.
 *
 * After the fix, sortByProximityToRef picks same-file first, then
 * nearest by shared-segment count.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { goResolver, sharedDirSegments, sortByProximityToRef } from '../src/resolution/frameworks/go.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import type { Node } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';

beforeEach(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-go-resolver-prox-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

describe('goResolver proximity tiebreak (Agent A FP1)', () => {
  let dir: string;

  beforeEach(() => {
    dir = tempDir();
  });
  afterEach(() => cleanup(dir));

  it('resolves same-named structs to the same-file definition (not the alphabetical winner)', async () => {
    // Recreate the ollama shape: multiple `model/models/<pkg>/model.go`
    // files, each with its own `Options` struct. Embed `*Options` in
    // each Model. Without the proximity tiebreak, all extends edges
    // would resolve to alpha's Options (first alphabetical).
    fs.mkdirSync(path.join(dir, 'model', 'models', 'alpha'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'model', 'models', 'beta'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'model', 'models', 'gamma'), { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'alpha', 'model.go'),
      `package alpha

type Options struct {
    Size int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'beta', 'model.go'),
      `package beta

type Options struct {
    Width int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'model', 'models', 'gamma', 'model.go'),
      `package gamma

type Options struct {
    Height int
}

type Model struct {
    *Options
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // Each Model→Options extends edge should land on the same-file Options.
    const rows = cg.queries.db
      .prepare(
        `SELECT src.file_path AS srcFile, tgt.file_path AS tgtFile
         FROM edges e
         JOIN nodes src ON src.id = e.source
         JOIN nodes tgt ON tgt.id = e.target
         WHERE e.kind = 'extends' AND tgt.name = 'Options' AND src.name = 'Model'`,
      )
      .all() as Array<{ srcFile: string; tgtFile: string }>;

    cg.close();

    expect(rows.length).toBe(3);
    for (const r of rows) {
      expect(r.tgtFile).toBe(r.srcFile);
    }
  });

  it('falls back to nearest-by-shared-segments when no same-file candidate exists', async () => {
    // Cross-package reference: foo/widget.go references Helper which exists
    // in foo/utils.go and bar/utils.go. Same-file shares all dirs; bar
    // shares zero (different second segment). Without proximity, alpha
    // wins; with proximity, foo wins.
    fs.mkdirSync(path.join(dir, 'foo'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'bar'), { recursive: true });
    // `Helper` is named so PathMatch ends with 'Helper' (no special suffix)
    // but the PascalCase pattern still catches it via Pattern 4 (model).
    // For this test use a name that hits Pattern 1 (`Handler`-suffix).
    fs.writeFileSync(
      path.join(dir, 'foo', 'handler.go'),
      `package foo
func MyHandler() {}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'bar', 'handler.go'),
      `package bar
func MyHandler() {}
`,
    );
    fs.writeFileSync(
      path.join(dir, 'foo', 'caller.go'),
      `package foo
func Caller() {
    MyHandler()
}
`,
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fix2', version: '0.0.0' }));

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const rows = cg.queries.db
      .prepare(
        `SELECT src.file_path AS srcFile, tgt.file_path AS tgtFile
         FROM edges e
         JOIN nodes src ON src.id = e.source
         JOIN nodes tgt ON tgt.id = e.target
         WHERE e.kind = 'calls' AND tgt.name = 'MyHandler' AND src.name = 'Caller'`,
      )
      .all() as Array<{ srcFile: string; tgtFile: string }>;

    cg.close();

    expect(rows.length).toBe(1);
    // The caller is in foo/. The resolver should prefer foo/handler.go
    // (shared dir `foo`) over bar/handler.go (shares only the root).
    expect(rows[0]!.tgtFile).toBe('foo/handler.go');
  });
});

// ---------------------------------------------------------------------------
// Direct-API tests for goResolver.detect / extractNodes / resolve.
//
// The full-index tests above are the regression net for the proximity
// tiebreak, but they only exercise the `resolve` path indirectly (through
// `extends` / `calls` edges) and don't touch the route/CLI extractors or
// the pattern-specific confidence/kind/dir filters at all. These
// synchronous direct-call tests pin that surface precisely. They mirror
// the helper style in `extraction-resolution-accuracy.test.ts`.
// ---------------------------------------------------------------------------

function goNode(overrides: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>): Node {
  return {
    qualifiedName: `${overrides.filePath}::${overrides.name}`,
    language: 'go',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function goContext(args: {
  nodes?: Node[];
  files?: Record<string, string>;
  existing?: Set<string>;
}): ResolutionContext {
  const nodes = args.nodes ?? [];
  const files = args.files ?? {};
  const existing = args.existing ?? new Set<string>();
  return {
    getNodesInFile: (filePath) => nodes.filter((n) => n.filePath === filePath),
    getNodesByName: (name) => nodes.filter((n) => n.name === name),
    getNodesByQualifiedName: () => [],
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
    getNodesByLowerName: (name) => nodes.filter((n) => n.name.toLowerCase() === name),
    getImportMappings: () => [],
    fileExists: (filePath) => existing.has(filePath),
    readFile: (filePath) => files[filePath] ?? null,
    getProjectRoot: () => '/repo',
    getAllFiles: () => [...new Set([...Object.keys(files), ...nodes.map((n) => n.filePath), ...existing])],
  };
}

function goRef(name: string, filePath = 'svc/foo.go'): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName: name,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath,
    language: 'go',
  };
}

const routeNames = (nodes: Node[]): string[] => nodes.filter((n) => n.kind === 'route').map((n) => n.name);

describe('goResolver metadata', () => {
  it('declares go as its only target language', () => {
    // The orchestrator gates extractNodes on this set; an empty/wrong set
    // would silently disable the Go route/CLI extractors.
    expect(goResolver.languages).toEqual(['go']);
  });

  it('extracts no nodes from empty content', () => {
    expect(goResolver.extractNodes!('empty.go', '')).toEqual([]);
  });
});

describe('goResolver.detect', () => {
  it('detects a Go project from a go.mod file', () => {
    expect(goResolver.detect(goContext({ files: { 'go.mod': 'module example.com/x' } }))).toBe(true);
  });

  it('detects a Go project from a .go file when there is no go.mod', () => {
    expect(goResolver.detect(goContext({ existing: new Set(['cmd/main.go']) }))).toBe(true);
  });

  it('returns false when neither go.mod nor any .go file is present', () => {
    expect(goResolver.detect(goContext({ files: { 'README.md': '# x' }, existing: new Set(['README.md']) }))).toBe(
      false,
    );
  });

  it('detects a Go project when SOME (not all) files are .go', () => {
    // Mixed file set: `.some` must fire on the single .go file even though
    // README.md is not .go (distinguishes `.some` from `.every`).
    expect(goResolver.detect(goContext({ existing: new Set(['README.md', 'main.go']) }))).toBe(true);
  });
});

describe('goResolver.extractNodes routes', () => {
  it('extracts every Gin HTTP method with its path', () => {
    const content = [
      'r.GET("/get", h)',
      'r.POST("/post", h)',
      'r.PUT("/put", h)',
      'r.PATCH("/patch", h)',
      'r.DELETE("/delete", h)',
      'r.OPTIONS("/options", h)',
      'r.HEAD("/head", h)',
    ].join('\n');
    const names = routeNames(goResolver.extractNodes!('gin.go', content));
    expect(names).toContain('GET /get');
    expect(names).toContain('POST /post');
    expect(names).toContain('PUT /put');
    expect(names).toContain('PATCH /patch');
    expect(names).toContain('DELETE /delete');
    expect(names).toContain('OPTIONS /options');
    expect(names).toContain('HEAD /head');
  });

  it('captures the route path string, not just the method', () => {
    const names = routeNames(goResolver.extractNodes!('gin.go', 'r.GET("/api/users/:id", h)'));
    expect(names).toContain('GET /api/users/:id');
  });

  it('extracts Echo routes via the e. receiver', () => {
    const names = routeNames(goResolver.extractNodes!('echo.go', 'e.DELETE("/echo-del", h)'));
    expect(names).toContain('DELETE /echo-del');
  });

  it('normalizes Chi method casing (Get -> GET) and requires a slash-rooted path', () => {
    const names = routeNames(goResolver.extractNodes!('chi.go', 'r.Get("/chi", h)\nr.Post("/chi2", h)'));
    // Method is upper-cased by the Chi normalizeMethod.
    expect(names).toContain('GET /chi');
    expect(names).toContain('POST /chi2');
    expect(names).not.toContain('Get /chi');
  });

  it('does not emit a Chi route for a non-slash arg like r.Get("bash")', () => {
    expect(routeNames(goResolver.extractNodes!('reg.go', 'r.Get("bash")'))).toHaveLength(0);
  });

  it('does not treat Header.Get (suffix of a word) as a Chi route', () => {
    // The (?<!\w) boundary stops `Header.Get(...)` from firing.
    expect(routeNames(goResolver.extractNodes!('h.go', 'req.Header.Get("/X-Foo")'))).toHaveLength(0);
  });

  it('emits ANY when a net/http spec has no method prefix', () => {
    expect(routeNames(goResolver.extractNodes!('mux.go', 'http.HandleFunc("/legacy", h)'))).toContain('ANY /legacy');
  });

  it('splits the Go 1.22 METHOD-prefix net/http spec into method + path', () => {
    const names = routeNames(goResolver.extractNodes!('mux.go', 'mux.Handle("GET /api/users", h)'));
    expect(names).toContain('GET /api/users');
    expect(names).not.toContain('ANY GET /api/users');
  });

  it('requires a slash in the net/http spec (no route for mux.Handle("noslash"))', () => {
    expect(routeNames(goResolver.extractNodes!('mux.go', 'mux.Handle("noslash", h)'))).toHaveLength(0);
  });

  it('trims the net/http spec so a leading space still parses the method prefix', () => {
    // Without the .trim(), the leading space defeats the `^([A-Z]+)`
    // method-prefix match and the route would fall back to ANY.
    expect(routeNames(goResolver.extractNodes!('mux.go', 'mux.Handle(" GET /x", h)'))).toEqual(['GET /x']);
  });

  it('requires one-or-more spaces between method and path (handles double space)', () => {
    // `\s+` (not `\s`) lets "GET  /x" (two spaces) still split into GET + /x.
    expect(routeNames(goResolver.extractNodes!('mux.go', 'mux.Handle("GET  /x", h)'))).toEqual(['GET /x']);
  });

  it('builds the route node with a route: id, qualified name, and go language', () => {
    const node = goResolver.extractNodes!('routes.go', 'r.GET("/x", h)').find((n) => n.kind === 'route');
    expect(node?.id).toBe('route:routes.go:GET:/x:1');
    expect(node?.qualifiedName).toBe('routes.go::GET:/x');
    expect(node?.language).toBe('go');
  });

  it('strips Go line comments before matching (a commented route is not extracted)', () => {
    // The `'go'` language arg drives comment stripping; a wrong/empty arg
    // would leave the `//`-commented route in place and falsely extract it.
    const content = ['// r.GET("/commented", h)', 'func f() {}'].join('\n');
    expect(routeNames(goResolver.extractNodes!('x.go', content))).toHaveLength(0);
  });
});

describe('goResolver.extractNodes cobra commands', () => {
  it('extracts the verb from a &cobra.Command{ Use: "verb ARG" } literal', () => {
    const nodes = goResolver.extractNodes!('cmd.go', '&cobra.Command{\n    Use: "create MODEL",\n}');
    const cli = nodes.filter((n) => n.kind === 'route' && n.name.startsWith('cmd '));
    expect(cli.map((n) => n.name)).toEqual(['cmd create']);
    // Signature carries the full Use string.
    expect(cli[0]!.signature).toBe('create MODEL');
  });

  it('extracts the value-form cobra.Command{ Use: "serve" } too', () => {
    const nodes = goResolver.extractNodes!('cmd.go', 'cobra.Command{\n    Use: "serve",\n}');
    expect(nodes.filter((n) => n.kind === 'route').map((n) => n.name)).toEqual(['cmd serve']);
  });

  it('skips malformed Use strings starting with a flag dash', () => {
    expect(routeNames(goResolver.extractNodes!('cmd.go', 'cobra.Command{ Use: "-flag" }'))).toHaveLength(0);
  });

  it('skips Use strings that start with a slash', () => {
    expect(routeNames(goResolver.extractNodes!('cmd.go', 'cobra.Command{ Use: "/path" }'))).toHaveLength(0);
  });

  it('skips Use strings whose verb contains a dot', () => {
    expect(routeNames(goResolver.extractNodes!('cmd.go', 'cobra.Command{ Use: "pkg.sub" }'))).toHaveLength(0);
  });

  it('trims the Use string before extracting the verb', () => {
    // Without .trim(), a leading space makes split(/\s+/)[0] === '' (an
    // empty leading token) and the command would be dropped as verb-less.
    expect(routeNames(goResolver.extractNodes!('cmd.go', 'cobra.Command{ Use: " create" }'))).toEqual(['cmd create']);
  });

  it('drops a Use string that is only whitespace (empty verb guard)', () => {
    // The `if (!verb) continue` guard must skip a verb that trims to ''.
    expect(routeNames(goResolver.extractNodes!('cmd.go', 'cobra.Command{ Use: " " }'))).toHaveLength(0);
  });

  it('dedups two identical-verb commands declared on the same line', () => {
    // Same file + same verb + same line => same id; the cobraSeen guard
    // collapses them into a single cmd route.
    const content = 'cobra.Command{Use:"serve"}; cobra.Command{Use:"serve"}';
    expect(routeNames(goResolver.extractNodes!('cmd.go', content))).toEqual(['cmd serve']);
  });

  it('builds the cli node with a cli: id, cmd qualified name, and go language', () => {
    const node = goResolver.extractNodes!('cmd.go', 'cobra.Command{Use:"serve"}').find((n) => n.kind === 'route');
    expect(node?.id).toBe('cli:cmd.go:serve:1');
    expect(node?.qualifiedName).toBe('cmd.go::cmd:serve');
    expect(node?.language).toBe('go');
  });
});

describe('goResolver.resolve patterns', () => {
  it('resolves a *Handler-suffixed function via the handler dirs at confidence 0.8', () => {
    const nodes = [goNode({ id: 'h1', kind: 'function', name: 'UserHandler', filePath: 'handler/user.go' })];
    expect(goResolver.resolve(goRef('UserHandler'), goContext({ nodes }))).toMatchObject({
      targetNodeId: 'h1',
      confidence: 0.8,
      resolvedBy: 'framework',
    });
  });

  it('resolves a Handle-prefixed function via Pattern 1', () => {
    const nodes = [goNode({ id: 'h2', kind: 'function', name: 'HandleLogin', filePath: 'handler/login.go' })];
    expect(goResolver.resolve(goRef('HandleLogin'), goContext({ nodes }))?.targetNodeId).toBe('h2');
  });

  it('returns null for a *Handler ref when no matching function node exists (no false positive)', () => {
    // Pattern 1 must NOT return a result object wrapping a null target
    // when resolveByNameAndKind found nothing.
    expect(goResolver.resolve(goRef('GhostHandler'), goContext({ nodes: [] }))).toBeNull();
  });

  it('resolves a *Repository struct via Pattern 2 (Repository suffix)', () => {
    const nodes = [goNode({ id: 'r1', kind: 'struct', name: 'UserRepository', filePath: 'repository/user.go' })];
    expect(goResolver.resolve(goRef('UserRepository'), goContext({ nodes }))).toMatchObject({
      targetNodeId: 'r1',
      confidence: 0.8,
    });
  });

  it('resolves a *Service struct via Pattern 2 at confidence 0.8', () => {
    const nodes = [goNode({ id: 's1', kind: 'struct', name: 'UserService', filePath: 'service/user.go' })];
    expect(goResolver.resolve(goRef('UserService'), goContext({ nodes }))).toMatchObject({
      targetNodeId: 's1',
      confidence: 0.8,
      resolvedBy: 'framework',
    });
  });

  it('Pattern 1 keeps only function candidates (a same-named struct is filtered out)', () => {
    // The struct is listed first and shares the same dir; only the
    // `kind: 'function'` filter promotes the function. Distinguishes a
    // mutated empty kind (which would disable the kind filter).
    const nodes = [
      goNode({ id: 'st', kind: 'struct', name: 'XHandler', filePath: 'src/handler/x.go' }),
      goNode({ id: 'fn', kind: 'function', name: 'XHandler', filePath: 'src/handler/y.go' }),
    ];
    expect(goResolver.resolve(goRef('XHandler'), goContext({ nodes }))?.targetNodeId).toBe('fn');
  });

  it('resolves a *Store interface via Pattern 2 (interface is an accepted kind)', () => {
    const nodes = [goNode({ id: 's2', kind: 'interface', name: 'DataStore', filePath: 'store/data.go' })];
    expect(goResolver.resolve(goRef('DataStore'), goContext({ nodes }))?.targetNodeId).toBe('s2');
  });

  it('does NOT resolve a *Service candidate that is a plain function (kind filter)', () => {
    const nodes = [goNode({ id: 'fn', kind: 'function', name: 'MyService', filePath: 'service/my.go' })];
    expect(goResolver.resolve(goRef('MyService'), goContext({ nodes }))).toBeNull();
  });

  it('resolves a *Middleware function via Pattern 3 at confidence 0.75', () => {
    const nodes = [goNode({ id: 'm1', kind: 'function', name: 'CorsMiddleware', filePath: 'middleware/cors.go' })];
    expect(goResolver.resolve(goRef('CorsMiddleware'), goContext({ nodes }))).toMatchObject({
      targetNodeId: 'm1',
      confidence: 0.75,
      resolvedBy: 'framework',
    });
  });

  it('resolves an Auth-prefixed middleware function via Pattern 3', () => {
    const nodes = [goNode({ id: 'm2', kind: 'function', name: 'AuthCheck', filePath: 'middleware/auth.go' })];
    expect(goResolver.resolve(goRef('AuthCheck'), goContext({ nodes }))?.confidence).toBe(0.75);
  });

  it('resolves a Log-prefixed middleware function via Pattern 3 (startsWith Log, not endsWith)', () => {
    // `LogRequest` starts with "Log" and does NOT end with "Middleware" —
    // distinguishes startsWith('Log') from a mutated endsWith('Log').
    const nodes = [goNode({ id: 'm3', kind: 'function', name: 'LogRequest', filePath: 'middleware/log.go' })];
    expect(goResolver.resolve(goRef('LogRequest'), goContext({ nodes }))?.confidence).toBe(0.75);
  });

  it('Pattern 3 keeps only function candidates (a same-named struct is filtered out)', () => {
    const nodes = [
      goNode({ id: 'st3', kind: 'struct', name: 'CorsMiddleware', filePath: 'src/middleware/x.go' }),
      goNode({ id: 'fn3', kind: 'function', name: 'CorsMiddleware', filePath: 'src/middleware/y.go' }),
    ];
    expect(goResolver.resolve(goRef('CorsMiddleware'), goContext({ nodes }))?.targetNodeId).toBe('fn3');
  });

  it('returns null for a middleware-shaped ref when no matching function exists', () => {
    // Pattern 3 must not wrap a null target. `LogRequest` reaches Pattern 3
    // (Log prefix) and Pattern 4 (PascalCase) but matches nothing -> null.
    expect(goResolver.resolve(goRef('LogRequest'), goContext({ nodes: [] }))).toBeNull();
  });

  it('resolves a PascalCase struct via the Model pattern at confidence 0.7', () => {
    const nodes = [goNode({ id: 'mo1', kind: 'struct', name: 'Account', filePath: 'model/account.go' })];
    expect(goResolver.resolve(goRef('Account'), goContext({ nodes }))).toMatchObject({
      targetNodeId: 'mo1',
      confidence: 0.7,
      resolvedBy: 'framework',
    });
  });

  it('does NOT apply the Model pattern to a snake_case name (regex requires PascalCase)', () => {
    // `if (true)` mutant of the `/^[A-Z][a-zA-Z]+$/` guard would wrongly fire.
    const nodes = [goNode({ id: 'sb', kind: 'struct', name: 'foo_bar', filePath: 'model/x.go' })];
    expect(goResolver.resolve(goRef('foo_bar'), goContext({ nodes }))).toBeNull();
  });

  it('does NOT apply the Model pattern to a lowercase-leading name (^ anchor)', () => {
    // Dropping the leading `^` would let `myAccount` match on `Account`.
    const nodes = [goNode({ id: 'ma', kind: 'struct', name: 'myAccount', filePath: 'model/x.go' })];
    expect(goResolver.resolve(goRef('myAccount'), goContext({ nodes }))).toBeNull();
  });

  it('does NOT apply the Model pattern to a name with a trailing digit ($ anchor)', () => {
    // Dropping the trailing `$` would let `Account9` match the `Account` prefix.
    const nodes = [goNode({ id: 'a9', kind: 'struct', name: 'Account9', filePath: 'model/x.go' })];
    expect(goResolver.resolve(goRef('Account9'), goContext({ nodes }))).toBeNull();
  });

  it('returns null when nothing in the graph matches the reference name', () => {
    expect(goResolver.resolve(goRef('totally_unknown'), goContext({ nodes: [] }))).toBeNull();
  });

  it('prefers a preferred-dir candidate over an off-convention one', () => {
    // The off-convention candidate is listed FIRST and shares the same
    // (zero) directory proximity with the ref, so the preferred-dir filter
    // is the ONLY thing that can promote `good`. A stable sort would keep
    // `bad` first if the filter were skipped. Paths are nested so the
    // `/handler/` substring (with leading + trailing slash) is recognized.
    const nodes = [
      goNode({ id: 'bad', kind: 'function', name: 'PingHandler', filePath: 'src/random/ping.go' }),
      goNode({ id: 'good', kind: 'function', name: 'PingHandler', filePath: 'src/handler/ping.go' }),
    ];
    expect(goResolver.resolve(goRef('PingHandler'), goContext({ nodes }))?.targetNodeId).toBe('good');
  });

  it('breaks ties by directory proximity when several preferred-dir candidates exist', () => {
    const nodes = [
      goNode({ id: 'near', kind: 'struct', name: 'Config', filePath: 'pkg/server/config.go' }),
      goNode({ id: 'far', kind: 'struct', name: 'Config', filePath: 'pkg/cli/config.go' }),
    ];
    // Ref lives in pkg/server/ — shares two leading segments with `near`,
    // one with `far`. Proximity must pick `near` regardless of alpha order
    // (`cli` < `server`, so without proximity `far` would win).
    expect(goResolver.resolve(goRef('Config', 'pkg/server/main.go'), goContext({ nodes }))?.targetNodeId).toBe('near');
  });

  // One representative entry per preferred-dir array, each with a competing
  // off-convention candidate listed first (equal zero proximity to the ref)
  // so the preferred-dir filter is the only discriminator. These prove each
  // *_DIRS array is actually consulted by the resolver.
  it('honors a handler-convention dir (api) for Pattern 1', () => {
    const nodes = [
      goNode({ id: 'bad', kind: 'function', name: 'PingHandler', filePath: 'src/zzz/a.go' }),
      goNode({ id: 'good', kind: 'function', name: 'PingHandler', filePath: 'src/api/a.go' }),
    ];
    expect(goResolver.resolve(goRef('PingHandler'), goContext({ nodes }))?.targetNodeId).toBe('good');
  });

  it('honors a service-convention dir (services) for Pattern 2', () => {
    const nodes = [
      goNode({ id: 'bad', kind: 'struct', name: 'PayService', filePath: 'src/zzz/a.go' }),
      goNode({ id: 'good', kind: 'struct', name: 'PayService', filePath: 'src/services/a.go' }),
    ];
    expect(goResolver.resolve(goRef('PayService'), goContext({ nodes }))?.targetNodeId).toBe('good');
  });

  it('honors a middleware-convention dir (middlewares) for Pattern 3', () => {
    const nodes = [
      goNode({ id: 'bad', kind: 'function', name: 'RateMiddleware', filePath: 'src/zzz/a.go' }),
      goNode({ id: 'good', kind: 'function', name: 'RateMiddleware', filePath: 'src/middlewares/a.go' }),
    ];
    expect(goResolver.resolve(goRef('RateMiddleware'), goContext({ nodes }))?.targetNodeId).toBe('good');
  });

  it('honors a model-convention dir (entity) for Pattern 4', () => {
    const nodes = [
      goNode({ id: 'bad', kind: 'struct', name: 'Invoice', filePath: 'src/zzz/a.go' }),
      goNode({ id: 'good', kind: 'struct', name: 'Invoice', filePath: 'src/entity/a.go' }),
    ];
    expect(goResolver.resolve(goRef('Invoice'), goContext({ nodes }))?.targetNodeId).toBe('good');
  });
});

describe('sharedDirSegments', () => {
  it('counts leading directory segments shared by two paths (ignoring the filename)', () => {
    expect(sharedDirSegments('a/b/c.go', 'a/b/d.go')).toBe(2);
  });

  it('stops at the first differing segment', () => {
    expect(sharedDirSegments('a/b/c.go', 'a/x/d.go')).toBe(1);
  });

  it('returns 0 when no leading segment matches', () => {
    expect(sharedDirSegments('a/b/c.go', 'z/y/d.go')).toBe(0);
  });

  it('returns 0 for two root-level files (no directory segments)', () => {
    // `slice(0, -1)` drops the filename, leaving empty dir lists -> 0.
    // Catches the `slice(0, -1)` -> `slice(0, +1)` and dropped-slice mutants.
    expect(sharedDirSegments('c.go', 'd.go')).toBe(0);
  });

  it('ignores the filename even when both paths are identical (slice drops the basename)', () => {
    // Without `.slice(0, -1)` the identical basename `c.go` would be counted
    // as a third shared segment (3 instead of 2).
    expect(sharedDirSegments('a/b/c.go', 'a/b/c.go')).toBe(2);
  });
});

describe('sortByProximityToRef', () => {
  const node = (id: string, filePath: string): Node => goNode({ id, kind: 'struct', name: 'X', filePath });

  it('puts the exact same-file candidate first, ahead of a same-directory sibling', () => {
    // Both share the same directory (equal shared-segment count); only the
    // same-file check distinguishes them. Sibling listed first so a broken
    // same-file branch would leave it on top.
    const arr = [node('sib', 'a/b/sibling.go'), node('self', 'a/b/target.go')];
    expect(sortByProximityToRef(arr, 'a/b/target.go').map((n) => n.id)).toEqual(['self', 'sib']);
  });

  it('orders by descending shared-segment count when no same-file candidate exists', () => {
    // `far` listed first; proximity must promote `near` (more shared dirs).
    const arr = [node('far', 'z/y/x.go'), node('near', 'a/b/n.go')];
    expect(sortByProximityToRef(arr, 'a/b/target.go').map((n) => n.id)).toEqual(['near', 'far']);
  });

  it('mutates and returns the same array reference', () => {
    const arr = [node('one', 'a/x.go')];
    expect(sortByProximityToRef(arr, 'a/target.go')).toBe(arr);
  });
});
