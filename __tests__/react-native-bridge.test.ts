/**
 * React Native bridge resolver (B12 sub-channel 2, 2026-05-29).
 *
 * Three layers, each catching a distinct failure mode:
 *  1. Pure parse helpers (`react-native-bridge.ts`) — the macro / spec regexes.
 *  2. The ObjC synthesizer (`extractNodes`) — the fork must MINT method nodes
 *     because the grammar can't parse RN bridge macros (zero method nodes
 *     otherwise; see the resolver docstring + BACKLOG F#82).
 *  3. `resolve()` over a mock context — the JS → native bridge, the
 *     RCTEventEmitter blocklist, the iOS-preference, and `clearCache`.
 *
 * Plus one end-to-end test against a real index: the synthesizer runs during
 * extraction, the resolver bridges, and the edge persists — the only test that
 * proves the whole pipeline (the mock tests bypass extraction + the pre-filter).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import type { Node, Language } from '../src/types.js';
import type { ResolutionContext, UnresolvedRef } from '../src/resolution/types.js';
import { reactNativeBridgeResolver } from '../src/resolution/frameworks/react-native.js';
import {
  defaultObjcModuleName,
  findObjcClassName,
  parseObjcRNExports,
  parseTurboModuleSpec,
} from '../src/resolution/react-native-bridge.js';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

/** Mock ResolutionContext. `fileContents` lets a `.ts` spec file carry source
 *  with no extracted nodes (the resolver reads it via `readFile`). */
