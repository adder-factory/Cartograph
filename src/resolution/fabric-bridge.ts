/**
 * Fabric + legacy Paper view-component bridge — pure parsing (B12 sub-channel 4, 2026-05-29).
 *
 * Graph-touching wiring lives in `./frameworks/fabric.ts` (synthesizes nodes)
 * and `../index-hooks/fabric-native-impl.ts` (the component→native-class
 * bridge edge). This module is pure source analysis, mirroring the
 * `react-native-bridge.ts` / `expo-modules-bridge.ts` splits.
 *
 * Three view-component declaration shapes, all of which keep their JS-visible
 * names in places the extractor doesn't surface (string args / macro bodies),
 * so they must be parsed from source and SYNTHESIZED:
 *  1. **Fabric Codegen** (TS/TSX): `codegenNativeComponent<NativeProps>('Name')`
 *     — component name from the string arg; props from the `NativeProps`
 *     interface fields.
 *  2. **Legacy Paper ObjC** (.m/.mm): a `*Manager`/`*ViewManager` class with
 *     `RCT_EXPORT_VIEW_PROPERTY(prop, …)` macros — invisible to the
 *     preprocessor-less grammar (F#82b's macro rewrite covers the RN *method*
 *     macros, not these view-property ones), so the prop is read from source.
 *  3. **Legacy Paper JVM** (.java/.kt): a `*Manager`/`*ViewManager` class with
 *     `@ReactProp(name="prop")` methods. (F#84 since captures the named-arg
 *     VALUE into `decoratorArgs.namedArgs`, but the prop name is still read
 *     from source here — the source-regex path is the parallel fallback that
 *     also covers the ObjC `RCT_EXPORT_VIEW_PROPERTY` macro side uniformly.)
 *
 * The component name for the legacy paths is derived from the manager class
 * name; the native impl class is matched back by name+suffix in the index-hook.
 */
import { extractInterfaceBody } from './_interface-body.js';

/** One synthesized symbol (component or property) + its source offset. */
export interface FabricMember {
  name: string;
  /** 0-based source offset — for line attribution. */
  index: number;
}

/** Parsed view-component declarations from one file. */
export interface FabricExtraction {
  /** Component nodes to synthesize (Codegen decls, or the single view-manager component). */
  components: FabricMember[];
  /** Property nodes to synthesize (NativeProps fields / view-prop macros). */
  props: FabricMember[];
  /** qualifiedName qualifier for props (`NativeProps` for Codegen, the component name for legacy). */
  propQualifier: string;
}

// ─── Fabric Codegen (TS / TSX) ──────────────────────────────────────────────

const CODEGEN_DECL_SRC = String.raw`codegenNativeComponent\s*(?:<[^>]+>)?\s*\(\s*['"]([A-Za-z_][A-Za-z0-9_]*)['"]`;

/** Cheap gate: a Codegen spec file mentions `codegenNativeComponent`. */
export function isFabricSpec(source: string): boolean {
  return source.includes('codegenNativeComponent');
}

function extractNativeProps(source: string): FabricMember[] {
  const iface = extractInterfaceBody(source, 'NativeProps');
  if (!iface) return [];
  const props: FabricMember[] = [];
  const seen = new Set<string>();
  // `name?: Type;` / `name: Type;` — method-shorthand (`foo(): T`) has no colon
  // immediately after the name, so it's naturally excluded. `[ \t]*` (not `\s*`)
  // keeps the line anchor honest so a member can't be matched across a newline.
  // KNOWN LIMIT: a multi-line function-typed member whose params sit on their
  // own indented lines (`onChange?: (\n  e: Event\n) => void`) yields a spurious
  // `e` property node — rare in real NativeProps (function types are usually
  // single-line); these are name-discoverability nodes, so the over-capture is
  // low-harm and not worth paren-depth tracking.
  const re = /^[ \t]*([A-Za-z_][A-Za-z0-9_]*)\??\s*:/gm;
  let m: RegExpExecArray | null;
  while ((m = re.exec(iface.body)) !== null) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    props.push({ name, index: iface.start + m.index });
  }
  return props;
}

