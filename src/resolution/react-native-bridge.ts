/**
 * React Native bridge — pure name-math + macro / spec parsing (B12 sub-channel 2, 2026-05-29).
 *
 * The graph-touching wiring lives in `./frameworks/react-native.ts`; this
 * module is pure string analysis (no graph / DB access), mirroring the
 * `swift-objc-bridge.ts` split from sub-channel 1.
 *
 * **Why parse macros here at all?** Upstream `4d1a2b3c` links JS callsites to
 * the ObjC method nodes its extractor produces for `RCT_EXPORT_METHOD`. This
 * fork's vendored `objc.wasm` grammar doesn't natively understand the RN bridge
 * macros; the F#82b pre-parse rewrite (`objc-macro-rewrite.ts`) now makes the
 * extractor emit a method node named by the NATIVE SELECTOR
 * (`getThingWithResolver:`). But the JS-visible name a caller uses (`getThing`,
 * or an RCT_EXPORT method's first keyword) is NOT that selector, so the resolver
 * still SYNTHESIZES a JS-NAME-keyed `method` node (tagged `RCTExport`, see the
 * resolver's `extractNodes`) for the bridge index — it coexists with the
 * extractor's native-selector node. (Pre-F#82b the macro degraded to a
 * `macro_type_specifier` + ERROR cascade and the extractor emitted ZERO method
 * nodes — also swallowing adjacent non-macro methods; that cascade is exactly
 * what F#82b closed.)
 *
 * The Android side needs no synthesis: `@ReactMethod` lands structurally in
 * `Node.decorators` for both Java and Kotlin, so the resolver reads those
 * nodes off the graph directly.
 */
import { extractInterfaceBody } from './_interface-body.js';

/**
 * `RCTEventEmitter` built-ins that every emitter subclass inherits. JS code
 * never calls these on the native module directly — they're plumbing for the
 * `NativeEventEmitter` JS abstraction. Left in the bridge map, every JS
 * `addListener` / `remove` call (Firestore subscribers, RxJS pipelines, plain
 * `Array.remove`, …) mis-bridges to whichever emitter happens to define them
 * (measured upstream: react-native-firebase 78 → 18 edges after this skip, 60
 * of the 78 were `addListener:` / `remove:` false positives). Native → JS
 * event fan-out is a SEPARATE channel (B12 sub-channel 5), so this channel
 * declines to bridge them.
 */
export const RN_EMITTER_BUILTINS: ReadonlySet<string> = new Set([
  'addListener',
  'removeListeners',
  'remove',
  'invalidate',
  'startObserving',
  'stopObserving',
]);

/**
 * Default ObjC module name when `RCT_EXPORT_MODULE()` has no argument: strip a
 * leading `RCT` prefix from the class name (Apple's convention) and treat the
 * rest as the JS-visible module name. `RCTGeolocation` → `Geolocation`. Class
 * names without an `RCT` prefix are returned unchanged.
 */
export function defaultObjcModuleName(className: string): string {
  return className.startsWith('RCT') && className.length > 3 ? className.slice(3) : className;
}

/**
 * Find the `@implementation` class name in an ObjC file — used as the fallback
 * module name when `RCT_EXPORT_MODULE()` has no explicit argument. Categories
 * (`@implementation Foo (Bar)`) capture as `Foo`.
 */
export function findObjcClassName(source: string): string | null {
  const m = source.match(/@implementation\s+([A-Za-z_][A-Za-z0-9_]*)/);
  return m?.[1] ?? null;
}

/** One JS-exposed native method parsed out of an ObjC `.m` / `.mm` source. */
export interface ObjcRNExport {
  /** Module name as seen from JS (`Geolocation`, explicit arg, or class name). */
  moduleName: string;
  /** JS-visible method name (selector first keyword, or the RCT_REMAP override). */
  jsName: string;
  /** 0-based source offset of the macro keyword — for line attribution. */
  index: number;
}

/**
 * Parse an ObjC `.m` / `.mm` source for the RN module + method-export macros,
 * returning the (moduleName, jsName) pairs with the macro's source offset.
 * Regex-based — the macros are highly stylized and the tree-sitter grammar
 * can't parse them anyway (see the module docstring).
 *
 * Two macro families, same JS-bridge shape:
 *   - **RCT_EXPORT** (Swift-or-ObjC modules with an `@implementation`):
 *       - `RCT_EXPORT_MODULE()`            — module = class name minus `RCT`
 *       - `RCT_EXPORT_MODULE(jsName)`      — explicit module name
 *       - `RCT_EXPORT[_BLOCKING_SYNCHRONOUS]_METHOD(sel:…)` — JS name = `sel`
 *       - `RCT_REMAP_METHOD(js, sel:…)`    — JS name = literal `js`
 *   - **RCT_EXTERN** (Swift-implemented modules — only an `@interface`, no
 *     `@implementation`; the grammar fails on the whole block):
 *       - `RCT_EXTERN_MODULE(ObjcName, Super)`              — module = ObjcName
 *       - `RCT_EXTERN_REMAP_MODULE(jsName, ObjcName, Super)`— module = jsName
 *       - `RCT_EXTERN[__BLOCKING_SYNCHRONOUS]_METHOD(sel:…)`— JS name = `sel`
 *       - `RCT_EXTERN_REMAP_METHOD(js, sel:…)`              — JS name = `js`
 *     (note RCT_EXTERN's blocking variant has a DOUBLE underscore). For both
 *     module forms the FIRST arg is the JS-visible module name.
 *
 * Returns `[]` when no module name can be derived (not a real RN module).
 */
