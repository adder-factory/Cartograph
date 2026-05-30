/**
 * Issue → symbol attribution: parser unit tests + end-to-end mining
 * against synthetic git repos.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getIssuesForNode } from '../src/db/queries-history.js';
import { setMetadata } from '../src/db/queries-metadata.js';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { execFileSync } from 'child_process';
import { extractSymbolFromContext, extractDeclaration } from '../src/issue-history/parse-diff.js';
import {
  mineIssueCommits,
  mineIssueHistory,
  ISSUE_REGEX,
  LAST_MINED_ISSUES_HEAD_KEY,
} from '../src/issue-history/index.js';
import Cartograph from '../src/index.js';
import { getNodesByKind } from '../src/db/queries.js';

let HAS_GIT = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  HAS_GIT = false;
}

let testDir: string;
let cg: Cartograph | null = null;

function git(...args: string[]): string {
  return execFileSync('git', args, {
    cwd: testDir,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@example.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@example.com',
      GIT_AUTHOR_DATE: process.env.GIT_AUTHOR_DATE,
      GIT_COMMITTER_DATE: process.env.GIT_COMMITTER_DATE,
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function commitAt(date: string, files: Record<string, string>, message: string) {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(testDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, content);
  }
  git('add', '-A');
  process.env.GIT_AUTHOR_DATE = date;
  process.env.GIT_COMMITTER_DATE = date;
  git('commit', '-m', message);
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
}

beforeEach(() => {
  testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-issues-'));
});

afterEach(() => {
  delete process.env.GIT_AUTHOR_DATE;
  delete process.env.GIT_COMMITTER_DATE;
  if (cg) {
    cg.destroy();
    cg = null;
  }
  if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
});

// ============================================================================
// Pure parser unit tests
// ============================================================================

describe('ISSUE_REGEX', () => {
  it('matches all canonical Fixes/Closes/Resolves verbs', () => {
    const cases = [
      'Fix #1',
      'Fixes #2',
      'Fixed #3',
      'Close #4',
      'Closes #5',
      'Closed #6',
      'Resolve #7',
      'Resolves #8',
      'Resolved #9',
    ];
    for (const s of cases) {
      ISSUE_REGEX.lastIndex = 0;
      expect(ISSUE_REGEX.test(s)).toBe(true);
    }
  });

  it('matches multiple issues in a single body', () => {
    ISSUE_REGEX.lastIndex = 0;
    const matches = [...'Fixes #1, closes #2 and resolves #3'.matchAll(ISSUE_REGEX)];
    expect(matches.map((m) => m[1])).toEqual(['1', '2', '3']);
  });

  it('is case-insensitive', () => {
    ISSUE_REGEX.lastIndex = 0;
    expect(ISSUE_REGEX.test('FIXES #42')).toBe(true);
  });

  it('does NOT match `#N` without a verb', () => {
    ISSUE_REGEX.lastIndex = 0;
    // Match in body of message that mentions #99 but with no verb prefix.
    expect(ISSUE_REGEX.test('See #99 for context')).toBe(false);
  });

  it('v1 limitation: `Fixes #1, #2` only captures #1', () => {
    // Documented behavior — the second issue lacks a verb prefix and
    // is silently dropped. Authors who care can write `Fixes #1, fixes #2`.
    ISSUE_REGEX.lastIndex = 0;
    const matches = [...'Fixes #1, #2'.matchAll(ISSUE_REGEX)];
    expect(matches.map((m) => m[1])).toEqual(['1']);
  });
});

describe('extractSymbolFromContext', () => {
  it('pulls function name from a TS function context', () => {
    expect(extractSymbolFromContext('function processOrder(order: Order) {')).toBe('processOrder');
  });
  it('pulls class name', () => {
    expect(extractSymbolFromContext('class UserService {')).toBe('UserService');
  });
  it('pulls Python def', () => {
    expect(extractSymbolFromContext('def compute_score(items):')).toBe('compute_score');
  });
  it('pulls Go func', () => {
    expect(extractSymbolFromContext('func ProcessOrder(o *Order) error {')).toBe('ProcessOrder');
  });
  it('pulls method-style ` async foo(`', () => {
    expect(extractSymbolFromContext('  async foo(args: string) {')).toBe('foo');
  });
  it('rejects keyword-only contexts', () => {
    expect(extractSymbolFromContext('  if (x) {')).toBeNull();
  });
  it('returns null on empty input', () => {
    expect(extractSymbolFromContext('')).toBeNull();
  });
});

describe('extractDeclaration', () => {
  it('captures + function decl', () => {
    expect(extractDeclaration('+function helper() {')).toEqual({ name: 'helper', sign: '+' });
  });
  it('captures - class decl', () => {
    expect(extractDeclaration('-export class Old {')).toEqual({ name: 'Old', sign: '-' });
  });
  it('captures Python def', () => {
    expect(extractDeclaration('+def my_helper(x):')).toEqual({ name: 'my_helper', sign: '+' });
  });
  it('captures Go func with receiver', () => {
    expect(extractDeclaration('+func (s *Service) DoThing() error {')).toEqual({
      name: 'DoThing',
      sign: '+',
    });
  });
  it('skips file-marker `+++` and `---` lines', () => {
    expect(extractDeclaration('+++ b/src/foo.ts')).toBeNull();
    expect(extractDeclaration('--- a/src/foo.ts')).toBeNull();
  });
  it('skips keywords like `+if`', () => {
    expect(extractDeclaration('+  if (x) return;')).toBeNull();
  });
  it('returns null on context lines (no +/-)', () => {
    expect(extractDeclaration(' some body line')).toBeNull();
  });
});

// ============================================================================
// Git mining: synthetic repo
// ============================================================================

describe.skipIf(!HAS_GIT)('mineIssueCommits', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
  });

  it('finds commits with `Fixes #N` in the subject', async () => {
    commitAt('2025-01-01T00:00:00Z', { 'a.ts': 'a' }, 'feat: add a (no issue)');
    commitAt('2025-01-02T00:00:00Z', { 'a.ts': 'a2' }, 'fix: bug. Fixes #42');
    const commits = await mineIssueCommits(testDir, null);
    expect(commits.length).toBe(1);
    expect(commits[0]!.issues).toEqual([42]);
  });

  it('parses multi-issue subjects', async () => {
    commitAt('2025-01-01T00:00:00Z', { 'a.ts': 'a' }, 'fix: triple. Fixes #1, closes #2, resolves #3');
    const [c] = await mineIssueCommits(testDir, null);
    expect(c?.issues).toEqual([1, 2, 3]);
  });

  it('ignores commits with no issue ref', async () => {
    commitAt('2025-01-01T00:00:00Z', { 'a.ts': 'a' }, 'plain message');
    expect((await mineIssueCommits(testDir, null)).length).toBe(0);
  });

  it('returns [] when not in a git repo', async () => {
    const nonGit = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-nogit-'));
    try {
      expect(await mineIssueCommits(nonGit, null)).toEqual([]);
    } finally {
      fs.rmSync(nonGit, { recursive: true, force: true });
    }
  });
});

// ============================================================================
// End-to-end through Cartograph
// ============================================================================

describe.skipIf(!HAS_GIT)('Cartograph issue history', () => {
  beforeEach(() => {
    git('init', '-q', '-b', 'main');
    git('config', 'commit.gpgsign', 'false');
  });

  it('attributes a Fixes #N commit to the modified function', async () => {
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 1; }\n`,
      },
      'feat: add foo',
    );

    commitAt(
      '2025-02-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() {\n  // changed\n  return 2;\n}\n`,
      },
      'fix: bug. Fixes #42',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'foo')!;
    expect(node).toBeDefined();
    const issues = getIssuesForNode(cg.queries, node.id);
    expect(issues.length).toBeGreaterThan(0);
    expect(issues.some((i) => i.issueNumber === 42)).toBe(true);
  });

  it('tracks the agent-usable multi-issue signal', async () => {
    // Simulate the cartograph history pattern: `loadGrammarsForLanguages`
    // touched by every language-add issue (#54, #82, #83, #85).
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/grammar.ts': `export function loadGrammarsForLanguages() { return []; }\n`,
      },
      'feat: add grammar loader',
    );

    commitAt(
      '2025-01-02T00:00:00Z',
      {
        'src/grammar.ts': `export function loadGrammarsForLanguages() {\n  // R support\n  return [];\n}\n`,
      },
      'feat: add R support. Fixes #82',
    );

    commitAt(
      '2025-01-03T00:00:00Z',
      {
        'src/grammar.ts': `export function loadGrammarsForLanguages() {\n  // R + HCL support\n  return [];\n}\n`,
      },
      'feat: add HCL. Fixes #83',
    );

    commitAt(
      '2025-01-04T00:00:00Z',
      {
        'src/grammar.ts': `export function loadGrammarsForLanguages() {\n  // R + HCL + SQL\n  return [];\n}\n`,
      },
      'feat: add SQL. Fixes #85',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'loadGrammarsForLanguages')!;
    expect(node).toBeDefined();
    const issues = getIssuesForNode(cg.queries, node.id);
    const issueNumbers = [...new Set(issues.map((i) => i.issueNumber))].sort((a, b) => a - b);
    expect(issueNumbers).toEqual([82, 83, 85]);
  });

  it('records `added` kind for symbols introduced in a Fixes commit', async () => {
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function existing() { return 1; }\n`,
      },
      'init',
    );

    commitAt(
      '2025-02-01T00:00:00Z',
      {
        'src/a.ts': `export function existing() { return 1; }\nexport function brandNew() { return 2; }\n`,
      },
      'feat: add brandNew. Fixes #100',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'brandNew')!;
    const issues = getIssuesForNode(cg.queries, node.id);
    expect(issues.some((i) => i.issueNumber === 100 && i.kind === 'added')).toBe(true);
  });

  it('drops attributions for symbols that no longer exist', async () => {
    // Symbol added then removed in two separate `Fixes` commits. The
    // current index has no node for it, so attributions for the removed
    // symbol must not appear (FK + drop-on-resolve).
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function staysHere() { return 1; }\nexport function temporary() { return 99; }\n`,
      },
      'feat: add. Fixes #1',
    );

    commitAt(
      '2025-02-01T00:00:00Z',
      {
        'src/a.ts': `export function staysHere() { return 1; }\n`,
      },
      'fix: drop temporary. Fixes #2',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // staysHere should have at least the #1 attribution (added).
    const node = getNodesByKind(cg.queries, 'function').find((n) => n.name === 'staysHere')!;
    const issues = getIssuesForNode(cg.queries, node.id);
    expect(issues.some((i) => i.issueNumber === 1)).toBe(true);

    // No node should exist named `temporary`, and no attribution to
    // issue #2 should reference a node that doesn't exist.
    expect(getNodesByKind(cg.queries, 'function').find((n) => n.name === 'temporary')).toBeUndefined();
  });

  it('survives indexAll outside a git repo (table empty, no errors)', async () => {
    fs.rmSync(path.join(testDir, '.git'), { recursive: true, force: true });
    fs.writeFileSync(path.join(testDir, 'a.ts'), `export function x() { return 1; }\n`);
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    const nodes = cg.queries.getNodesByFile('a.ts');
    expect(nodes.length).toBeGreaterThan(0);
    for (const n of nodes) expect(getIssuesForNode(cg.queries, n.id)).toEqual([]);
  });

  it('respects enableIssueHistory=false', async () => {
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 1; }\n`,
      },
      'init',
    );
    commitAt(
      '2025-01-02T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 2; }\n`,
      },
      'fix: foo. Fixes #1',
    );

    cg = Cartograph.initSync(testDir, {
      config: { include: ['**/*.ts'], exclude: [], enableIssueHistory: false },
    });
    await cg.indexAll();
    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'foo')!;
    expect(getIssuesForNode(cg.queries, node.id)).toEqual([]);
  });

  it('incrementally picks up new Fixes commits on sync', async () => {
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 1; }\n`,
      },
      'init',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'foo')!;
    expect(getIssuesForNode(cg.queries, node.id).length).toBe(0);

    commitAt(
      '2025-02-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 2; }\n`,
      },
      'fix: foo. Fixes #50',
    );
    await cg.sync();

    const issues = getIssuesForNode(cg.queries, node.id);
    expect(issues.some((i) => i.issueNumber === 50)).toBe(true);
  });

  // (Removed: a defensive test for the v4-migration-collision bug class.
  // With file-based migrations (NNN-name.ts), two migrations claiming
  // the same version produces a filesystem-level conflict — the silent
  // skip the defensive guard protected against can no longer happen.)

  it('recovers from an unreachable last_mined_issues_head', async () => {
    commitAt(
      '2025-01-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 1; }\n`,
      },
      'init',
    );
    commitAt(
      '2025-02-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 2; }\n`,
      },
      'fix: foo. Fixes #1',
    );

    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
    const node = cg.queries.getNodesByFile('src/a.ts').find((n) => n.name === 'foo')!;
    expect([...new Set(getIssuesForNode(cg.queries, node.id).map((i) => i.issueNumber))]).toEqual([1]);

    // Simulate force-push / gc by storing an unreachable SHA.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setMetadata((cg as any).queries, LAST_MINED_ISSUES_HEAD_KEY, '0'.repeat(40));

    commitAt(
      '2025-03-01T00:00:00Z',
      {
        'src/a.ts': `export function foo() { return 3; }\n`,
      },
      'fix: foo again. Fixes #2',
    );
    await cg.sync();

    const issueNums = [...new Set(getIssuesForNode(cg.queries, node.id).map((i) => i.issueNumber))].sort(
      (a, b) => a - b,
    );
    expect(issueNums).toEqual([1, 2]);
  });
});
