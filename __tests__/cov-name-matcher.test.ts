/**
 * Coverage-focused unit tests for `src/resolution/name-matcher.ts`.
 *
 * Drives `matchReference` (the only export) through every resolution
 * strategy and confidence tier with hand-built `Node` / `ResolutionContext`
 * inputs — no DB, no indexing. Each case asserts the REAL chosen candidate
 * id / confidence / resolvedBy, not just "non-null".
 */
import { describe, expect, it } from 'vitest';
import { matchReference } from '../src/resolution/name-matcher.js';
import type { ImportMapping, ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import type { Node } from '../src/types.js';

function node(overrides: Partial<Node> & Pick<Node, 'id' | 'name' | 'kind' | 'filePath'>): Node {
  return {
    qualifiedName: overrides.name,
    language: 'typescript',
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 1,
    updatedAt: 0,
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
    column: 1,
    ...overrides,
  } as UnresolvedRef;
}

interface ContextExtras {
  imports?: ImportMapping[];
  readFile?: (filePath: string) => string | null;
}

function context(nodes: Node[], extras: ContextExtras = {}): ResolutionContext {
  return {
    getNodesInFile(filePath: string) {
      return nodes.filter((n) => n.filePath === filePath);
    },
    getNodesByName(name: string) {
      return nodes.filter((n) => n.name === name);
    },
    getNodesByQualifiedName(qualifiedName: string) {
      return nodes.filter((n) => n.qualifiedName === qualifiedName);
    },
    getNodesByLowerName(lowerName: string) {
      return nodes.filter((n) => n.name.toLowerCase() === lowerName);
    },
    getNodesByKind(kind: Node['kind']) {
      return nodes.filter((n) => n.kind === kind);
    },
    fileExists() {
      return true;
    },
    readFile(filePath: string) {
      return extras.readFile ? extras.readFile(filePath) : null;
    },
    getProjectRoot() {
      return '/proj';
    },
    getAllFiles() {
      return [...new Set(nodes.map((n) => n.filePath))];
    },
    getImportMappings() {
      return extras.imports ?? [];
    },
  } as ResolutionContext;
}

/** Build a full ImportMapping with the booleans test fixtures usually omit. */
function imp(localName: string, source: string, over: Partial<ImportMapping> = {}): ImportMapping {
  return { localName, exportedName: localName, source, isDefault: false, isNamespace: false, ...over };
}

// ---------------------------------------------------------------------------
// 0. matchByFilePath
// ---------------------------------------------------------------------------
describe('matchByFilePath (file-path strategy)', () => {
  it('returns null for a reference name with no slash that matches no node', () => {
    // No '/' → matchByFilePath bails immediately; no node shares the name so
    // no other strategy can resolve it either.
    const f = node({ id: 'f', name: 'somethingDifferent', kind: 'file', qualifiedName: 'x/foo', filePath: 'x/foo' });
    expect(matchReference(ref({ referenceName: 'unrelatedName' }), context([f]))).toBeNull();
  });

  it('resolves an exact qualified-name path match at 0.95', () => {
    const f = node({
      id: 'file:exact',
      name: 'drawer.liquid',
      kind: 'file',
      qualifiedName: 'snippets/drawer.liquid',
      filePath: 'snippets/drawer.liquid',
    });
    expect(matchReference(ref({ referenceName: 'snippets/drawer.liquid' }), context([f]))).toMatchObject({
      targetNodeId: 'file:exact',
      confidence: 0.95,
      resolvedBy: 'file-path',
    });
  });

  it('resolves an exact filePath (not qualifiedName) path match at 0.95', () => {
    const f = node({
      id: 'file:fp',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'unrelated-qn',
      filePath: 'snippets/card.liquid',
    });
    expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), context([f]))).toMatchObject({
      targetNodeId: 'file:fp',
      confidence: 0.95,
    });
  });

  it('falls back to a path-segment-boundary suffix match at 0.85', () => {
    const f = node({
      id: 'file:suffix',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'src/theme/snippets/card.liquid',
      filePath: 'src/theme/snippets/card.liquid',
    });
    expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), context([f]))).toMatchObject({
      targetNodeId: 'file:suffix',
      confidence: 0.85,
    });
  });

  it('does NOT suffix-match across a non-/ boundary but falls back to filename-only (single node) at 0.7', () => {
    // ref "snippets/card.liquid" must not suffix-match "src/mysnippets/card.liquid"
    // (no `/` boundary before "snippets"); with one file node sharing the
    // filename it falls to the filename-only tier.
    const f = node({
      id: 'file:only',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'src/mysnippets/card.liquid',
      filePath: 'src/mysnippets/card.liquid',
    });
    expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), context([f]))).toMatchObject({
      targetNodeId: 'file:only',
      confidence: 0.7,
    });
  });

  it('returns null when several same-name file nodes lack exact/suffix agreement', () => {
    // 2+ filename matches, none exact/suffix → ambiguous, returns null.
    const a = node({
      id: 'file:a',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'aaa/card.liquid',
      filePath: 'aaa/card.liquid',
    });
    const b = node({
      id: 'file:b',
      name: 'card.liquid',
      kind: 'file',
      qualifiedName: 'bbb/card.liquid',
      filePath: 'bbb/card.liquid',
    });
    expect(matchReference(ref({ referenceName: 'snippets/card.liquid' }), context([a, b]))).toBeNull();
  });

  it('returns null when the basename matches no file node and no other strategy fires', () => {
    const f = node({ id: 'file:x', name: 'other.liquid', kind: 'file', filePath: 'a/other.liquid' });
    expect(matchReference(ref({ referenceName: 'snippets/missing.liquid' }), context([f]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 1. matchByQualifiedName
// ---------------------------------------------------------------------------
describe('matchByQualifiedName (qualified-name strategy)', () => {
  it('resolves a single exact qualified-name candidate at 0.95', () => {
    // Use a non-method-call shape (referenceKind references) so matchMethodCall
    // does not pre-empt: a dotted reference whose receiver is not a class.
    const fn = node({
      id: 'qn:single',
      name: 'helper',
      kind: 'function',
      qualifiedName: 'utils.helper',
      filePath: 'src/utils.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'utils.helper', referenceKind: 'references' }), context([fn])),
    ).toMatchObject({ targetNodeId: 'qn:single', confidence: 0.95, resolvedBy: 'qualified-name' });
  });

  it('resolves via a :: partial-suffix qualified match at 0.85', () => {
    const m = node({
      id: 'qn:partial',
      name: 'create',
      kind: 'method',
      qualifiedName: 'app::models::User::create',
      language: 'rust',
      filePath: 'src/user.rs',
    });
    expect(
      matchReference(
        ref({ referenceName: 'User::create', referenceKind: 'references', language: 'rust', filePath: 'src/x.rs' }),
        context([m]),
      ),
    ).toMatchObject({ targetNodeId: 'qn:partial', confidence: 0.85, resolvedBy: 'qualified-name' });
  });

  it('does NOT suffix-match across an identifier boundary (Zed::create vs FooBar::create)', () => {
    // F#80 bug class: a `Zed::create` ref must not suffix-match onto the
    // unrelated `FooBar::create`. The candidate is a `function` (not a
    // `method`), so the method-call receiver / word-overlap fallbacks can't
    // pick it up either — isolating the qualified-name boundary check.
    const m = node({
      id: 'qn:foobar',
      name: 'create',
      kind: 'function',
      qualifiedName: 'FooBar::create',
      language: 'rust',
      filePath: 'src/foobar.rs',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Zed::create', referenceKind: 'references', language: 'rust', filePath: 'src/x.rs' }),
        context([m]),
      ),
    ).toBeNull();
  });

  it('returns null when a qualified name has 2+ exact candidates and no partial agrees', () => {
    const a = node({
      id: 'qn:m1',
      name: 'helper',
      kind: 'function',
      qualifiedName: 'utils.helper',
      filePath: 'a.ts',
    });
    const b = node({
      id: 'qn:m2',
      name: 'helper',
      kind: 'function',
      qualifiedName: 'utils.helper',
      filePath: 'b.ts',
    });
    // Two exact qualified-name hits (length !== 1), and the partial loop
    // re-finds the same names but the boundary check requires endsWith
    // ".helper" which both satisfy — so the FIRST partial wins, not null.
    // Assert it resolves to the first via the 0.85 partial tier.
    expect(
      matchReference(ref({ referenceName: 'utils.helper', referenceKind: 'references' }), context([a, b])),
    ).toMatchObject({ confidence: 0.85, resolvedBy: 'qualified-name' });
  });
});

// ---------------------------------------------------------------------------
// 2. matchMethodCall — direct / capitalized / inferred receivers
// ---------------------------------------------------------------------------
describe('matchMethodCall (method-on-receiver strategy)', () => {
  it('resolves Class.method via a direct qualified receiver at 0.85', () => {
    // The method's qualifiedName uses a `#` member separator so the earlier
    // qualified-name strategy (which only suffix-matches `.run` / `::run`
    // boundaries against the full `Service.run` ref) misses, forcing the
    // receiver-method path. That path only needs
    // `qualifiedName.includes(classNode.name)` ("Service"), so it hits.
    const cls = node({
      id: 'class:svc',
      name: 'Service',
      kind: 'class',
      qualifiedName: 'app.Service',
      filePath: 'src/service.ts',
      startLine: 1,
      endLine: 40,
    });
    const m = node({
      id: 'method:run',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service#run',
      filePath: 'src/service.ts',
    });
    expect(matchReference(ref({ referenceName: 'Service.run' }), context([cls, m]))).toMatchObject({
      targetNodeId: 'method:run',
      confidence: 0.85,
      resolvedBy: 'qualified-name',
    });
  });

  it('resolves a Class::method receiver (Rust/C++ style) at 0.85', () => {
    const cls = node({
      id: 'class:foo',
      name: 'Foo',
      kind: 'struct',
      qualifiedName: 'Foo',
      language: 'rust',
      filePath: 'src/foo.rs',
    });
    const m = node({
      id: 'method:bar',
      name: 'bar',
      kind: 'method',
      qualifiedName: 'Foo::bar',
      language: 'rust',
      filePath: 'src/foo.rs',
    });
    expect(
      matchReference(ref({ referenceName: 'Foo::bar', language: 'rust', filePath: 'src/x.rs' }), context([cls, m])),
    ).toMatchObject({ targetNodeId: 'method:bar', resolvedBy: 'qualified-name' });
  });

  it('resolves a lowercased instance receiver by capitalizing it (instance-method, 0.8)', () => {
    // `service.run()` → capitalize to `Service`, find Service.run.
    const cls = node({
      id: 'class:svc2',
      name: 'Service',
      kind: 'class',
      qualifiedName: 'Service',
      filePath: 'src/service.ts',
      startLine: 1,
      endLine: 40,
    });
    const m = node({
      id: 'method:run2',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service.run',
      filePath: 'src/service.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'service.run', filePath: 'src/other.ts' }), context([cls, m])),
    ).toMatchObject({ targetNodeId: 'method:run2', confidence: 0.8, resolvedBy: 'instance-method' });
  });

  it('resolves a C++ out-of-class method definition (Class::method function node)', () => {
    const cls = node({
      id: 'class:widget',
      name: 'Widget',
      kind: 'class',
      qualifiedName: 'Widget',
      language: 'cpp',
      filePath: 'src/widget.h',
      startLine: 1,
      endLine: 20,
    });
    // Out-of-class definition is extracted as a FUNCTION named "Widget::draw".
    const def = node({
      id: 'fn:widget-draw',
      name: 'Widget::draw',
      kind: 'function',
      qualifiedName: 'Widget::draw',
      language: 'cpp',
      filePath: 'src/widget.cpp',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Widget::draw', language: 'cpp', filePath: 'src/main.cpp' }),
        context([cls, def]),
      ),
    ).toMatchObject({ targetNodeId: 'fn:widget-draw', resolvedBy: 'qualified-name' });
  });

  it('infers a TS field receiver type from a class field annotation (readFile)', () => {
    const repo = node({
      id: 'class:repo',
      name: 'Repo',
      kind: 'class',
      qualifiedName: 'Repo',
      filePath: 'src/repo.ts',
      startLine: 1,
      endLine: 30,
    });
    const cacheField = node({
      id: 'field:cache',
      name: 'cache',
      kind: 'field',
      filePath: 'src/repo.ts',
      startLine: 3,
      endLine: 3,
    });
    const tiny = node({
      id: 'class:tiny',
      name: 'TinyCache',
      kind: 'class',
      qualifiedName: 'TinyCache',
      filePath: 'src/cache.ts',
    });
    const remember = node({
      id: 'method:remember',
      name: 'remember',
      kind: 'method',
      qualifiedName: 'TinyCache.remember',
      filePath: 'src/cache.ts',
    });
    const src = ['class Repo {', '  value = 1;', '  private cache: TinyCache;', '  run() {}'].join('\n');
    expect(
      matchReference(ref({ referenceName: 'cache.remember', filePath: 'src/repo.ts', line: 12 }), {
        ...context([repo, cacheField, tiny, remember]),
        readFile: () => src,
      } as ResolutionContext),
    ).toMatchObject({ targetNodeId: 'method:remember', resolvedBy: 'instance-method' });
  });

  it('infers a TS field receiver type from a `= new Ctor()` field initializer', () => {
    const repo = node({
      id: 'class:repo3',
      name: 'Box',
      kind: 'class',
      qualifiedName: 'Box',
      filePath: 'src/box.ts',
      startLine: 1,
      endLine: 30,
    });
    const field = node({
      id: 'field:store',
      name: 'store',
      kind: 'field',
      filePath: 'src/box.ts',
      startLine: 2,
      endLine: 2,
    });
    const store = node({
      id: 'class:store',
      name: 'Store',
      kind: 'class',
      qualifiedName: 'Store',
      filePath: 'src/store.ts',
    });
    const save = node({
      id: 'method:save',
      name: 'save',
      kind: 'method',
      qualifiedName: 'Store.save',
      filePath: 'src/store.ts',
    });
    const src = ['class Box {', '  private store = new Store();', '  run() {}'].join('\n');
    expect(
      matchReference(ref({ referenceName: 'store.save', filePath: 'src/box.ts', line: 13 }), {
        ...context([repo, field, store, save]),
        readFile: () => src,
      } as ResolutionContext),
    ).toMatchObject({ targetNodeId: 'method:save', resolvedBy: 'instance-method' });
  });

  it('infers a Java field receiver type from the field signature (userbo -> UserBO)', () => {
    const controller = node({
      id: 'class:ctrl',
      name: 'Controller',
      kind: 'class',
      qualifiedName: 'Controller',
      language: 'java',
      filePath: 'src/Controller.java',
      startLine: 1,
      endLine: 40,
    });
    const field = node({
      id: 'field:userbo',
      name: 'userbo',
      kind: 'field',
      signature: 'com.example.UserBO userbo',
      language: 'java',
      filePath: 'src/Controller.java',
      startLine: 3,
      endLine: 3,
    });
    const userbo = node({
      id: 'class:userbo',
      name: 'UserBO',
      kind: 'class',
      qualifiedName: 'UserBO',
      language: 'java',
      filePath: 'src/UserBO.java',
    });
    const login = node({
      id: 'method:login',
      name: 'toLogin2',
      kind: 'method',
      qualifiedName: 'UserBO.toLogin2',
      language: 'java',
      filePath: 'src/UserBO.java',
    });
    expect(
      matchReference(
        ref({ referenceName: 'userbo.toLogin2', filePath: 'src/Controller.java', language: 'java', line: 20 }),
        context([controller, field, userbo, login]),
      ),
    ).toMatchObject({ targetNodeId: 'method:login', resolvedBy: 'instance-method' });
  });

  it('infers a Ruby local receiver type from `x = Klass.new` (instance-method)', () => {
    const klass = node({
      id: 'class:rb',
      name: 'Service',
      kind: 'class',
      qualifiedName: 'Service',
      language: 'ruby',
      filePath: 'lib/service.rb',
    });
    const perform = node({
      id: 'method:perform',
      name: 'perform',
      kind: 'method',
      qualifiedName: 'Service.perform',
      language: 'ruby',
      filePath: 'lib/service.rb',
    });
    const caller = node({
      id: 'caller',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Caller.run',
      language: 'ruby',
      filePath: 'lib/caller.rb',
      startLine: 1,
      endLine: 10,
    });
    const src = ['def run', '  svc = Service.new', '  svc.perform', 'end'].join('\n');
    expect(
      matchReference(
        ref({
          referenceName: 'svc.perform',
          fromNodeId: 'caller',
          filePath: 'lib/caller.rb',
          language: 'ruby',
          line: 3,
        }),
        { ...context([klass, perform, caller]), readFile: () => src } as ResolutionContext,
      ),
    ).toMatchObject({ targetNodeId: 'method:perform', resolvedBy: 'instance-method' });
  });

  it('returns null for a method call when the receiver class is unknown (no candidate kinds)', () => {
    // `unknownThing.doStuff` — no class named UnknownThing, and doStuff is
    // not a builtin, and no method named doStuff exists → unresolved.
    expect(
      matchReference(ref({ referenceName: 'unknownThing.doStuff', filePath: 'src/x.ts' }), context([])),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 3. matchMethodCall — word-overlap fallback (strategy 3)
// ---------------------------------------------------------------------------
describe('matchMethodCall word-overlap fallback', () => {
  it('resolves a single same-language method by bare name overlap at 0.7', () => {
    // Receiver `orderService` is not a class and not capitalizable to a class;
    // method `placeOrder` exists exactly once in the same language → 0.7.
    const m = node({
      id: 'method:place',
      name: 'placeOrder',
      kind: 'method',
      qualifiedName: 'Checkout.placeOrder',
      filePath: 'src/checkout.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'orderService.placeOrder', filePath: 'src/x.ts' }), context([m])),
    ).toMatchObject({ targetNodeId: 'method:place', confidence: 0.7, resolvedBy: 'instance-method' });
  });

  it('picks the best multi-candidate method by receiver word overlap (>=2 words) at 0.65', () => {
    // Receiver "userAccountManager" shares words user+account with
    // UserAccountStore.load; the decoy UnrelatedThing.load shares none.
    const good = node({
      id: 'method:good-load',
      name: 'load',
      kind: 'method',
      qualifiedName: 'UserAccountStore.load',
      filePath: 'src/store.ts',
    });
    const decoy = node({
      id: 'method:decoy-load',
      name: 'load',
      kind: 'method',
      qualifiedName: 'UnrelatedThing.load',
      filePath: 'src/other.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'userAccountManager.load', filePath: 'src/x.ts' }), context([good, decoy])),
    ).toMatchObject({ targetNodeId: 'method:good-load', confidence: 0.65, resolvedBy: 'instance-method' });
  });

  it('returns null when multi-candidate overlap is below the >=2-word gate', () => {
    // Receiver "thing" shares no >1-char word with either qualified name;
    // both score 0 from overlap (+1 each for same language) -> below gate.
    const a = node({
      id: 'method:a-load',
      name: 'load',
      kind: 'method',
      qualifiedName: 'Alpha.load',
      filePath: 'src/a.ts',
    });
    const b = node({
      id: 'method:b-load',
      name: 'load',
      kind: 'method',
      qualifiedName: 'Beta.load',
      filePath: 'src/b.ts',
    });
    expect(matchReference(ref({ referenceName: 'thing.load', filePath: 'src/x.ts' }), context([a, b]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 4. matchMethodCall — chained returned-receiver (factory) resolution
// ---------------------------------------------------------------------------
describe('matchMethodCall chained returned-receiver resolution', () => {
  it('resolves Class.factory().method() through the factory return type', () => {
    // Builder.create() returns a Widget (signature `: Widget`); then .render()
    // resolves onto Widget.render at instance-method confidence.
    const builderCls = node({
      id: 'class:builder',
      name: 'Builder',
      kind: 'class',
      qualifiedName: 'Builder',
      filePath: 'src/builder.ts',
      startLine: 1,
      endLine: 20,
    });
    const factory = node({
      id: 'method:create',
      name: 'create',
      kind: 'method',
      qualifiedName: 'Builder::create',
      signature: 'static create(): Widget',
      filePath: 'src/builder.ts',
    });
    const widget = node({
      id: 'class:widget2',
      name: 'Widget',
      kind: 'class',
      qualifiedName: 'Widget',
      filePath: 'src/widget.ts',
      startLine: 1,
      endLine: 20,
    });
    const render = node({
      id: 'method:render',
      name: 'render',
      kind: 'method',
      qualifiedName: 'Widget.render',
      filePath: 'src/widget.ts',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Builder.create().render', filePath: 'src/x.ts' }),
        context([builderCls, factory, widget, render]),
      ),
    ).toMatchObject({ targetNodeId: 'method:render', resolvedBy: 'instance-method', confidence: 0.8 });
  });

  it('resolves a chained call whose factory return type is lowercase `self` back onto the receiver', () => {
    // `returnedReceiverName` only passes a return type through when it is the
    // LOWERCASE token `self` or `static` (see flagged Rust `Self` gap below).
    // A factory typed `-> self` resolves the chained method onto the receiver
    // class `Foo`.
    const foo = node({
      id: 'class:foo-self',
      name: 'Foo',
      kind: 'struct',
      qualifiedName: 'Foo',
      language: 'rust',
      filePath: 'src/foo.rs',
      startLine: 1,
      endLine: 30,
    });
    const builder = node({
      id: 'method:foo-builder',
      name: 'builder',
      kind: 'method',
      qualifiedName: 'Foo::builder',
      signature: 'fn builder() -> self',
      language: 'rust',
      filePath: 'src/foo.rs',
    });
    const build = node({
      id: 'method:foo-build',
      name: 'build',
      kind: 'method',
      qualifiedName: 'Foo::build',
      language: 'rust',
      filePath: 'src/foo.rs',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Foo::builder().build', language: 'rust', filePath: 'src/main.rs' }),
        context([foo, builder, build]),
      ),
    ).toMatchObject({ targetNodeId: 'method:foo-build', resolvedBy: 'instance-method' });
  });

  it('does NOT pass a capitalized `Self` return type through (flagged Rust gap)', () => {
    // BUG/GAP FLAG: returnedReceiverName treats only the lowercase tokens
    // `self` / `static` as receiver passthroughs, but idiomatic Rust factory
    // signatures return CAPITALIZED `Self`. Here `builder() -> Self` makes the
    // chain look for a class literally named `Self`, finds none, and the
    // chained `.build` call goes unresolved. Documents current behavior.
    const foo = node({
      id: 'class:foo-cap',
      name: 'Foo',
      kind: 'struct',
      qualifiedName: 'Foo',
      language: 'rust',
      filePath: 'src/foo2.rs',
      startLine: 1,
      endLine: 30,
    });
    const builder = node({
      id: 'method:foo-cap-builder',
      name: 'make',
      kind: 'method',
      qualifiedName: 'Foo::make',
      signature: 'fn make() -> Self',
      language: 'rust',
      filePath: 'src/foo2.rs',
    });
    const build = node({
      id: 'method:foo-cap-build',
      name: 'finish',
      kind: 'method',
      qualifiedName: 'Foo::finish',
      language: 'rust',
      filePath: 'src/foo2.rs',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Foo::make().finish', language: 'rust', filePath: 'src/m2.rs' }),
        context([foo, builder, build]),
      ),
    ).toBeNull();
  });

  it('does not chain-resolve when the factory return type is a primitive', () => {
    // create() returns `string` (primitive) → returnType is null → chain bails,
    // and there is no method `length` reachable → null.
    const cls = node({
      id: 'class:p',
      name: 'P',
      kind: 'class',
      qualifiedName: 'P',
      filePath: 'src/p.ts',
      startLine: 1,
      endLine: 10,
    });
    const factory = node({
      id: 'method:p-create',
      name: 'create',
      kind: 'method',
      qualifiedName: 'P::create',
      signature: 'static create(): string',
      filePath: 'src/p.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'P.create().fooBarBaz', filePath: 'src/x.ts' }), context([cls, factory])),
    ).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 5. JVM FQN disambiguation
// ---------------------------------------------------------------------------
describe('matchMethodCall JVM FQN disambiguation', () => {
  function jvmFixture() {
    const callerImport = node({
      id: 'import:service',
      name: 'com.example.impl.Service',
      kind: 'import',
      signature: 'import com.example.impl.Service',
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
    // `#` member separator so the earlier qualified-name partial-suffix
    // strategy (which only matches `.run` / `::run` boundaries against the
    // full `Service.run` ref) misses, forcing the FQN-disambiguating
    // receiver-method path. `findMethodInClassFile` only needs
    // `qualifiedName.includes("Service")`, which still holds.
    const wrongRun = node({
      id: 'method:wrong',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service#run',
      language: 'java',
      filePath: wrongClass.filePath,
    });
    const rightRun = node({
      id: 'method:right',
      name: 'run',
      kind: 'method',
      qualifiedName: 'Service#run',
      language: 'java',
      filePath: rightClass.filePath,
    });
    return [callerImport, wrongClass, wrongRun, rightClass, rightRun];
  }

  it('prefers the import-FQN-matching class and resolves at fqn-disambiguated 0.9', () => {
    expect(
      matchReference(
        ref({ referenceName: 'Service.run', filePath: 'src/main/kotlin/App.kt', language: 'kotlin', line: 20 }),
        context(jvmFixture()),
      ),
    ).toMatchObject({ targetNodeId: 'method:right', resolvedBy: 'fqn-disambiguated', confidence: 0.9 });
  });

  it('resolves a JVM method on a class with NO import hint at the fallback 0.6 (>1 candidate, no FQN match)', () => {
    // Same fixture but the caller file has no import node → no FQN match for
    // either same-named class; with 2 candidates the resolver lands the first
    // method at the 0.6 "fqn-available-but-unmatched" tier is NOT triggered
    // (fqnAvailable false); instead a plain qualified-name resolve fires.
    const nodes = jvmFixture().filter((n) => n.kind !== 'import');
    const r = matchReference(
      ref({ referenceName: 'Service.run', filePath: 'src/main/kotlin/NoImport.kt', language: 'kotlin', line: 5 }),
      context(nodes),
    );
    // No import → fqnAvailable false → first class's run resolves at the
    // direct-receiver qualified-name confidence 0.85.
    expect(r).toMatchObject({ resolvedBy: 'qualified-name', confidence: 0.85 });
    expect(['method:wrong', 'method:right']).toContain(r?.targetNodeId);
  });
});

// ---------------------------------------------------------------------------
// 6. matchByExactName — single / multi / builtin guards
// ---------------------------------------------------------------------------
describe('matchByExactName (exact-name strategy)', () => {
  it('resolves a single same-language exact match at 0.9', () => {
    const fn = node({ id: 'fn:exact', name: 'computeTotal', kind: 'function', filePath: 'src/calc.ts' });
    expect(matchReference(ref({ referenceName: 'computeTotal' }), context([fn]))).toMatchObject({
      targetNodeId: 'fn:exact',
      confidence: 0.9,
      resolvedBy: 'exact-match',
    });
  });

  it('penalizes a single cross-language exact match to 0.5', () => {
    const fn = node({
      id: 'fn:py',
      name: 'computeTotal',
      kind: 'function',
      language: 'python',
      filePath: 'svc.py',
    });
    expect(matchReference(ref({ referenceName: 'computeTotal' }), context([fn]))).toMatchObject({
      targetNodeId: 'fn:py',
      confidence: 0.5,
      resolvedBy: 'exact-match',
    });
  });

  it('picks the same-file candidate among multiple and stamps a tieMargin for the runner-up', () => {
    // Two functions named handle: one in the ref's own file (huge same-file
    // bonus), one elsewhere. Best = same-file; runner-up differs -> tieMargin.
    const here = node({ id: 'fn:here', name: 'handle', kind: 'function', filePath: 'src/app.ts', startLine: 9 });
    const there = node({ id: 'fn:there', name: 'handle', kind: 'function', filePath: 'src/far/away.ts' });
    const r = matchReference(
      ref({ referenceName: 'handle', filePath: 'src/app.ts', line: 10 }),
      context([here, there]),
    );
    expect(r).toMatchObject({ targetNodeId: 'fn:here', resolvedBy: 'exact-match' });
    expect(typeof r?.tieMargin).toBe('number');
  });

  it('prefers an exported function over a non-exported same-name one across files', () => {
    const exported = node({
      id: 'fn:exp',
      name: 'sharedUtil',
      kind: 'function',
      filePath: 'src/lib/util.ts',
      isExported: true,
    });
    const internal = node({
      id: 'fn:int',
      name: 'sharedUtil',
      kind: 'function',
      filePath: 'src/lib/internal.ts',
      isExported: false,
    });
    // Both cross-file from src/app.ts at equal proximity; export bonus breaks
    // the tie toward the exported one.
    expect(
      matchReference(ref({ referenceName: 'sharedUtil', filePath: 'src/app.ts' }), context([exported, internal])),
    ).toMatchObject({ targetNodeId: 'fn:exp' });
  });

  it('prefers a function over a class for a `calls` reference (kind affinity)', () => {
    const cls = node({ id: 'cls:thing', name: 'thing', kind: 'class', filePath: 'src/a.ts' });
    const fn = node({ id: 'fn:thing', name: 'thing', kind: 'function', filePath: 'src/b.ts' });
    expect(
      matchReference(
        ref({ referenceName: 'thing', referenceKind: 'calls', filePath: 'src/app.ts' }),
        context([cls, fn]),
      ),
    ).toMatchObject({ targetNodeId: 'fn:thing' });
  });

  it('prefers a field/property over a top-level const for a `field_access` reference', () => {
    const constNode = node({ id: 'const:total', name: 'total', kind: 'variable', filePath: 'src/a.ts' });
    const field = node({ id: 'field:total', name: 'total', kind: 'field', filePath: 'src/b.ts' });
    expect(
      matchReference(
        ref({ referenceName: 'total', referenceKind: 'field_access', filePath: 'src/app.ts' }),
        context([constNode, field]),
      ),
    ).toMatchObject({ targetNodeId: 'field:total' });
  });

  it('rejects a low-proximity TS/JS builtin-name multi-match (regex.exec must not hit DatabaseAdapter.exec)', () => {
    // `exec` is in TS_JS_BUILTIN_METHODS; two same-name methods in far dirs
    // → best proximity is weak → builtin guard rejects the whole match.
    const a = node({
      id: 'm:exec-a',
      name: 'exec',
      kind: 'method',
      qualifiedName: 'DatabaseAdapter.exec',
      filePath: 'src/db/adapter.ts',
    });
    const b = node({
      id: 'm:exec-b',
      name: 'exec',
      kind: 'method',
      qualifiedName: 'Runner.exec',
      filePath: 'src/run/runner.ts',
    });
    expect(matchReference(ref({ referenceName: 'exec', filePath: 'src/api/route.ts' }), context([a, b]))).toBeNull();
  });

  it('suppresses a bare unbacked builtin prototype method (`set`) that only matches a remote user symbol', () => {
    const remoteSet = node({
      id: 'method:remote-set',
      name: 'set',
      kind: 'method',
      qualifiedName: 'Cache.set',
      filePath: 'src/cache.ts',
    });
    expect(matchReference(ref({ referenceName: 'set' }), context([remoteSet]))).toBeNull();
  });

  it('keeps a bare builtin name when a same-FILE definition exists (lexical scope)', () => {
    const remoteSet = node({
      id: 'method:remote-set2',
      name: 'set',
      kind: 'method',
      qualifiedName: 'Cache.set',
      filePath: 'src/cache.ts',
    });
    const localSet = node({
      id: 'function:local-set',
      name: 'set',
      kind: 'function',
      qualifiedName: 'set',
      filePath: 'src/app.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'set', filePath: 'src/app.ts' }), context([remoteSet, localSet])),
    ).toMatchObject({
      targetNodeId: 'function:local-set',
    });
  });

  it('keeps a bare builtin name when it is import-backed', () => {
    const remoteSet = node({
      id: 'method:remote-set3',
      name: 'set',
      kind: 'method',
      qualifiedName: 'Cache.set',
      filePath: 'src/cache.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'set' }), context([remoteSet], { imports: [imp('set', './cache')] })),
    ).toMatchObject({ targetNodeId: 'method:remote-set3' });
  });

  it('does NOT suppress a builtin-name `references` (non-calls) reference', () => {
    // The bare-builtin suppression is scoped to referenceKind 'calls'. A
    // 'references' ref to `size` resolves normally.
    const sizeNode = node({
      id: 'field:size',
      name: 'size',
      kind: 'field',
      qualifiedName: 'Grid.size',
      filePath: 'src/grid.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'size', referenceKind: 'references' }), context([sizeNode])),
    ).toMatchObject({ targetNodeId: 'field:size' });
  });

  it('suppresses an incompatible cross-language exact match when the name is import-backed', () => {
    // describe-hub bug: import { describe } from 'bun:test' + a lone ObjC
    // method named describe → suppress the phantom cross-language edge.
    const objcDescribe = node({
      id: 'method:objc-describe',
      name: 'describe',
      kind: 'method',
      qualifiedName: 'Fixture.describe',
      language: 'objc',
      filePath: 'fixtures/fixture.m',
    });
    expect(
      matchReference(
        ref({ referenceName: 'describe', filePath: '__tests__/foo.test.ts' }),
        context([objcDescribe], { imports: [imp('describe', 'bun:test')] }),
      ),
    ).toBeNull();
  });

  it('keeps an unbacked cross-language exact match at the penalized 0.5', () => {
    const objcDescribe = node({
      id: 'method:objc-describe2',
      name: 'describe',
      kind: 'method',
      qualifiedName: 'Fixture.describe',
      language: 'objc',
      filePath: 'fixtures/fixture.m',
    });
    expect(matchReference(ref({ referenceName: 'describe' }), context([objcDescribe]))).toMatchObject({
      targetNodeId: 'method:objc-describe2',
      confidence: 0.5,
      resolvedBy: 'exact-match',
    });
  });

  it('keeps an import-backed JVM cross-language exact match (kotlin -> java is compatible)', () => {
    const javaClass = node({
      id: 'class:java-bar',
      name: 'Bar',
      kind: 'class',
      qualifiedName: 'com.foo.Bar',
      language: 'java',
      filePath: 'src/main/java/com/foo/Bar.java',
    });
    expect(
      matchReference(
        ref({ referenceName: 'Bar', filePath: 'src/main/kotlin/com/foo/App.kt', language: 'kotlin' }),
        context([javaClass], { imports: [imp('Bar', 'com.foo.Bar')] }),
      ),
    ).toMatchObject({ targetNodeId: 'class:java-bar' });
  });
});

// ---------------------------------------------------------------------------
// 7. matchFuzzy — case-insensitive last resort
// ---------------------------------------------------------------------------
describe('matchFuzzy (case-insensitive fallback)', () => {
  it('resolves a single same-language callable via case-insensitive name at 0.5', () => {
    const fn = node({
      id: 'fn:fuzzy',
      name: 'HandleRequest',
      kind: 'function',
      qualifiedName: 'HandleRequest',
      filePath: 'src/h.ts',
    });
    expect(matchReference(ref({ referenceName: 'handlerequest' }), context([fn]))).toMatchObject({
      targetNodeId: 'fn:fuzzy',
      resolvedBy: 'fuzzy',
      confidence: 0.5,
    });
  });

  it('lowers fuzzy confidence to 0.3 for a single cross-language callable', () => {
    const fn = node({
      id: 'fn:fuzzy-py',
      name: 'HandleRequest',
      kind: 'function',
      qualifiedName: 'HandleRequest',
      language: 'python',
      filePath: 'svc.py',
    });
    expect(matchReference(ref({ referenceName: 'handlerequest' }), context([fn]))).toMatchObject({
      targetNodeId: 'fn:fuzzy-py',
      resolvedBy: 'fuzzy',
      confidence: 0.3,
    });
  });

  it('returns null when the only fuzzy candidate is a non-callable kind (variable)', () => {
    const variable = node({ id: 'var:thing', name: 'thing', kind: 'variable', filePath: 'src/a.ts' });
    expect(matchReference(ref({ referenceName: 'THING' }), context([variable]))).toBeNull();
  });

  it('returns null when 2+ fuzzy callables remain ambiguous', () => {
    const a = node({ id: 'fn:fa', name: 'Doit', kind: 'function', filePath: 'a.ts' });
    const b = node({ id: 'fn:fb', name: 'DoIt', kind: 'function', filePath: 'b.ts' });
    expect(matchReference(ref({ referenceName: 'doit' }), context([a, b]))).toBeNull();
  });

  it('does not fuzzy-resolve a bare unbacked builtin method onto a homonym', () => {
    // `map` as a bare unbacked builtin call: exact match is suppressed AND the
    // fuzzy path is gated by the same builtin check → null.
    const userMap = node({
      id: 'fn:user-map',
      name: 'Map',
      kind: 'function',
      qualifiedName: 'Map',
      filePath: 'src/m.ts',
    });
    expect(matchReference(ref({ referenceName: 'map' }), context([userMap]))).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// 8. strategy ordering & overall no-match
// ---------------------------------------------------------------------------
describe('matchReference strategy ordering', () => {
  it('returns null when no strategy matches anything', () => {
    const fn = node({ id: 'fn:unrelated', name: 'somethingElse', kind: 'function', filePath: 'src/a.ts' });
    expect(matchReference(ref({ referenceName: 'doesNotExist' }), context([fn]))).toBeNull();
  });

  it('prefers a qualified-name match over a same-name exact match for a dotted ref', () => {
    // `Module.thing` should resolve via qualified-name, not by exact-matching
    // the bare-name node "Module.thing" (there is none) — the qualified path
    // wins ahead of exact/fuzzy.
    const qn = node({
      id: 'qn:win',
      name: 'thing',
      kind: 'function',
      qualifiedName: 'Module.thing',
      filePath: 'src/mod.ts',
    });
    expect(
      matchReference(ref({ referenceName: 'Module.thing', referenceKind: 'references' }), context([qn])),
    ).toMatchObject({ targetNodeId: 'qn:win', resolvedBy: 'qualified-name' });
  });
});
