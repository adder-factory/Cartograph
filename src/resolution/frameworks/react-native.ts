/**
 * React Native bridge resolver (B12 sub-channel 2, 2026-05-29).
 *
 * Closes the JS ↔ native call gap in React Native projects, both the legacy
 * bridge and TurboModules. Ported from upstream `4d1a2b3c`, reshaped to this
 * fork's realities (see `../react-native-bridge.ts` for the macro-parse
 * rationale). Pure name-math + parsing lives there; this file is the wiring.
 *
 * **Three native sources feed one `byJsName` index:**
 *  1. **Legacy ObjC** — `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD`. The fork's
 *     ObjC extractor (since F#82b's macro rewrite) emits a native-SELECTOR-named
 *     method node for each, but the JS-visible name differs, so `extractNodes`
 *     SYNTHESIZES a JS-NAME-keyed `method` node per export (tagged
 *     `decorators: ['RCTExport']`). `buildRNMaps` reads those synthesized nodes
 *     off the graph — no source re-parse at resolve time.
 *  2. **Legacy Android** — Java / Kotlin `@ReactMethod` methods, read
 *     structurally off `Node.decorators` (`['ReactMethod']`). No synthesis
 *     needed; the normal extractor captures these correctly.
 *  3. **TurboModules** — the TS `Spec` interface is ground truth; each spec
 *     method matches a native impl of the same name (ObjC selector
 *     first-keyword OR JVM identifier), catching Codegen-generated impls that
 *     carry neither macro nor annotation.
 *
 * **JS-side only.** `resolve()` redirects JS callers (`obj.method()` →
 * `obj.method` / bare `method`) to the native impl; native-language callers
 * return null. iOS (ObjC) targets win over Android when both exist.
 * `resolvedBy: 'framework'`, confidence 0.6 (→ INFERRED), like sub-channel 1.
 *
 * Because every synthesized / native node carries the JS-visible name, the
 * names land in `knownNames` and pass the resolver pre-filter without a
 * `claimsReference` opt-in — and a spec method with no native impl naturally
 * falls out (no `byJsName` entry → null).
 *
 * **Not covered** (later B12 sub-channels): Fabric view components
 * (`RCT_EXPORT_VIEW_PROPERTY` / Codegen view specs) and native → JS events
 * (`RCTEventEmitter.sendEvent` → `addListener`) — different flow shapes.
 */
import type { Node } from '../../types.js';
import type { FrameworkResolver, ResolutionContext, ResolvedRef, UnresolvedRef } from '../types.js';
import { makeLineIndex } from '../../utils.js';
import {
  findObjcClassName,
  parseObjcRNExports,
  parseTurboModuleSpec,
  RN_EMITTER_BUILTINS,
  stripReceiverPrefix,
} from '../react-native-bridge.js';

/** A native RN method known to the resolver, indexed by JS-visible name. */
interface NativeMethod {
  /** Module name as seen from JS (informational — resolve keys on jsName). */
  moduleName: string;
  /** JS-visible method name. */
  jsName: string;
  /** Native implementation node (synthesized ObjC / Java / Kotlin method). */
  node: Node;
}

/** Marker decorator stamped on synthesized ObjC RN-export method nodes so
 *  `buildRNMaps` can distinguish them from ordinary ObjC methods. */
const RCT_EXPORT_DECORATOR = 'RCTExport';

/**
 * Per-context lazy `byJsName` cache, keyed by `ResolutionContext` identity (so
 * the daemon's multiple projects don't share). Invalidated by `clearCache` at
 * every resolution-pass boundary — the context is reused across syncs, so a
 * sync that adds RN modules would otherwise see a stale map until full
 * reindex. (Upstream relies on a fresh context per pass and omits this; the
 * fork reuses one long-lived context, so the hook is required.)
 */
const nativeMethodMaps = new WeakMap<ResolutionContext, { byJsName: Map<string, NativeMethod[]> }>();

/** A (jsName, moduleName, node) triple before it's keyed into `byJsName`. */
interface NativeEntry {
  jsName: string;
  moduleName: string;
  node: Node;
}

