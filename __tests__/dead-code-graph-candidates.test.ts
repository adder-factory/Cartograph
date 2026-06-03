/**
 * Integration tests for `findGraphCandidates` — the graph-orphan
 * pre-filter behind `cartograph_dead_code({via: 'rule'})` and the
 * `cartograph_review({mode: 'risk'})` dead-code lens.
 *
 * Regression for the r8 friction: constructors flooded the candidate
 * list (a constructor is reached via `instantiates`, not `calls`, so
 * the orphan query always flags it), and fixture orphans — which sort
 * ahead of `src/` by file_path — consumed a small caller's `max`
 * budget so the review lens reported a false "no orphaned symbols".
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { findGraphCandidates } from '../src/llm/dead-code.js';
import { isFixturePath } from '../src/mcp/tools/shared.js';

describe('findGraphCandidates — constructor + fixture-exemption behaviour', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-deadcode-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.mkdirSync(path.join(testDir, 'lib'));
    fs.mkdirSync(path.join(testDir, 'docs', 'test-beds'), { recursive: true });

    fs.writeFileSync(
      path.join(testDir, 'src', 'box.ts'),
      [
        'export class Box {',
        '  constructor(private size: number) {}',
        '  area(): number { return this.size; }',
        '}',
        '',
        '// `initialize` is a constructor only in Ruby — in TS it is an',
        '// ordinary method and must NOT be skipped as a constructor.',
        'export class Widget {',
        '  initialize(): void {}',
        '}',
        '',
        '// Not exported, never called — a genuine graph orphan.',
        'function unusedHelper(): number { return 42; }',
        '',
        '// Not exported and only ever constructed (never called). Its',
        '// incoming edge is `instantiates`, not `calls` — it must NOT be',
        '// flagged as a dead-code orphan.',
        'class Crate {}',
        'function packParcel(): Crate { return new Crate(); }',
        '',
        'class TinyCache {',
        '  get(id: string): number | undefined { return id.length; }',
        '  delete(id: string): void {}',
        '}',
        'class CacheUser {',
        '  private cache = new TinyCache();',
        '  read(id: string): number | undefined { return this.cache.get(id); }',
        '  drop(id: string): void { this.cache.delete(id); }',
        '}',
        '',
        '// Not exported, no incoming edges of any kind — genuine orphan.',
        'class AbandonedBin {}',
      ].join('\n'),
    );
    fs.mkdirSync(path.join(testDir, 'src', 'db'), { recursive: true });
    fs.writeFileSync(
      path.join(testDir, 'src', 'cartograph-llm-service.ts'),
      [
        'export class CartographLlmService {',
        '  hasLlm(): boolean { return false; }',
        '  getEffectiveLlmConfig(): null { return null; }',
        '  legacyLike(): string { return "candidate"; }',
        '}',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(testDir, 'src', 'db', 'index.ts'),
      [
        'export class DatabaseConnection {',
        '  getPath(): string { return "/tmp/db.sqlite"; }',
        '  transaction<T>(fn: () => T): T { return fn(); }',
        '  localOnly(): number { return 1; }',
        '}',
      ].join('\n'),
    );
    // Ruby class — `initialize` IS the constructor here.
    fs.writeFileSync(
      path.join(testDir, 'lib', 'box.rb'),
      ['class RubyBox', '  def initialize', '  end', 'end'].join('\n'),
    );
    // Fixture-path orphans. `docs/test-beds/` sorts before `src/` by
    // file_path, so without inline exemption these consume the budget.
    fs.writeFileSync(
      path.join(testDir, 'docs', 'test-beds', 'junk.ts'),
      ['function fixtureA() {}', 'function fixtureB() {}', 'function fixtureC() {}'].join('\n'),
    );

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    cg?.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('surfaces a genuine orphan but never a constructor method', () => {
    const candidates = findGraphCandidates({ queries: cg.queries, max: 50 });
    const names = candidates.map((c) => c.name);
    expect(names).toContain('unusedHelper');
    // A constructor is bound to its class's liveness — never its own
    // dead-code candidate, even though it has no incoming `calls` edge.
    expect(names).not.toContain('constructor');
  });

  it('does not flag a non-exported class that is only constructed (instantiates edge ≠ calls edge)', () => {
    const candidates = findGraphCandidates({ queries: cg.queries, max: 50 });
    const names = candidates.map((c) => c.name);
    // `Crate` has an incoming `instantiates` (and `returns`) edge but no
    // `calls` edge — the orphan query must count it as used.
    expect(names).not.toContain('Crate');
    // A class with no incoming edges at all is still a genuine orphan.
    expect(names).toContain('AbandonedBin');
  });

  it('does not flag helper methods used through field/member access', () => {
    const candidates = findGraphCandidates({ queries: cg.queries, max: 50 });
    const cacheMethods = candidates
      .filter((c) => c.filePath.endsWith('src/box.ts') && (c.name === 'get' || c.name === 'delete'))
      .map((c) => c.name);
    expect(cacheMethods).toEqual([]);
  });

  it('suppresses exact public API shims but keeps nearby orphan methods visible', () => {
    const candidates = findGraphCandidates({ queries: cg.queries, max: 50 });
    const namesByPath = candidates.map((c) => `${c.filePath}:${c.name}`);

    expect(namesByPath).not.toContain('src/cartograph-llm-service.ts:hasLlm');
    expect(namesByPath).not.toContain('src/cartograph-llm-service.ts:getEffectiveLlmConfig');
    expect(namesByPath).not.toContain('src/db/index.ts:getPath');
    expect(namesByPath).not.toContain('src/db/index.ts:transaction');
    expect(namesByPath).toContain('src/cartograph-llm-service.ts:legacyLike');
    expect(namesByPath).toContain('src/db/index.ts:localOnly');
  });

  it('gates constructor names by language — TS `initialize` is kept, Ruby `initialize` is dropped', () => {
    const candidates = findGraphCandidates({ queries: cg.queries, max: 50 });
    const tsInitialize = candidates.filter((c) => c.name === 'initialize' && c.language === 'typescript');
    const rubyInitialize = candidates.filter((c) => c.name === 'initialize' && c.language === 'ruby');
    // `initialize` is an ordinary method in TS — it stays a candidate.
    expect(tsInitialize.length).toBeGreaterThan(0);
    // `initialize` is the constructor in Ruby — it is excluded.
    expect(rubyInitialize).toHaveLength(0);
    // Sanity: the Ruby file was indexed (its class is itself an orphan),
    // so the Ruby exclusion above is meaningful and not vacuous.
    expect(candidates.some((c) => c.name === 'RubyBox')).toBe(true);
  });

  it('isExempt drops fixture orphans inline so a small max still reaches real code', () => {
    // `docs/test-beds/` orphans sort first by file_path. With a small
    // budget and NO callback they consume it entirely...
    const noExempt = findGraphCandidates({ queries: cg.queries, max: 2 });
    expect(noExempt).toHaveLength(2);
    expect(noExempt.every((c) => isFixturePath(c.filePath))).toBe(true);

    // ...but with `isFixturePath` they are skipped inline, so the same
    // budget reaches genuine non-fixture orphans instead.
    const withExempt = findGraphCandidates({ queries: cg.queries, max: 2, isExempt: isFixturePath });
    expect(withExempt).toHaveLength(2);
    expect(withExempt.some((c) => isFixturePath(c.filePath))).toBe(false);
  });
});
