/**
 * #22-2 — configurable body-line floor (`config.llm.minBodyLines` /
 * `minBodyLinesByKind`).
 *
 * Validates the shared {@link resolveBodyLineFloor} resolver and that a
 * lowered floor actually widens the summarizable candidate set (the
 * operator's "fuller coverage of short symbols" use case), in lock-step
 * across the consuming passes.
 */
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import {
  resolveBodyLineFloor,
  MIN_BODY_LINES,
  SUMMARIZABLE_KINDS,
  DEFAULT_DOC_CHAR_THRESHOLD,
} from '../src/llm/summarizer.js';
import { getSummarizableNodes } from '../src/db/queries-summaries.js';

describe('resolveBodyLineFloor', () => {
  it('defaults to MIN_BODY_LINES (4) and route:1 when no override', () => {
    const floor = resolveBodyLineFloor();
    expect(floor.defaultMinBodyLines).toBe(MIN_BODY_LINES);
    expect(floor.minBodyLinesByKind.get('route')).toBe(1);
  });

  it('honours a scalar minBodyLines override', () => {
    expect(resolveBodyLineFloor({ minBodyLines: 2 }).defaultMinBodyLines).toBe(2);
  });

  it('merges per-kind overrides over the default map (route survives)', () => {
    const floor = resolveBodyLineFloor({ minBodyLinesByKind: { method: 2 } });
    expect(floor.minBodyLinesByKind.get('method')).toBe(2);
    expect(floor.minBodyLinesByKind.get('route')).toBe(1); // default preserved
  });

  it('respects the fallbackDefault param (agent-bridge uses 3)', () => {
    expect(resolveBodyLineFloor(undefined, 3).defaultMinBodyLines).toBe(3);
    // An explicit override still wins over the fallback.
    expect(resolveBodyLineFloor({ minBodyLines: 6 }, 3).defaultMinBodyLines).toBe(6);
  });

  it('ignores invalid overrides (negative / non-numeric)', () => {
    expect(resolveBodyLineFloor({ minBodyLines: Number.NaN }).defaultMinBodyLines).toBe(MIN_BODY_LINES);
    const floor = resolveBodyLineFloor({ minBodyLinesByKind: { method: Number.NaN } });
    expect(floor.minBodyLinesByKind.has('method')).toBe(false);
  });
});

describe('configurable floor widens the summarizable candidate set (#22-2)', () => {
  let dir: string | undefined;
  afterEach(() => {
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    dir = undefined;
  });

  function git(cwd: string, ...args: string[]): void {
    execFileSync('git', args, { cwd, stdio: ['pipe', 'pipe', 'pipe'] });
  }

  it('a short 2-line function is excluded by default but included once the floor is lowered', async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-minbody-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // `tiny` has a 2-line body (below the default floor of 4); `big` has
    // a 5-line body (above it).
    fs.writeFileSync(
      path.join(dir, 'src', 'a.ts'),
      [
        'export function tiny(n: number): number {',
        '  return n + 1;',
        '}',
        '',
        'export function big(n: number): number {',
        '  const a = n + 1;',
        '  const b = a * 2;',
        '  const c = b - 3;',
        '  return c;',
        '}',
        '',
      ].join('\n'),
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    try {
      await cg.indexAll({ summarize: false });

      const nameOf = (n: { name: string }): string => n.name;

      // Default floor (4): only `big` is a candidate.
      const defaultFloor = resolveBodyLineFloor();
      const defaultCandidates = getSummarizableNodes(cg.queries, SUMMARIZABLE_KINDS, {
        minBodyLinesByKind: defaultFloor.minBodyLinesByKind,
        defaultMinBodyLines: defaultFloor.defaultMinBodyLines,
        docCharThreshold: DEFAULT_DOC_CHAR_THRESHOLD,
      }).map(nameOf);
      expect(defaultCandidates).toContain('big');
      expect(defaultCandidates).not.toContain('tiny');

      // Lowered floor (2): `tiny` now qualifies too.
      const lowFloor = resolveBodyLineFloor({ minBodyLines: 2 });
      const lowCandidates = getSummarizableNodes(cg.queries, SUMMARIZABLE_KINDS, {
        minBodyLinesByKind: lowFloor.minBodyLinesByKind,
        defaultMinBodyLines: lowFloor.defaultMinBodyLines,
        docCharThreshold: DEFAULT_DOC_CHAR_THRESHOLD,
      }).map(nameOf);
      expect(lowCandidates).toContain('big');
      expect(lowCandidates).toContain('tiny');
    } finally {
      cg.close();
    }
  });
});
