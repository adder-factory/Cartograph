/**
 * Tooling-gaps item #1: Freshness severity bucket.
 *
 * `getFreshnessInfo` currently exposes raw `isStale` + counts. Agents
 * (and CLI users) need a bucketed severity so "14h, 7 commits behind"
 * can be classified as "safe to query" vs "results may mislead"
 * without re-deriving the thresholds at every call site.
 *
 * Expected API: FreshnessInfo gains a `severity` field with values
 * 'fresh' | 'recent' | 'stale' | 'very_stale'.
 *
 *   fresh       — in sync with HEAD AND indexedAt within ~1h
 *   recent      — small drift (≤1d AND ≤10 files changed)
 *   stale       — >1d OR >10 files changed
 *   very_stale  — >7d OR >100 files changed
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { getFreshnessInfo, classifyFreshness } from '../src/freshness.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function setupRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 't@t');
  git(dir, 'config', 'user.name', 't');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('Tooling-gaps #1: freshness severity bucket', () => {
  let testDir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-fresh-sev-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function a(){return 1;}\n`);
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    setupRepo(testDir);
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');
    cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('exposes a `severity` enum on FreshnessInfo', () => {
    const f = getFreshnessInfo((cg as any).queries, testDir);
    expect(f).not.toBeNull();
    // Must be one of the documented buckets.
    expect((f as any).severity).toMatch(/^(fresh|recent|stale|very_stale)$/);
  });

  it('classifies a just-indexed, in-sync repo as `fresh`', () => {
    const f = getFreshnessInfo((cg as any).queries, testDir);
    expect((f as any).severity).toBe('fresh');
  });

  it('an in-sync repo indexed >7 days ago is NOT very_stale (regression)', () => {
    // Reviewer caught this: an in-sync repo (isStale=false, no drift)
    // indexed 8 days ago should land in `recent`, not `very_stale` —
    // the index content is still correct.
    const eightDaysMs = 8 * 24 * 60 * 60 * 1000;
    expect(
      classifyFreshness({
        ageMs: eightDaysMs,
        filesChanged: 0,
        commitsAhead: 0,
        isStale: false,
      }),
    ).toBe('recent');
  });

  it('classifies many-files-changed as `very_stale`', async () => {
    // Simulate large drift: write 120 new files post-index, advance HEAD.
    for (let i = 0; i < 120; i++) {
      fs.writeFileSync(path.join(testDir, 'src', `new${i}.ts`), `export const v${i}=${i};\n`);
    }
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'big drift');
    const f = getFreshnessInfo((cg as any).queries, testDir);
    expect((f as any).severity).toBe('very_stale');
  });
});