/** Native method nodes indexed by JS-visible name, plus the legacy-bridge
 *  entries collected while indexing. The `*By*` maps drive TurboModule spec
 *  matching (which must also reach Codegen impls lacking a macro/annotation). */
interface NativeIndexes {
  objcByFirstKw: Map<string, Node[]>;
  jvmByName: Map<string, Node[]>;
  legacy: NativeEntry[];
}

const JS_LANGUAGES = new Set(['javascript', 'typescript', 'tsx', 'jsx']);

/** ObjC selector → JS-visible first keyword (`getTotalLength:` → `getTotalLength`). */
function objcFirstKeyword(name: string): string {
  return name.includes(':') ? name.slice(0, name.indexOf(':')) : name;
}

/** Module segment of a `Module::method` qualified name (informational). */
function moduleOf(node: Node): string {
  const i = node.qualifiedName.indexOf('::');
  return i >= 0 ? node.qualifiedName.slice(0, i) : '';
}

function pushToMap<V>(map: Map<string, V[]>, key: string, value: V): void {
  const arr = map.get(key);
  if (arr) arr.push(value);
  else map.set(key, [value]);
}

/**
 * TurboModule spec files follow RN's Codegen naming requirement —
 * `Native<Name>.ts` (the Codegen scanner only picks these up) or a
 * `*Spec.ts(x)` convention. Gating the `.ts` scan on this both bounds the
 * per-pass file read (a TS project has few such files) and is non-lossy: a
 * non-conforming file isn't a Codegen spec, so it has no generated native
 * impl to bridge to.
 */
function isLikelyTurboSpecFile(filePath: string): boolean {
  const base = filePath.slice(filePath.lastIndexOf('/') + 1);
  return (base.startsWith('Native') && /\.tsx?$/.test(base)) || /Spec\.tsx?$/.test(base);
}

/**
 * Every JS-visible TurboModule spec method name seen by `detect()` across all
 * resolution passes. `claimsReference` reads this to opt a JS ref PAST the
 * known-node pre-filter when the only native impl is a Codegen ObjC method
 * whose node name carries a selector colon (`getTotalLength:`) — that bare JS
 * name (`getTotalLength`) is otherwise absent from `knownNames` and the ref
 * would be silently dropped before `resolve()` runs.
 *
 * Module-level + add-only by design. `claimsReference` is context-free (the
 * interface gives it only the name), so a per-context map can't be consulted
 * there. Over-claiming is harmless: it only costs an extra `resolve()` that
 * returns null for a wrong-project name (resolve IS context-correct, keyed off
 * the per-context `nativeMethodMaps` which clearCache DOES invalidate). The set
 * is bounded by distinct spec method names (tiny) and refreshed every pass by
 * `detect()` running in `warmCaches`.
 */
const rnSpecMethodNames = new Set<string>();

/** Index every native method node by JS-visible name, collecting the
 *  legacy-bridge entries (synthesized ObjC `RCTExport` + JVM `@ReactMethod`)
 *  inline — both carry the JS name directly. */
function collectNativeIndexes(context: ResolutionContext): NativeIndexes {
  const objcByFirstKw = new Map<string, Node[]>();
  const jvmByName = new Map<string, Node[]>();
  const legacy: NativeEntry[] = [];
  for (const node of context.getNodesByKind('method')) {
    if (node.language === 'objc') {
      pushToMap(objcByFirstKw, objcFirstKeyword(node.name), node);
      if (node.decorators?.includes(RCT_EXPORT_DECORATOR))
        legacy.push({ jsName: node.name, moduleName: moduleOf(node), node });
    } else if (node.language === 'java' || node.language === 'kotlin') {
      pushToMap(jvmByName, node.name, node);
      if (node.decorators?.includes('ReactMethod'))
        legacy.push({ jsName: node.name, moduleName: moduleOf(node), node });
    }
  }
  return { objcByFirstKw, jvmByName, legacy };
}

