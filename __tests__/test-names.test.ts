/**
 * Tests for the test-names index hook (migration 039) and its
 * surfaces in mode=intent + cartograph_tests_for.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('test-names hook + intent + tests_for wiring', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-test-names-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, '__tests__'));

    fs.writeFileSync(
      path.join(testDir, 'src', 'auth.ts'),
      [
        'export function verifyJwt(token: string): boolean { return token.length > 0; }',
        'export function parseCookie(header: string): Record<string, string> { return {}; }',
      ].join('\n'),
    );

    fs.writeFileSync(
      path.join(testDir, '__tests__', 'auth.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        "import { verifyJwt, parseCookie } from '../src/auth';",
        '',
        "describe('auth', () => {",
        "  it('rejects expired tokens', () => { verifyJwt('x'); });",
        "  it('accepts valid tokens', () => { verifyJwt('y'); });",
        "  it.skip('handles malformed input', () => {});",
        "  it(`parses Cookie header into key-value pairs`, () => { parseCookie('a=b'); });",
        '});',
      ].join('\n'),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('mines describe + every it/test description from the test file', () => {
    const rows = cg.db.getDb().prepare('SELECT description, line FROM test_names ORDER BY line').all() as Array<{
      description: string;
      line: number;
    }>;
    const descriptions = rows.map((r) => r.description);
    // The mining regex matches describe + every it (incl. it.skip / template-literal forms).
    expect(descriptions).toContain('auth');
    expect(descriptions).toContain('rejects expired tokens');
    expect(descriptions).toContain('accepts valid tokens');
    expect(descriptions).toContain('handles malformed input');
    expect(descriptions).toContain('parses Cookie header into key-value pairs');
    expect(rows).toHaveLength(5);
  });

  it("mode='intent' surfaces matching test descriptions in a separate block", async () => {
    const r = await handler.execute('cartograph_find', {
      by: 'name',
      mode: 'intent',
      query: 'expired tokens',
    });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/Test-description matches/);
    expect(text).toMatch(/rejects expired tokens/);
    expect(text).toMatch(/auth\.test\.ts/);
  });

  it('cartograph_tests_for(files=[..]) renders mined assertions for the matched test file', async () => {
    const r = await handler.execute('cartograph_tests_for', { files: ['src/auth.ts'] });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/auth\.test\.ts/);
    expect(text).toMatch(/rejects expired tokens/);
    expect(text).toMatch(/parses Cookie header/);
  });

  it('cartograph_node enrichment surfaces linked test assertions', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'verifyJwt' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/Tested as/);
    expect(text).toMatch(/rejects expired tokens/);
    expect(text).toMatch(/auth\.test\.ts/);
  });

  it('re-mines test names after a sync that changes the test file', async () => {
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'auth.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        '',
        "describe('auth v2', () => {",
        "  it('totally new assertion text', () => {});",
        '});',
      ].join('\n'),
    );
    await cg.sync();
    const descriptions = (
      cg.db.getDb().prepare('SELECT description FROM test_names ORDER BY description').all() as Array<{
        description: string;
      }>
    ).map((r) => r.description);
    expect(descriptions).toEqual(['auth v2', 'totally new assertion text']);
  });
});

/**
 * Regression for FRICTION-B: the cartograph_node "Tested as" section
 * must NOT dump arbitrary it/describe headers from the whole linked
 * test file. Only assertions whose title OR it-block body reference
 * the symbol identifier by name should surface.
 */
describe('cartograph_node "Tested as" filters file-level test noise', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-tested-as-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, '__tests__'));

    // Two exported symbols in one source file.
    fs.writeFileSync(
      path.join(testDir, 'src', 'extraction.ts'),
      [
        'export function getChangedFiles(): string[] { return []; }',
        'export function detectLanguage(file: string): string { return file; }',
      ].join('\n'),
    );

    // The test file links to extraction.ts via a file-level `tests`
    // edge. It has one assertion that exercises getChangedFiles (by
    // body reference) and several that are about an unrelated symbol.
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'extraction.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        "import { getChangedFiles, detectLanguage } from '../src/extraction';",
        '',
        "describe('Language Detection', () => {",
        "  it('should detect TypeScript files', () => { detectLanguage('a.ts'); });",
        "  it('should detect JavaScript files', () => { detectLanguage('a.js'); });",
        '});',
        "describe('change tracking', () => {",
        "  it('returns the changed file list', () => { getChangedFiles(); });",
        '});',
      ].join('\n'),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces only assertions that reference the symbol, not whole-file headers', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'getChangedFiles' });
    const text = r.content[0]?.text ?? '';
    // The relevant assertion (body references getChangedFiles) is kept.
    expect(text).toMatch(/Tested as/);
    expect(text).toMatch(/returns the changed file list/);
    // The orthogonal Language Detection headers must NOT appear.
    expect(text).not.toMatch(/should detect TypeScript files/);
    expect(text).not.toMatch(/should detect JavaScript files/);
    expect(text).not.toMatch(/Language Detection/);
  });
});

/**
 * Regression for the r8 friction: a class exercised by a test file
 * that instantiates it (`new Widget()`) — but has no bare `imports`
 * edge to the symbol — was reported by `cartograph_node` as having
 * "no direct test callers or importers", and the "Tested as" header
 * named a single test file while listing rows from two. Both test
 * sections must now agree.
 */
describe('cartograph_node test sections — non-import edges + multi-file label', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-node-tests-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, '__tests__'));

    fs.writeFileSync(path.join(testDir, 'src', 'widget.ts'), 'export class Widget { run(): number { return 1; } }\n');
    // Stem-matching test file — linked to widget.ts by the `tests`
    // filename convention. Instantiates Widget; no bare `imports` edge
    // to the Widget symbol itself.
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'widget.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        "import { Widget } from '../src/widget';",
        "describe('Widget core', () => {",
        "  it('constructs a Widget', () => { new Widget(); });",
        '});',
      ].join('\n'),
    );
    // Non-stem-matching test file — reachable only via the direct
    // caller (`references`/`instantiates`) supplement, not the
    // filename-convention `tests` edge.
    fs.writeFileSync(
      path.join(testDir, '__tests__', 'integration.test.ts'),
      [
        "import { describe, it } from 'vitest';",
        "import { Widget } from '../src/widget';",
        "describe('integration', () => {",
        "  it('wires a Widget end to end', () => { new Widget(); });",
        '});',
      ].join('\n'),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('includeTests finds a test that instantiates the class (not imports-only)', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'Widget', includeTests: true });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/\*\*Tests/);
    expect(text).not.toMatch(/no direct test callers or importers/i);
    expect(text).toMatch(/widget\.test\.ts/);
  });

  it('"Tested as" header reports a file count when rows span multiple files', async () => {
    const r = await handler.execute('cartograph_node', { symbol: 'Widget' });
    const text = r.content[0]?.text ?? '';
    expect(text).toMatch(/Tested as/);
    // Two test files reference Widget — the header must not claim one.
    expect(text).toMatch(/tests across 2 test files/);
    expect(text).toMatch(/constructs a Widget/);
    expect(text).toMatch(/wires a Widget end to end/);
  });
});
