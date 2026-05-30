/**
 * Freshness Gate — concurrency + adversarial stress.
 *
 * Skipped by default (long-running, spawns git, dozens of indexers).
 * Run explicitly:
 *   STRESS=1 npx vitest run __tests__/freshness-stress.test.ts
 */

import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import type { QueryBuilder } from '../src/db/queries.js';
import { setMetadata } from '../src/db/queries-metadata.js';

const STRESS = process.env.STRESS === '1';
const describeStress = STRESS ? describe : describe.skip;

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function makeRepo(suffix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `cg-freshstress-${suffix}-`));
  fs.mkdirSync(path.join(dir, 'src'));
  fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha() { return 1; }\n`);
  fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'stress@example.com');
  git(dir, 'config', 'user.name', 'Stress');
  git(dir, 'config', 'commit.gpgsign', 'false');
  git(dir, 'add', '.');
  git(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

describeStress('Freshness Gate — concurrency stress', () => {
  let staleDir: string;
  let freshDir: string;
  let staleCg: Cartograph;
  let freshCg: Cartograph;

  beforeAll(async () => {
    staleDir = makeRepo('stale');
    freshDir = makeRepo('fresh');
    staleCg = Cartograph.initSync(staleDir, { config: { include: ['**/*.ts'], exclude: [] } });
    freshCg = Cartograph.initSync(freshDir, { config: { include: ['**/*.ts'], exclude: [] } });
    await staleCg.indexAll();
    await freshCg.indexAll();

    // Drift the stale project's HEAD by MORE than AUTO_SYNC_MAX_FILES
    // (currently 5) so the inline auto-sync path doesn't kick in and
    // erase the banner mid-run. Tests that auto-sync small drifts are
    // exercised separately in `freshness-v2-stress.test.ts`.
    for (let i = 0; i < 10; i++) {
      fs.writeFileSync(path.join(staleDir, 'src', `drift_${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(staleDir, 'add', '.');
    git(staleDir, 'commit', '-q', '-m', 'drift batch');

    expect(staleCg.getFreshness()?.isStale).toBe(true);
    expect(freshCg.getFreshness()?.isStale).toBe(false);
  }, 60000);

  afterAll(() => {
    if (staleCg) staleCg.destroy();
    if (freshCg) freshCg.destroy();
    if (fs.existsSync(staleDir)) fs.rmSync(staleDir, { recursive: true, force: true });
    if (fs.existsSync(freshDir)) fs.rmSync(freshDir, { recursive: true, force: true });
  });

  it('1000 interleaved execute() calls preserve per-call banner state', async () => {
    const handler = new ToolHandler(staleCg);
    const CALLS = 1000;
    const PARALLEL = 50;

    let mismatches = 0;
    let errors = 0;
    let staleSeen = 0;
    let freshSeen = 0;

    const tasks: Array<() => Promise<void>> = [];
    for (let i = 0; i < CALLS; i++) {
      const useStale = i % 2 === 0;
      const projectPath = useStale ? staleDir : freshDir;
      tasks.push(async () => {
        try {
          const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha', projectPath });
          const text = (result.content?.[0] as { text?: string })?.text ?? '';
          const hasBanner = text.startsWith('> ⚠ Index out of date');
          if (useStale) {
            if (hasBanner) staleSeen++;
            else mismatches++;
          } else {
            if (hasBanner) {
              mismatches++;
            } else {
              freshSeen++;
            }
          }
        } catch (err) {
          errors++;
          console.error('error', err);
        }
      });
    }

    for (let i = 0; i < tasks.length; i += PARALLEL) {
      await Promise.all(tasks.slice(i, i + PARALLEL).map((f) => f()));
    }

    console.log(`stress: stale=${staleSeen} fresh=${freshSeen} mismatches=${mismatches} errors=${errors}`);
    expect(errors).toBe(0);
    expect(mismatches).toBe(0);
    expect(staleSeen).toBe(CALLS / 2);
    expect(freshSeen).toBe(CALLS / 2);
  }, 120000);
});

describeStress('Freshness Gate — adversarial edge cases', () => {
  it('handles 5000-file changed count without crashing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-freshstress-bigdiff-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');

    const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Mass-add 5000 files in a single commit
    for (let i = 0; i < 5000; i++) {
      fs.writeFileSync(path.join(dir, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
    }
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'mass add');

    const start = Date.now();
    const f = cg.stats.getFreshness();
    const elapsed = Date.now() - start;
    console.log(`big-diff freshness elapsed: ${elapsed}ms, filesChanged: ${f?.filesChanged}`);

    expect(f).not.toBeNull();
    expect(f!.isStale).toBe(true);
    expect(f!.filesChanged).toBeGreaterThanOrEqual(5000);
    expect(elapsed).toBeLessThan(3000); // shouldn't be agonizingly slow

    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 120000);

  it('handles detached HEAD without crashing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-freshstress-detached-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'first');
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 2;\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'second');

    const firstSha = git(dir, 'rev-parse', 'HEAD~1');

    const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Detach HEAD to a prior commit
    git(dir, 'checkout', '-q', firstSha);

    const f = cg.stats.getFreshness();
    expect(f).not.toBeNull();
    expect(f!.isStale).toBe(true); // indexed at second sha, now at first
    expect(f!.banner).toContain('Index out of date');

    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 60000);

  it('survives .git deletion after indexing', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-freshstress-nogit-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');

    const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Wipe .git
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });

    // Should not throw, should not show a banner
    const f = cg.stats.getFreshness();
    expect(f).not.toBeNull();
    expect(f!.isStale).toBe(false);
    expect(f!.banner).toBeNull();

    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);

  it('survives corrupted index_timestamp metadata', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-freshstress-corrupt-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export const a = 1;\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'initial');

    const cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
    await cg.indexAll();

    // Corrupt index_timestamp via the live QueryBuilder so we exercise the
    // parse-failure branch in getFreshnessInfo (Number.isFinite guard).
    // Using setMetadata directly avoids the DB-lock pitfalls of opening a
    // second SQLite connection while cg still holds the first.
    setMetadata((cg as unknown as { queries: QueryBuilder }).queries, 'index_timestamp', 'not-a-number');

    const f = cg.stats.getFreshness();
    // Corrupted timestamp should yield null (no info), not crash.
    expect(f).toBeNull();
    cg.destroy();
    fs.rmSync(dir, { recursive: true, force: true });
  }, 30000);
});
