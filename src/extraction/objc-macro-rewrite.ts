/**
 * F#82b — Length-preserving pre-parse rewrite of React Native bridge macros.
 *
 * `RCT_EXPORT_METHOD` / `RCT_REMAP_METHOD` /
 * `RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD` /
 * `RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD` expand (via the RN preprocessor) to
 * real Objective-C method definitions, but tree-sitter-objc has no
 * preprocessor — it parses each as a `macro_type_specifier` followed by a
 * cascade of ERROR nodes. The consequences (verified empirically): ZERO method
 * nodes for the macros, the enclosing `@implementation` degrades to one big
 * ERROR node (so any *adjacent* well-formed methods lose their class
 * containment and get mis-extracted as top-level functions), and the macro
 * body produces a spurious `function` node from a call inside it.
 *
 * This rewrites each macro invocation to equivalent ObjC method syntax BEFORE
 * the parse, BYTE-FOR-BYTE length-preserving so every downstream node offset,
 * body span, and line/column stays exact. Each rewrite only overwrites bytes
 * in place (macro name + `(` → a method-decl skeleton padded with spaces;
 * any RCT_REMAP leading args → spaces; the closing `)` → a space), so
 * `rewriteReactNativeMacros(s).length === s.length` always holds.
 *
 *   RCT_EXPORT_METHOD(sel…)                          → `- (void)<pad> sel… <sp>`
 *   RCT_REMAP_METHOD(js, sel…)                       → `- (void)<pad><blank js,> sel… <sp>`
 *   RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(sel…)     → `- (id)<pad> sel… <sp>`
 *   RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD(js, t, sel…) → `- (id)<pad><blank js,t,> sel… <sp>`
 *
 * The JS-visible name (RCT_REMAP's first arg) and the export tagging are
 * recovered SEPARATELY by the RN bridge resolver (`frameworks/react-native.ts`),
 * which reads the ORIGINAL source — this rewrite only feeds the BASE extractor a
 * parseable native method (its name is the native selector, its body its calls).
 *
 * Documented benign limitations (length is always preserved, so offsets never
 * drift even when a rewrite is "wrong"):
 *  - A macro inside a `//` or block comment stays inside it (the comment token
 *    is unchanged); a macro inside a string literal corrupts only that string's
 *    VALUE, not the token structure — neither is a real-world RN pattern.
 *  - `RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD`'s declared return type is dropped
 *    (skeleton is `- (id)`); the method node's name + body are still recovered.
 */

interface RnMacroSpec {
  /** Macro identifier as written in source. */
  name: string;
  /** ObjC method-declaration prefix spliced in (must be ≤ `name.length + 1`). */
  skeleton: string;
  /** Top-level comma-separated args to BLANK before the native selector
   *  (RCT_REMAP's js-name, plus the return type for the blocking-sync remap). */
  leadingArgs: number;
}

/** The RN method-export macros. Names don't prefix-shadow each other once the
 *  trailing `(` is required, so match order is irrelevant. */
const RN_MACROS: readonly RnMacroSpec[] = [
  { name: 'RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD', skeleton: '- (id)', leadingArgs: 2 },
  { name: 'RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD', skeleton: '- (id)', leadingArgs: 0 },
  { name: 'RCT_REMAP_METHOD', skeleton: '- (void)', leadingArgs: 1 },
  { name: 'RCT_EXPORT_METHOD', skeleton: '- (void)', leadingArgs: 0 },
];

const IDENT_CHAR = /[A-Za-z0-9_]/;
function isIdentChar(ch: string): boolean {
  return ch !== '' && IDENT_CHAR.test(ch);
}

/** Return the macro whose name starts at `i` and is immediately followed by a
 *  `(`, or null. Requires an identifier boundary BEFORE `i` so a macro that is a
 *  substring of a longer identifier isn't matched. */
