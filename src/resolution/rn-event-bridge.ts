/**
 * React Native event-channel bridge — pure source parsing (B12 sub-channel 5, 2026-05-29).
 *
 * Graph-touching wiring lives in `../index-hooks/rn-event-channel.ts`; this
 * module is pure regex parsing (no graph / DB / fs access), mirroring the
 * other RN bridge parser modules.
 *
 * Closes the native→JS event fan-out: a native module dispatches an event by
 * literal NAME and JS subscribers register handlers for that same name —
 *   ObjC:  `[self sendEventWithName:@"locationUpdate" body:@{…}]`
 *   Swift: `sendEvent(withName: "locationUpdate", body: …)`
 *   JVM:   `emitter.emit("locationUpdate", body)`
 *   JS:    `new NativeEventEmitter(…).addListener("locationUpdate", handler)`
 * The event name is a STRING ARGUMENT on every side — node-invisible to the
 * extractor — so the channel matches dispatchers ↔ handlers by re-reading
 * source and keying on the literal event-name string (the index-hook then
 * attributes each call site to its enclosing graph node).
 *
 * A FRESH `RegExp` is built per call (the `g` flag is stateful — a shared
 * module-level instance would skip matches across files via a leaked
 * `lastIndex`).
 */

/** A native event-dispatch site. */
export interface NativeDispatch {
  /** The event-name string literal. */
  event: string;
  /** 0-based source offset of the dispatch call — for line attribution. */
  index: number;
}

/** A JS event-subscription site (`.on`/`.once`/`.addListener("X", handler)`). */
export interface JsSubscription {
  event: string;
  /** The handler argument identifier (may be dotted, e.g. `this.onFoo`). */
  handlerArg: string;
  /** 0-based source offset of the subscribe call — for line attribution. */
  index: number;
}

const OBJC_SEND_SRC = String.raw`\bsendEventWithName\s*:\s*@"([^"]+)"`;
const SWIFT_SEND_SRC = String.raw`\bsendEvent\s*\(\s*withName\s*:\s*"([^"]+)"`;
const JVM_EMIT_SRC = String.raw`\.emit\s*\(\s*"([^"]+)"\s*,`;
// Handler arg is any identifier (named fn OR a parameter like `listener`) —
// inline arrows (`d => …`) start with `(` and are intentionally NOT matched
// (no named target to attribute at extraction time).
const JS_SUBSCRIBE_SRC = String.raw`\.(?:on|once|addListener)\(\s*['"]([^'"]+)['"]\s*,\s*([A-Za-z_][\w.]*)`;

/** The native dispatch pattern for a language, or null if the language has no
 *  native RN event-dispatch form. */
function nativeDispatchPattern(language: string): string | null {
  if (language === 'objc') return OBJC_SEND_SRC;
  if (language === 'swift') return SWIFT_SEND_SRC;
  if (language === 'java' || language === 'kotlin') return JVM_EMIT_SRC;
  return null;
}

/** Whether a language has a native RN event-dispatch form ch.5 parses. */
export function isNativeDispatchLanguage(language: string): boolean {
  return nativeDispatchPattern(language) !== null;
}

/** Parse native event-dispatch sites for the given language (ObjC
 *  `sendEventWithName:` / Swift `sendEvent(withName:)` / JVM `.emit("X",`). */
export function parseNativeDispatches(source: string, language: string): NativeDispatch[] {
  const patternSrc = nativeDispatchPattern(language);
  if (!patternSrc) return [];
  const re = new RegExp(patternSrc, 'g');
  const out: NativeDispatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1]) out.push({ event: m[1], index: m.index });
  }
  return out;
}

/** Parse JS event-subscription sites (`.on`/`.once`/`.addListener("X", handler)`). */
export function parseJsSubscriptions(source: string): JsSubscription[] {
  const re = new RegExp(JS_SUBSCRIBE_SRC, 'g');
  const out: JsSubscription[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(source)) !== null) {
    if (m[1] && m[2]) out.push({ event: m[1], handlerArg: m[2], index: m.index });
  }
  return out;
}
