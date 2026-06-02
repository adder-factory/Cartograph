/**
 * Commit-intent LLM residue pass — the two new helpers behind it.
 *
 * `getUnknownCommitShas` selects the heuristic-`unknown` residue;
 * `getCommitSubjects` git-fetches subject lines for those SHAs to feed
 * the LLM fallback. The phase itself (`runCommitIntentResiduePhase`)
 * is integration-covered via the background LLM pass.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { recordCommitIntents, getUnknownCommitShas } from '../src/db/queries-commit-intents.js';
import { getCommitSubjects, getCurrentHeadSha } from '../src/git-utils.js';

const byString = (a: string, b: string): number => a.localeCompare(b);

describe('getUnknownCommitShas', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ci-residue-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
  });
  afterEach(() => {
    try {
      db.close();
    } catch {
      /* noop */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns only the SHAs whose intent is unknown', () => {
    recordCommitIntents(q, [
      { sha: 'a'.repeat(40), intent: 'feat', score: 0.9 },
      { sha: 'b'.repeat(40), intent: 'unknown', score: 0 },
      { sha: 'c'.repeat(40), intent: 'unknown', score: 0 },
      { sha: 'd'.repeat(40), intent: 'fix', score: 0.8 },
    ]);
    expect(getUnknownCommitShas(q).sort(byString)).toEqual(['b'.repeat(40), 'c'.repeat(40)]);
  });

  it('returns empty when nothing is unknown', () => {
    recordCommitIntents(q, [{ sha: 'a'.repeat(40), intent: 'feat', score: 0.9 }]);
    expect(getUnknownCommitShas(q)).toEqual([]);
  });
});

describe('getCommitSubjects', () => {
  let dir: string;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-ci-git-'));
    execFileSync('git', ['init'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.email', 't@t.com'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['config', 'user.name', 'T'], { cwd: dir, stdio: 'pipe' });
  });
  afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

  let n = 0;
  function commit(message: string): string {
    fs.writeFileSync(path.join(dir, `f${n++}.txt`), 'x');
    execFileSync('git', ['add', '-A'], { cwd: dir, stdio: 'pipe' });
    execFileSync('git', ['commit', '-m', message], { cwd: dir, stdio: 'pipe' });
    return getCurrentHeadSha(dir)!;
  }

  it('fetches the subject line (only) for each requested SHA', () => {
    const s1 = commit('reword the retry path\n\nbody text the subject must not include');
    const s2 = commit('another commit');
    const map = getCommitSubjects(dir, [s1, s2]);
    expect(map.get(s1)).toBe('reword the retry path');
    expect(map.get(s2)).toBe('another commit');
  });

  it('skips an unknown SHA without failing the rest of the batch', () => {
    const s1 = commit('real commit');
    const map = getCommitSubjects(dir, [s1, '0'.repeat(40)]);
    expect(map.get(s1)).toBe('real commit');
    expect(map.has('0'.repeat(40))).toBe(false);
  });

  it('returns an empty map for an empty SHA list', () => {
    expect(getCommitSubjects(dir, []).size).toBe(0);
  });
});
