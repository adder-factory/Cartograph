/**
 * Fabric + legacy Paper view-component channel (B12 sub-channel 4, 2026-05-29).
 *
 * Layers:
 *  1. Pure parse (`fabric-bridge.ts`) — Codegen spec, legacy ObjC/JVM view managers.
 *  2. The synthesizer (`fabric.ts` extractNodes) — `component` + `property` nodes.
 *  3. End-to-end (the ARBITER): a Codegen spec + a native ObjC class + a JSX
 *     usage, indexed for real, proving BOTH (a) the JSX `<MyView>` → component
 *     node hop closes FREE via react.ts resolveComponent (a `references` edge —
 *     the fork has no jsx-render synthesizer), and (b) the component → native
 *     class bridge edge is synthesized by the `fabric-native-impl` index-hook.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { fabricViewResolver } from '../src/resolution/frameworks/fabric.js';
import {
  deriveComponentNameFromManager,
  parseCodegenSpecs,
  parseJvmViewManager,
  parseObjcViewManager,
} from '../src/resolution/fabric-bridge.js';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

const CODEGEN_SPEC = [
  "import { codegenNativeComponent } from 'react-native';",
  "import type { ViewProps, ColorValue } from 'react-native';",
  'export interface NativeProps extends ViewProps {',
  '  color?: ColorValue;',
  '  enabled?: boolean;',
  '  onTap?: (e: Readonly<{ x: number }>) => void;',
  '}',
  "export default codegenNativeComponent<NativeProps>('MyView');",
  '',
].join('\n');

const OBJC_MANAGER = [
  '#import <React/RCTViewManager.h>',
  '@implementation RNTFooManager',
  'RCT_EXPORT_MODULE()',
  'RCT_EXPORT_VIEW_PROPERTY(color, UIColor)',
  'RCT_EXPORT_VIEW_PROPERTY(enabled, BOOL)',
  '- (UIView *)view { return [UIView new]; }',
  '@end',
  '',
].join('\n');

const KOTLIN_MANAGER = [
  'package com.app',
  'import com.facebook.react.uimanager.SimpleViewManager',
  'import com.facebook.react.uimanager.annotations.ReactProp',
  'class FooViewManager : SimpleViewManager<FooView>() {',
  '  override fun getName() = "RNTFoo"',
  '  @ReactProp(name = "color") fun setColor(view: FooView, color: Int) {}',
  '  @ReactProp(name = "enabled") fun setEnabled(view: FooView, enabled: Boolean) {}',
  '}',
  '',
].join('\n');

describe('Fabric — parse helpers', () => {
  it('parseCodegenSpecs: component name from the string arg + props from NativeProps', () => {
    const ex = parseCodegenSpecs(CODEGEN_SPEC);
    expect(ex?.components.map((c) => c.name)).toEqual(['MyView']);
    expect(ex?.props.map((p) => p.name).sort()).toEqual(['color', 'enabled', 'onTap']);
  });

  it('parseCodegenSpecs: bare codegenNativeComponent(no generic, no NativeProps) → component, 0 props', () => {
    const ex = parseCodegenSpecs(
      "import { codegenNativeComponent } from 'react-native';\nexport default codegenNativeComponent('BareComponent');",
    );
    expect(ex?.components.map((c) => c.name)).toEqual(['BareComponent']);
    expect(ex?.props).toEqual([]);
  });

  it('parseCodegenSpecs: a file without codegenNativeComponent → null', () => {
    expect(parseCodegenSpecs('export const x = 1;')).toBeNull();
  });

  it('deriveComponentNameFromManager: strips RCT prefix + ViewManager/Manager suffix', () => {
    expect(deriveComponentNameFromManager('RNTFooManager')).toBe('RNTFoo');
    expect(deriveComponentNameFromManager('FooViewManager')).toBe('Foo');
    expect(deriveComponentNameFromManager('RCTFooManager')).toBe('Foo');
  });

  it('parseObjcViewManager: component from manager class + props from RCT_EXPORT_VIEW_PROPERTY', () => {
    const ex = parseObjcViewManager(OBJC_MANAGER);
    expect(ex?.components.map((c) => c.name)).toEqual(['RNTFoo']);
    expect(ex?.props.map((p) => p.name).sort()).toEqual(['color', 'enabled']);
  });

  it('parseObjcViewManager: a non-manager ObjC class → null', () => {
    expect(parseObjcViewManager('@implementation Helper\n- (void)foo {}\n@end')).toBeNull();
  });

  it('parseJvmViewManager: component from manager class + props from @ReactProp(name=…) values', () => {
    const ex = parseJvmViewManager(KOTLIN_MANAGER);
    expect(ex?.components.map((c) => c.name)).toEqual(['Foo']); // FooViewManager → Foo
    // prop names are the @ReactProp VALUEs (color/enabled), NOT the setter names.
    expect(ex?.props.map((p) => p.name).sort()).toEqual(['color', 'enabled']);
  });

  it('parseJvmViewManager: finds the manager class even when a helper class precedes it', () => {
    // A first-match (`source.match`) would grab `FooState` and bail; the scan
    // must skip past it to the manager class.
    const src = [
      'package com.app',
      'import com.facebook.react.uimanager.annotations.ReactProp',
      'data class FooState(val color: Int)',
      'class FooViewManager : SimpleViewManager<FooView>() {',
      '  @ReactProp(name = "color") fun setColor(v: FooView, c: Int) {}',
      '}',
    ].join('\n');
    const ex = parseJvmViewManager(src);
    expect(ex?.components.map((c) => c.name)).toEqual(['Foo']);
    expect(ex?.props.map((p) => p.name)).toEqual(['color']);
  });
});

describe('Fabric — synthesizer (extractNodes)', () => {
  it('Codegen .ts → one component node + property nodes (correct ids/kinds)', () => {
    const nodes = fabricViewResolver.extractNodes!('src/MyViewNativeComponent.ts', CODEGEN_SPEC);
    const comps = nodes.filter((n) => n.kind === 'component');
    const props = nodes.filter((n) => n.kind === 'property');
    expect(comps.map((n) => n.name)).toEqual(['MyView']);
    expect(comps[0]!.id.startsWith('fabric-component:')).toBe(true);
    expect(props.map((n) => n.name).sort()).toEqual(['color', 'enabled', 'onTap']);
    expect(props.every((n) => n.id.startsWith('fabric-prop:'))).toBe(true);
  });

  it('legacy ObjC .m → component + property nodes (language objc)', () => {
    const nodes = fabricViewResolver.extractNodes!('ios/RNTFooManager.m', OBJC_MANAGER);
    expect(nodes.filter((n) => n.kind === 'component').map((n) => n.name)).toEqual(['RNTFoo']);
    expect(
      nodes
        .filter((n) => n.kind === 'property')
        .map((n) => n.name)
        .sort(),
    ).toEqual(['color', 'enabled']);
    expect(nodes.every((n) => n.language === 'objc')).toBe(true);
  });

  it('legacy Kotlin .kt → component + property nodes (language kotlin)', () => {
    const nodes = fabricViewResolver.extractNodes!('android/FooViewManager.kt', KOTLIN_MANAGER);
    expect(nodes.filter((n) => n.kind === 'component').map((n) => n.name)).toEqual(['Foo']);
    expect(nodes.every((n) => n.language === 'kotlin')).toBe(true);
  });

  it('emits nothing for a non-view file', () => {
    expect(fabricViewResolver.extractNodes!('src/plain.ts', 'export const x = 1;')).toEqual([]);
  });
});

describe('Fabric — end-to-end (real index)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fabric-'));
  });
  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('JSX → Codegen component (free) + component → native ObjC class (fabric-native-impl bridge)', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"app","dependencies":{"react-native":"^0.73.0"}}');
    fs.writeFileSync(
      path.join(tempDir, 'MyViewNativeComponent.ts'),
      [
        "import { codegenNativeComponent } from 'react-native';",
        "import type { ViewProps } from 'react-native';",
        'export interface NativeProps extends ViewProps { color?: string; }',
        "export default codegenNativeComponent<NativeProps>('MyView');",
        '',
      ].join('\n'),
    );
    // Native Fabric ComponentView (ObjC) — 'MyView' + 'View' suffix → MyViewView.
    fs.writeFileSync(
      path.join(tempDir, 'MyView.mm'),
      [
        '#import <UIKit/UIKit.h>',
        '@interface MyViewView : UIView',
        '@end',
        '@implementation MyViewView',
        '- (void)setColor:(NSString *)c {}',
        '@end',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.tsx'),
      [
        'import React from "react";',
        'import MyView from "./MyViewNativeComponent";',
        'export function App() {',
        '  return <MyView color="red" />;',
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    // (1) synthesized Fabric component node
    const component = getNodesByKind(cg.queries, 'component').find(
      (n) => n.name === 'MyView' && n.id.startsWith('fabric-component:'),
    );
    expect(component, 'fabric component node synthesized').toBeDefined();

    // (2) native ObjC class node (extracted by the ObjC extractor)
    const native = getNodesByKind(cg.queries, 'class').find((n) => n.name === 'MyViewView' && n.language === 'objc');
    expect(native, 'native ObjC class MyViewView indexed').toBeDefined();

    // (3) the fabric-native-impl bridge edge: component → native class
    const bridge = getOutgoingEdges(cg.queries, component!.id).find((e) => e.target === native!.id);
    expect(bridge, 'component → native-class bridge edge').toBeDefined();
    expect((bridge!.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy).toBe('fabric-native-impl');

    // (4) JSX <MyView> → component node (free, via react.ts resolveComponent)
    const app = [...getNodesByKind(cg.queries, 'component'), ...getNodesByKind(cg.queries, 'function')].find(
      (n) => n.name === 'App' && (n.language === 'tsx' || n.language === 'typescript'),
    );
    expect(app, 'App caller indexed').toBeDefined();
    const jsxTargets = getOutgoingEdges(cg.queries, app!.id).map((e) => e.target);
    expect(jsxTargets, 'JSX <MyView> → synthesized component node').toContain(component!.id);
  });
});