/** Parse `codegenNativeComponent<Props>('Name')` declarations + the shared
 *  `NativeProps` fields. Returns null when the file isn't a Codegen spec. */
export function parseCodegenSpecs(source: string): FabricExtraction | null {
  if (!isFabricSpec(source)) return null;
  const components: FabricMember[] = [];
  const re = new RegExp(CODEGEN_DECL_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) components.push({ name: m[1], index: m.index });
  }
  if (components.length === 0) return null;
  return { components, props: extractNativeProps(source), propQualifier: 'NativeProps' };
}

// ─── Legacy Paper view managers (native) ────────────────────────────────────

const OBJC_IMPL_SRC = String.raw`@implementation\s+([A-Za-z_][A-Za-z0-9_]*)`;
const JVM_CLASS_SRC = String.raw`\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\b`;
const RCT_VIEW_PROP_SRC = String.raw`\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\s*\(\s*([A-Za-z_][A-Za-z0-9_]*)`;
const REACT_PROP_SRC = String.raw`@ReactProp\s*\(\s*(?:name\s*=\s*)?["']([^"']+)["']`;

/** Derive the JS-visible component name from a view-manager class name: strip a
 *  leading `RCT` (Apple convention) then a trailing `ViewManager` else `Manager`.
 *  `RNTFooManager` → `RNTFoo`; `FooViewManager` → `Foo`; `RCTFooManager` → `Foo`. */
export function deriveComponentNameFromManager(className: string): string {
  let n = className;
  if (n.startsWith('RCT') && n.length > 3) n = n.slice(3);
  if (n.endsWith('ViewManager')) n = n.slice(0, -'ViewManager'.length);
  else if (n.endsWith('Manager')) n = n.slice(0, -'Manager'.length);
  return n;
}

/** First class / `@implementation` whose name ends with `Manager` (covers both
 *  `…Manager` and `…ViewManager`). Scans PAST any helper / data class declared
 *  before the view manager (`source.match()` would grab only the first class
 *  and miss the manager). Fresh `g`-regex per call so no `lastIndex` leaks. */
function findManagerClass(source: string, patternSrc: string): { name: string; index: number } | null {
  const re = new RegExp(patternSrc, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] && m.index !== undefined && m[1].endsWith('Manager')) return { name: m[1], index: m.index };
  }
  return null;
}

function extractMacroProps(source: string, patternSrc: string): FabricMember[] {
  const props: FabricMember[] = [];
  const seen = new Set<string>();
  const re = new RegExp(patternSrc, 'g');
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    const name = m[1];
    if (!name || seen.has(name)) continue;
    seen.add(name);
    props.push({ name, index: m.index });
  }
  return props;
}

/** Parse an ObjC `*Manager`/`*ViewManager` with `RCT_*_VIEW_PROPERTY` macros.
 *  Returns null when the file has no view-prop macros or no manager class. */
export function parseObjcViewManager(source: string): FabricExtraction | null {
  if (!/\bRCT_(?:EXPORT|CUSTOM|REMAP)_VIEW_PROPERTY\b/.test(source)) return null;
  const cls = findManagerClass(source, OBJC_IMPL_SRC);
  if (!cls) return null;
  const name = deriveComponentNameFromManager(cls.name);
  return {
    components: [{ name, index: cls.index }],
    props: extractMacroProps(source, RCT_VIEW_PROP_SRC),
    propQualifier: name,
  };
}

/** Parse a Java/Kotlin `*Manager`/`*ViewManager` with `@ReactProp` methods.
 *  Returns null when the file has no `@ReactProp` or no manager class. */
export function parseJvmViewManager(source: string): FabricExtraction | null {
  if (!source.includes('@ReactProp')) return null;
  const cls = findManagerClass(source, JVM_CLASS_SRC);
  if (!cls) return null;
  const name = deriveComponentNameFromManager(cls.name);
  return {
    components: [{ name, index: cls.index }],
    props: extractMacroProps(source, REACT_PROP_SRC),
    propQualifier: name,
  };
}
