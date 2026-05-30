/**
 * F#65 — Objective-C extraction.
 *
 * Adapted from upstream commit 61153f96 (PR #165). The `.wasm`
 * grammar is vendored from the `tree-sitter-objc@3.0.2` npm package
 * (ships a pre-built ABI-14-compatible wasm).
 *
 * Tests cover:
 *   - classes, methods, functions, imports (`#import`)
 *   - multi-keyword selector reconstruction (`doThing:with:`)
 *   - inheritance (extends) + protocol conformance (implements)
 *   - message-send call resolution (`[obj greet]` → calls Foo.greet)
 *   - `.h` content-heuristic dispatch (C vs ObjC)
 *   - language registration + display name
 */
import { describe, it, expect, beforeAll } from 'vitest';
import {
  initGrammars,
  isLanguageSupported,
  detectLanguage,
  getLanguageDisplayName,
  loadAllGrammars,
} from '../src/extraction/grammars.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe('Objective-C extraction (F#65)', () => {
  const sample = `
#import <Foundation/Foundation.h>
#import "MyClass.h"

@interface MyClass : NSObject <NSCopying>
@property (nonatomic, copy) NSString *name;
- (void)greet;
- (void)doThing:(id)x with:(id)y;
+ (instancetype)shared;
@end

@implementation MyClass

- (void)greet {
    NSLog(@"Hello");
    [self doWork];
}

- (void)doThing:(id)x with:(id)y {
    [self notify:x];
}

+ (instancetype)shared {
    return [[MyClass alloc] init];
}

@end

void helperFunction(int count) {
    MyClass *obj = [MyClass shared];
    [obj greet];
}
`;

  it('extracts classes, methods, functions, and imports', () => {
    const result = extractFromSource('App.m', sample);

    const classes = result.nodes.filter((n) => n.kind === 'class');
    expect(classes.filter((c) => c.name === 'MyClass').length).toBeGreaterThanOrEqual(1);

    const methods = result.nodes.filter((n) => n.kind === 'method');
    const methodNames = methods.map((m) => m.name).sort();
    expect(methodNames).toContain('greet');
    expect(methodNames).toContain('shared');
    // Multi-keyword selector reconstruction — the core F#65 win.
    expect(methodNames).toContain('doThing:with:');

    const shared = methods.find((m) => m.name === 'shared');
    expect(shared?.isStatic).toBe(true);

    const properties = result.nodes.filter((n) => n.kind === 'property');
    expect(properties.some((p) => p.name === 'name')).toBe(true);

    const functions = result.nodes.filter((n) => n.kind === 'function');
    expect(functions.some((f) => f.name === 'helperFunction')).toBe(true);

    const imports = result.nodes.filter((n) => n.kind === 'import').map((n) => n.name);
    expect(imports.some((m) => m.includes('Foundation'))).toBe(true);
    expect(imports).toContain('MyClass.h');
  });

  it('records inheritance and protocol conformance', () => {
    const result = extractFromSource('App.m', sample);
    const extendsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'extends');
    const implementsRefs = result.unresolvedReferences.filter((r) => r.referenceKind === 'implements');
    expect(extendsRefs.map((r) => r.referenceName)).toContain('NSObject');
    expect(implementsRefs.map((r) => r.referenceName)).toContain('NSCopying');
  });

  it('records message-send call names with the full selector', () => {
    const result = extractFromSource('App.m', sample);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    // `NSLog(@"Hello")` — bare function call.
    expect(calls).toContain('NSLog');
    // `[self doWork]` — `self` receiver skipped, bare method name remains.
    expect(calls).toContain('doWork');
    // `[MyClass shared]` — class-method receiver kept as the qualifier.
    expect(calls).toContain('MyClass.shared');
    // `[obj greet]` — instance receiver kept.
    expect(calls).toContain('obj.greet');
  });

  it('reconstructs the full selector on arg-carrying message sends (F#82a)', () => {
    // Pre-F#82a the call side returned only the `(method)` field, so an
    // arg-carrying send name-mismatched its definition: `[obj foo:1]` → `foo`
    // vs def `foo:`, and `[obj a:1 b:2]` → `a` vs def `a:b:`. Now the full
    // selector is reconstructed from the keyword identifiers (each followed
    // by `:` in source), so the call-ref name EQUALS the def name and
    // name-matching resolution connects them.
    const src = `@implementation Worker
- (void)doThing:(id)x with:(id)y { }
- (void)other:(int)n { }
- (void)run {
  [self doThing:1 with:2];
  [self other:3];
  [store setValue:a forKey:b];
}
@end`;
    const result = extractFromSource('Worker.m', src);
    const calls = result.unresolvedReferences.filter((r) => r.referenceKind === 'calls').map((r) => r.referenceName);
    const methodNames = result.nodes.filter((n) => n.kind === 'method').map((n) => n.name);

    // Multi-keyword send → full selector; `self` receiver dropped. The
    // reconstructed ref name matches the method definition exactly.
    expect(methodNames).toContain('doThing:with:');
    expect(calls).toContain('doThing:with:');
    // Single-keyword arg-carrying send → trailing colon (was `other` pre-F#82a).
    expect(methodNames).toContain('other:');
    expect(calls).toContain('other:');
    // Identifier-valued args (`a`, `b`) must NOT be mistaken for keywords —
    // only identifiers immediately followed by `:` count.
    expect(calls).toContain('store.setValue:forKey:');
    // No truncated/partial selector leaks through.
    expect(calls).not.toContain('store.setValue');
    expect(calls).not.toContain('other');
  });

  it('does NOT classify pure C headers (with @end in a comment) as ObjC', () => {
    const cHeader = '/* @end of file */\n#ifndef STDIO_H\nvoid printf(const char *);\n#endif\n';
    // looksLikeObjc looks for @interface/@implementation/@protocol/
    // @synthesize specifically — `@end` in a block comment is not a
    // match.
    expect(detectLanguage('stdio.h', cHeader)).toBe('c');
  });

  it('extracts protocol declarations', () => {
    const code = `
@protocol DataSource <NSObject>
- (NSInteger)numberOfItems;
@end
`;
    const result = extractFromSource('DataSource.h', code);
    const protocol = result.nodes.find((n) => n.kind === 'protocol' && n.name === 'DataSource');
    expect(protocol).toBeDefined();
  });

  // F#70 — lightweight-generic class shape: `@interface MyMap<K, V> :
  // NSObject <NSCopying>` parses with TWO parameterized_arguments under
  // class_interface (first is generics, second is protocols). Pre-fix
  // both got merged into `implements`, so K and V were emitted as
  // protocol refs alongside the real NSCopying. The dispatcher now
  // picks the LAST parameterized_arguments as the protocol list.
  it('records inheritance correctly on a lightweight-generic class', () => {
    const code = `
@interface MyMap<KeyType, ObjectType> : NSObject <NSCopying>
- (void)setObject:(ObjectType)obj forKey:(KeyType)key;
@end
`;
    const result = extractFromSource('MyMap.h', code);
    const extendsRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'extends')
      .map((r) => r.referenceName);
    const implementsRefs = result.unresolvedReferences
      .filter((r) => r.referenceKind === 'implements')
      .map((r) => r.referenceName);
    expect(extendsRefs).toEqual(['NSObject']);
    expect(implementsRefs).toContain('NSCopying');
    expect(implementsRefs).not.toContain('KeyType');
    expect(implementsRefs).not.toContain('ObjectType');
  });

  it('registers objc as a supported language with the right display name', () => {
    expect(isLanguageSupported('objc')).toBe(true);
    expect(getLanguageDisplayName('objc')).toBe('Objective-C');
  });
});
