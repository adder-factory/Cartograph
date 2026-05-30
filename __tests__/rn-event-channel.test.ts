/**
 * RN event-channel synthesizer (B12 sub-channel 5, 2026-05-29).
 *
 * Layers:
 *  1. Pure parse (`rn-event-bridge.ts`) — the native-dispatch + JS-subscribe regexes.
 *  2. End-to-end (the ARBITER): a native `sendEventWithName:@"X"` + a JS
 *     `.addListener("X", handler)` indexed for real, proving the hook re-reads
 *     source, matches by event name, and emits a native-dispatcher → JS-handler
 *     `calls` edge (metadata.synthesizedBy='rn-event-channel') — once to a
 *     NAMED handler (tier 1), once to the enclosing subscribe-wrapper (tier 2,
 *     where the handler is a parameter).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import {
  isNativeDispatchLanguage,
  parseJsSubscriptions,
  parseNativeDispatches,
} from '../src/resolution/rn-event-bridge.js';
import { Cartograph } from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';
import { getOutgoingEdges } from '../src/db/queries-edges.js';

describe('RN event-channel — parse helpers', () => {
  it('parseNativeDispatches: ObjC sendEventWithName:@"X"', () => {
    const src = '- (void)emit { [self sendEventWithName:@"locationUpdate" body:@{}]; }';
    expect(parseNativeDispatches(src, 'objc').map((d) => d.event)).toEqual(['locationUpdate']);
  });

  it('parseNativeDispatches: Swift sendEvent(withName:)', () => {
    const src = 'func emit() { sendEvent(withName: "geoDidChange", body: data) }';
    expect(parseNativeDispatches(src, 'swift').map((d) => d.event)).toEqual(['geoDidChange']);
  });

  it('parseNativeDispatches: JVM .emit("X", …) (requires trailing comma)', () => {
    expect(parseNativeDispatches('emitter.emit("onScan", payload)', 'kotlin').map((d) => d.event)).toEqual(['onScan']);
    // a bare `.emit("X")` with no body arg is NOT a dispatch site
    expect(parseNativeDispatches('foo.emit("noComma")', 'java')).toEqual([]);
  });

  it('parseNativeDispatches: a non-native language yields nothing', () => {
    expect(parseNativeDispatches('sendEventWithName:@"x"', 'javascript')).toEqual([]);
    expect(isNativeDispatchLanguage('javascript')).toBe(false);
    expect(isNativeDispatchLanguage('objc')).toBe(true);
  });

  it('parseJsSubscriptions: .addListener/.on/.once with a named handler arg', () => {
    const src = [
      "emitter.addListener('locationUpdate', onLocation);",
      "thing.on('data', this.onData);",
      "x.once('ready', () => {});", // inline arrow → NOT captured (no named target)
    ].join('\n');
    const subs = parseJsSubscriptions(src);
    expect(subs.map((s) => [s.event, s.handlerArg])).toEqual([
      ['locationUpdate', 'onLocation'],
      ['data', 'this.onData'],
    ]);
  });
});

describe('RN event-channel — end-to-end (real index)', () => {
  let tempDir: string;
  let cg: Cartograph | undefined;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-rn-event-'));
  });
  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
    cg = undefined;
  });

  function bridgeEdge(
    fromName: string,
    fromLang: string,
    fromKind: 'method' | 'function',
    toName: string,
  ): { event?: string; ok: boolean } {
    const dispatcher = getNodesByKind(cg!.queries, fromKind).find(
      (n) => n.name === fromName && n.language === fromLang,
    );
    const handler = [...getNodesByKind(cg!.queries, 'function'), ...getNodesByKind(cg!.queries, 'method')].find(
      (n) => n.name === toName && (n.language === 'javascript' || n.language === 'typescript'),
    );
    if (!dispatcher || !handler) return { ok: false };
    const edge = getOutgoingEdges(cg!.queries, dispatcher.id).find(
      (e) =>
        e.target === handler.id &&
        (e.metadata as { synthesizedBy?: string } | undefined)?.synthesizedBy === 'rn-event-channel',
    );
    return { ok: !!edge, event: (edge?.metadata as { event?: string } | undefined)?.event };
  }

  it('ObjC sendEventWithName → a NAMED JS handler (tier 1)', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"x","dependencies":{"react-native":"^0.73"}}');
    fs.writeFileSync(
      path.join(tempDir, 'Emitter.m'),
      [
        '@implementation Emitter',
        '- (void)reportLocation {',
        '  [self sendEventWithName:@"locationUpdate" body:@{}];',
        '}',
        '@end',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'App.js'),
      [
        'function onLocation(payload) { return payload; }',
        "emitter.addListener('locationUpdate', onLocation);",
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    const r = bridgeEdge('reportLocation', 'objc', 'method', 'onLocation');
    expect(r.ok, 'reportLocation (objc) → onLocation (js) rn-event edge').toBe(true);
    expect(r.event).toBe('locationUpdate');
  });

  it('subscribe-wrapper: a parameter handler attributes to the enclosing fn (tier 2)', async () => {
    fs.writeFileSync(path.join(tempDir, 'package.json'), '{"name":"x","dependencies":{"react-native":"^0.73"}}');
    fs.writeFileSync(
      path.join(tempDir, 'MyEmitter.m'),
      [
        '@implementation MyEmitter',
        '- (void)pushMessage {',
        '  [self sendEventWithName:@"messageReceived" body:@{}];',
        '}',
        '@end',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(tempDir, 'messaging.ts'),
      [
        "import { NativeEventEmitter } from 'react-native';",
        'const emitter = new NativeEventEmitter();',
        'export function onMessage(listener: (m: unknown) => void) {',
        "  return emitter.addListener('messageReceived', listener);",
        '}',
        '',
      ].join('\n'),
    );

    cg = await Cartograph.init(tempDir, { index: true, config: { llm: { endpoint: '' } } });
    // `listener` is a param (no named fn node) → tier-1 fails → attributes to the enclosing `onMessage`.
    const r = bridgeEdge('pushMessage', 'objc', 'method', 'onMessage');
    expect(r.ok, 'pushMessage (objc) → onMessage wrapper (ts) rn-event edge').toBe(true);
    expect(r.event).toBe('messageReceived');
  });
});
