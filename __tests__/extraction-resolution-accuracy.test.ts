/**
 * Extraction & Resolution Accuracy Tests
 *
 * Regression tests for three accuracy bugs fixed in one PR:
 *   1. Parse-retry comment strip was hardcoded to `//`, no-op on Python/Ruby/etc.
 *   2. Framework route extractors ran regex over raw file content, matching
 *      examples in docstrings/comments as real routes.
 *   3. UTF-8 BOM caused spurious "modified" hash mismatches between editors.
 */

import { describe, it, expect } from 'vitest';
import { stripBom, stripCommentLinesForRetry, stripCommentsForRegex } from '../src/utils.js';
import { hashContent } from '../src/extraction/index.js';
import { flaskResolver, fastapiResolver, djangoResolver } from '../src/resolution/frameworks/python.js';
import { expressResolver } from '../src/resolution/frameworks/express.js';
import { aspnetResolver } from '../src/resolution/frameworks/csharp.js';
import { rustResolver } from '../src/resolution/frameworks/rust.js';
import { laravelResolver } from '../src/resolution/frameworks/laravel.js';
import { goResolver } from '../src/resolution/frameworks/go.js';
import { reactResolver } from '../src/resolution/frameworks/react.js';
import type { Node } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

function frameworkNode(overrides: Partial<Node> & Pick<Node, 'id' | 'kind' | 'name' | 'filePath'>): Node {
  return {
    qualifiedName: `${overrides.filePath}::${overrides.name}`,
    language: 'python',
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
    ...overrides,
  };
}

function frameworkContext(args: {
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

function frameworkRef(name: string, language: UnresolvedRef['language'] = 'python'): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName: name,
    referenceKind: 'references',
    line: 1,
    column: 0,
    filePath: language === 'rust' ? 'src/main.rs' : 'app.py',
    language,
  };
}

describe('UTF-8 BOM normalization (bug #5)', () => {
  it('stripBom removes leading U+FEFF', () => {
    expect(stripBom('﻿hello')).toBe('hello');
    expect(stripBom('hello')).toBe('hello');
    expect(stripBom('')).toBe('');
  });

  it('stripBom only removes leading BOM, not embedded ones', () => {
    expect(stripBom('a﻿b')).toBe('a﻿b');
  });

  it('hashContent treats BOM and no-BOM as identical', () => {
    const withBom = '﻿export function hello() { return 42; }';
    const withoutBom = 'export function hello() { return 42; }';
    expect(hashContent(withBom)).toBe(hashContent(withoutBom));
  });
});

