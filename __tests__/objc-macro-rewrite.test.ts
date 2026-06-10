/**
 * F#82b — React Native bridge-macro pre-parse rewrite.
 *
 * `rewriteReactNativeMacros` rewrites RCT_EXPORT_METHOD / RCT_REMAP_METHOD /
 * RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD / RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD
 * into parseable ObjC method syntax, BYTE-FOR-BYTE length-preserving. Without
 * it the preprocessor-less grammar emits a macro_type_specifier + ERROR cascade
 * that drops the macro methods, mis-parents adjacent methods, and synthesizes a
 * spurious `function` node from a macro-body call.
 */
import { describe, it, expect, beforeAll } from 'vitest';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { rewriteReactNativeMacros } from '../src/extraction/objc-macro-rewrite.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('rewriteReactNativeMacros — length invariant', () => {
  // The whole design hinges on byte-for-byte preservation: any length drift
  // would corrupt every downstream node offset / line number.
  const samples: Array<[string, string]> = [
    ['export', 'RCT_EXPORT_METHOD(doSomething:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve)\n{\n}'],
    ['remap', 'RCT_REMAP_METHOD(getThing, getThingWithResolver:(RCTPromiseResolveBlock)resolve)\n{\n}'],
    ['blocking', 'RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(getName)\n{\n  return @"x";\n}'],
    ['remap-blocking', 'RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD(getCount, NSNumber *, getCountValue)\n{\n}'],
    [
      'remap-blocking-generic-return',
      'RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD(getMap, NSDictionary<NSString *, id> *, getMapValue)\n{\n}',
    ],
    ['no-macro', '@implementation Foo\n- (void)greet { NSLog(@"hi"); }\n@end'],
    ['empty', ''],
    ['nested-parens', 'RCT_EXPORT_METHOD(f:(NSDictionary<NSString *, id> *)opts)\n{\n}'],
  ];
  for (const [label, src] of samples) {
    it(`preserves byte length: ${label}`, () => {
      expect(rewriteReactNativeMacros(src).length).toBe(src.length);
    });
  }

  it('returns the input unchanged when no RCT_ macro is present (fast bail)', () => {
    const src = '@implementation Foo\n- (void)greet {}\n@end';
    expect(rewriteReactNativeMacros(src)).toBe(src);
  });

  it('does not rewrite an identifier that merely contains a macro name as a substring', () => {
    const src = 'int MY_RCT_EXPORT_METHOD_COUNT = 1;';
    // `RCT_EXPORT_METHOD` is preceded by `_` (an ident char) → not a macro.
    expect(rewriteReactNativeMacros(src)).toBe(src);
  });

  it('preserves the selector when an astral char (emoji) precedes the macro', () => {
    // The mutable buffer must be split by UTF-16 code UNIT (`split('')`),
    // not code POINT (`Array.from`): an emoji ahead of the macro otherwise
    // shifts every index, dropping the selector's first letter and
    // unbalancing parens. Regression guard for that off-by-codepoint bug.
    const src = '// log 🔥 marker\nRCT_EXPORT_METHOD(getValue:(NSString *)key) {\n}';
    const out = rewriteReactNativeMacros(src);
    expect(out.length).toBe(src.length);
    expect(out).toContain('getValue:');
    expect(out).not.toContain('R- (void)');
    expect(out).toContain('🔥');
  });
});

describe('rewriteReactNativeMacros — produces parseable methods (F#82b)', () => {
  const src = `@implementation RNThing
RCT_EXPORT_METHOD(doSomething:(NSString *)name resolver:(RCTPromiseResolveBlock)resolve)
{
  resolve(@"ok");
}

- (void)plainMethod:(NSInteger)x with:(NSInteger)y
{
  [self helper];
}

RCT_REMAP_METHOD(getThing, getThingWithResolver:(RCTPromiseResolveBlock)resolve)
{
  resolve(@"thing");
}

RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD(syncName)
{
  return @"v";
}
@end`;

  it('extracts the macro methods as `method` nodes with native selector names', () => {
    const result = extractFromSource('RNThing.m', src);
    const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    // RCT_EXPORT_METHOD → full native selector.
    expect(methods).toContain('doSomething:resolver:');
    // RCT_REMAP_METHOD → the NATIVE selector (2nd arg), not the JS name `getThing`.
    expect(methods).toContain('getThingWithResolver:');
    expect(methods).not.toContain('getThing');
    // RCT_EXPORT_BLOCKING_SYNCHRONOUS_METHOD → bare no-arg selector.
    expect(methods).toContain('syncName');
  });

  it('keeps the adjacent plain method a `method` (no ERROR-cascade mis-parenting)', () => {
    const result = extractFromSource('RNThing.m', src);
    const plain = result.nodes.find((n) => n.name === 'plainMethod:with:');
    expect(plain).toBeDefined();
    expect(plain!.kind).toBe('method');
  });

  it('does NOT synthesize a spurious `function` node from a macro-body call', () => {
    const result = extractFromSource('RNThing.m', src);
    // Pre-F#82b the broken parse turned `resolve(@"ok")` into a top-level
    // `function "resolve"` node. It must be a CALL ref now, not a node.
    const fnNames = result.nodes.filter((n) => n.kind === 'function').map((n) => n.name);
    expect(fnNames).not.toContain('resolve');
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    expect(calls).toContain('resolve');
  });

  it('recovers macro-method body call refs ([self helper] inside the plain method)', () => {
    const result = extractFromSource('RNThing.m', src);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    // `[self helper]` — self skipped → bare `helper`.
    expect(calls).toContain('helper');
  });

  it('recovers the native selector when a REMAP_BLOCKING return type has generics', () => {
    // The generic return type `NSDictionary<NSString *, id> *` carries an inner
    // comma; bracketDelta must track `<>` so it is NOT counted as a top-level
    // arg comma (which would leave a partial type token wrecking the selector).
    const gsrc = `@implementation M
RCT_REMAP_BLOCKING_SYNCHRONOUS_METHOD(getMap, NSDictionary<NSString *, id> *, getMapValue)
{
  return @{};
}
@end`;
    const result = extractFromSource('M.m', gsrc);
    const methods = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);
    expect(methods).toContain('getMapValue');
  });
});