function matchMacroAt(source: string, i: number): RnMacroSpec | null {
  if (i > 0 && isIdentChar(source.charAt(i - 1))) return null;
  for (const spec of RN_MACROS) {
    if (source.startsWith(spec.name, i) && source.charAt(i + spec.name.length) === '(') {
      return spec;
    }
  }
  return null;
}

/** Index of the `)` matching the `(` at `openParen`, or -1 if unbalanced. */
function findMatchingParen(source: string, openParen: number): number {
  let depth = 0;
  for (let k = openParen; k < source.length; k++) {
    const c = source.charAt(k);
    if (c === '(') depth++;
    else if (c === ')') {
      depth--;
      if (depth === 0) return k;
    }
  }
  return -1;
}

/** Bracket-nesting delta for a char: +1 for openers, -1 for closers, else 0.
 *  Includes `<>` so generic / protocol-qualified types in a return-type or
 *  parameter arg (`NSDictionary<NSString *, id> *`, `id<RCTBridgeModule>`)
 *  don't leak their inner comma as a top-level one — in an ObjC method
 *  signature `<>` is always balanced. */
function bracketDelta(c: string): number {
  if (c === '(' || c === '[' || c === '{' || c === '<') return 1;
  if (c === ')' || c === ']' || c === '}' || c === '>') return -1;
  return 0;
}

/** Index of the `n`-th top-level comma at/after `start`, scanning WITHIN the
 *  current paren group — it stops (returns -1) at the closer that would drop
 *  depth below 0, i.e. the macro's own `)`. Used to find the end of the
 *  RCT_REMAP leading args (js-name / return-type) that get blanked. */
function findNthTopLevelComma(source: string, start: number, n: number): number {
  let depth = 0;
  let found = 0;
  for (let k = start; k < source.length; k++) {
    const c = source.charAt(k);
    const delta = bracketDelta(c);
    if (delta < 0 && depth === 0) return -1; // exited the macro arg list
    depth += delta;
    if (c === ',' && depth === 0 && ++found === n) return k;
  }
  return -1;
}

/**
 * Rewrite every RN bridge macro invocation in `source` to length-equivalent
 * ObjC method syntax. Returns the input unchanged when no macro is present.
 */
export function rewriteReactNativeMacros(source: string): string {
  // Fast bail — `RCT_` gates the vast majority of (non-RN) ObjC files out with
  // a single substring scan, before any allocation.
  if (!source.includes('RCT_')) return source;

  let chars: string[] | null = null; // lazily materialized on first rewrite
  let i = 0;
  while (i < source.length) {
    // Every macro name begins with 'R' — skip the matchMacroAt work otherwise.
    if (source.charAt(i) !== 'R') {
      i++;
      continue;
    }
    const spec = matchMacroAt(source, i);
    if (!spec) {
      i++;
      continue;
    }
    const openParen = i + spec.name.length;
    const closeParen = findMatchingParen(source, openParen);
    if (closeParen < 0) {
      // Unbalanced (truncated source / macro in a string) — leave as-is.
      i = openParen + 1;
      continue;
    }
    if (!chars) chars = Array.from(source);

    // 1. `MACRO(` → skeleton + spaces (covers [i, openParen], same length).
    for (let k = i; k <= openParen; k++) chars[k] = ' ';
    for (let k = 0; k < spec.skeleton.length; k++) chars[i + k] = spec.skeleton.charAt(k);

    // 2. Blank RCT_REMAP leading args (js-name [, return type]) up to and
    //    including the n-th top-level comma; the native selector follows.
    if (spec.leadingArgs > 0) {
      const blankEnd = findNthTopLevelComma(source, openParen + 1, spec.leadingArgs);
      if (blankEnd >= 0) {
        for (let k = openParen + 1; k <= blankEnd; k++) chars[k] = ' ';
      }
      // Too few commas (malformed) → leave the rest untouched; still length-safe.
    }

    // 3. Closing `)` → a space, so the method body `{…}` follows cleanly.
    chars[closeParen] = ' ';

    i = closeParen + 1;
  }

  return chars ? chars.join('') : source;
}
