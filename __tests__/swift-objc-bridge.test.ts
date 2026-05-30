/**
 * Swift ↔ ObjC bridge name-math (B12 sub-channel 1, 2026-05-29).
 *
 * Pins the reverse direction (ObjC selector → candidate Swift base names)
 * — the only direction the resolver consumes. Breaking these breaks both
 * resolve() directions (the Swift→ObjC reverse map is built from this).
 */
import { describe, it, expect } from 'vitest';
import { swiftBaseNamesForObjcSelector } from '../src/resolution/swift-objc-bridge.js';

describe('swiftBaseNamesForObjcSelector (B12)', () => {
  it('bare + single-colon selectors reduce to the base name', () => {
    expect(swiftBaseNamesForObjcSelector('play')).toEqual(['play']);
    expect(swiftBaseNamesForObjcSelector('play:')).toEqual(['play']);
    expect(swiftBaseNamesForObjcSelector('play:by:')).toEqual(['play']);
  });

  it('With-prefixed selectors yield BOTH the stripped base and the literal name', () => {
    // `playWithSong:` ← Swift `play(song:)` OR a literal `playWithSong(_:)`.
    expect(swiftBaseNamesForObjcSelector('playWithSong:')).toEqual(['playWithSong', 'play']);
    expect(swiftBaseNamesForObjcSelector('playWithSong:by:')).toEqual(['playWithSong', 'play']);
  });

  it('initWith… reduces to init', () => {
    expect(swiftBaseNamesForObjcSelector('initWithName:')).toContain('init');
    expect(swiftBaseNamesForObjcSelector('initWithName:age:')).toContain('init');
  });

  it('Cocoa preposition prefixes (With/For/From/…) recover the base name', () => {
    // The preposition must be IN the first keyword and followed by a capital
    // (`object`+`For`+`Key`). `imageNamed:` has NO preposition (`Named` isn't
    // one), so it correctly does NOT recover `image`.
    expect(swiftBaseNamesForObjcSelector('objectForKey:')).toContain('object');
    expect(swiftBaseNamesForObjcSelector('stringWithFormat:')).toContain('string');
    expect(swiftBaseNamesForObjcSelector('dataFromBytes:')).toContain('data');
    expect(swiftBaseNamesForObjcSelector('imageNamed:')).not.toContain('image');
  });

  it('setX: setters also offer the property name', () => {
    // `setName:` could be a property setter (`name`) OR a regular func.
    const names = swiftBaseNamesForObjcSelector('setName:');
    expect(names).toContain('setName');
    expect(names).toContain('name');
  });

  it('does NOT treat multi-keyword setX:y: as a property setter', () => {
    // The setter heuristic only fires for the single-keyword shape.
    const names = swiftBaseNamesForObjcSelector('setName:age:');
    expect(names).toContain('setName');
    expect(names).not.toContain('name');
  });

  it('delegate-style multi-keyword selectors keep the first keyword', () => {
    expect(swiftBaseNamesForObjcSelector('tableView:numberOfRowsInSection:')).toEqual(['tableView']);
  });

  it('empty / colon-only input is handled gracefully', () => {
    expect(swiftBaseNamesForObjcSelector('')).toEqual([]);
    expect(swiftBaseNamesForObjcSelector(':')).toEqual([]);
  });
});
