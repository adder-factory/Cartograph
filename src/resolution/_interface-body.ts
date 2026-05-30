/**
 * Brace-balanced TS interface-body extraction (shared by the framework
 * resolvers that parse a named `export interface X { … }` out of source).
 *
 * A `\{([\s\S]*?)\}` regex can't do this reliably: a non-greedy first-`}`
 * truncates at an inline object type (`getConstants(): {x: string};`),
 * dropping every member after it; a greedy last-`}` over-captures trailing
 * module code. So we scan braces from the interface's opening `{` to its
 * depth-0 close. Newline-agnostic (CRLF-safe), so offsets stay relative to the
 * `source` passed in.
 *
 * Used by the Expo / RN TurboModule `Spec` parser (`react-native-bridge.ts`)
 * and the Fabric Codegen `NativeProps` parser (`fabric-bridge.ts`).
 */
import { escapeRegExp } from '../utils.js';

export interface InterfaceBody {
  /** Source between the interface's opening `{` and its matching `}` (exclusive). */
  body: string;
  /** Source offset of the first char of `body` (just after the opening `{`). */
  start: number;
}

/** Extract the body of `export interface <interfaceName> { … }`. Returns null
 *  when the interface is absent or unbalanced. `interfaceName` is regex-escaped
 *  before interpolation, so a name with metacharacters is matched literally. */
export function extractInterfaceBody(source: string, interfaceName: string): InterfaceBody | null {
  const head = new RegExp(String.raw`export\s+interface\s+${escapeRegExp(interfaceName)}\b[^{]*\{`).exec(source);
  if (head?.index === undefined) return null;
  const open = head.index + head[0].length - 1; // offset of the opening `{`
  let depth = 0;
  for (let i = open; i < source.length; i++) {
    const c = source[i];
    if (c === '{') depth++;
    else if (c === '}' && --depth === 0) return { body: source.slice(open + 1, i), start: open + 1 };
  }
  return null;
}
