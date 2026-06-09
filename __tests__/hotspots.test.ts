/**
 * cartograph_hotspots — 3-category split (risk / maintenance / brittle).
 *
 * Sets up a small git repo with files having intentionally different
 * centrality + churn profiles, then verifies that:
 *   - category='all' returns 3 sections
 *   - category='maintenance' returns the high-churn / low-centrality bucket
 *   - category='brittle' returns the high-centrality / low-churn bucket
 *   - default (no category arg) is unchanged / backward-compatible
 *
 * Centrality is computed from graph structure — files that are imported
 * by many others rank higher. Churn is commit count per file.
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { getCategorizedHotspots } from '../src/db/queries-history.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';

let HAS_GIT = true;
try {
  execFileSync('git', ['--version'], { stdio: 'ignore' });
} catch {
  HAS_GIT = false;
}

function git(cwd: string, ...args: string[]): void {
  execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 'Test',
      GIT_AUTHOR_EMAIL: 'test@t.com',
      GIT_COMMITTER_NAME: 'Test',
      GIT_COMMITTER_EMAIL: 'test@t.com',
    },
    stdio: ['pipe', 'pipe', 'pipe'],
  });
}

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

describe.skipIf(!HAS_GIT)('cartograph_hotspots — categorized split', () => {
  let dir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspots-'));
    fs.mkdirSync(path.join(dir, 'src'));

    // ── File layout ────────────────────────────────────────────────────────
    //
    // hub.ts — imported by many others (high centrality after PageRank).
    //          We'll commit it rarely → low churn.
    //          → Should land in BRITTLE bucket.
    //
    // churn.ts — not imported by anything else (low centrality).
    //            We'll commit it many times → high churn.
    //            → Should land in MAINTENANCE bucket.
    //
    // hot.ts  — imports hub.ts (medium centrality via incoming edges from
    //           deps) AND gets many commits.
    //           → Should land in RISK bucket when both dimensions are high.
    //
    // a.ts, b.ts, c.ts — low-traffic files that import hub.ts to boost
    //                    its PageRank score.
    //
    // The intent is NOT to guarantee exact bucket membership for every
    // file (that depends on the 75th/25th percentile thresholds computed
    // from whatever combination of files survives minCommits filtering).
    // Instead we assert that the tool renders the expected section headers
    // and that each single-category call returns a non-empty table.

    const hubSrc = `export function fromHub(): number { return 42; }\n`;
    const churnSrc = (v: number) => `export function churnFn(): number { return ${v}; }\n`;
    const importHub = `import { fromHub } from './hub.js';\nexport function useHub(): number { return fromHub(); }\n`;
    const hotSrc = (v: number) =>
      `import { fromHub } from './hub.js';\nexport function hotFn(): number { return fromHub() + ${v}; }\n`;

    fs.writeFileSync(path.join(dir, 'src', 'hub.ts'), hubSrc);
    fs.writeFileSync(path.join(dir, 'src', 'churn.ts'), churnSrc(0));
    fs.writeFileSync(path.join(dir, 'src', 'hot.ts'), hotSrc(0));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), importHub);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), importHub);
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), importHub);
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-hs', version: '0.0.0' }));

    git(dir, 'init', '-q');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    // Give churn.ts many more commits to push it into the high-churn bucket.
    for (let i = 1; i <= 8; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'churn.ts'), churnSrc(i));
      git(dir, 'add', 'src/churn.ts');
      git(dir, 'commit', '-q', '-m', `churn update ${i}`);
    }

    // Give hot.ts a few commits too.
    for (let i = 1; i <= 6; i++) {
      fs.writeFileSync(path.join(dir, 'src', 'hot.ts'), hotSrc(i));
      git(dir, 'add', 'src/hot.ts');
      git(dir, 'commit', '-q', '-m', `hot update ${i}`);
    }

    // hub.ts stays at 1 commit (just the init) → low churn.
    // a.ts, b.ts, c.ts also stay at 1 commit.

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it("category='all' renders three named sections", async () => {
    const result = await handler.execute('cartograph_hotspots', {
      category: 'all',
      minCommits: 1,
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/### Risk hotspots/);
    expect(text).toMatch(/### Maintenance burden/);
    expect(text).toMatch(/### Brittle dependencies/);
  });

  it("category='maintenance' returns the high-churn/low-centrality bucket", async () => {
    const result = await handler.execute('cartograph_hotspots', {
      category: 'maintenance',
      minCommits: 1,
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    // Should have the maintenance header and a table entry.
    expect(text).toMatch(/Maintenance burden/);
    // churn.ts has the most commits and no callers → top maintenance target.
    expect(text).toMatch(/churn\.ts/);
  });

  it("category='brittle' returns the high-centrality/low-churn bucket", async () => {
    const result = await handler.execute('cartograph_hotspots', {
      category: 'brittle',
      minCommits: 1,
    });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    expect(text).toMatch(/Brittle dependencies/);
    // hub.ts is imported by a.ts, b.ts, c.ts, hot.ts → high centrality.
    // It has only 1 commit → low churn.
    expect(text).toMatch(/hub\.ts/);
  });

  it('default (no category arg) is backward-compatible with risk-only output', async () => {
    const result = await handler.execute('cartograph_hotspots', { minCommits: 1 });
    const text = result.content[0]?.text ?? '';
    expect(result.isError).toBeFalsy();
    // Should NOT show the three-section layout.
    expect(text).not.toMatch(/### Maintenance burden/);
    expect(text).not.toMatch(/### Brittle dependencies/);
    // Should show the original single-table header.
    expect(text).toMatch(/## Hotspots/);
  });
});

/**
 * Regression for friction F-r9-2: the `brittle` lens claims "changes
 * here have outsized impact", but `fileCentrality` (Σ node PageRank)
 * rewards a file's INTERNAL call structure. A self-contained script
 * whose helpers all call each other scores high centrality with zero
 * external consumers — and was being mislabeled brittle. The bucket
 * now requires a real external in-degree.
 */