/** TurboModule specs: the TS `Spec` interface is ground truth — match each
 *  spec method to native impls of the same name across BOTH platforms. */
function collectTurboModuleEntries(context: ResolutionContext, indexes: NativeIndexes): NativeEntry[] {
  const entries: NativeEntry[] = [];
  for (const file of context.getAllFiles()) {
    if (!isLikelyTurboSpecFile(file)) continue;
    const source = context.readFile(file);
    const spec = source ? parseTurboModuleSpec(source) : null;
    if (!spec) continue;
    for (const methodName of spec.methods) {
      const candidates = [
        ...(indexes.objcByFirstKw.get(methodName) ?? []),
        ...(indexes.jvmByName.get(methodName) ?? []),
      ];
      for (const node of candidates) entries.push({ jsName: methodName, moduleName: spec.moduleName, node });
    }
  }
  return entries;
}

function buildRNMaps(context: ResolutionContext): { byJsName: Map<string, NativeMethod[]> } {
  const cached = nativeMethodMaps.get(context);
  if (cached) return cached;

  const indexes = collectNativeIndexes(context);
  const byJsName = new Map<string, NativeMethod[]>();
  const seen = new Set<string>(); // `${jsName}|${node.id}` — dedupe across passes
  for (const { jsName, moduleName, node } of [...indexes.legacy, ...collectTurboModuleEntries(context, indexes)]) {
    if (RN_EMITTER_BUILTINS.has(jsName)) continue;
    const key = `${jsName}|${node.id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    pushToMap(byJsName, jsName, { moduleName, jsName, node });
  }

  const result = { byJsName };
  nativeMethodMaps.set(context, result);
  return result;
}

export const reactNativeBridgeResolver: FrameworkResolver = {
  name: 'react-native-bridge',
  // `extractNodes` synthesizes ObjC RN-export method nodes; it must run on
  // `.m` / `.mm` (both map to the single `objc` Language). `resolve()` is NOT
  // gated by `languages` (only extraction is), so it still fires on JS refs.
  languages: ['objc'],
  // Aho-Corasick pre-filter: only `extractNodes` on files carrying an RN
  // method macro. Method-specific so a future Fabric resolver's
  // `RCT_EXPORT_VIEW_PROPERTY` anchor can't collide. For the RCT_EXTERN family
  // (Swift-implemented), anchor on the MODULE openers instead of each method
  // macro: every EXTERN file has exactly one `RCT_EXTERN[_REMAP]_MODULE` and
  // `parseObjcRNExports` requires it anyway, so two anchors cover all the
  // EXTERN method variants (plain / remap / __BLOCKING_SYNCHRONOUS).
  anchors: [
    'RCT_EXPORT_METHOD',
    'RCT_REMAP_METHOD',
    'RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD',
    'RCT_EXTERN_MODULE',
    'RCT_EXTERN_REMAP_MODULE',
  ],

  /**
   * Detect: `package.json` depends on `react-native`, OR a source file carries
   * the `RCT_EXPORT_MODULE` / `RCT_EXTERN[_REMAP]_MODULE` (ObjC) /
   * `TurboModuleRegistry` (TS) marker. Either signal suffices — RN libraries
   * split the JS package from native dirs, and a Swift-only native lib may have
   * only EXTERN modules and no `react-native` package.json dependency.
   *
   * Also populates {@link rnSpecMethodNames} from every TurboModule spec file
   * (the only context-bearing hook that runs in `warmCaches`, before refs are
   * resolved — so `claimsReference` has the names ready). Spec files are read
   * in full (a small `Native*`/`*Spec` subset); the `.m`/`.mm` macro scan stays
   * capped since it only needs to confirm one signal.
   */
  detect(context) {
    const pkg = context.readFile('package.json');
    let detected = pkg !== null && /["']react-native["']\s*:/.test(pkg);
    let objcScanned = 0;
    for (const f of context.getAllFiles()) {
      const specDetected = collectTurboSpecMethods(f, (path) => context.readFile(path));
      if (specDetected) detected = true;
      if (!specDetected && (f.endsWith('.m') || f.endsWith('.mm')) && objcScanned < 200) {
        objcScanned++;
        const src = context.readFile(f);
        if (src && /(?:RCT_EXPORT_MODULE|RCT_EXTERN(?:_REMAP)?_MODULE)\b/.test(src)) detected = true;
      }
    }
    return detected;
  },

  /** Opt a JS ref past the known-node pre-filter when it names a TurboModule
   *  spec method — the Codegen ObjC impl's node is named with a selector colon
   *  (`getTotalLength:`), so the bare JS name (`getTotalLength`) isn't in
   *  `knownNames` and the ref would be dropped before `resolve()` (which then
   *  decides, context-correctly). Synthesized-ObjC / JVM legacy targets carry
   *  the JS name verbatim and pass the pre-filter without this. */
  claimsReference(name) {
    return rnSpecMethodNames.has(stripReceiverPrefix(name));
  },

  /**
   * Synthesize a JS-NAME-keyed `method` node per `RCT_EXPORT_METHOD` /
   * `RCT_REMAP_METHOD` in an ObjC `.m` / `.mm` file. The extractor (since F#82b)
   * emits a NATIVE-selector-named node for each macro, but the JS-visible name
   * differs, so the bridge index needs this JS-name-keyed node, tagged
   * `RCTExport` so `buildRNMaps` finds it (see the bridge module docstring).
   * Emitter built-ins are skipped at synthesis so they never enter the graph as
   * bridge targets.
   */
  extractNodes(filePath, content) {
    const exports = parseObjcRNExports(content, findObjcClassName(content));
    if (exports.length === 0) return [];
    const lineOf = makeLineIndex(content);
    const now = Date.now();
    const nodes: Node[] = [];
    const seen = new Set<string>();
    for (const exp of exports) {
      if (RN_EMITTER_BUILTINS.has(exp.jsName)) continue;
      const line = lineOf(exp.index);
      const key = `${exp.jsName}:${line}`;
      if (seen.has(key)) continue;
      seen.add(key);
      nodes.push({
        id: `rnmethod:${filePath}:${exp.jsName}:${line}`,
        kind: 'method',
        name: exp.jsName,
        qualifiedName: `${exp.moduleName}::${exp.jsName}`,
        filePath,
        language: 'objc',
        startLine: line,
        endLine: line,
        startColumn: 0,
        endColumn: 0,
        decorators: [RCT_EXPORT_DECORATOR],
        updatedAt: now,
      });
    }
    return nodes;
  },

  resolve(ref: UnresolvedRef, context: ResolutionContext): ResolvedRef | null {
    // JS callers only — native callers don't need this bridge.
    if (!JS_LANGUAGES.has(ref.language)) return null;

    const name = stripReceiverPrefix(ref.referenceName);
    const entries = buildRNMaps(context).byJsName.get(name);
    if (!entries || entries.length === 0) return null;

    // Prefer the iOS (ObjC) target over Android when both exist — iOS is the
    // conventional first-class platform for RN library docs. Only one edge is
    // emitted; a JVM-only resolution is fine when no ObjC target exists.
    const target = entries.find((e) => e.node.language === 'objc') ?? entries[0];
    if (!target) return null;
    return { original: ref, targetNodeId: target.node.id, confidence: 0.6, resolvedBy: 'framework' };
  },

  /** Drop the per-context native-method map so a sync that changed RN modules
   *  rebuilds it on next resolve (the context is reused across syncs). */
  clearCache(context) {
    nativeMethodMaps.delete(context);
  },
};

function collectTurboSpecMethods(filePath: string, readFile: (filePath: string) => string | null): boolean {
  if (!isLikelyTurboSpecFile(filePath)) return false;
  const src = readFile(filePath);
  if (!src) return false;
  const spec = parseTurboModuleSpec(src);
  if (spec) for (const m of spec.methods) rnSpecMethodNames.add(m);
  return /TurboModuleRegistry\.(?:get|getEnforcing)\s*</.test(src);
}
