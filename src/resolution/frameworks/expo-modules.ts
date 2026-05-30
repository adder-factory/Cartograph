/**
 * Expo Modules resolver (B12 sub-channel 3, 2026-05-29).
 *
 * Bridges JS callers to the native implementations of an Expo module's
 * Swift/Kotlin DSL (`Module { Name("X"); Function("y") { … } }`). Ported from
 * upstream `4d1a2b3c`, reshaped to this fork (pure DSL parsing lives in
 * `../expo-modules-bridge.ts`).
 *
 * **Synthesizer + resolve().** The Expo DSL's JS-visible names live only in
 * string-literal arguments the extractor never reads, so `extractNodes`
 * regex-parses the source and SYNTHESIZES one `method` node per
 * `Function`/`AsyncFunction`/`Property`/`Constants("name")` member, named by
 * its JS-visible name and tagged `ExpoExport`. Upstream relies on the standard
 * name-matcher to close `requireNativeModule('X').y()` → the node, but THIS
 * fork's member-call matcher is receiver-type-driven and the
 * `requireNativeModule(...)` binding is untyped, so the cross-language edge
 * does NOT form on its own (verified — the end-to-end tests fail without a
 * resolver). So `resolve()` bridges a JS `obj.y()` call to the `ExpoExport`
 * member node of that name (iOS-preferred), `confidence: 0.6` /
 * `resolvedBy: 'framework'`, like ch.1/ch.2. No `claimsReference` is needed —
 * the synthesized node carries the JS name, so the pre-filter passes naturally.
 *
 * **Not covered** (matches upstream; later channels): `Prop(...)` view props
 * inside `View { … }` blocks and `Events(...)` — these belong with the Fabric /
 * Paper view-component channel.
 */
import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { makeLineIndex } from '../../utils.js';
import { stripReceiverPrefix } from '../react-native-bridge.js';
import { isExpoModuleSource, parseExpoModule } from '../expo-modules-bridge.js';

/** Marker stamped on synthesized Expo member nodes so `resolve()` can find
 *  them (and not bridge to an unrelated same-named method). */
const EXPO_EXPORT_DECORATOR = 'ExpoExport';
const JS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'jsx']);

export const expoModulesResolver: FrameworkResolver = {
  name: 'expo-modules',
  // `extractNodes` synthesizes from Swift + Kotlin Expo module sources.
  languages: ['swift', 'kotlin'],
  // Every Expo module extends `Module`; the substring is always present, so it
  // is the minimal correct Aho-Corasick anchor (over-broad only loses the
  // pre-filter win on non-Expo files, never correctness).
  anchors: ['Module'],

  /**
   * Detect: `package.json` depends on `expo-modules-core`, OR a Swift/Kotlin
   * source file is an Expo module (`class … : Module` + a DSL member literal).
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    if (pkg && /["']expo-modules-core["']\s*:/.test(pkg)) return true;
    const files = context.getAllFiles();
    for (let i = 0; i < Math.min(files.length, 200); i++) {
      const f = files[i];
      if (!f || (!f.endsWith('.swift') && !f.endsWith('.kt'))) continue;
      const src = context.readFile(f);
      if (src && isExpoModuleSource(src)) return true;
    }
    return false;
  },

  /**
   * Synthesize a `method` node per Expo DSL member, named by the JS-visible
   * name and tagged `ExpoExport` so `resolve()` can bridge JS callsites to it.
   * `expo-module:`-prefixed id namespaces these synthetic nodes.
   */
  extractNodes(filePath, content) {
    const parsed = parseExpoModule(content);
    if (!parsed) return [];
    const lineOf = makeLineIndex(content);
    const now = Date.now();
    const language = filePath.endsWith('.kt') ? 'kotlin' : 'swift';
    const nodes: Node[] = [];
    const seen = new Set<string>();
    for (const member of parsed.members) {
      const line = lineOf(member.index);
      const key = `${member.name}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({
        id: `expo-module:${filePath}:${parsed.moduleName}.${member.name}:${line}`,
        kind: 'method',
        name: member.name,
        qualifiedName: `${parsed.moduleName}::${member.name}`,
        filePath,
        language,
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        decorators: [EXPO_EXPORT_DECORATOR],
        updatedAt: now,
      });
    }
    return nodes;
  },

  /** Bridge a JS `obj.member()` call to the synthesized Expo member node of
   *  that name (iOS-preferred when both platforms define it). JS callers only;
   *  native-language callers return null. The `ExpoExport` filter keeps the
   *  bridge from claiming an unrelated same-named method. */
  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    if (!JS_LANGUAGES.has(ref.language)) return null;
    const name = stripReceiverPrefix(ref.referenceName);
    const matches = context.getNodesByName(name).filter((n) => n.decorators?.includes(EXPO_EXPORT_DECORATOR));
    if (matches.length === 0) return null;
    const target = matches.find((n) => n.language === 'swift') ?? matches[0];
    if (!target) return null;
    return { original: ref, targetNodeId: target.id, confidence: 0.6, resolvedBy: 'framework' };
  },
};
