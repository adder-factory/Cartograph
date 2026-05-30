/**
 * classifyCommitMessage — heuristic commit-intent classifier.
 *
 * Coverage:
 *   - Conventional Commits prefix (rule 1, score 0.95)
 *   - Keyword cues in subject (rule 2, score 0.5–0.6)
 *   - Body / footer cues (rule 3, score 0.5–0.6)
 *   - Fallback to 'unknown'
 *   - Priority: prefix > keyword, first keyword wins
 */

import { describe, it, expect } from 'vitest';
import { classifyCommitMessage } from '../src/llm/commit-intent.js';

// ---------------------------------------------------------------------------
// Rule 1 — Conventional Commits prefix
// ---------------------------------------------------------------------------

describe('classifyCommitMessage — conventional prefixes', () => {
  it('feat: add auth → feat 0.95', () => {
    const r = classifyCommitMessage('feat: add auth');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.95);
  });

  it('feat(api): foo → feat 0.95', () => {
    const r = classifyCommitMessage('feat(api): foo');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.95);
  });

  it('feature: new thing → feat 0.95', () => {
    const r = classifyCommitMessage('feature: new thing');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.95);
  });

  it('fix: stop crash → fix 0.95', () => {
    const r = classifyCommitMessage('fix: stop crash');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.95);
  });

  it('bugfix: guard null → fix 0.95', () => {
    const r = classifyCommitMessage('bugfix: guard null');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.95);
  });

  it('hotfix: patch logout → fix 0.95', () => {
    const r = classifyCommitMessage('hotfix: patch logout');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.95);
  });

  it('refactor: extract X → refactor 0.95', () => {
    const r = classifyCommitMessage('refactor: extract X');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.95);
  });

  it('perf: cache lookups → perf 0.95', () => {
    const r = classifyCommitMessage('perf: cache lookups');
    expect(r.intent).toBe('perf');
    expect(r.score).toBe(0.95);
  });

  it('test: cover edge case → test 0.95', () => {
    const r = classifyCommitMessage('test: cover edge case');
    expect(r.intent).toBe('test');
    expect(r.score).toBe(0.95);
  });

  it('docs: update README → docs 0.95', () => {
    const r = classifyCommitMessage('docs: update README');
    expect(r.intent).toBe('docs');
    expect(r.score).toBe(0.95);
  });

  it('doc: fix wording → docs 0.95', () => {
    const r = classifyCommitMessage('doc: fix wording');
    expect(r.intent).toBe('docs');
    expect(r.score).toBe(0.95);
  });

  it('chore: bump deps → chore 0.95', () => {
    const r = classifyCommitMessage('chore: bump deps');
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.95);
  });

  it('build: bump TS version → chore 0.95', () => {
    const r = classifyCommitMessage('build: bump TS version');
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.95);
  });

  it('ci: add caching → chore 0.95', () => {
    const r = classifyCommitMessage('ci: add caching');
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.95);
  });
});

// ---------------------------------------------------------------------------
// Rule 2 — Keyword cues in subject (no conventional prefix)
// ---------------------------------------------------------------------------

describe('classifyCommitMessage — keyword cues without prefix', () => {
  it('Add user authentication → feat 0.6', () => {
    const r = classifyCommitMessage('Add user authentication');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.6);
  });

  it('Implement OAuth flow → feat 0.6', () => {
    const r = classifyCommitMessage('Implement OAuth flow');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.6);
  });

  it('Introduce dark mode → feat 0.6', () => {
    const r = classifyCommitMessage('Introduce dark mode');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.6);
  });

  it('Support multiple providers → feat 0.6', () => {
    const r = classifyCommitMessage('Support multiple providers');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.6);
  });

  it('Fix the token refresh bug → fix 0.6', () => {
    const r = classifyCommitMessage('Fix the token refresh bug');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.6);
  });

  it('Resolve timeout issue when caching → fix 0.6', () => {
    const r = classifyCommitMessage('Resolve timeout issue when caching');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.6);
  });

  it('Correct crash on null user error → fix 0.6', () => {
    const r = classifyCommitMessage('Correct crash on null user error');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.6);
  });

  it('Refactor caching layer → refactor 0.6', () => {
    const r = classifyCommitMessage('Refactor caching layer');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.6);
  });

  it('Rename foo to bar → refactor 0.6', () => {
    const r = classifyCommitMessage('Rename foo to bar');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.6);
  });

  it('Extract auth into its own module → refactor 0.6', () => {
    const r = classifyCommitMessage('Extract auth into its own module');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.6);
  });

  it('Simplify the parser logic → refactor 0.6', () => {
    const r = classifyCommitMessage('Simplify the parser logic');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.6);
  });

  it('Speed up query path → perf 0.6', () => {
    const r = classifyCommitMessage('Speed up query path');
    expect(r.intent).toBe('perf');
    expect(r.score).toBe(0.6);
  });

  it('Optimize render → perf 0.6', () => {
    const r = classifyCommitMessage('Optimize render');
    expect(r.intent).toBe('perf');
    expect(r.score).toBe(0.6);
  });

  it('Improve performance of the sync pass → perf 0.6', () => {
    const r = classifyCommitMessage('Improve performance of the sync pass');
    expect(r.intent).toBe('perf');
    expect(r.score).toBe(0.6);
  });

  it('Add test for X → test 0.6', () => {
    const r = classifyCommitMessage('Add test for X');
    expect(r.intent).toBe('test');
    expect(r.score).toBe(0.6);
  });

  it('Add tests for the resolver → test 0.6', () => {
    const r = classifyCommitMessage('Add tests for the resolver');
    expect(r.intent).toBe('test');
    expect(r.score).toBe(0.6);
  });

  it('Update README with examples → docs 0.6', () => {
    const r = classifyCommitMessage('Update README with examples');
    expect(r.intent).toBe('docs');
    expect(r.score).toBe(0.6);
  });

  it('Fix typo in comment → docs (typo beats generic fix)', () => {
    // "typo" is a docs signal; the generic "fix + bug-signal" rule
    // requires a bug-noise word. "typo" fires docs first.
    const r = classifyCommitMessage('Fix typo in comment');
    expect(r.intent).toBe('docs');
    expect(r.score).toBe(0.6);
  });

  it('Bump @types/node → chore 0.55', () => {
    const r = classifyCommitMessage('Bump @types/node');
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.55);
  });

  it('Upgrade vitest to 2.0 → chore 0.55', () => {
    const r = classifyCommitMessage('Upgrade vitest to 2.0');
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.55);
  });
});

