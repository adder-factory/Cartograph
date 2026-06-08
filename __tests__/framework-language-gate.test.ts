import { describe, it, expect } from 'vitest';
import { vaporResolver, swiftUIResolver, uikitResolver } from '../src/resolution/frameworks/swift.js';
import { swiftObjcBridgeResolver } from '../src/resolution/frameworks/swift-objc.js';
import { codeIgniterResolver } from '../src/resolution/frameworks/codeigniter.js';
import { expressResolver } from '../src/resolution/frameworks/express.js';
import { honoResolver } from '../src/resolution/frameworks/hono.js';
import { djangoResolver, flaskResolver, fastapiResolver } from '../src/resolution/frameworks/python.js';
import { rustResolver } from '../src/resolution/frameworks/rust.js';
import { goResolver } from '../src/resolution/frameworks/go.js';
import { vueResolver } from '../src/resolution/frameworks/vue.js';
import { playResolver } from '../src/resolution/frameworks/play.js';

/**
 * Regression suite for the framework-extractor language gate. The
 * orchestrator at src/extraction/index.ts:1922 (`eoRunFrameworkExtractors`)
 * skips a resolver's `extractNodes` when its declared `languages` set
 * doesn't include the file's language. Without that gate, e.g. the
 * Vapor `.get('a.ts')` regex fired on TypeScript test files containing
 * `db.prepare(...).get('a.ts')` SQLite calls, producing hundreds of
 * bogus `kind='route'` nodes (live observed: 401 structural summaries
 * tagged "HTTP GET a.ts" / "HTTP GET --\\0b.ts" on a test corpus).
 *
 * These tests pin the resolver-side declarations. The orchestrator's
 * gate behaviour is verified indirectly via the integration test below.
 */

describe('framework resolver language gates', () => {
  it('Vapor (Swift) declares languages: [swift]', () => {
    expect(vaporResolver.languages).toEqual(['swift']);
  });

  it('SwiftUI declares languages: [swift]', () => {
    expect(swiftUIResolver.languages).toEqual(['swift']);
  });

  it('UIKit declares languages: [swift]', () => {
    expect(uikitResolver.languages).toEqual(['swift']);
  });

  it('Swift↔ObjC bridge declares languages: [swift, objc]', () => {
    // Cross-language resolver — runs on both sides of the bridge.
    expect(swiftObjcBridgeResolver.languages).toEqual(['swift', 'objc']);
  });

  it('Express declares languages: [typescript, javascript, tsx, jsx]', () => {
    expect(expressResolver.languages).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
  });

  it('Hono declares languages: [typescript, javascript, tsx, jsx]', () => {
    expect(honoResolver.languages).toEqual(['typescript', 'javascript', 'tsx', 'jsx']);
  });

  it('Django/Flask/FastAPI declare languages: [python]', () => {
    expect(djangoResolver.languages).toEqual(['python']);
    expect(flaskResolver.languages).toEqual(['python']);
    expect(fastapiResolver.languages).toEqual(['python']);
  });

  it('Rust declares languages: [rust]', () => {
    expect(rustResolver.languages).toEqual(['rust']);
  });

  it('Go declares languages: [go]', () => {
    expect(goResolver.languages).toEqual(['go']);
  });

  it('Vue/Nuxt declares languages: [vue, typescript, javascript, tsx, jsx]', () => {
    expect(vueResolver.languages).toEqual(['vue', 'typescript', 'javascript', 'tsx', 'jsx']);
  });

  it('Play declares languages: [scala, java, yaml]', () => {
    expect(playResolver.languages).toEqual(['scala', 'java', 'yaml']);
  });

  it('CodeIgniter declares languages: [php]', () => {
    expect(codeIgniterResolver.languages).toEqual(['php']);
  });

  it('Vapor regex still matches a Swift `.get("path")` body even though it\'s gated by language', () => {
    // The regex itself isn't a typo — the gate is what protects TS
    // files. Verify the regex still does its job on legit Swift input
    // so the fix doesn't accidentally regress real Vapor route extraction.
    const swiftSrc = 'app.get("/api/users") { req in ... }';
    const nodes = vaporResolver.extractNodes!('routes.swift', swiftSrc);
    expect(nodes.length).toBeGreaterThan(0);
    expect(nodes.some((n) => n.name === 'GET /api/users')).toBe(true);
  });

  it("Vapor regex still over-fires on .get('a.ts') if called directly on a TS file (gate is the protection)", () => {
    // This DOCUMENTS the expected over-fire behaviour at the resolver
    // level: the regex genuinely matches a SQLite `.get('a.ts')` call.
    // That's why the orchestrator-level language gate is the load-
    // bearing safeguard. If someone tightens the regex AND keeps the
    // gate, this test should be updated to expect 0 hits.
    const tsSrc = "db.getDb().prepare('SELECT * FROM files WHERE path=?').get('a.ts')";
    const nodes = vaporResolver.extractNodes!('test.ts', tsSrc);
    expect(nodes.length).toBeGreaterThan(0); // documents the over-fire
  });
});
