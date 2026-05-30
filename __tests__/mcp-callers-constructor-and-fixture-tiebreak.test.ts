/**
 * Regression coverage for two clarification fixes that landed
 * together (frictions #33 and #35):
 *
 *   #33 — cartograph_callers on a symbol resolved as a constructor with
 *         no callers should append a one-line note explaining that
 *         constructors are invoked via `new ClassName(...)` and the
 *         `instantiates` edge targets the parent class instead.
 *         Caller traces for non-constructor methods are unchanged.
 *
 *   #35 — cartograph_node {symbol: 'foo'} when 'foo' resolves to BOTH a
 *         fixture-path file (docs/test-beds/* / __tests__/fixtures/* /
 *         test/fixtures/* / spec/fixtures/*) AND a non-fixture file
 *         must pick the non-fixture path as the displayed primary.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('callers + node disambiguation regressions (#33 + #35)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callers-ctor-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(dir, 'docs', 'test-beds'), { recursive: true });

    // Real production class with a constructor — exercise #33's
    // happy path (constructor with no callers gets the explanatory
    // note about `instantiates`).
    fs.writeFileSync(
      path.join(dir, 'src', 'core.ts'),
      [
        'export class Widget {',
        '  constructor(public readonly id: string) {}',
        '  ping(): string { return this.id; }',
        '}',
        'export function helper(): number { return 1; }',
      ].join('\n') + '\n',
    );

    // Fixture file with a name collision — `helper` exists in both
    // the production source AND the fixture. #35 expects the
    // non-fixture path to be the primary.
    fs.writeFileSync(
      path.join(dir, 'docs', 'test-beds', 'fixture.ts'),
      'export function helper(): string { return "fixture"; }\n',
    );

    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  // -----------------------------------------------------------------
  // #33 — constructor "no callers" note
  // -----------------------------------------------------------------

  it('callers on "constructor" with no callers appends the instantiates-edge note', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'constructor' });
    const text = result.content[0]?.text ?? '';
    // The note must mention `instantiates` and direct the user to the
    // parent class — those are the two load-bearing strings.
    expect(text).toMatch(/instantiates/i);
    expect(text).toMatch(/parent class|enclosing class|class instead/i);
  });

  it('callers on a non-constructor method does NOT show the constructor note', async () => {
    const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'ping' });
    const text = result.content[0]?.text ?? '';
    // The constructor-specific note must not leak onto unrelated methods.
    expect(text).not.toMatch(/instantiates.*parent class|invoked via.*new ClassName/i);
  });

  // -----------------------------------------------------------------
  // #35 — node tie-break prefers non-fixture path
  // -----------------------------------------------------------------

  it('node {symbol} with collision picks non-fixture path as primary', async () => {
    const result = await handler.execute('cartograph_node', { symbol: 'helper' });
    const text = result.content[0]?.text ?? '';
    // The primary card's location line must reference the production
    // file. The fixture path may still surface as an "Others" entry,
    // but the primary must be the non-fixture match.
    const primaryLocationMatch = text.match(/\*\*Location:\*\*\s+`?([^\n`]+)`?/);
    expect(primaryLocationMatch, 'expected a Location: line').not.toBeNull();
    const primaryPath = primaryLocationMatch?.[1] ?? '';
    expect(primaryPath).toMatch(/^src\/core\.ts/);
    expect(primaryPath).not.toMatch(/docs\/test-beds\//);
  });
});

// -----------------------------------------------------------------
// FRICTION-15 — type-users note respects explicit edgeKind filter
// -----------------------------------------------------------------

describe('callers type-users note respects edgeKind filter (FRICTION-15)', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-callers-f15-'));
    fs.mkdirSync(path.join(dir, 'src'), { recursive: true });

    // Model — a type that callers can instantiate or extend.
    fs.writeFileSync(
      path.join(dir, 'src', 'model.ts'),
      [
        'export class Model { id: string = ""; }',
        'export class ChildModel extends Model {}',
        'export function makeModel(): Model { return new Model(); }',
        'export function useModel(m: Model): void {}',
      ].join('\n') + '\n',
    );

    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    if (handler) handler.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('type-users note with edgeKind=instantiates names "instantiate" not the five-kind list', async () => {
    const result = await handler.execute('cartograph_graph', {
      direction: 'callers',
      start: 'Model',
      edgeKind: 'instantiates',
    });
    const text = result.content[0]?.text ?? '';
    // When edgeKind filter is set, the note must name only that edge kind.
    // Acceptable: note absent (no type-users match the filter) or note names "instantiate".
    if (text.includes('is a type')) {
      expect(text).toMatch(/instantiate/i);
      // Must NOT list all five usage kinds when a specific filter is active.
      expect(text).not.toMatch(/parameter \/ return \/ field \/ instantiation \/ inheritance/);
    }
    // If no type-users matched the filter, the note is absent — that's also fine.
  });

  it('type-users note without edgeKind filter lists all five usage kinds', async () => {
    const result = await handler.execute('cartograph_graph', {
      direction: 'callers',
      start: 'Model',
    });
    const text = result.content[0]?.text ?? '';
    // Without a filter, the note (if present) must show all five kinds.
    if (text.includes('is a type')) {
      expect(text).toMatch(/parameter \/ return \/ field \/ instantiation \/ inheritance/);
    }
  });
});
