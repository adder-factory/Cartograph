/**
 * Swift ↔ ObjC bridge resolver end-to-end (B12 sub-channel 1, 2026-05-29).
 *
 * A mixed Swift + ObjC project: ObjC code calls a Swift `@objc` method via
 * its auto-bridged selector. The resolver must connect the ObjC call site to
 * the Swift declaration, and must NOT bridge a `@nonobjc` method (the
 * audit-fix's whole point — exposure is read structurally from decorators).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

describe('Swift↔ObjC bridge resolver (B12)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-swift-objc-'));
  });
  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  it('resolves an ObjC call to a bridged Swift @objc method, and skips @nonobjc', async () => {
    fs.writeFileSync(
      path.join(tempDir, 'Greeter.swift'),
      [
        'import Foundation',
        '@objc class Greeter: NSObject {',
        '  @objc func play(song: String) {}', // bridged → ObjC selector playWithSong:
        '  @nonobjc func fetch(data: String) {}', // NOT bridged
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'Caller.m'),
      [
        '#import "Greeter.h"',
        '@implementation Caller',
        '- (void)go {',
        '  Greeter *g = [Greeter new];',
        '  [g playWithSong:@"hello"];', // → Swift play (bridged)
        '  [g fetchWithData:@"x"];', // → @nonobjc fetch (must NOT bridge)
        '}',
        '@end',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const play = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'play' && n.language === 'swift');
    expect(play, 'Swift @objc play method indexed').toBeDefined();
    expect(play!.decorators, '@objc captured structurally').toContain('objc');

    const fetch = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'fetch' && n.language === 'swift');
    expect(fetch!.decorators, '@nonobjc captured structurally').toContain('nonobjc');

    const go = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'go' && n.language === 'objc');
    expect(go, 'ObjC caller method indexed').toBeDefined();

    const targets = getOutgoingEdges(cg.queries, go!.id).map((e) => e.target);
    expect(targets, 'ObjC [g playWithSong:] → bridged Swift play').toContain(play!.id);
    expect(targets, '@nonobjc fetch must NOT be bridged').not.toContain(fetch!.id);
  });

  it('resolves an ObjC→ObjC call to the ObjC method, not the Swift @objc same-base name (F#82a interaction)', async () => {
    // Once ObjC call refs carry colons (`setValue:`, F#82a), the bridge can
    // produce a candidate for the setter reduction `value` while a real ObjC
    // `setValue:` method also exists. The observable contract: the call
    // resolves to the ObjC method, NOT the Swift `@objc value`. Two mechanisms
    // protect it — `resolveObjcCallToSwift` bails when an ObjC node owns the
    // selector, AND the name-matcher's exact match out-ranks the 0.6 bridge
    // candidate in pickWinnerWithTieMargin. This guards both against a future
    // regression in either.
    fs.writeFileSync(
      path.join(tempDir, 'Helper.swift'),
      ['import Foundation', '@objc class Helper: NSObject {', '  @objc func value() -> Int { return 1 }', '}', ''].join(
        '\n',
      ),
    );
    fs.writeFileSync(
      path.join(tempDir, 'Store.m'),
      [
        '#import "Store.h"',
        '@implementation Store',
        '- (void)setValue:(id)v {}', // real ObjC method named `setValue:`
        '- (void)go {',
        '  [self setValue:@"x"];', // ObjC→ObjC — must resolve to setValue:, NOT Swift value
        '}',
        '@end',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const swiftValue = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'value' && n.language === 'swift');
    expect(swiftValue, 'Swift @objc value method indexed').toBeDefined();
    const objcSetValue = getNodesByKind(cg.queries, 'method').find(
      (n) => n.name === 'setValue:' && n.language === 'objc',
    );
    expect(objcSetValue, 'ObjC setValue: method indexed with full selector').toBeDefined();
    const go = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'go' && n.language === 'objc');

    const targets = getOutgoingEdges(cg.queries, go!.id).map((e) => e.target);
    expect(targets, 'ObjC [self setValue:] → ObjC setValue:, not the Swift bridge').toContain(objcSetValue!.id);
    expect(targets, 'must NOT hijack to the Swift @objc value method').not.toContain(swiftValue!.id);
  });

  it('bridges a method exposed only via class-level @objcMembers, and still skips @nonobjc', async () => {
    // A Swift class marked @objcMembers blanket-exposes every member to ObjC
    // WITHOUT each method carrying its own @objc — so an ObjC caller must still
    // reach `greet` (no own @objc), while a member opting out via @nonobjc stays
    // unbridged.
    fs.writeFileSync(
      path.join(tempDir, 'Greeter.swift'),
      [
        'import Foundation',
        '@objcMembers class Greeter: NSObject {',
        '  func play(song: String) {}', // exposed via @objcMembers, no own @objc → ObjC selector playWithSong:
        '  @nonobjc func fetch(data: String) {}', // opts out even under @objcMembers
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'Caller.m'),
      [
        '#import "Greeter.h"',
        '@implementation Caller',
        '- (void)go {',
        '  Greeter *g = [Greeter new];',
        '  [g playWithSong:@"hi"];', // → Swift play (bridged via @objcMembers)
        '  [g fetchWithData:@"x"];', // → @nonobjc fetch (must NOT bridge)
        '}',
        '@end',
        '',
      ].join('\n'),
    );
    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });

    const play = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'play' && n.language === 'swift');
    const fetch = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'fetch' && n.language === 'swift');
    const go = getNodesByKind(cg.queries, 'method').find((n) => n.name === 'go' && n.language === 'objc');
    expect(play, 'Swift play (no own @objc) indexed').toBeDefined();
    expect(play!.decorators ?? [], 'play has NO own @objc — exposure comes from class @objcMembers').not.toContain(
      'objc',
    );

    const targets = getOutgoingEdges(cg.queries, go!.id).map((e) => e.target);
    expect(targets, 'ObjC [g playWithSong:] → Swift play via class @objcMembers').toContain(play!.id);
    expect(targets, '@nonobjc fetch must NOT bridge even under @objcMembers').not.toContain(fetch!.id);
  });
});
