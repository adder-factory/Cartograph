/**
 * F#62 — Drupal framework resolver, YAML language, and the
 * FrameworkResolver.extract() interface extension.
 * F#69 (2026-05-28) — hook-implementation discovery moved out of
 * `extract()` into the [`drupal-hooks` index-hook](../src/index-hooks/drupal-hooks.ts).
 *
 * Tests cover:
 *   - Drupal detection from composer.json (drupal/* dep)
 *   - Routing.yml parsing via tree-sitter-yaml AST (NOT regex)
 *   - `_controller` FQCN → method-on-class resolution
 *   - `_form` FQCN → class resolution
 *   - Hook detection via docblock `@Implements hook_X()` (F#69 hook)
 *   - Hook detection via name pattern `{moduleName}_X` (F#69 hook)
 *   - PHP_DEF .module/.install/.theme/.inc extension routing
 *   - YAML language registration
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';
import { isLanguageSupported, getLanguageDisplayName, detectLanguage } from '../src/extraction/grammars.js';
import { drupalResolver } from '../src/resolution/frameworks/drupal.js';
import type { ResolutionContext } from '../src/resolution/types.js';

function detectionContext(readFile: ResolutionContext['readFile']): ResolutionContext {
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => [],
    getNodesByKind: () => [],
    fileExists: () => false,
    readFile,
    getProjectRoot: () => '',
    getAllFiles: () => [],
    getNodesByLowerName: () => [],
    getImportMappings: () => [],
  };
}

describe('YAML language registration (F#62)', () => {
  it('registers yaml as a supported language with the right display name', () => {
    expect(isLanguageSupported('yaml')).toBe(true);
    expect(getLanguageDisplayName('yaml')).toBe('YAML');
  });

  it('detects .yml and .yaml files as yaml', () => {
    expect(detectLanguage('config.yml')).toBe('yaml');
    expect(detectLanguage('config.yaml')).toBe('yaml');
    expect(detectLanguage('my_module.routing.yml')).toBe('yaml');
  });
});

describe('Drupal framework resolver (F#62)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('detects a Drupal project via composer.json drupal/* deps', () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const detected = drupalResolver.detect(
      detectionContext((relPath: string) => {
        const abs = path.join(tempDir, relPath);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      }),
    );
    expect(detected).toBe(true);
  });

  it('rejects a non-Drupal composer project', () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'laravel/framework': '^10.0' } }),
    );
    const detected = drupalResolver.detect(
      detectionContext((relPath: string) => {
        const abs = path.join(tempDir, relPath);
        return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
      }),
    );
    expect(detected).toBe(false);
  });

  it('ignores inherited composer require fields during Drupal detection', () => {
    fs.writeFileSync(path.join(tempDir, 'composer.json'), '{}');
    Object.defineProperty(Object.prototype, 'require', {
      configurable: true,
      writable: true,
      value: { 'drupal/core-recommended': '~10.5' },
    });

    try {
      const detected = drupalResolver.detect(
        detectionContext((relPath: string) => {
          const abs = path.join(tempDir, relPath);
          return fs.existsSync(abs) ? fs.readFileSync(abs, 'utf-8') : null;
        }),
      );
      expect(detected).toBe(false);
    } finally {
      Reflect.deleteProperty(Object.prototype, 'require');
    }
  });

  it('end-to-end: routing.yml route → PHP controller method edge', async () => {
    // Minimal Drupal project — composer.json triggers detection;
    // routing.yml declares the route; PHP controller class+method
    // are indexed via tree-sitter; the framework resolver bridges them.
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src', 'Controller'), { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.routing.yml'),
      [
        'my_module.hello:',
        "  path: '/hello'",
        '  defaults:',
        String.raw`    _controller: '\Drupal\my_module\Controller\HelloController::build'`,
        "    _title: 'Hello'",
        '  requirements:',
        "    _permission: 'access content'",
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(modDir, 'src', 'Controller', 'HelloController.php'),
      [
        '<?php',
        String.raw`namespace Drupal\my_module\Controller;`,
        String.raw`use Drupal\Core\Controller\ControllerBase;`,
        'class HelloController extends ControllerBase {',
        '  public function build() {',
        "    return ['#markup' => 'Hello'];",
        '  }',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // Route node — created by the Drupal resolver from routing.yml.
    const routes = getNodesByKind(cg.queries, 'route');
    expect(routes.length).toBeGreaterThan(0);
    const helloRoute = routes.find((r) => r.name.includes('/hello'));
    expect(helloRoute, 'route node should exist for /hello').toBeDefined();

    // Controller method indexed via the tree-sitter PHP path.
    const methods = getNodesByKind(cg.queries, 'method');
    const buildMethod = methods.find((m) => m.name === 'build' && m.filePath.includes('HelloController'));
    expect(buildMethod, 'HelloController::build should be indexed').toBeDefined();

    // The route → method edge is what F#62 ships. Without it, the
    // routing.yml reference dead-ends. The resolver's `_controller`
    // FQCN match (`\Drupal\…\HelloController::build`) → method
    // lookup is the bridge.
    const outEdges = getOutgoingEdges(cg.queries, helloRoute!.id);
    expect(outEdges.length).toBeGreaterThan(0);
    const refToBuild = outEdges.find((e) => e.target === buildMethod!.id);
    expect(refToBuild, 'route → HelloController.build edge should exist').toBeDefined();
  });

  it('end-to-end: .module file with docblock-annotated hook implementation', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.module'),
      [
        '<?php',
        '',
        '/**',
        ' * Implements hook_form_alter().',
        ' */',
        'function my_module_form_alter(&$form, $form_state, $form_id) {',
        '  // hook body',
        '}',
        '',
        '/**',
        ' * Some helper that is NOT a hook (no @Implements + no module prefix).',
        ' */',
        'function helper_not_a_hook() { return 1; }',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // Function node — should exist (PHP_DEF extension mapping picked
    // up .module).
    const funcs = getNodesByKind(cg.queries, 'function');
    const hookFn = funcs.find((f) => f.name === 'my_module_form_alter');
    expect(hookFn, 'my_module_form_alter function should be indexed').toBeDefined();
    expect(hookFn!.language).toBe('php');

    // F#69 + Drupal v4 — the drupal-hooks index-hook walks the indexed PHP
    // function nodes (docstring strategy A: `Implements hook_X()`) and emits
    // a `references` edge from the implementation to the hook's CONTRACT
    // node. Core's real `hook_form_alter` stub isn't indexed here, so the
    // hook synthesizes a virtual `resource` node named `hook_form_alter` and
    // the impl points at it (no longer the old canonical-impl self-edge).
    // `helper_not_a_hook` matches neither docblock nor module prefix, so it
    // MUST NOT emit a hook edge.
    const hookEdges = getOutgoingEdges(cg.queries, hookFn!.id).filter(
      (e) => e.kind === 'references' && e.metadata?.synthesizedBy === 'drupal-hooks',
    );
    expect(hookEdges.length, 'drupal-hooks should emit a references edge for the @Implements docblock').toBe(1);
    expect(hookEdges[0]!.metadata?.hookName).toBe('hook_form_alter');
    // v4: the edge targets a synthesized virtual hook contract node.
    const hookNode = getNodesByKind(cg.queries, 'resource').find((r) => r.name === 'hook_form_alter');
    expect(hookNode, 'virtual hook_form_alter contract node should exist').toBeDefined();
    expect(hookEdges[0]!.target, 'impl → virtual hook node').toBe(hookNode!.id);
    expect(hookEdges[0]!.target, 'not a self-edge to the impl').not.toBe(hookFn!.id);

    const helper = funcs.find((f) => f.name === 'helper_not_a_hook');
    expect(helper, 'helper_not_a_hook should be indexed').toBeDefined();
    const helperHookEdges = getOutgoingEdges(cg.queries, helper!.id).filter(
      (e) => e.kind === 'references' && e.metadata?.synthesizedBy === 'drupal-hooks',
    );
    expect(helperHookEdges.length, 'non-hook helper should not emit a drupal-hooks edge').toBe(0);
  });

  it('end-to-end: name-pattern hook detection (no docblock)', async () => {
    // F#69 strategy B — function name matches `{moduleName}_X` but
    // has no docblock. The drupal-hooks index-hook should still emit
    // a `references` edge tagged with the inferred hook name.
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.module'),
      ['<?php', '', 'function my_module_install() {', '  // hook_install body, no docblock', '}', ''].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const funcs = getNodesByKind(cg.queries, 'function');
    const hookFn = funcs.find((f) => f.name === 'my_module_install');
    expect(hookFn, 'my_module_install should be indexed').toBeDefined();

    const hookEdges = getOutgoingEdges(cg.queries, hookFn!.id).filter(
      (e) => e.kind === 'references' && e.metadata?.synthesizedBy === 'drupal-hooks',
    );
    expect(hookEdges.length, 'name-pattern fallback should emit a hook edge').toBe(1);
    expect(hookEdges[0]!.metadata?.hookName).toBe('hook_install');
    // v4: strategy-B impls also point at a synthesized virtual hook node.
    const hookNode = getNodesByKind(cg.queries, 'resource').find((r) => r.name === 'hook_install');
    expect(hookNode, 'virtual hook_install contract node should exist').toBeDefined();
    expect(hookEdges[0]!.target, 'name-pattern impl → virtual hook node').toBe(hookNode!.id);
  });
});

