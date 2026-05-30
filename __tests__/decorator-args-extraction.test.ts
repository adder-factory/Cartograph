/**
 * B9 (2026-05-26) — Decorator argument literal extraction.
 *
 * Verifies that `tsExtractDecoratorsFor` captures the URL paths,
 * topic names, config keys, and identifier args from decorator
 * call expressions. The captured data lands on `Node.decoratorArgs`
 * and persists to the new `nodes.decorator_args` JSON column added
 * by migration 070.
 *
 * Why these tests matter: B9 is the architectural unlock for B10
 * (NestJS resolver), B11 (Spring + MyBatis), and several others.
 * Each downstream resolver reads `decoratorArgs` directly from the
 * graph — no source re-parsing. Breaking the contract here breaks
 * every downstream consumer silently.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Decorator argument extraction (B9)', () => {
  it('captures string-literal args from a NestJS-shape @Controller + @Get', () => {
    const src = `
@Controller('users')
class UsersController {
  @Get(':id')
  findOne() { return null; }
}
`;
    const result = extractFromSource('users.controller.ts', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'UsersController');
    expect(classNode).toBeDefined();
    expect(classNode!.decorators).toContain('Controller');
    expect(classNode!.decoratorArgs).toBeDefined();
    const controllerArgs = classNode!.decoratorArgs!.find((a) => a.name === 'Controller');
    expect(controllerArgs).toBeDefined();
    expect(controllerArgs!.argStrings).toEqual(['users']);

    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'findOne');
    expect(methodNode).toBeDefined();
    expect(methodNode!.decorators).toContain('Get');
    const getArgs = methodNode!.decoratorArgs!.find((a) => a.name === 'Get');
    expect(getArgs).toBeDefined();
    expect(getArgs!.argStrings).toEqual([':id']);
  });

  it('captures bare-identifier args from `@UseGuards(AuthGuard, RolesGuard)`', () => {
    const src = `
@UseGuards(AuthGuard, RolesGuard)
class GuardedController {
  hello() { return null; }
}
`;
    const result = extractFromSource('guarded.controller.ts', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'GuardedController');
    expect(classNode).toBeDefined();
    const args = classNode!.decoratorArgs!.find((a) => a.name === 'UseGuards');
    expect(args).toBeDefined();
    expect(args!.argIdents).toEqual(['AuthGuard', 'RolesGuard']);
    expect(args!.argStrings).toEqual([]);
  });

  it('captures mixed string + identifier args', () => {
    const src = `
@SetMetadata('roles', AdminRole)
class Mixed {
  m() { return null; }
}
`;
    const result = extractFromSource('mixed.ts', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'Mixed');
    expect(classNode).toBeDefined();
    const args = classNode!.decoratorArgs!.find((a) => a.name === 'SetMetadata');
    expect(args).toBeDefined();
    expect(args!.argStrings).toEqual(['roles']);
    expect(args!.argIdents).toEqual(['AdminRole']);
  });

  it('decoratorArgs is undefined when no decorators are call-form', () => {
    // Bare-form decorators (no `(...)`) record null at the index — they
    // get filtered out before persistence, so the field stays undefined
    // when EVERY decorator is bare. This keeps the DB column NULL on
    // pre-B9 patterns (legacy `@Override`-style decorators).
    const src = `
@Override
class X {
  m() { return null; }
}
`;
    const result = extractFromSource('x.ts', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'X');
    expect(classNode).toBeDefined();
    expect(classNode!.decorators).toContain('Override');
    expect(classNode!.decoratorArgs).toBeUndefined();
  });

  it('captures Spring-shape @RequestMapping("/path") on a Java method', () => {
    // F#64c (2026-05-26) — `findDecoratorCallExpression` +
    // `extractDecoratorCallArgs` now recognise Java's
    // `annotation > annotation_argument_list` shape (distinct from
    // TS/JS's `decorator > call_expression > arguments`). Before
    // F#64c this contract was best-effort; after it the assertion
    // is firm because the Spring `@Value` linkage hook depends on it.
    const src = `
class UserController {
  @RequestMapping("/users")
  public String findAll() { return ""; }
}
`;
    const result = extractFromSource('UserController.java', src);
    const methodNode = result.nodes.find((n) => n.kind === 'method' && n.name === 'findAll');
    expect(methodNode).toBeDefined();
    expect(methodNode!.decorators).toContain('RequestMapping');
    expect(methodNode!.decoratorArgs).toBeDefined();
    const reqMapping = methodNode!.decoratorArgs!.find((a) => a.name === 'RequestMapping');
    expect(reqMapping).toBeDefined();
    expect(reqMapping!.argStrings).toContain('/users');
  });

  it('captures Java `element_value_pair` named args incl. boolean (F#83)', () => {
    // `@ReactMethod(isBlockingSynchronousMethod = true)` parses as
    // `annotation_argument_list > element_value_pair > [key:identifier,
    // value:true]`. Before F#83 there was no branch for `element_value_pair`,
    // so the whole pair was dropped → `decoratorArgs = NULL` on Java.
    const src = `
class MyModule {
  @ReactMethod(isBlockingSynchronousMethod = true)
  public void doWork() {}

  @RequestMapping(value = "/users", method = "GET")
  public String findAll() { return ""; }
}
`;
    const result = extractFromSource('MyModule.java', src);
    const doWork = result.nodes.find((n) => n.kind === 'method' && n.name === 'doWork');
    expect(doWork).toBeDefined();
    const rm = doWork!.decoratorArgs!.find((a) => a.name === 'ReactMethod');
    expect(rm).toBeDefined();
    // Boolean value captured as the text 'true'.
    expect(rm!.namedArgs).toEqual({ isBlockingSynchronousMethod: 'true' });

    const findAll = result.nodes.find((n) => n.kind === 'method' && n.name === 'findAll');
    const reqMapping = findAll!.decoratorArgs!.find((a) => a.name === 'RequestMapping');
    expect(reqMapping).toBeDefined();
    // String-valued named args land in namedArgs; the numeric arms are skipped.
    expect(reqMapping!.namedArgs).toEqual({ value: '/users', method: 'GET' });
  });

  it('captures Kotlin named `value_argument` value incl. boolean (F#84)', () => {
    // `@ReactProp(name = "x")` parses as `value_argument > [simple_identifier
    // "name", string_literal "x"]` (no `name:` field). Before F#84 the unwrap
    // grabbed the leading KEY identifier and dropped the value, so the value
    // never reached decoratorArgs.
    const src = `
class C {
  @ReactProp(name = "x", defaultBoolean = true)
  fun setX() {}

  @GetMapping("/path")
  fun list() {}
}
`;
    const result = extractFromSource('C.kt', src);
    const setX = result.nodes.find((n) => n.kind === 'method' && n.name === 'setX');
    expect(setX).toBeDefined();
    const rp = setX!.decoratorArgs!.find((a) => a.name === 'ReactProp');
    expect(rp).toBeDefined();
    expect(rp!.namedArgs).toEqual({ name: 'x', defaultBoolean: 'true' });

    // Regression guard: a POSITIONAL Kotlin arg still flows to argStrings,
    // not namedArgs (the named-arg branch must not swallow positionals).
    const list = result.nodes.find((n) => n.kind === 'method' && n.name === 'list');
    const gm = list!.decoratorArgs!.find((a) => a.name === 'GetMapping');
    expect(gm).toBeDefined();
    expect(gm!.argStrings).toEqual(['/path']);
    expect(gm!.namedArgs).toBeUndefined();
  });

  it('captures PHP-8-attribute NAMED args into namedArgs (Drupal v4 `#[Block(id: …)]`)', () => {
    // Drupal v4 — `#[Block(id: 'my_block')]` parses as
    // `attribute > parameters:(arguments (argument name:(name) (string …)))`.
    // The named-arg path records each `name: value` into `namedArgs`; the
    // Drupal plugin hook reads `namedArgs.id` to synthesize the plugin node.
    const src = `<?php
use Drupal\\Core\\Block\\Attribute\\Block;
#[Block(id: 'my_block', admin_label: 'My Block', category: 'Custom')]
class MyBlockPlugin {}
`;
    const result = extractFromSource('MyBlockPlugin.php', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'MyBlockPlugin');
    expect(classNode).toBeDefined();
    expect(classNode!.decorators).toContain('Block');
    const blockArgs = classNode!.decoratorArgs!.find((a) => a.name === 'Block');
    expect(blockArgs).toBeDefined();
    expect(blockArgs!.namedArgs).toEqual({ id: 'my_block', admin_label: 'My Block', category: 'Custom' });
    // Named args are NOT positional — they must not leak into argStrings.
    expect(blockArgs!.argStrings).toEqual([]);
  });

  it('collapses an inline-FQCN PHP attribute to its bare name', () => {
    // `#[\Drupal\…\Action(id: 'x')]` — the attribute name parses as a
    // `qualified_name`; `recordDecoratorIfPresent` strips the `\`-prefix to
    // the last segment so the decorator name matches the bare-`use` form.
    const src = `<?php
#[\\Drupal\\Core\\Action\\Attribute\\Action(id: 'fqcn_action')]
class MyActionPlugin {}
`;
    const result = extractFromSource('MyActionPlugin.php', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'MyActionPlugin');
    expect(classNode).toBeDefined();
    expect(classNode!.decorators).toContain('Action');
    const actionArgs = classNode!.decoratorArgs!.find((a) => a.name === 'Action');
    expect(actionArgs).toBeDefined();
    expect(actionArgs!.namedArgs).toEqual({ id: 'fqcn_action' });
  });

  it('routes a POSITIONAL PHP attribute arg to argStrings (not namedArgs)', () => {
    // A positional `argument` (no `name:` field) must still flow through the
    // shared string bucket — a regression guard so the named-arg branch
    // doesn't swallow positional attribute args.
    const src = `<?php
#[Action('positional_only')]
class PositionalPlugin {}
`;
    const result = extractFromSource('PositionalPlugin.php', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'PositionalPlugin');
    expect(classNode).toBeDefined();
    const args = classNode!.decoratorArgs!.find((a) => a.name === 'Action');
    expect(args).toBeDefined();
    expect(args!.argStrings).toEqual(['positional_only']);
    expect(args!.namedArgs).toBeUndefined();
  });

  it('positional alignment: decorators and decoratorArgs stay in sync', () => {
    // The compact representation drops null entries, so when SOME
    // decorators are bare and others are call-form, the surviving
    // decoratorArgs entries should still find their pair in decorators
    // via the `.find(a => a.name === X)` lookup the framework
    // resolvers use. Position-alignment is NOT required (because
    // multiple decorators can share a name in some edge cases — last
    // write wins is fine).
    const src = `
@Override
@Get('/api')
class Mixed {
  m() { return null; }
}
`;
    const result = extractFromSource('mixed-bare-and-call.ts', src);
    const classNode = result.nodes.find((n) => n.kind === 'class' && n.name === 'Mixed');
    expect(classNode).toBeDefined();
    expect(classNode!.decorators).toContain('Override');
    expect(classNode!.decorators).toContain('Get');
    const getArgs = classNode!.decoratorArgs!.find((a) => a.name === 'Get');
    expect(getArgs).toBeDefined();
    expect(getArgs!.argStrings).toEqual(['/api']);
  });
});