describe('Per-language comment-line stripping (bug #1)', () => {
  it('strips `#` lines for Python', () => {
    const input = ['# CHECK: foo', 'def x():', '    pass'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n')).toEqual(['', 'def x():', '    pass']);
  });

  it('strips `#` lines for Ruby', () => {
    const input = ['# top comment', 'def x; end'].join('\n');
    const out = stripCommentLinesForRetry(input, 'ruby');
    expect(out.split('\n')).toEqual(['', 'def x; end']);
  });

  it('strips `//` lines for TypeScript', () => {
    const input = ['// header', 'function x() {}'].join('\n');
    const out = stripCommentLinesForRetry(input, 'typescript');
    expect(out.split('\n')).toEqual(['', 'function x() {}']);
  });

  it('strips both `//` and `#` lines for PHP', () => {
    const input = ['// js-style', '# perl-style', '<?php $x = 1;'].join('\n');
    const out = stripCommentLinesForRetry(input, 'php');
    expect(out.split('\n')).toEqual(['', '', '<?php $x = 1;']);
  });

  it('returns content unchanged for unknown languages', () => {
    const input = '// looks like a comment\ncode';
    expect(stripCommentLinesForRetry(input, 'unknown-lang')).toBe(input);
  });

  it('preserves line count so node positions stay correct', () => {
    const input = ['# c1', 'a', '# c2', 'b'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n').length).toBe(input.split('\n').length);
  });

  it('does NOT strip indented `#` inside Python (still recognized as line comment)', () => {
    // The marker matches optional leading whitespace + `#`, so an indented
    // pure comment line is correctly stripped. Non-comment code on the same
    // line as `#` (mid-line comment) is intentionally not stripped here.
    const input = ['    # indented comment', '    pass  # trailing'].join('\n');
    const out = stripCommentLinesForRetry(input, 'python');
    expect(out.split('\n')).toEqual(['', '    pass  # trailing']);
  });
});

describe('Framework regex no longer matches docstrings/comments (bug #4)', () => {
  describe('Flask', () => {
    it('skips routes inside `#` comments', () => {
      const content = [
        'from flask import Flask',
        'app = Flask(__name__)',
        '# Example: @app.route("/fake")',
        '@app.route("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = flaskResolver.extractNodes!('app.py', content);
      const paths = nodes.map((n) => n.name);
      expect(paths).toContain('/real');
      expect(paths).not.toContain('/fake');
    });

    it('skips routes inside triple-quoted docstrings', () => {
      const content = [
        'def example():',
        '    """',
        '    Usage: @app.route("/fake")',
        '    """',
        '    pass',
        '@app.route("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = flaskResolver.extractNodes!('app.py', content);
      const paths = nodes.map((n) => n.name);
      expect(paths).toContain('/real');
      expect(paths).not.toContain('/fake');
    });
  });

  describe('FastAPI', () => {
    it('skips routes inside `#` comments and triple-quoted docstrings', () => {
      const content = [
        '"""',
        'Module docs — example: @app.get("/docfake")',
        '"""',
        '# @app.post("/commentfake")',
        '@app.get("/real")',
        'def real(): pass',
      ].join('\n');
      const nodes = fastapiResolver.extractNodes!('app.py', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
      expect(names.some((n) => n.includes('/commentfake'))).toBe(false);
    });

    it('preserves correct line numbers for real routes after stripping', () => {
      const content = [
        '"""', // line 1
        '@app.get("/fake")', // line 2 — inside docstring
        '"""', // line 3
        '', // line 4
        '@app.get("/real")', // line 5 — real
      ].join('\n');
      const nodes = fastapiResolver.extractNodes!('app.py', content);
      const real = nodes.find((n) => n.name.includes('/real'));
      expect(real).toBeDefined();
      expect(real!.startLine).toBe(5);
    });
  });

  describe('Django URL patterns', () => {
    it('skips path() inside `#` comments', () => {
      const content = [
        'from django.urls import path',
        '# example: path("fake/", fake_view)',
        'urlpatterns = [path("real/", real_view)]',
      ].join('\n');
      const nodes = djangoResolver.extractNodes!('urls.py', content);
      const names = nodes.map((n) => n.name);
      expect(names).toContain('real/');
      expect(names).not.toContain('fake/');
    });
  });

  describe('Express', () => {
    it('skips routes inside `//` comments', () => {
      const content = [
        'const app = express();',
        '// app.get("/fake", fakeHandler);',
        'app.get("/real", realHandler);',
      ].join('\n');
      const nodes = expressResolver.extractNodes!('server.js', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/fake'))).toBe(false);
    });

    it('skips routes inside `/* ... */` block comments', () => {
      const content = ['/*', ' * app.post("/blockfake", h);', ' */', 'app.get("/real", h);'].join('\n');
      const nodes = expressResolver.extractNodes!('server.js', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/blockfake'))).toBe(false);
    });
  });

  describe('Laravel', () => {
    it('skips routes inside PHP `//` and `#` comments', () => {
      const content = [
        '<?php',
        '// Route::get("/jsfake", $h);',
        '# Route::get("/perlfake", $h);',
        'Route::get("/real", $h);',
      ].join('\n');
      const nodes = laravelResolver.extractNodes!('routes.php', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/jsfake'))).toBe(false);
      expect(names.some((n) => n.includes('/perlfake'))).toBe(false);
    });
  });

  describe('Rust', () => {
    it('skips actix/rocket routes inside `///` doc comments', () => {
      const content = ['/// Example route: #[get("/docfake")]', '#[get("/real")]', 'fn real() {}'].join('\n');
      const nodes = rustResolver.extractNodes!('main.rs', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
    });

    it('extracts actix/rocket routes without duplicating shared #[get] attributes and extracts axum routes', () => {
      const content = [
        '#[get("/users")]',
        'async fn users() {}',
        '#[options("/health")]',
        'async fn health() {}',
        'Router::new().route("/items", post(create_item))',
      ].join('\n');
      const nodes = rustResolver.extractNodes!('src/main.rs', content);
      expect(nodes.map((n) => n.name).sort(byString)).toEqual(['GET /users', 'OPTIONS /health', 'POST /items']);
      expect(nodes.filter((n) => n.name === 'GET /users')).toHaveLength(1);
    });
  });

  describe('ASP.NET (C#)', () => {
    it('skips route attributes inside `///` XML doc comments', () => {
      const content = [
        '/// <summary>',
        '/// Example: [HttpGet("/docfake")]',
        '/// </summary>',
        '[HttpGet("/real")]',
        'public class C {}',
      ].join('\n');
      const nodes = aspnetResolver.extractNodes!('Controller.cs', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/docfake'))).toBe(false);
    });

    it('skips minimal-API MapGet/MapPost calls inside comments', () => {
      // Regression: the minimalApiPattern loop below the routePatterns
      // loop was initially missed when applying the strip helper, leaving
      // commented-out `app.MapGet("/x")` calls extracted as real routes.
      const content = [
        '// app.MapGet("/linefake", h);',
        '/*',
        ' * app.MapPost("/blockfake", h);',
        ' */',
        'app.MapGet("/real", h);',
      ].join('\n');
      const nodes = aspnetResolver.extractNodes!('Program.cs', content);
      const names = nodes.map((n) => n.name);
      expect(names.some((n) => n.includes('/real'))).toBe(true);
      expect(names.some((n) => n.includes('/linefake'))).toBe(false);
      expect(names.some((n) => n.includes('/blockfake'))).toBe(false);
    });
  });
});

describe('Framework resolver detection and convention-based resolution', () => {
  it('detects Django, Flask, FastAPI, and Rust project signatures', () => {
    expect(djangoResolver.detect(frameworkContext({ files: { 'requirements.txt': 'django==5.0' } }))).toBe(true);
    expect(djangoResolver.detect(frameworkContext({ existing: new Set(['manage.py']) }))).toBe(true);
    expect(flaskResolver.detect(frameworkContext({ files: { 'app.py': 'app = Flask(__name__)' } }))).toBe(true);
    expect(fastapiResolver.detect(frameworkContext({ files: { 'main.py': 'app = FastAPI()' } }))).toBe(true);
    expect(rustResolver.detect(frameworkContext({ existing: new Set(['Cargo.toml']) }))).toBe(true);
  });

  it('resolves Django models, views, and forms from conventional directories', () => {
    const userModel = frameworkNode({
      id: 'class:app/models.py:User',
      kind: 'class',
      name: 'User',
      filePath: 'app/models.py',
    });
    const userView = frameworkNode({
      id: 'class:app/views.py:UserViewSet',
      kind: 'class',
      name: 'UserViewSet',
      filePath: 'app/views.py',
    });
    const userForm = frameworkNode({
      id: 'class:app/forms.py:UserForm',
      kind: 'class',
      name: 'UserForm',
      filePath: 'app/forms.py',
    });
    const ctx = frameworkContext({ nodes: [userModel, userView, userForm] });

    expect(djangoResolver.resolve(frameworkRef('User'), ctx)).toMatchObject({ targetNodeId: userModel.id });
    expect(djangoResolver.resolve(frameworkRef('UserViewSet'), ctx)).toMatchObject({ targetNodeId: userView.id });
    expect(djangoResolver.resolve(frameworkRef('UserForm'), ctx)).toMatchObject({ targetNodeId: userForm.id });
    expect(djangoResolver.resolve(frameworkRef('unknown_name'), ctx)).toBeNull();
  });

  it('resolves Flask blueprints and FastAPI routers/dependencies by framework naming conventions', () => {
    const blueprint = frameworkNode({
      id: 'var:api/users.py:users_bp',
      kind: 'variable',
      name: 'users_bp',
      filePath: 'api/users.py',
    });
    const router = frameworkNode({
      id: 'var:api/routes/users.py:users_router',
      kind: 'variable',
      name: 'users_router',
      filePath: 'api/routes/users.py',
    });
    const dependency = frameworkNode({
      id: 'func:api/deps/auth.py:get_current_user',
      kind: 'function',
      name: 'get_current_user',
      filePath: 'api/dependencies/auth.py',
    });
    const ctx = frameworkContext({ nodes: [blueprint, router, dependency] });

    expect(flaskResolver.resolve(frameworkRef('users_bp'), ctx)).toMatchObject({ targetNodeId: blueprint.id });
    expect(fastapiResolver.resolve(frameworkRef('users_router'), ctx)).toMatchObject({ targetNodeId: router.id });
    expect(fastapiResolver.resolve(frameworkRef('get_current_user'), ctx)).toMatchObject({
      targetNodeId: dependency.id,
      confidence: 0.75,
    });
  });

  it('resolves Rust handlers, services, structs, and module references', () => {
    const handler = frameworkNode({
      id: 'func:src/handlers/users.rs:list_handler',
      kind: 'function',
      name: 'list_handler',
      filePath: 'src/handlers/users.rs',
      language: 'rust',
    });
    const service = frameworkNode({
      id: 'struct:src/services/user.rs:UserService',
      kind: 'struct',
      name: 'UserService',
      filePath: 'src/services/user.rs',
      language: 'rust',
    });
    const model = frameworkNode({
      id: 'struct:src/models/user.rs:User',
      kind: 'struct',
      name: 'User',
      filePath: 'src/models/user.rs',
      language: 'rust',
    });
    const module = frameworkNode({
      id: 'module:src/auth/mod.rs:auth',
      kind: 'module',
      name: 'auth',
      filePath: 'src/auth/mod.rs',
      language: 'rust',
    });
    const ctx = frameworkContext({
      nodes: [handler, service, model, module],
      existing: new Set(['src/auth/mod.rs']),
    });

    expect(rustResolver.resolve(frameworkRef('list_handler', 'rust'), ctx)).toMatchObject({
      targetNodeId: handler.id,
      confidence: 0.8,
    });
    expect(rustResolver.resolve(frameworkRef('UserService', 'rust'), ctx)).toMatchObject({ targetNodeId: service.id });
    expect(rustResolver.resolve(frameworkRef('User', 'rust'), ctx)).toMatchObject({
      targetNodeId: model.id,
      confidence: 0.7,
    });
    expect(rustResolver.resolve(frameworkRef('auth', 'rust'), ctx)).toMatchObject({
      targetNodeId: module.id,
      confidence: 0.6,
    });
    expect(rustResolver.resolve(frameworkRef('missing_module', 'rust'), ctx)).toBeNull();
  });

  it('detects React from package metadata or JSX/TSX files and ignores invalid package JSON', () => {
    expect(
      reactResolver.detect(
        frameworkContext({ files: { 'package.json': JSON.stringify({ dependencies: { react: '^19.0.0' } }) } }),
      ),
    ).toBe(true);
    expect(reactResolver.detect(frameworkContext({ files: { 'package.json': '{not-json' } }))).toBe(false);
    expect(reactResolver.detect(frameworkContext({ files: { 'src/App.tsx': '' } }))).toBe(true);
  });

  it('extracts Next.js pages/app routes and preserves route language', () => {
    const pageRoutes = [
      ...reactResolver.extractNodes!('src/pages/index.tsx', 'export default function Home() { return null; }'),
      ...reactResolver.extractNodes!('src/pages/blog/[slug].jsx', 'export default function Blog() { return null; }'),
      ...reactResolver.extractNodes!('src/app/users/[id]/page.ts', 'export default function Page() { return null; }'),
      ...reactResolver.extractNodes!('src/app/users/layout.tsx', 'export default function Layout() { return null; }'),
    ];

    expect(pageRoutes.map((n) => `${n.name}:${n.language}`).sort(byString)).toEqual([
      '/:tsx',
      '/blog/:slug:javascript',
      '/users/:id:typescript',
    ]);
  });

  it('resolves React components, hooks, and contexts using React conventions', () => {
    const localButton = frameworkNode({
      id: 'component:src/screens/Button.tsx:Button',
      kind: 'component',
      name: 'Button',
      filePath: 'src/screens/Button.tsx',
      language: 'tsx',
    });
    const siblingPrefixButton = frameworkNode({
      id: 'component:src/screens-extra/Button.tsx:Button',
      kind: 'component',
      name: 'Button',
      filePath: 'src/screens-extra/Button.tsx',
      language: 'tsx',
    });
    const libraryButton = frameworkNode({
      id: 'component:src/components/Button.tsx:Button',
      kind: 'component',
      name: 'Button',
      filePath: 'src/components/Button.tsx',
      language: 'tsx',
    });
    const hook = frameworkNode({
      id: 'function:src/hooks/useAuth.ts:useAuth',
      kind: 'function',
      name: 'useAuth',
      filePath: 'src/hooks/useAuth.ts',
      language: 'typescript',
    });
    const context = frameworkNode({
      id: 'variable:src/providers/AuthContext.tsx:AuthContext',
      kind: 'variable',
      name: 'AuthContext',
      filePath: 'src/providers/AuthContext.tsx',
      language: 'tsx',
    });
    const baseContext = frameworkNode({
      id: 'variable:src/providers/Theme.tsx:Theme',
      kind: 'variable',
      name: 'Theme',
      filePath: 'src/providers/Theme.tsx',
      language: 'tsx',
    });
    const ctx = frameworkContext({
      nodes: [siblingPrefixButton, libraryButton, localButton, hook, context, baseContext],
    });

    const componentRef = frameworkRef('Button', 'tsx');
    componentRef.filePath = 'src/screens/App.tsx';
    expect(reactResolver.resolve(componentRef, ctx)).toMatchObject({
      targetNodeId: localButton.id,
      confidence: 0.8,
    });
    expect(reactResolver.resolve(frameworkRef('String', 'tsx'), ctx)).toBeNull();
    expect(reactResolver.resolve(frameworkRef('useAuth', 'tsx'), ctx)).toMatchObject({
      targetNodeId: hook.id,
      confidence: 0.85,
    });
    expect(reactResolver.resolve(frameworkRef('AuthContext', 'tsx'), ctx)).toMatchObject({
      targetNodeId: context.id,
      confidence: 0.8,
    });
    expect(reactResolver.resolve(frameworkRef('ThemeProvider', 'tsx'), ctx)).toMatchObject({
      targetNodeId: baseContext.id,
      confidence: 0.8,
    });
  });
});

describe('Go route extractor: Header.Get/Set/Add/Del args not treated as routes', () => {
  it('does not emit a route for req.Header.Get("Content-Type")', () => {
    const content = ['func handler(req *http.Request) {', '    ct := req.Header.Get("Content-Type")', '}'].join('\n');
    const nodes = goResolver.extractNodes!('handler.go', content);
    const names = nodes.map((n) => n.name);
    expect(names).not.toContain('GET Content-Type');
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });

  it('does not emit a route for r.Header.Get("X-Foo")', () => {
    const content = 'r.Header.Get("X-Foo")';
    const nodes = goResolver.extractNodes!('attack.go', content);
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });

  it('does not emit a route for hdr.Get("X-Vegeta-Attack") (vegeta regression)', () => {
    const content = [
      'func setHeaders(req *http.Request, atk *Attacker) {',
      '    if have, want := hdr.Get("X-Vegeta-Attack"), atk.name; have != want {',
      '        t.Fatal("wrong")',
      '    }',
      '}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('attack_test.go', content);
    const names = nodes.map((n) => n.name);
    expect(names).not.toContain('GET X-Vegeta-Attack');
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });

  it('does not emit a route for resp.Header.Get("Content-Type")', () => {
    const content = 'ct := resp.Header.Get("Content-Type")';
    const nodes = goResolver.extractNodes!('client.go', content);
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });

  it('still emits a real Chi route r.Get("/path", handler)', () => {
    const content = [
      'func routes(r chi.Router) {',
      '    r.Get("/attack", attackHandler)',
      '    r.Post("/targets", targetsHandler)',
      '}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('routes.go', content);
    const names = nodes.map((n) => n.name);
    expect(names).toContain('GET /attack');
    expect(names).toContain('POST /targets');
  });

  // ollama bug-hunt extension: net/http supports `mux.Handle(...)` /
  // `mux.HandleFunc(...)` alongside `http.HandleFunc`, and Go 1.22+
  // accepts a `METHOD /path` prefix. ollama uses both shapes in
  // `app/ui/ui.go`. The unified regex catches all four combinations
  // and splits the method prefix when present.
  it('extracts net/http patterns: http.HandleFunc, mux.HandleFunc, mux.Handle, with optional Go 1.22 METHOD prefix', () => {
    const content = [
      'package main',
      '',
      'func setup() {',
      '    http.HandleFunc("/legacy", legacyHandler)',
      '    mux := http.NewServeMux()',
      '    mux.HandleFunc("/health", healthHandler)',
      '    mux.Handle("/static", staticHandler)',
      '    mux.Handle("GET /api/users", listUsersHandler)',
      '    mux.Handle("POST /api/users/{id}", updateUserHandler)',
      '    mux.HandleFunc("DELETE /api/users/{id}", deleteUserHandler)',
      '}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('mux.go', content);
    const routes = nodes
      .filter((n) => n.kind === 'route')
      .map((n) => n.name)
      .sort(byString);
    expect(routes).toEqual([
      'ANY /health',
      'ANY /legacy',
      'ANY /static',
      'DELETE /api/users/{id}',
      'GET /api/users',
      'POST /api/users/{id}',
    ]);
  });

  // ollama bug-hunt FN: cobra was unrecognized as a CLI framework, so
  // every Go CLI's subcommands (kubectl, helm, gh, docker, ollama itself)
  // never surfaced in the cli entry-points bucket. The recognizer now
  // emits `cmd <verb>` route nodes for each `cobra.Command{Use: ...}`
  // literal, matching the convention the commander/yargs JS resolver
  // already uses.
  it('extracts cobra Command Use strings as cmd routes', () => {
    const content = [
      'package main',
      '',
      'import "github.com/spf13/cobra"',
      '',
      'func newRoot() *cobra.Command {',
      '    rootCmd := &cobra.Command{',
      '        Use:   "ollama",',
      '        Short: "Large language model runner",',
      '    }',
      '    createCmd := &cobra.Command{',
      '        Use:   "create MODEL",',
      '        Short: "Create a model",',
      '        RunE:  CreateHandler,',
      '    }',
      '    serveCmd := &cobra.Command{',
      '        Use:     "serve",',
      '        Aliases: []string{"start"},',
      '    }',
      '    rootCmd.AddCommand(createCmd, serveCmd)',
      '    return rootCmd',
      '}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('cmd/cmd.go', content);
    const cliRoutes = nodes.filter((n) => n.kind === 'route' && n.name.startsWith('cmd '));
    const cliRouteNames = cliRoutes.map((n) => n.name).sort(byString);
    expect(cliRouteNames).toEqual(['cmd create', 'cmd ollama', 'cmd serve']);

    // Signature carries the full Use string for downstream context.
    const createRoute = cliRoutes.find((n) => n.name === 'cmd create');
    expect(createRoute?.signature).toBe('create MODEL');
  });

  // Comment-strip guard: any framework-pattern match inside a Go doc
  // comment / migration note must NOT fire as a real route. Covers the
  // newly-comment-stripped Gin / Echo / Chi / http / cobra patterns.
  it('skips framework patterns inside Go comments', () => {
    const content = [
      'package x',
      '',
      '// Example route registration:',
      '//',
      '//   r.GET("/comment-gin", handler)',
      '//   r.Get("/comment-chi", handler)',
      '//   http.HandleFunc("/comment-http", handler)',
      '//   e.GET("/comment-echo", handler)',
      '//',
      '// Cobra command shape:',
      '//   &cobra.Command{ Use: "commentcmd" }',
      '/*',
      ' * Block: &cobra.Command{ Use: "blockcmd" }',
      ' */',
      '',
      'func nothingHere() {}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('docs.go', content);
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });

  // ollama bug-hunt: the Chi pattern over-matched any `r.Get("string")` call,
  // so a custom registry whose method `Get(name string)` looked up tools by
  // name fired 6 spurious route nodes in x/tools/registry_test.go. The
  // tightened pattern now requires the path string to start with `/`.
  it('does not emit a route for r.Get("bash") registry lookup (ollama regression)', () => {
    const content = [
      'func TestRegistryGet(t *testing.T) {',
      '    r := NewRegistry()',
      '    tool := r.Get("bash")',
      '    other := r.Get("web_search")',
      '    none := r.Get("nonexistent")',
      '    _ = tool; _ = other; _ = none',
      '}',
    ].join('\n');
    const nodes = goResolver.extractNodes!('registry_test.go', content);
    expect(nodes.filter((n) => n.kind === 'route')).toHaveLength(0);
  });
});

describe('stripCommentsForRegex preserves line offsets', () => {
  it('keeps newlines so match.index → original line number', () => {
    const input = '"""\n@app.get("/x")\n"""\n@app.get("/y")';
    const out = stripCommentsForRegex(input, 'python');
    // Newlines preserved
    expect(out.split('\n').length).toBe(input.split('\n').length);
    // The /y route survives
    expect(out).toContain('/y');
    // The docstring contents are blanked
    expect(out).not.toContain('/x');
  });

  it('blanks a trailing inline // comment but keeps the code before it', () => {
    const input = 'const port = readPort(); // process.env.GHOST_TRAILING';
    const out = stripCommentsForRegex(input, 'typescript');
    expect(out).toContain('const port = readPort();');
    expect(out).not.toContain('GHOST_TRAILING');
    expect(out.length).toBe(input.length); // length-preserving
  });

  it('does NOT strip a // that sits inside a string literal', () => {
    const input = 'const url = "https://example.com/x"; // real comment';
    const out = stripCommentsForRegex(input, 'typescript');
    expect(out).toContain('"https://example.com/x"');
    expect(out).not.toContain('real comment');
  });

  it('blanks a trailing # comment in Python but keeps real code', () => {
    const input = 'real = os.environ.get("KEEP_ME")  # os.getenv("GHOST_PY")';
    const out = stripCommentsForRegex(input, 'python');
    expect(out).toContain('KEEP_ME');
    expect(out).not.toContain('GHOST_PY');
  });

  it('does not treat Ruby #{...} interpolation as a comment', () => {
    const input = 'pattern = /#{ENV["RUBY_KEY"]}/';
    const out = stripCommentsForRegex(input, 'ruby');
    expect(out).toContain('RUBY_KEY'); // #{ guard kept the interpolation
  });

  it('keeps code after an escaped // inside a regex literal', () => {
    // `/foo\/\//` ends in an escaped `//` then the regex terminator —
    // the `\`-preceded guard must not treat that as a comment start.
    const input = String.raw`const re = /foo\/\//; const KEEP_AFTER = 1;`;
    const out = stripCommentsForRegex(input, 'typescript');
    expect(out).toContain('KEEP_AFTER');
  });

  it('legacy leading-only mode keeps trailing inline comments (algo-hash path)', () => {
    const input = 'const x = readPort(); // process.env.HASH_TAIL';
    const out = stripCommentsForRegex(input, 'typescript', { stripInlineComments: false });
    expect(out).toContain('HASH_TAIL'); // trailing comment survives → counts toward the hash
  });

  it('per-line scan blanks // inside a multi-line template literal (known limitation)', () => {
    // The scanner resets string state per line, so a // on a
    // continuation line of a template literal is treated as a
    // comment. Documented + intentional — template-literal interiors
    // are noise for the downstream pattern scans anyway.
    const input = 'const q = `first\n// middle line\nlast`;';
    const out = stripCommentsForRegex(input, 'typescript');
    expect(out.split('\n').length).toBe(3); // newlines preserved
    expect(out).not.toContain('middle line');
  });
});
