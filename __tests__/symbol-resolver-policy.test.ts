/**
 * Symbol-resolver disambiguation policy tests — structural fix #30.
 *
 * Two surfaces under test:
 *   - The typed `SYMBOL_DISAMBIGUATION_POLICIES` registry — three entries
 *     today (file by commit_count, callable by caller_count, container
 *     by member_count). Contract: each policy is `{name, description,
 *     applies, score}`; registry order doesn't matter as long as
 *     `applies` predicates are mutually exclusive.
 *   - The `withDisambiguationBanner` / `prependDisambiguationBanner`
 *     helpers — the string + ToolResult-shaped primitives that every
 *     consumer of `findSymbol` should route through to keep the
 *     banner-at-top convention enforced.
 *
 * Cross-tool invariants: every kind class that the registry covers
 * gets a synthetic-ambiguity test that asserts the policy's ranking
 * picks the structurally-louder candidate AND emits a top-of-output
 * disambiguation banner. Adding a new policy = adding one fixture
 * + one assertion here.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import { Cartograph } from '../src/index.js';
import {
  SYMBOL_DISAMBIGUATION_POLICIES,
  findSymbol,
  prependDisambiguationBanner,
  withDisambiguationBanner,
  type DisambiguationPolicy,
} from '../src/mcp/tools/symbol-resolver.js';

describe('SYMBOL_DISAMBIGUATION_POLICIES — registry contract', () => {
  it('every policy has a stable name + non-empty description + predicate + scorer', () => {
    expect(SYMBOL_DISAMBIGUATION_POLICIES.length).toBeGreaterThan(0);
    for (const p of SYMBOL_DISAMBIGUATION_POLICIES) {
      expect(p.name).toMatch(/^[a-z][a-z0-9-]+$/);
      expect(p.description.length).toBeGreaterThan(10);
      expect(typeof p.applies).toBe('function');
      expect(typeof p.score).toBe('function');
    }
  });

  it('policy names are unique', () => {
    const names = SYMBOL_DISAMBIGUATION_POLICIES.map((p) => p.name);
    expect(new Set(names).size).toBe(names.length);
  });

  it('registry covers the regression-tied kind classes (file / function / method / class)', () => {
    const covers = (kind: string): boolean => SYMBOL_DISAMBIGUATION_POLICIES.some((p) => p.applies(kind));
    expect(covers('file')).toBe(true);
    expect(covers('function')).toBe(true);
    expect(covers('method')).toBe(true);
    expect(covers('class')).toBe(true);
    expect(covers('struct')).toBe(true);
    expect(covers('interface')).toBe(true);
  });

  it('applies predicates are mutually exclusive for every covered kind', () => {
    for (const kind of ['file', 'function', 'method', 'class', 'struct', 'interface', 'trait', 'protocol']) {
      const hits = SYMBOL_DISAMBIGUATION_POLICIES.filter((p) => p.applies(kind));
      expect(hits.length, `kind=${kind} matches multiple policies`).toBeLessThanOrEqual(1);
    }
  });

  it('adding a new policy entry is mechanically one operation (smoke)', () => {
    const syntheticPolicy: DisambiguationPolicy = {
      name: 'synthetic-test-policy',
      description: 'A synthetic policy added in a test — never reaches production.',
      applies: () => false,
      score: () => 0,
    };
    const composed = [...SYMBOL_DISAMBIGUATION_POLICIES, syntheticPolicy];
    expect(composed.length).toBe(SYMBOL_DISAMBIGUATION_POLICIES.length + 1);
  });
});

describe('withDisambiguationBanner — string primitive', () => {
  it('returns the body unchanged when banner is empty / missing', () => {
    expect(withDisambiguationBanner('', 'body')).toBe('body');
    expect(withDisambiguationBanner(undefined, 'body')).toBe('body');
  });

  it('normalises leading \\n and inserts a blank-line separator', () => {
    const out = withDisambiguationBanner('\n\n> **Note:** picked X', '## Body header');
    expect(out).toBe('> **Note:** picked X\n\n## Body header');
  });

  it('trims trailing whitespace from the banner so the separator stays exact one line', () => {
    const out = withDisambiguationBanner('\n\n> **Note:** picked X  \n', 'body');
    expect(out.startsWith('> **Note:**')).toBe(true);
    expect(out.includes('  \n\n\n')).toBe(false);
  });
});

describe('prependDisambiguationBanner — ToolResult wrapper', () => {
  it('routes through withDisambiguationBanner for the body composition', () => {
    const result = { content: [{ type: 'text' as const, text: '## Body' }] };
    const wrapped = prependDisambiguationBanner(result, '\n\n> **Note:** picked X');
    expect(wrapped.content?.[0]?.text).toBe('> **Note:** picked X\n\n## Body');
  });

  it('no-ops on empty note', () => {
    const result = { content: [{ type: 'text' as const, text: '## Body' }] };
    expect(prependDisambiguationBanner(result, undefined)).toBe(result);
    expect(prependDisambiguationBanner(result, '')).toBe(result);
  });

  it('no-ops on non-text content type', () => {
    const result = { content: [{ type: 'image' as const, text: 'unused' }] };
    expect(prependDisambiguationBanner(result, '> **Note:** picked X')).toBe(result);
  });
});

// ── Per-kind disambiguation behaviour — end-to-end fixtures ─────────
// Each test sets up a synthetic project with N symbols sharing a name
// where N > 1, indexes it, and asserts findSymbol's pick matches the
// policy's intended winner AND the rendered note is recognisable.
describe('SYMBOL_DISAMBIGUATION_POLICIES — end-to-end per-kind picks', () => {
  let dir: string;
  let cg: Cartograph;

  function git(...argv: string[]): void {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-resolver-policy-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.mkdirSync(path.join(dir, 'src', 'busy'));
    fs.mkdirSync(path.join(dir, 'src', 'quiet'));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('container-by-member-count — picks the class with more methods', async () => {
    fs.writeFileSync(
      path.join(dir, 'src', 'busy', 'svc.ts'),
      [
        'export class Service {',
        '  one(): number { return 1; }',
        '  two(): number { return 2; }',
        '  three(): number { return 3; }',
        '  four(): number { return 4; }',
        '  five(): number { return 5; }',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'quiet', 'svc.ts'),
      ['export class Service {', '  solo(): number { return 1; }', '}', ''].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    git('add', '.');
    git('commit', '-q', '-m', 'initial');

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const match = findSymbol(cg, 'Service');
    expect(match).not.toBeNull();
    // The 5-method copy is the structurally fuller one — it wins.
    expect(match!.node.filePath).toBe('src/busy/svc.ts');
    // The banner names BOTH copies + cites the policy by name.
    expect(match!.note).toMatch(/container-by-member-count/);
    expect(match!.note).toMatch(/quiet\/svc\.ts/);
  });

  it('callable-by-caller-count — picks the function with more incoming calls', async () => {
    // Two functions named `helper` in different files. The "busy" copy
    // is invoked by a `caller` function in the same file (one `calls`
    // edge); the "quiet" copy has no callers. The policy picks the
    // busy one — the more-called copy is the likely user target.
    fs.writeFileSync(
      path.join(dir, 'src', 'busy', 'helper.ts'),
      [
        'export function helper(x: number): number {',
        '  return x + 1;',
        '}',
        'export function caller(x: number): number {',
        '  return helper(x) * 2;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(
      path.join(dir, 'src', 'quiet', 'helper.ts'),
      [
        'export function helper(y: number): number {',
        '  // never called — synthetic ambiguity fixture.',
        '  return y - 1;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    git('add', '.');
    git('commit', '-q', '-m', 'initial');

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const match = findSymbol(cg, 'helper');
    expect(match).not.toBeNull();
    expect(match!.node.filePath).toBe('src/busy/helper.ts');
    expect(match!.note).toMatch(/callable-by-caller-count/);
    expect(match!.note).toMatch(/quiet\/helper\.ts/);
  });

  it('file-by-commit-count — picks the higher-churn file basename', async () => {
    // Two files named `queries.ts`. Busy copy gets 4 follow-up commits;
    // quiet copy stays at 1. Disambiguating `queries.ts` MUST resolve
    // to the busy one for `cartograph_history` to be useful.
    fs.writeFileSync(path.join(dir, 'src', 'busy', 'queries.ts'), 'export const A = 1;\n');
    fs.writeFileSync(path.join(dir, 'src', 'quiet', 'queries.ts'), 'export const B = 2;\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    // 4 more commits touching the busy copy only.
    for (let i = 0; i < 4; i++) {
      fs.appendFileSync(path.join(dir, 'src', 'busy', 'queries.ts'), `export const X${i} = ${i};\n`);
      git('add', '.');
      git('commit', '-q', '-m', `busy-${i}`);
    }
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const match = findSymbol(cg, 'queries.ts');
    expect(match).not.toBeNull();
    expect(match!.node.filePath).toBe('src/busy/queries.ts');
    expect(match!.note).toMatch(/file-by-commit-count/);
  });
});