describe('Drupal services.yml (v2, 2026-05-29)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-svc-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  async function buildServicesFixture(): Promise<void> {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  _defaults:', // pseudo-key — must NOT become a node
        '    autowire: true',
        '  my_module.cleaner:',
        String.raw`    class: Drupal\my_module\Cleaner`,
        "    arguments: ['@my_module.helper']", // service→service ref
        '  my_module.helper:',
        String.raw`    class: Drupal\my_module\Helper`,
        '  my_module.cleaner_alias:',
        '    alias: my_module.cleaner', // alias → service ref
        '',
      ].join('\n'),
    );
    const cls = (name: string): string =>
      ['<?php', String.raw`namespace Drupal\my_module;`, `class ${name} {`, '  public function run() {}', '}', ''].join(
        '\n',
      );
    fs.writeFileSync(path.join(modDir, 'src', 'Cleaner.php'), cls('Cleaner'));
    fs.writeFileSync(path.join(modDir, 'src', 'Helper.php'), cls('Helper'));
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
  }

  it('emits a resource node per service and skips the _defaults pseudo-key', async () => {
    await buildServicesFixture();
    const resources = getNodesByKind(cg!.queries, 'resource');
    const ids = resources.map((r) => r.name);
    expect(ids).toContain('my_module.cleaner');
    expect(ids).toContain('my_module.helper');
    expect(ids).toContain('my_module.cleaner_alias');
    expect(ids, '_defaults is a Symfony DI pseudo-key, not a service').not.toContain('_defaults');
  });

  it('resolves a service to its implementing class (class: FQCN → class node)', async () => {
    await buildServicesFixture();
    const cleaner = getNodesByKind(cg!.queries, 'resource').find((r) => r.name === 'my_module.cleaner')!;
    const cleanerClass = getNodesByKind(cg!.queries, 'class').find((c) => c.name === 'Cleaner')!;
    expect(cleanerClass, 'Cleaner class should be indexed').toBeDefined();
    const edge = getOutgoingEdges(cg!.queries, cleaner.id).find((e) => e.target === cleanerClass.id);
    expect(edge, 'service → implementing-class edge should exist').toBeDefined();
  });

  it('resolves @service_id arguments and alias targets to the referenced service node', async () => {
    await buildServicesFixture();
    const resources = getNodesByKind(cg!.queries, 'resource');
    const cleaner = resources.find((r) => r.name === 'my_module.cleaner')!;
    const helper = resources.find((r) => r.name === 'my_module.helper')!;
    const alias = resources.find((r) => r.name === 'my_module.cleaner_alias')!;
    // cleaner's `arguments: ['@my_module.helper']` → cleaner → helper edge
    expect(
      getOutgoingEdges(cg!.queries, cleaner.id).some((e) => e.target === helper.id),
      'cleaner → helper service-argument edge',
    ).toBe(true);
    // alias → cleaner edge
    expect(
      getOutgoingEdges(cg!.queries, alias.id).some((e) => e.target === cleaner.id),
      'alias → cleaner edge',
    ).toBe(true);
  });

  it('resolves @service args written in YAML block-sequence form (- "@svc")', async () => {
    // The flow form `['@x']` is covered above; this pins the block form,
    // which collectSequenceScalars handles via block_sequence_item leaves.
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  my_module.cleaner:',
        String.raw`    class: Drupal\my_module\Cleaner`,
        '    arguments:', // block-sequence form (not inline ['...'])
        "      - '@my_module.helper'",
        '  my_module.helper:',
        String.raw`    class: Drupal\my_module\Helper`,
        '',
      ].join('\n'),
    );
    const cls = (name: string): string =>
      ['<?php', String.raw`namespace Drupal\my_module;`, `class ${name} {}`, ''].join('\n');
    fs.writeFileSync(path.join(modDir, 'src', 'Cleaner.php'), cls('Cleaner'));
    fs.writeFileSync(path.join(modDir, 'src', 'Helper.php'), cls('Helper'));
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const cleaner = resources.find((r) => r.name === 'my_module.cleaner')!;
    const helper = resources.find((r) => r.name === 'my_module.helper')!;
    expect(
      getOutgoingEdges(cg.queries, cleaner.id).some((e) => e.target === helper.id),
      'block-form arg → helper edge',
    ).toBe(true);
  });

  it('wires services.yml parent: and @service factory: references', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  my_module.base:',
        String.raw`    class: Drupal\my_module\Base`,
        '  my_module.factory:',
        String.raw`    class: Drupal\my_module\FactoryService`,
        '  my_module.child:',
        '    parent: my_module.base', // parent → base service
        "    factory: ['@my_module.factory', 'create']", // @factory → factory service
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    const resources = getNodesByKind(cg.queries, 'resource');
    const child = resources.find((r) => r.name === 'my_module.child')!;
    const base = resources.find((r) => r.name === 'my_module.base')!;
    const factory = resources.find((r) => r.name === 'my_module.factory')!;
    const targets = getOutgoingEdges(cg.queries, child.id).map((e) => e.target);
    expect(targets, 'child → parent(base) edge').toContain(base.id);
    expect(targets, 'child → factory service edge').toContain(factory.id);
  });

  it('wires class-static-method factory: (→ class FQCN) and named ($arg) arguments (v4)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~11.0' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(path.join(modDir, 'src'), { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  my_module.logger_factory:',
        String.raw`    class: Drupal\my_module\LoggerFactory`,
        '  my_module.made:',
        String.raw`    factory: ['Drupal\my_module\LoggerFactory', 'create']`, // class-static → class FQCN
        '  my_module.consumer:',
        String.raw`    class: Drupal\my_module\Consumer`,
        '    arguments:',
        "      $factory: '@my_module.logger_factory'", // named arg → service ref
        '',
      ].join('\n'),
    );
    const cls = (name: string): string =>
      [
        '<?php',
        String.raw`namespace Drupal\my_module;`,
        `class ${name} {`,
        '  public function create() {}',
        '}',
        '',
      ].join('\n');
    fs.writeFileSync(path.join(modDir, 'src', 'LoggerFactory.php'), cls('LoggerFactory'));
    fs.writeFileSync(path.join(modDir, 'src', 'Consumer.php'), cls('Consumer'));
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const made = resources.find((r) => r.name === 'my_module.made')!;
    const consumer = resources.find((r) => r.name === 'my_module.consumer')!;
    const loggerFactorySvc = resources.find((r) => r.name === 'my_module.logger_factory')!;
    const factoryClass = getNodesByKind(cg.queries, 'class').find((c) => c.name === 'LoggerFactory')!;
    expect(factoryClass, 'LoggerFactory class indexed').toBeDefined();
    // class-static-method factory → the class FQCN (resolves to the class node).
    expect(
      getOutgoingEdges(cg.queries, made.id).some((e) => e.target === factoryClass.id),
      'made → LoggerFactory class (class-static factory)',
    ).toBe(true);
    // named arg `$factory: '@my_module.logger_factory'` → the service node.
    expect(
      getOutgoingEdges(cg.queries, consumer.id).some((e) => e.target === loggerFactorySvc.id),
      'consumer → logger_factory service (named arg)',
    ).toBe(true);
  });
});