function makeContext(nodes: Node[], fileContents: Record<string, string> = {}): ResolutionContext {
  const byName = new Map<string, Node[]>();
  for (const n of nodes) {
    const arr = byName.get(n.name);
    if (arr) arr.push(n);
    else byName.set(n.name, [n]);
  }
  const allFiles = new Set<string>([...nodes.map((n) => n.filePath), ...Object.keys(fileContents)]);
  return {
    getNodesInFile: (fp) => nodes.filter((n) => n.filePath === fp),
    getNodesByName: (name) => byName.get(name) ?? [],
    getNodesByQualifiedName: () => {
      throw new Error('not used');
    },
    getNodesByKind: (kind) => nodes.filter((n) => n.kind === kind),
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

/** A native method node as it lands in the graph: synthesized ObjC RN methods
 *  carry `decorators: ['RCTExport']`; JVM `@ReactMethod` carry `['ReactMethod']`. */
function method(name: string, language: Language, filePath: string, decorators?: string[]): Node {
  return {
    id: `${language}:${filePath}:${name}`,
    kind: 'method',
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language,
    startLine: 10,
    endLine: 15,
    startColumn: 0,
    endColumn: 0,
    decorators,
    updatedAt: 1,
  } as Node;
}

function ref(name: string, language: Language): UnresolvedRef {
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

describe('React Native bridge — parse helpers', () => {
  it('defaultObjcModuleName strips a leading RCT prefix', () => {
    expect(defaultObjcModuleName('RCTGeolocation')).toBe('Geolocation');
    expect(defaultObjcModuleName('Bluetooth')).toBe('Bluetooth'); // no prefix → unchanged
    expect(defaultObjcModuleName('RCT')).toBe('RCT'); // too short → unchanged
  });

  it('parseObjcRNExports: RCT_EXPORT_METHOD JS name = selector first keyword', () => {
    const src =
      '@implementation RCTGeolocation\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb) {}\n@end';
    const out = parseObjcRNExports(src, findObjcClassName(src));
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ jsName: 'getCurrentPosition', moduleName: 'Geolocation' });
  });

  it('parseObjcRNExports: explicit RCT_EXPORT_MODULE(name) overrides the class name', () => {
    const src =
      '@implementation BluetoothImpl\nRCT_EXPORT_MODULE(BluetoothManager)\nRCT_EXPORT_METHOD(startScan:(id)cb) {}\n@end';
    const out = parseObjcRNExports(src, findObjcClassName(src));
    expect(out[0]?.moduleName).toBe('BluetoothManager');
  });

  it('parseObjcRNExports: RCT_REMAP_METHOD JS name = the first arg, NOT the selector', () => {
    const src =
      '@implementation Computer\nRCT_EXPORT_MODULE()\nRCT_REMAP_METHOD(compute, doInternalCompute:(NSDictionary *)opts) {}\n@end';
    const out = parseObjcRNExports(src, findObjcClassName(src));
    expect(out.map((e) => e.jsName)).toEqual(['compute']);
  });

  it('parseObjcRNExports: catches the BLOCKING_SYNCHRONOUS variant', () => {
    const src = '@implementation M\nRCT_EXPORT_MODULE()\nRCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getConstants) {}\n@end';
    expect(parseObjcRNExports(src, findObjcClassName(src)).map((e) => e.jsName)).toEqual(['getConstants']);
  });

  it('parseObjcRNExports: bails when no module name can be derived', () => {
    // No @implementation class and no RCT_EXPORT_MODULE → not a real RN module.
    expect(parseObjcRNExports('RCT_EXPORT_METHOD(foo:(id)x) {}', null)).toEqual([]);
  });

  it('parseObjcRNExports: RCT_EXTERN family — module from RCT_EXTERN_MODULE (no @implementation), methods incl. remap + blocking', () => {
    const src = [
      '#import <React/RCTBridgeModule.h>',
      '@interface RCT_EXTERN_MODULE(CalendarManager, NSObject)',
      'RCT_EXTERN_METHOD(addEvent:(NSString *)name location:(NSString *)location)',
      'RCT_EXTERN_REMAP_METHOD(findAll, findAllWithResolver:(RCTPromiseResolveBlock)resolve)',
      'RCT_EXTERN__BLOCKING_SYNCHRONOUS_METHOD(getName)', // note the DOUBLE underscore
      '@end',
    ].join('\n');
    // No @implementation → className is null; the module name comes from RCT_EXTERN_MODULE.
    expect(findObjcClassName(src)).toBeNull();
    const out = parseObjcRNExports(src, findObjcClassName(src));
    expect(out.every((e) => e.moduleName === 'CalendarManager')).toBe(true);
    expect(out.map((e) => e.jsName).sort(byString)).toEqual(['addEvent', 'findAll', 'getName']);
  });

  it('parseObjcRNExports: RCT_EXTERN_REMAP_MODULE module name = the JS-name first arg (not the ObjC class)', () => {
    const src =
      '@interface RCT_EXTERN_REMAP_MODULE(CalJS, CalendarManager, NSObject)\nRCT_EXTERN_METHOD(doThing:(id)x)\n@end';
    const out = parseObjcRNExports(src, null);
    expect(out.map((e) => ({ m: e.moduleName, js: e.jsName }))).toEqual([{ m: 'CalJS', js: 'doThing' }]);
  });

  it('parseTurboModuleSpec: pulls the registry name + spec method names', () => {
    const src =
      "import { TurboModuleRegistry } from 'react-native';\n" +
      'export interface Spec extends TurboModule {\n  getTotalLength(tag: number): number;\n  readonly constants: object;\n  isPointInFill(tag: number): boolean;\n}\n' +
      "export default TurboModuleRegistry.getEnforcing<Spec>('RNSVGRenderableModule');";
    const spec = parseTurboModuleSpec(src);
    expect(spec?.moduleName).toBe('RNSVGRenderableModule');
    // `constants` is a property (no `(`) → excluded.
    expect(spec?.methods).toEqual(['getTotalLength', 'isPointInFill']);
  });

  it('parseTurboModuleSpec: returns null without both a registry call and a Spec interface', () => {
    expect(parseTurboModuleSpec("export const x = TurboModuleRegistry.getEnforcing<Spec>('Foo');")).toBeNull();
    expect(parseTurboModuleSpec('export interface Spec extends TurboModule { foo(): void; }')).toBeNull();
  });

  it('parseTurboModuleSpec: tolerates CRLF line endings (Windows-authored spec)', () => {
    const src = [
      'export interface Spec extends TurboModule {',
      '  getValue(key: string): string;',
      '}',
      "export default TurboModuleRegistry.getEnforcing<Spec>('Store');",
    ].join('\r\n');
    expect(parseTurboModuleSpec(src)?.methods).toEqual(['getValue']);
  });

  it('parseTurboModuleSpec: parses a single-line interface body', () => {
    const src =
      "export interface Spec extends TurboModule { getValue(k: string): string; setValue(k: string, v: string): void; }\nexport default TurboModuleRegistry.get<Spec>('Store');";
    expect(parseTurboModuleSpec(src)?.methods).toEqual(['getValue', 'setValue']);
  });

  it('parseTurboModuleSpec: an inline object-type return does not truncate later methods (NativeDeviceInfo shape)', () => {
    const src = [
      'export interface Spec extends TurboModule {',
      '  getConstants(): { apiVersion: string; model: string };',
      '  getValue(key: string): string;',
      '}',
      "export default TurboModuleRegistry.getEnforcing<Spec>('DeviceInfo');",
    ].join('\n');
    // Brace-balanced body extraction must reach `getValue` past the inline `{…}`.
    expect(parseTurboModuleSpec(src)?.methods).toEqual(['getConstants', 'getValue']);
  });
});

describe('React Native bridge — ObjC synthesizer (extractNodes)', () => {
  it('synthesizes a method node per RCT_EXPORT_METHOD, named by JS name, tagged RCTExport', () => {
    const src =
      '@implementation RCTGeolocation\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(getCurrentPosition:(id)cb) {}\n@end';
    const nodes = reactNativeBridgeResolver.extractNodes!('ios/RCTGeolocation.m', src);
    expect(nodes).toHaveLength(1);
    expect(nodes[0]).toMatchObject({
      kind: 'method',
      name: 'getCurrentPosition',
      language: 'objc',
      qualifiedName: 'Geolocation::getCurrentPosition',
      decorators: ['RCTExport'],
    });
  });

  it('synthesizes the RCT_REMAP_METHOD node under the JS name (not the native selector)', () => {
    const src =
      '@implementation Computer\nRCT_EXPORT_MODULE()\nRCT_REMAP_METHOD(compute, doInternalCompute:(id)x) {}\n@end';
    const nodes = reactNativeBridgeResolver.extractNodes!('ios/Computer.m', src);
    expect(nodes.map((n) => n.name)).toEqual(['compute']);
  });

  it('synthesizes RCT_EXTERN_MODULE methods (Swift-implemented bridge; no @implementation)', () => {
    // RCT_EXTERN modules have only an @interface — the grammar fails on the
    // whole block, so the synthesizer (reading source) is the only path to
    // these JS-callable methods.
    const src = [
      '@interface RCT_EXTERN_MODULE(CalendarManager, NSObject)',
      'RCT_EXTERN_METHOD(addEvent:(NSString *)name location:(NSString *)location)',
      '@end',
    ].join('\n');
    const nodes = reactNativeBridgeResolver.extractNodes!('ios/CalendarManagerBridge.m', src);
    expect(nodes.map((n) => n.name)).toEqual(['addEvent']);
    expect(nodes[0]).toMatchObject({
      kind: 'method',
      name: 'addEvent',
      language: 'objc',
      qualifiedName: 'CalendarManager::addEvent',
      decorators: ['RCTExport'],
    });
  });

  it('does NOT synthesize RCTEventEmitter built-ins (addListener / remove)', () => {
    const src =
      '@implementation EventEmitter\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(addListener:(NSString *)e) {}\nRCT_EXPORT_METHOD(remove:(double)id) {}\nRCT_EXPORT_METHOD(realMethod:(id)x) {}\n@end';
    const names = reactNativeBridgeResolver.extractNodes!('ios/EE.m', src).map((n) => n.name);
    expect(names).toEqual(['realMethod']);
  });

  it('emits nothing for a file with no RN method macros', () => {
    expect(
      reactNativeBridgeResolver.extractNodes!('ios/Plain.m', '@implementation Plain\n- (void)foo {}\n@end'),
    ).toEqual([]);
  });

  it('synthesizes on .mm (ObjC++) files too — synthesis is extension-agnostic', () => {
    const src = '@implementation Cxx\nRCT_EXPORT_MODULE()\nRCT_EXPORT_METHOD(doWork:(id)x) {}\n@end';
    const nodes = reactNativeBridgeResolver.extractNodes!('ios/Cxx.mm', src);
    expect(nodes.map((n) => n.name)).toEqual(['doWork']);
    expect(nodes[0]?.language).toBe('objc');
  });
});

describe('React Native bridge — detect()', () => {
  it('true when package.json declares react-native', () => {
    expect(
      reactNativeBridgeResolver.detect(
        makeContext([], { 'package.json': '{"dependencies":{"react-native":"^0.73"}}' }),
      ),
    ).toBe(true);
  });
  it('true on an ObjC file using RCT_EXPORT_MODULE', () => {
    expect(
      reactNativeBridgeResolver.detect(
        makeContext([], { 'NativeFoo.mm': '@implementation Foo\nRCT_EXPORT_MODULE()\n@end' }),
      ),
    ).toBe(true);
  });
  it('true on a TS file using TurboModuleRegistry', () => {
    expect(
      reactNativeBridgeResolver.detect(
        makeContext([], { 'NativeFoo.ts': "export default TurboModuleRegistry.getEnforcing<Spec>('Foo');" }),
      ),
    ).toBe(true);
  });
  it('false with no RN signals present', () => {
    expect(reactNativeBridgeResolver.detect(makeContext([method('hi', 'objc', 'X.m', ['RCTExport'])]))).toBe(false);
  });
});

describe('React Native bridge — resolve()', () => {
  it('legacy ObjC: JS call → synthesized RCTExport method node', () => {
    const native = method('getCurrentPosition', 'objc', 'ios/RCTGeolocation.m', ['RCTExport']);
    const out = reactNativeBridgeResolver.resolve(ref('getCurrentPosition', 'javascript'), makeContext([native]));
    expect(out?.targetNodeId).toBe(native.id);
    expect(out?.resolvedBy).toBe('framework');
  });

  it('legacy Android: JS call → @ReactMethod Java method node', () => {
    const native = method('getCurrentPosition', 'java', 'android/GeoModule.java', ['ReactMethod']);
    expect(
      reactNativeBridgeResolver.resolve(ref('getCurrentPosition', 'javascript'), makeContext([native]))?.targetNodeId,
    ).toBe(native.id);
  });

  it('legacy Android: Kotlin @ReactMethod resolves too', () => {
    const native = method('startScan', 'kotlin', 'android/BtModule.kt', ['ReactMethod']);
    expect(reactNativeBridgeResolver.resolve(ref('startScan', 'typescript'), makeContext([native]))?.targetNodeId).toBe(
      native.id,
    );
  });

  it('an ObjC method WITHOUT the RCTExport tag is not a legacy-bridge target', () => {
    // A plain ObjC method (not RN-exported) must not be bridged by name alone.
    const plain = method('helper', 'objc', 'ios/Thing.m');
    expect(reactNativeBridgeResolver.resolve(ref('helper', 'javascript'), makeContext([plain]))).toBeNull();
  });

  it('TurboModule: spec method matches a same-named native impl (even un-tagged Codegen)', () => {
    // react-native-svg shape: iOS Codegen impl is a regular ObjC method node.
    const native = method('getTotalLength:', 'objc', 'ios/RNSVGRenderableManager.mm');
    const ctx = makeContext([native], {
      'NativeSvg.ts':
        "import { TurboModuleRegistry } from 'react-native';\nexport interface Spec extends TurboModule {\n  getTotalLength(tag: number): number;\n}\nexport default TurboModuleRegistry.getEnforcing<Spec>('RNSVGRenderableModule');",
    });
    expect(reactNativeBridgeResolver.resolve(ref('getTotalLength', 'tsx'), ctx)?.targetNodeId).toBe(native.id);
  });

  it('TurboModule: spec method with no native impl resolves to null', () => {
    const ctx = makeContext([], {
      'NativeFoo.ts':
        "import { TurboModuleRegistry } from 'react-native';\nexport interface Spec extends TurboModule {\n  thingThatDoesntExist(): void;\n}\nexport default TurboModuleRegistry.getEnforcing<Spec>('Foo');",
    });
    expect(reactNativeBridgeResolver.resolve(ref('thingThatDoesntExist', 'tsx'), ctx)).toBeNull();
  });

  it('strips a receiver chain to the bare method name (NativeModules.Mod.compute → compute)', () => {
    const native = method('compute', 'objc', 'ios/Mod.m', ['RCTExport']);
    expect(
      reactNativeBridgeResolver.resolve(ref('NativeModules.Mod.compute', 'javascript'), makeContext([native]))
        ?.targetNodeId,
    ).toBe(native.id);
  });

  it('prefers the iOS (ObjC) target over Android when both expose the same method', () => {
    const ios = method('save', 'objc', 'ios/Store.m', ['RCTExport']);
    const android = method('save', 'kotlin', 'android/Store.kt', ['ReactMethod']);
    expect(
      reactNativeBridgeResolver.resolve(ref('save', 'javascript'), makeContext([android, ios]))?.targetNodeId,
    ).toBe(ios.id);
  });

  it('is JS-side only — native-language callers return null', () => {
    const native = method('compute', 'objc', 'ios/Mod.m', ['RCTExport']);
    expect(reactNativeBridgeResolver.resolve(ref('compute', 'objc'), makeContext([native]))).toBeNull();
  });

  it('blocklist: a real @ReactMethod addListener is NOT bridged (emitter plumbing)', () => {
    const native = method('addListener', 'java', 'android/EE.java', ['ReactMethod']);
    expect(reactNativeBridgeResolver.resolve(ref('addListener', 'javascript'), makeContext([native]))).toBeNull();
  });

  it('clearCache invalidates the per-context map so a later sync sees new modules', () => {
    let nodes: Node[] = [];
    const ctx = makeContext([]);
    // Override getNodesByKind to read the mutable `nodes` (simulates re-sync).
    (ctx as { getNodesByKind: ResolutionContext['getNodesByKind'] }).getNodesByKind = (kind) =>
      nodes.filter((n) => n.kind === kind);

    expect(reactNativeBridgeResolver.resolve(ref('later', 'javascript'), ctx)).toBeNull(); // builds + caches an empty map
    const native = method('later', 'objc', 'ios/Later.m', ['RCTExport']);
    nodes = [native];
    expect(reactNativeBridgeResolver.resolve(ref('later', 'javascript'), ctx), 'stale cache still empty').toBeNull();
    reactNativeBridgeResolver.clearCache!(ctx);
    expect(
      reactNativeBridgeResolver.resolve(ref('later', 'javascript'), ctx)?.targetNodeId,
      'rebuilt after clearCache',
    ).toBe(native.id);
  });
});

describe('React Native bridge — end-to-end (real index)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rn-bridge-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('bridges a JS caller to a synthesized ObjC method AND a Kotlin @ReactMethod', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"app","dependencies":{"react-native":"^0.73.0"}}');
    // iOS native module — the macro is unparseable, so the resolver synthesizes the node.
    fs.writeFileSync(
      path.join(tempDir, 'RCTGeolocation.m'),
      [
        '#import <React/RCTBridgeModule.h>',
        '@implementation RCTGeolocation',
        'RCT_EXPORT_MODULE()',
        'RCT_EXPORT_METHOD(getCurrentPosition:(RCTResponseSenderBlock)cb) {}',
        '@end',
        '',
      ].join('\n'),
    );
    // Android native module — @ReactMethod captured structurally.
    fs.writeFileSync(
      path.join(tempDir, 'BluetoothModule.kt'),
      [
        'package com.app',
        'import com.facebook.react.bridge.ReactContextBaseJavaModule',
        'import com.facebook.react.bridge.ReactMethod',
        'import com.facebook.react.bridge.ReactApplicationContext',
        'class BluetoothModule(c: ReactApplicationContext) : ReactContextBaseJavaModule(c) {',
        '  override fun getName() = "Bluetooth"',
        '  @ReactMethod fun startScan(cb: Callback) {}',
        '}',
        '',
      ].join('\n'),
    );
    // JS caller of both native modules.
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'import { NativeModules } from "react-native";',
        'export function boot() {',
        '  NativeModules.Geolocation.getCurrentPosition(cb);',
        '  NativeModules.Bluetooth.startScan(cb);',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const synthesized = getNodesByKind(cg.queries, 'method').find(
      (n) => n.name === 'getCurrentPosition' && n.language === 'objc',
    );
    expect(synthesized, 'ObjC RN method synthesized from the macro').toBeDefined();
    expect(synthesized!.decorators, 'tagged RCTExport').toContain('RCTExport');

    const kotlin = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'startScan' && n.language === 'kotlin');
    expect(kotlin, 'Kotlin @ReactMethod indexed').toBeDefined();

    const boot = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'boot' && n.language === 'javascript');
    expect(boot, 'JS caller indexed').toBeDefined();

    const targets = getOutgoingEdges(cg.queries, boot!.id).map((e) => e.target);
    expect(targets, 'JS getCurrentPosition → synthesized ObjC method').toContain(synthesized!.id);
    expect(targets, 'JS startScan → Kotlin @ReactMethod').toContain(kotlin!.id);
  });

  it('bridges a TurboModule spec call to a Codegen ObjC impl THROUGH the pre-filter (claimsReference)', async () => {
    // The native impl is a REGULAR ObjC method (no macro), so its node is named
    // with the selector colon — `doThing:`. The bare JS call name `doThing` is
    // NOT in knownNames, so without claimsReference the resolver's pre-filter
    // drops the ref before resolve() runs. The spec file names it, so
    // claimsReference opts it through. This exercises the full resolveOne path
    // (the resolve()-only unit test cannot — it bypasses the pre-filter).
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"app","dependencies":{"react-native":"^0.73.0"}}');
    fs.writeFileSync(
      path.join(tempDir, 'RNThingManager.m'),
      [
        '#import <Foundation/Foundation.h>',
        '@implementation RNThingManager',
        '- (void)doThing:(NSInteger)tag {}',
        '@end',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'NativeThing.ts'),
      [
        "import { TurboModuleRegistry, type TurboModule } from 'react-native';",
        'export interface Spec extends TurboModule {',
        '  doThing(tag: number): void;',
        '}',
        "export default TurboModuleRegistry.getEnforcing<Spec>('Thing');",
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'import { NativeModules } from "react-native";',
        'export function boot() {',
        '  NativeModules.Thing.doThing(1);',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const objc = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'doThing:' && n.language === 'objc');
    expect(objc, 'regular ObjC method (colon-named) indexed').toBeDefined();
    const boot = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'boot' && n.language === 'javascript');
    const targets = getOutgoingEdges(cg.queries, boot!.id).map((e) => e.target);
    expect(targets, 'JS TurboModule spec call → Codegen ObjC impl (via claimsReference)').toContain(objc!.id);
  });

  it('bridges a JS caller to a pure RCT_EXTERN_MODULE method THROUGH the anchor pre-filter', async () => {
    // A Swift-implemented module: ONLY an @interface RCT_EXTERN_MODULE block (no
    // @implementation, no RCT_EXPORT_* macro). This exercises the dispatch path
    // end-to-end: the `anchors` pre-filter must admit the file (it carries no
    // RCT_EXPORT anchor — only RCT_EXTERN_MODULE), so extractNodes runs and
    // synthesizes the method. (The unit tests call extractNodes directly and
    // bypass this gate — this test guards the anchor list.)
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"app","dependencies":{"react-native":"^0.73.0"}}');
    fs.writeFileSync(
      path.join(tempDir, 'CalendarManagerBridge.m'),
      [
        '#import <React/RCTBridgeModule.h>',
        '@interface RCT_EXTERN_MODULE(CalendarManager, NSObject)',
        'RCT_EXTERN_METHOD(addEvent:(NSString *)name location:(NSString *)location)',
        '@end',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'import { NativeModules } from "react-native";',
        'export function boot() {',
        '  NativeModules.CalendarManager.addEvent(n, l);',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const synthesized = getNodesByKind(cg.queries, 'method').find(
      (n) => n.name === 'addEvent' && n.language === 'objc',
    );
    expect(synthesized, 'RCT_EXTERN method synthesized (anchor pre-filter admitted the file)').toBeDefined();
    expect(synthesized!.decorators).toContain('RCTExport');

    const boot = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'boot' && n.language === 'javascript');
    const targets = getOutgoingEdges(cg.queries, boot!.id).map((e) => e.target);
    expect(targets, 'JS NativeModules.CalendarManager.addEvent → synthesized RCT_EXTERN method').toContain(
      synthesized!.id,
    );
  });
});
