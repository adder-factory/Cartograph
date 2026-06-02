/**
 * Expo Modules resolver (B12 sub-channel 3, 2026-05-29).
 *
 * Layers, each catching a distinct failure mode:
 *  1. Pure DSL parse (`expo-modules-bridge.ts`) — the Module/Name/Function regexes.
 *  2. The synthesizer (`extractNodes`) — mints method nodes the grammar can't
 *     give (the JS-visible names are string args, unreachable from the graph).
 *  3. `detect()` — Expo project recognition.
 *  4. `resolve()` — bridges a JS member-call ref to the `ExpoExport` node by
 *     name (iOS/swift-preferred); JS-only.
 *
 * Plus end-to-end tests (the ARBITER): they prove a JS `requireNativeModule('X').foo()`
 * call bridges to the synthesized native member across the language boundary.
 * These tests are what proved upstream's resolve()-free design does NOT hold in
 * this fork (the receiver-type-driven name-matcher can't resolve an untyped
 * `requireNativeModule(...)` binding), so the resolver carries a `resolve()`.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Node, Language } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import { expoModulesResolver } from '../src/resolution/frameworks/expo-modules.js';
import { isExpoModuleSource, parseExpoModule } from '../src/resolution/expo-modules-bridge.js';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

function makeContext(fileContents: Record<string, string> = {}): ResolutionContext {
  const allFiles = new Set<string>(Object.keys(fileContents));
  return {
    getNodesInFile: () => [],
    getNodesByName: () => [],
    getNodesByQualifiedName: () => {
      throw new Error('not used');
    },
    getNodesByKind: () => [],
    getNodesByLowerName: () => {
      throw new Error('not used');
    },
    fileExists: (fp) => allFiles.has(fp),
    readFile: (fp) => fileContents[fp] ?? null,
    getProjectRoot: () => '/test',
    getAllFiles: () => Array.from(allFiles),
    getImportMappings: () => [],
  };
}

function expoNode(name: string, language: Language): Node {
  return {
    id: `expo-module:${language}/Mod.${name}:1`,
    kind: 'method',
    name,
    qualifiedName: `Mod::${name}`,
    filePath: `${language}/Mod`,
    language,
    startLine: 1,
    endLine: 1,
    startColumn: 0,
    endColumn: 0,
    decorators: ['ExpoExport'],
    updatedAt: 1,
  } as Node;
}

function ctxByName(nodes: Node[]): ResolutionContext {
  const ctx = makeContext();
  (ctx as { getNodesByName: ResolutionContext['getNodesByName'] }).getNodesByName = (name) =>
    nodes.filter((n) => n.name === name);
  return ctx;
}

function jsRef(name: string, language: Language = 'javascript'): UnresolvedRef {
  return {
    fromNodeId: 'caller',
    referenceName: name,
    referenceKind: 'calls',
    line: 1,
    column: 0,
    filePath: 'App.js',
    language,
  };
}

async function bootEdgeTargets(tempDir: string): Promise<{ cg: Cartograph; targets: string[] }> {
  const cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
  const boot = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'boot' && n.language === 'javascript');
  expect(boot, 'JS caller indexed').toBeDefined();
  return { cg, targets: getOutgoingEdges(cg.queries, boot!.id).map((e) => e.target) };
}

const SWIFT_HAPTICS = [
  'import ExpoModulesCore',
  'public class HapticsModule: Module {',
  '  public func definition() -> ModuleDefinition {',
  '    Name("ExpoHaptics")',
  '    AsyncFunction("notificationAsync") { (t: NotificationType) in }',
  '    Function("synchronousThing") { return 1 }',
  '    Property("isAvailable") { return true }',
  '    Constants(["pi": 3.14])',
  '  }',
  '}',
  '',
].join('\n');

const KOTLIN_FOO = [
  'package expo.modules.foo',
  'import expo.modules.kotlin.modules.Module',
  'import expo.modules.kotlin.modules.ModuleDefinition',
  'class FooModule : Module() {',
  '  override fun definition() = ModuleDefinition {',
  '    Name("ExpoFoo")',
  '    AsyncFunction("doAsync") { name: String -> name.uppercase() }',
  '    Function("doSync") { 42 }',
  '  }',
  '}',
  '',
].join('\n');

describe('Expo Modules — DSL parse helpers', () => {
  it('parseExpoModule (Swift): Name("X") + Function/AsyncFunction/Property members', () => {
    const parsed = parseExpoModule(SWIFT_HAPTICS);
    expect(parsed?.moduleName).toBe('ExpoHaptics');
    // `Constants(["pi": 3.14])` takes a DICT, not a string name → correctly NOT
    // a member (the pattern requires `Constants("name")`).
    expect(parsed?.members.map((m) => m.name)).toEqual(['notificationAsync', 'synchronousThing', 'isAvailable']);
  });

  it('parseExpoModule (Kotlin): module name + Function/AsyncFunction members', () => {
    const parsed = parseExpoModule(KOTLIN_FOO);
    expect(parsed?.moduleName).toBe('ExpoFoo');
    expect(parsed?.members.map((m) => m.name).sort(byString)).toEqual(['doAsync', 'doSync']);
  });

  it('parseExpoModule: falls back to the class name when there is no Name("X")', () => {
    const src =
      'public class BareModule: Module {\n  public func definition() -> ModuleDefinition {\n    Function("doX") { return 1 }\n  }\n}';
    expect(parseExpoModule(src)?.moduleName).toBe('BareModule');
  });

  it('isExpoModuleSource / parseExpoModule: a plain class (no : Module) is not an Expo module', () => {
    const src = 'class Helper {\n  func doX() { }\n}';
    expect(isExpoModuleSource(src)).toBe(false);
    expect(parseExpoModule(src)).toBeNull();
  });

  it('isExpoModuleSource: a `class X: Module` with NO DSL member literal is not enough', () => {
    expect(isExpoModuleSource('class X: Module {\n  func plain() {}\n}')).toBe(false);
  });
});

describe('Expo Modules — synthesizer (extractNodes)', () => {
  it('synthesizes a method node per DSL member, named by the JS-visible name', () => {
    const nodes = expoModulesResolver.extractNodes!('ios/HapticsModule.swift', SWIFT_HAPTICS);
    const names = nodes.map((n) => n.name);
    expect(names).toContain('notificationAsync');
    expect(names).toContain('synchronousThing');
    expect(names).toContain('isAvailable'); // Property is a method node too
    expect(nodes.every((n) => n.kind === 'method')).toBe(true);
    expect(nodes.every((n) => n.qualifiedName.includes('ExpoHaptics::'))).toBe(true);
    expect(nodes.every((n) => n.id.startsWith('expo-module:'))).toBe(true);
    expect(nodes.every((n) => n.language === 'swift')).toBe(true);
    expect(nodes.every((n) => n.decorators?.includes('ExpoExport'))).toBe(true);
  });

  it('synthesizes Kotlin members with language=kotlin', () => {
    const nodes = expoModulesResolver.extractNodes!('android/FooModule.kt', KOTLIN_FOO);
    expect(nodes.map((n) => n.name).sort(byString)).toEqual(['doAsync', 'doSync']);
    expect(nodes.every((n) => n.language === 'kotlin')).toBe(true);
  });

  it('emits nothing for a non-Expo Swift file', () => {
    expect(expoModulesResolver.extractNodes!('Helper.swift', 'class Helper {\n  func doX() {}\n}')).toEqual([]);
  });
});

describe('Expo Modules — detect()', () => {
  it('true when package.json declares expo-modules-core', () => {
    expect(
      expoModulesResolver.detect(makeContext({ 'package.json': '{"dependencies":{"expo-modules-core":"^1.0.0"}}' })),
    ).toBe(true);
  });
  it('true on a Swift Expo module source', () => {
    expect(expoModulesResolver.detect(makeContext({ 'ios/HapticsModule.swift': SWIFT_HAPTICS }))).toBe(true);
  });
  it('true on a Kotlin Expo module source', () => {
    expect(expoModulesResolver.detect(makeContext({ 'android/FooModule.kt': KOTLIN_FOO }))).toBe(true);
  });
  it('false with no Expo signals', () => {
    expect(expoModulesResolver.detect(makeContext({ 'Helper.swift': 'class Helper { func doX() {} }' }))).toBe(false);
  });
});

describe('Expo Modules — resolve()', () => {
  it('prefers the iOS (swift) target over Android (kotlin) when a module exists on both platforms', () => {
    const swift = expoNode('save', 'swift');
    const kotlin = expoNode('save', 'kotlin');
    const out = expoModulesResolver.resolve(jsRef('Store.save'), ctxByName([kotlin, swift]));
    expect(out?.targetNodeId).toBe(swift.id);
    expect(out?.resolvedBy).toBe('framework');
  });

  it('resolves a bare / receiver-qualified JS call to the ExpoExport member', () => {
    const k = expoNode('doAsync', 'kotlin');
    expect(expoModulesResolver.resolve(jsRef('Mod.doAsync'), ctxByName([k]))?.targetNodeId).toBe(k.id);
    expect(expoModulesResolver.resolve(jsRef('doAsync'), ctxByName([k]))?.targetNodeId).toBe(k.id);
  });

  it('does NOT bridge to a same-named method that is not an Expo member', () => {
    const plain = { ...expoNode('save', 'swift'), decorators: undefined } as Node;
    expect(expoModulesResolver.resolve(jsRef('x.save'), ctxByName([plain]))).toBeNull();
  });

  it('is JS-side only — a native-language caller returns null', () => {
    const swift = expoNode('save', 'swift');
    expect(expoModulesResolver.resolve(jsRef('save', 'swift'), ctxByName([swift]))).toBeNull();
  });
});

describe('Expo Modules — end-to-end (real index)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-expo-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('bridges a JS caller to a synthesized Swift Expo AsyncFunction', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      '{"name":"app","dependencies":{"expo-modules-core":"^1.0.0"}}',
    );
    fs.writeFileSync(
      path.join(tempDir, 'HapticsModule.swift'),
      [
        'import ExpoModulesCore',
        'public class HapticsModule: Module {',
        '  public func definition() -> ModuleDefinition {',
        '    Name("ExpoHaptics")',
        '    AsyncFunction("uniqueExpoHapticCall") { }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'import { requireNativeModule } from "expo-modules-core";',
        'const Haptics = requireNativeModule("ExpoHaptics");',
        'export function boot() {',
        '  Haptics.uniqueExpoHapticCall();',
        '}',
        '',
      ].join('\n'),
    );

    const booted = await bootEdgeTargets(tempDir);
    cg = booted.cg;
    const targets = booted.targets;
    const synth = getNodesByKind(cg.queries, 'method').find(
      (n) => n.name === 'uniqueExpoHapticCall' && n.language === 'swift',
    );
    expect(synth, 'Swift Expo AsyncFunction synthesized').toBeDefined();
    expect(synth!.id.startsWith('expo-module:'), 'expo-module: id namespace').toBe(true);
    expect(targets, 'JS Haptics.uniqueExpoHapticCall() → synthesized native member').toContain(synth!.id);
  });

  it('bridges a JS caller to a synthesized Kotlin Expo Function', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'package.json'),
      '{"name":"app","dependencies":{"expo-modules-core":"^1.0.0"}}',
    );
    fs.writeFileSync(
      path.join(tempDir, 'SettingsModule.kt'),
      [
        'package expo.modules.settings',
        'import expo.modules.kotlin.modules.Module',
        'import expo.modules.kotlin.modules.ModuleDefinition',
        'class SettingsModule : Module() {',
        '  override fun definition() = ModuleDefinition {',
        '    Name("ExpoSettings")',
        '    Function("uniqueExpoSettingsCall") { 1 }',
        '  }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'import { requireNativeModule } from "expo-modules-core";',
        'const Settings = requireNativeModule("ExpoSettings");',
        'export function boot() {',
        '  Settings.uniqueExpoSettingsCall();',
        '}',
        '',
      ].join('\n'),
    );

    const booted = await bootEdgeTargets(tempDir);
    cg = booted.cg;
    const targets = booted.targets;
    const synth = getNodesByKind(cg.queries, 'method').find(
      (n) => n.name === 'uniqueExpoSettingsCall' && n.language === 'kotlin',
    );
    expect(synth, 'Kotlin Expo Function synthesized').toBeDefined();
    expect(targets, 'JS Settings.uniqueExpoSettingsCall() → synthesized native member').toContain(synth!.id);
  });
});