describe('Drupal service tags (v4, 2026-05-29)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-tags-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('links tag providers and consumers ACROSS modules through one tag hub node', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    // Provider lives in module_a; consumer in module_b — different files, so
    // the linkage can only come from the project-wide drupal-service-tags hook.
    const modA = path.join(tempDir, 'web', 'modules', 'custom', 'module_a');
    const modB = path.join(tempDir, 'web', 'modules', 'custom', 'module_b');
    fs.mkdirSync(modA, { recursive: true });
    fs.mkdirSync(modB, { recursive: true });
    fs.writeFileSync(
      path.join(modA, 'module_a.services.yml'),
      [
        'services:',
        '  module_a.subscriber:',
        String.raw`    class: Drupal\module_a\Subscriber`,
        '    tags:',
        '      - { name: event_subscriber }',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(modB, 'module_b.services.yml'),
      [
        'services:',
        '  module_b.dispatcher:',
        String.raw`    class: Drupal\module_b\Dispatcher`,
        '    arguments: [!tagged_iterator event_subscriber]',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const tagHub = resources.find((r) => r.name === 'event_subscriber');
    expect(tagHub, 'a resource hub node named after the tag').toBeDefined();

    const subscriber = resources.find((r) => r.name === 'module_a.subscriber')!;
    const dispatcher = resources.find((r) => r.name === 'module_b.dispatcher')!;
    const provideEdge = getOutgoingEdges(cg.queries, subscriber.id).find((e) => e.target === tagHub!.id);
    expect(provideEdge, 'provider → tag hub edge').toBeDefined();
    expect(provideEdge!.metadata?.synthesizedBy).toBe('drupal-service-tags');
    expect(provideEdge!.metadata?.role).toBe('provides');
    const consumeEdge = getOutgoingEdges(cg.queries, dispatcher.id).find((e) => e.target === tagHub!.id);
    expect(consumeEdge, 'consumer → tag hub edge').toBeDefined();
    expect(consumeEdge!.metadata?.role).toBe('consumes');
  });

  it('creates a hub for a consumer-only tag (provider in unindexed core)', async () => {
    // The common Drupal shape: a module injects services tagged by core
    // (e.g. `event_subscriber`), but core itself isn't indexed — so the tag
    // has consumers but no indexed provider. The hub must still be created
    // (a regression guard against keying hub creation on providers).
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const modDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module');
    fs.mkdirSync(modDir, { recursive: true });
    fs.writeFileSync(
      path.join(modDir, 'my_module.services.yml'),
      [
        'services:',
        '  my_module.dispatcher:',
        String.raw`    class: Drupal\my_module\Dispatcher`,
        '    arguments: [!tagged_iterator core.unindexed_tag]',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const tagHub = resources.find((r) => r.name === 'core.unindexed_tag');
    expect(tagHub, 'hub node created even with no indexed provider').toBeDefined();
    const dispatcher = resources.find((r) => r.name === 'my_module.dispatcher')!;
    const consumeEdge = getOutgoingEdges(cg.queries, dispatcher.id).find((e) => e.target === tagHub!.id);
    expect(consumeEdge, 'consumer → hub edge').toBeDefined();
    expect(consumeEdge!.metadata?.role).toBe('consumes');
    // No provider edge exists for this tag.
    const providerEdges = getOutgoingEdges(cg.queries, dispatcher.id).filter(
      (e) => e.target === tagHub!.id && e.metadata?.role === 'provides',
    );
    expect(providerEdges.length, 'no provides edge for a consumer-only tag').toBe(0);
  });
});

describe('Drupal plugin annotations (v3, 2026-05-29)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-drupal-plugin-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('emits a resource node per docblock-annotated plugin + an edge to its class', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~10.5' } }),
    );
    const blockDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module', 'src', 'Plugin', 'Block');
    fs.mkdirSync(blockDir, { recursive: true });
    fs.writeFileSync(
      path.join(blockDir, 'AnnoBlock.php'),
      [
        '<?php',
        String.raw`namespace Drupal\my_module\Plugin\Block;`,
        String.raw`use Drupal\Core\Block\BlockBase;`,
        '/**',
        ' * Provides a custom block.',
        ' *',
        ' * @Block(',
        '  *   id = "my_anno_block",',
        '  *   admin_label = @Translation("My Anno Block")',
        ' * )',
        ' */',
        'class AnnoBlock extends BlockBase {}',
        // A non-plugin class with a docblock that has NO `id =` must NOT
        // produce a resource node (guards the LIKE pre-filter + regex).
        '',
        '/**',
        ' * Just a helper, not a plugin.',
        ' */',
        'class PlainHelper {}',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const plugin = resources.find((r) => r.name === 'my_anno_block');
    expect(plugin, 'plugin resource node named by its id').toBeDefined();
    expect(plugin!.qualifiedName, 'qualifiedName encodes the plugin type').toContain('Block:my_anno_block');
    // No spurious resource node for the non-plugin class.
    expect(resources.some((r) => r.name === 'PlainHelper')).toBe(false);

    const annoClass = getNodesByKind(cg.queries, 'class').find((c) => c.name === 'AnnoBlock')!;
    const edge = getOutgoingEdges(cg.queries, plugin!.id).find((e) => e.target === annoClass.id);
    expect(edge, 'plugin → implementing-class edge').toBeDefined();
    expect(edge!.metadata?.synthesizedBy).toBe('drupal-plugins');
  });

  it('emits a resource node per PHP-8-attribute plugin + an edge to its class (v4)', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'composer.json'),
      JSON.stringify({ require: { 'drupal/core-recommended': '~11.0' } }),
    );
    const blockDir = path.join(tempDir, 'web', 'modules', 'custom', 'my_module', 'src', 'Plugin', 'Block');
    fs.mkdirSync(blockDir, { recursive: true });
    fs.writeFileSync(
      path.join(blockDir, 'AttrBlock.php'),
      [
        '<?php',
        String.raw`namespace Drupal\my_module\Plugin\Block;`,
        String.raw`use Drupal\Core\Block\BlockBase;`,
        String.raw`use Drupal\Core\Block\Attribute\Block;`,
        String.raw`use Drupal\Core\StringTranslation\TranslatableMarkup;`,
        '',
        '#[Block(',
        "  id: 'my_attr_block',",
        "  admin_label: new TranslatableMarkup('My Attr Block')",
        ')]',
        'class AttrBlock extends BlockBase {}',
        // A class with an attribute but NO `id:` must NOT become a plugin.
        '',
        String.raw`#[\Attribute]`,
        'class NotAPlugin {}',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const resources = getNodesByKind(cg.queries, 'resource');
    const plugin = resources.find((r) => r.name === 'my_attr_block');
    expect(plugin, 'attribute plugin resource node named by its id').toBeDefined();
    expect(plugin!.qualifiedName, 'qualifiedName encodes the plugin type').toContain('Block:my_attr_block');
    // No spurious resource node for the id-less attribute class.
    expect(resources.some((r) => r.name === 'NotAPlugin')).toBe(false);

    const attrClass = getNodesByKind(cg.queries, 'class').find((c) => c.name === 'AttrBlock')!;
    const edge = getOutgoingEdges(cg.queries, plugin!.id).find((e) => e.target === attrClass.id);
    expect(edge, 'plugin → implementing-class edge').toBeDefined();
    expect(edge!.metadata?.synthesizedBy).toBe('drupal-plugins');
  });
});