export function parseObjcRNExports(source: string, className: string | null): ObjcRNExport[] {
  const results: ObjcRNExport[] = [];

  // Module name — RCT_EXPORT_MODULE (optional arg → class name) OR
  // RCT_EXTERN[_REMAP]_MODULE (first arg = JS module name). One per file.
  const exportModuleMatch = source.match(/RCT_EXPORT_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)?\s*\)/);
  const externModuleMatch = source.match(/RCT_EXTERN(?:_REMAP)?_MODULE\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/);
  const moduleName =
    exportModuleMatch?.[1] ?? externModuleMatch?.[1] ?? (className ? defaultObjcModuleName(className) : null);
  if (!moduleName) return results;

  // Selector-first-keyword exports — RCT_EXPORT / RCT_EXTERN [blocking] methods.
  // The first keyword (up to the first `:` / open paren) is the JS-visible name;
  // RN's JS view of a multi-keyword selector uses only that first keyword.
  // RCT_EXTERN_REMAP_METHOD does NOT match here (it has `_REMAP_` before
  // `_METHOD`) — it's handled by the remap pass below.
  const firstKeywordRegexes = [
    /RCT_EXPORT(?:_BLOCKING_SYNCHRONOUS)?_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g,
    /RCT_EXTERN(?:__BLOCKING_SYNCHRONOUS)?_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)/g,
  ];
  let m: RegExpExecArray | null;
  for (const re of firstKeywordRegexes) {
    while ((m = re.exec(source)) !== null) {
      const kw = m[1];
      if (kw) results.push({ moduleName, jsName: kw, index: m.index });
    }
  }

  // Remap methods — `RCT_[EXTERN_]REMAP_METHOD(jsName, nativeSelector:…)`: the
  // JS-visible name is the FIRST arg, overriding the selector.
  const remapRegex = /RCT_(?:EXTERN_)?REMAP_METHOD\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*[A-Za-z_][A-Za-z0-9_]*/g;
  while ((m = remapRegex.exec(source)) !== null) {
    const jsName = m[1];
    if (jsName) results.push({ moduleName, jsName, index: m.index });
  }

  return results;
}

/** A parsed TurboModule spec: the registry name + its JS-visible method list. */
export interface TurboModuleSpec {
  moduleName: string;
  methods: string[];
}

/**
 * Parse a TS file for a TurboModule spec declaration — the JS ↔ native
 * source-of-truth in the new architecture. The `Spec` interface lists every
 * JS-visible method; a `TurboModuleRegistry.get*<Spec>('<Name>')` default
 * export pins the module name. Returns `null` when the file isn't a spec. The
 * interface body is extracted brace-balanced (see `extractInterfaceBody`) so an
 * inline object-return type doesn't truncate later methods.
 */
export function parseTurboModuleSpec(source: string): TurboModuleSpec | null {
  // Normalize CRLF → LF so the patterns below behave identically on
  // Windows-authored spec files.
  const src = source.replaceAll('\r\n', '\n');

  const regMatch = src.match(/TurboModuleRegistry\.(?:getEnforcing|get)\s*<[^>]*>\s*\(\s*['"]([^'"]+)['"]\s*\)/);
  if (!regMatch?.[1]) return null;

  const iface = extractInterfaceBody(src, 'Spec');
  if (!iface) return null;

  const methods: string[] = [];
  // Method shape: `name(args): ReturnType;`. Anchor each name on a line start
  // or `;` so (a) single-line bodies (`{ a(): void; b(): void; }`) yield every
  // method and (b) parameter identifiers (after `(`) and inline-object-type
  // members (after `{`/`:`) are skipped. The `(` requirement skips properties.
  const methodRegex = /(?:^|;)\s*([A-Za-z_][A-Za-z0-9_]*)\s*\(/gm;
  let m: RegExpExecArray | null;
  while ((m = methodRegex.exec(iface.body)) !== null) {
    if (m[1]) methods.push(m[1]);
  }
  return { moduleName: regMatch[1], methods };
}

/** Strip a `receiver.member` / `NativeModules.Mod.fn` chain to the bare last
 *  segment — the JS-visible method name a callsite reaches the resolver as. */
export function stripReceiverPrefix(name: string): string {
  return name.includes('.') ? name.slice(name.lastIndexOf('.') + 1) : name;
}
