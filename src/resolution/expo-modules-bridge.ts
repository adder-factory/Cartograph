/**
 * Expo Modules bridge — pure DSL parsing (B12 sub-channel 3, 2026-05-29).
 *
 * The graph-touching wiring lives in `./frameworks/expo-modules.ts`; this
 * module is pure source analysis (no graph / DB access), mirroring the
 * `react-native-bridge.ts` split from sub-channel 2.
 *
 * **Why parse source?** The Expo Modules API is a Swift/Kotlin DSL:
 *
 *     public class FooModule: Module {           // Kotlin: `: Module()`
 *       public func definition() -> ModuleDefinition {
 *         Name("Foo")
 *         Function("bar") { ... }
 *         AsyncFunction("baz") { ... }
 *         Property("qux") { ... }
 *       }
 *     }
 *
 * The JS-visible module name (`"Foo"`) and method names (`"bar"`/`"baz"`) are
 * STRING ARGUMENTS to builder calls. The universal extractor reads only a
 * call's CALLEE name (`Function` / `AsyncFunction` / `Name`), never its string
 * args — so those JS-facing names are unreachable from any node/ref/edge
 * (verified empirically for both Swift and Kotlin). The resolver therefore
 * parses them from source here and SYNTHESIZES one `method` node per member
 * (see `./frameworks/expo-modules.ts`'s `extractNodes`), the same strategy as
 * ch.2's ObjC-macro synthesizer.
 */

/** `class X: Module` (Swift) / `class X : Module` (Kotlin) — the Expo module
 *  class declaration. Also the module-name fallback when no `Name("…")` given. */
const EXPO_CLASS_RE = /\bclass\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*Module\b/;
/** `Name("X")` — the JS-visible module name. */
const EXPO_MODULE_NAME_RE = /\bName\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']/;
/**
 * Member-declaration pattern source. Captures the JS-visible name from
 * `Function("name")` / `AsyncFunction("name")` / `Property("name")` /
 * `Constants("name")`. NOT `Events`, NOT `Prop(...)` inside `View { … }` (view
 * props — deferred to the Fabric/Paper channel, matching upstream). A FRESH
 * `RegExp` is built per parse because the `g` flag is stateful — a shared
 * instance would skip matches across files via a leaked `lastIndex`.
 */
const EXPO_DECL_SRC = String.raw`\b(?:Function|AsyncFunction|Property|Constants)\s*\(\s*["']([A-Za-z_][A-Za-z0-9_]*)["']`;

/** One JS-exposed member parsed out of an Expo module DSL. */
export interface ExpoMember {
  /** JS-visible name (the `Function`/`AsyncFunction`/`Property`/`Constants` string arg). */
  name: string;
  /** 0-based source offset of the builder keyword — for line attribution. */
  index: number;
}

/** A parsed Expo module: its JS-visible name + exposed members. */
export interface ExpoModule {
  moduleName: string;
  members: ExpoMember[];
}

/**
 * An Expo module source = a `class … : Module` AND ≥1 DSL member literal.
 * Either signal alone over-matches (a plain `class X: Module`, or a stray
 * `Function("…")` call in unrelated code), so both are required.
 */
export function isExpoModuleSource(source: string): boolean {
  if (!EXPO_CLASS_RE.test(source)) return false;
  return new RegExp(EXPO_DECL_SRC).test(source);
}

/**
 * Parse an Expo module's DSL out of Swift/Kotlin source. Returns null when the
 * source isn't an Expo module. The module name prefers an explicit `Name("X")`
 * literal, then the class name, then the literal `'ExpoModule'`.
 */
export function parseExpoModule(source: string): ExpoModule | null {
  if (!isExpoModuleSource(source)) return null;
  const moduleName = source.match(EXPO_MODULE_NAME_RE)?.[1] ?? source.match(EXPO_CLASS_RE)?.[1] ?? 'ExpoModule';
  const members: ExpoMember[] = [];
  const declRe = new RegExp(EXPO_DECL_SRC, 'g');
  let m: RegExpExecArray | null;
  while ((m = declRe.exec(source)) !== null) {
    if (m[1]) members.push({ name: m[1], index: m.index });
  }
  return { moduleName, members };
}