// ---------------------------------------------------------------------------
// Rule 3 — Body / footer cues
// ---------------------------------------------------------------------------

describe('classifyCommitMessage — body / footer cues', () => {
  it('subject ambiguous + "Fixes #123" in body → fix 0.5', () => {
    const r = classifyCommitMessage('Some description\n\nFixes #123');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.5);
  });

  it('subject ambiguous + "Closes #42" in body → fix 0.5', () => {
    const r = classifyCommitMessage('Some change\n\nCloses #42');
    expect(r.intent).toBe('fix');
    expect(r.score).toBe(0.5);
  });

  it('subject ambiguous + "BREAKING CHANGE:" → feat 0.6', () => {
    const r = classifyCommitMessage('Some change\n\nBREAKING CHANGE: old API removed');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.6);
  });
});

// ---------------------------------------------------------------------------
// Fallback — unknown
// ---------------------------------------------------------------------------

describe('classifyCommitMessage — fallback', () => {
  it('empty string → unknown', () => {
    const r = classifyCommitMessage('');
    expect(r.intent).toBe('unknown');
    expect(r.score).toBe(0.0);
  });

  it('"WIP" → unknown', () => {
    const r = classifyCommitMessage('WIP');
    expect(r.intent).toBe('unknown');
    expect(r.score).toBe(0.0);
  });

  it('"asdf" → unknown', () => {
    const r = classifyCommitMessage('asdf');
    expect(r.intent).toBe('unknown');
    expect(r.score).toBe(0.0);
  });

  it('"merge branch feature/X" → chore 0.5', () => {
    const r = classifyCommitMessage("merge branch 'feature/X'");
    expect(r.intent).toBe('chore');
    expect(r.score).toBe(0.5);
  });
});

// ---------------------------------------------------------------------------
// Priority checks
// ---------------------------------------------------------------------------

describe('classifyCommitMessage — priority', () => {
  it('prefix beats keyword: "feat: fix typo" → feat', () => {
    // Subject starts with "feat:" — rule 1 fires before any keyword scan.
    const r = classifyCommitMessage('feat: fix typo');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.95);
  });

  it('first keyword wins: "Add fix for refactor" → feat (add fires first)', () => {
    // "Add" is a feat keyword; "fix" also appears but has no bug-signal
    // noun next to it, so the fix pattern won't match. Even if it did,
    // the docs/feat rules are evaluated before fix in KEYWORD_RULES.
    // "refactor" appears as a noun, not a verb — refactor rule won't fire.
    const r = classifyCommitMessage('Add fix for refactor');
    expect(r.intent).toBe('feat');
  });

  it('prefix beats footer: "feat: something\\n\\nFixes #1" → feat', () => {
    // Rule 1 fires on the subject; rule 3 is never reached.
    const r = classifyCommitMessage('feat: something\n\nFixes #1');
    expect(r.intent).toBe('feat');
    expect(r.score).toBe(0.95);
  });

  it('keyword beats footer: ambiguous subject + keyword → keyword wins', () => {
    // "Rename X to Y" (refactor keyword) + "Fixes #1" in body.
    // Rule 2 should fire before rule 3.
    const r = classifyCommitMessage('Rename X to Y\n\nFixes #1');
    expect(r.intent).toBe('refactor');
    expect(r.score).toBe(0.6);
  });
});