describe.skipIf(!HAS_GIT)('cartograph_hotspots — brittle requires external dependents', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspots-brittle-'));
    fs.mkdirSync(path.join(dir, 'src'));

    // hub.ts — imported by a/b/c → real external dependents.
    fs.writeFileSync(path.join(dir, 'src', 'hub.ts'), `export function fromHub(): number { return 1; }\n`);
    const importHub = `import { fromHub } from './hub.js';\nexport function useHub(): number { return fromHub(); }\n`;
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), importHub);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), importHub);
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), importHub);
    // spike.ts — a self-contained internal call chain, imported by
    // nothing. Rich internal structure → high Σ-centrality, but zero
    // external in-degree.
    fs.writeFileSync(
      path.join(dir, 'src', 'spike.ts'),
      [
        'function s0(): number { return 1; }',
        'function s1(): number { return s0() + 1; }',
        'function s2(): number { return s1() + s0(); }',
        'function s3(): number { return s2() + s1(); }',
        'function s4(): number { return s3() + s2(); }',
        'export function spikeMain(): number { return s4() + s3(); }',
      ].join('\n') + '\n',
    );
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-hsb', version: '0.0.0' }));

    git(dir, 'init', '-q');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    // Every file stays at 1 commit → uniform low churn.

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('excludes a self-contained high-centrality file with no external dependents', () => {
    const { brittle } = getCategorizedHotspots(cg.queries, { minCommits: 1, limitPerCategory: 20 });
    // Invariant: every brittle file genuinely has consumers.
    expect(brittle.every((r) => (r.externalDependents ?? 0) > 0)).toBe(true);
    // hub.ts is imported by a/b/c → it stays a brittle candidate.
    expect(brittle.some((r) => r.filePath === 'src/hub.ts')).toBe(true);
    // spike.ts has zero external in-degree → excluded despite its
    // internally-generated centrality.
    expect(brittle.some((r) => r.filePath === 'src/spike.ts')).toBe(false);
  });
});

describe('cartograph_hotspots — empty-result diagnostic (friction #19)', () => {
  let dir: string;
  let cg: Cartograph;

  afterEach(() => {
    if (cg) cg.close();
    if (dir && fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('names "no churn mined" — not "not a git repo" — on a non-git project', async () => {
    // A non-git project: no commit history, so churn is never mined.
    // The diagnostic must NOT blame `minCommits` (it is irrelevant when
    // commit_count is 0 everywhere) and must name the real cause.
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspots-empty-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lone.ts'), 'export function lone(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-he', version: '0.0.0' }));

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const handler = new ToolHandler(cg, { profile: 'full' });
    const result = await handler.execute('cartograph_hotspots', {});
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No hotspots to report/);
    // The real cause is named.
    expect(text).toMatch(/No churn data has been mined yet/);
    // The misleading pre-fix headline cause must be gone.
    expect(text).not.toMatch(/`minCommits` is set higher than any file in the project/);
  });

  it.skipIf(!HAS_GIT)('names "filter too strict" when churn is mined but minCommits excludes all', async () => {
    // A git repo with one commit → churn IS mined (commit_count > 0).
    // An absurdly high `minCommits` filters every file. The diagnostic
    // must point at the filters, not at "no git history".
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-hotspots-strict-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'lone.ts'), 'export function lone(): number { return 1; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'cg-hs', version: '0.0.0' }));
    git(dir, 'init', '-q');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    const handler = new ToolHandler(cg, { profile: 'full' });
    const result = await handler.execute('cartograph_hotspots', { minCommits: 9999 });
    handler.closeAll();
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/No hotspots to report/);
    expect(text).toMatch(/Churn data is present/);
    expect(text).not.toMatch(/No churn data has been mined/);
  });
});
