/**
 * ChangeOracle — unit + cross-tool invariant coverage.
 *
 * Unit tests assert each facet's primitive behaviour. The invariant
 * tests are the load-bearing ones: they pin the contract that prevents
 * silent disagreement between tools that ask "is this file changed?".
 * If a new tool computes a change set some OTHER way and disagrees with
 * the Oracle, that's a structural regression — these tests should
 * catch it via the equivalent Oracle facet.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { whatChanged, changedFileUnion, ALL_FACETS, type ChangeFacet } from '../src/change-oracle/index.js';
import { getFreshnessInfo } from '../src/freshness.js';
import { listChangedFilesSince } from '../src/git-utils.js';

const ALL: ReadonlySet<ChangeFacet> = ALL_FACETS;

describe('ChangeOracle — unit', () => {
  let dir: string;
  let cg: Cartograph;

  function git(...argv: string[]): void {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oracle-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return 2; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    // init creates a project .gitignore that excludes .cartograph/. Commit
    // it BEFORE indexAll so indexedSha matches the post-init HEAD — the
    // freshness primitive only computes `contentDriftedFiles` when
    // `currentSha === indexedSha`, and our cross-tool invariant test
    // depends on that path being live.
    git('add', '.');
    if (execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' }).trim().length > 0) {
      git('commit', '-q', '-m', 'init gitignore');
    }
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('returns an empty snapshot when no facets are requested', () => {
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set() });
    expect(snap.gitDiff).toBeNull();
    expect(snap.contentDrift.size).toBe(0);
    expect(snap.healFlagged.size).toBe(0);
    expect(snap.vanished.size).toBe(0);
  });

  it('reports only the requested facet — clean tree', () => {
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['gitDiff']) });
    expect(snap.gitDiff).not.toBeNull();
    expect(snap.gitDiff!.paths.size).toBe(0);
    // Other facets stay untouched even though contentDrift would also be empty.
    expect(snap.contentDrift.size).toBe(0);
    expect(snap.healFlagged.size).toBe(0);
    expect(snap.vanished.size).toBe(0);
  });

  it('gitDiff facet reports untracked + modified working-tree files', () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 99; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return 3; }\n`);
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['gitDiff']) });
    expect(snap.gitDiff!.paths.has('src/a.ts')).toBe(true);
    expect(snap.gitDiff!.paths.has('src/c.ts')).toBe(true);
  });

  it('contentDrift facet flags files whose on-disk SHA differs from index even when git is clean', () => {
    // Reproduce the "committed-but-drifted" case: corrupt the indexed
    // content_hash + bump mtime so isFileStale's mtime fast-path lets
    // the hash check run.
    cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale-hash' WHERE path = 'src/a.ts'`).run();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['contentDrift']) });
    expect(snap.contentDrift.has('src/a.ts')).toBe(true);
    expect(snap.contentDrift.has('src/b.ts')).toBe(false);
  });

  it('healFlagged facet surfaces files with needs_reextract=1', () => {
    cg.queries.db.prepare(`UPDATE files SET needs_reextract = 1 WHERE path = 'src/b.ts'`).run();
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['healFlagged']) });
    expect(snap.healFlagged.has('src/b.ts')).toBe(true);
    expect(snap.healFlagged.has('src/a.ts')).toBe(false);
  });

  it('vanished facet reports indexed files that no longer exist on disk', () => {
    fs.unlinkSync(path.join(dir, 'src', 'b.ts'));
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['vanished']) });
    expect(snap.vanished.has('src/b.ts')).toBe(true);
    expect(snap.vanished.has('src/a.ts')).toBe(false);
  });

  it('changedFileUnion merges every requested facet', () => {
    // Set up: a.ts content-drift, b.ts heal-flag, c.ts untracked.
    cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale' WHERE path = 'src/a.ts'`).run();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    cg.queries.db.prepare(`UPDATE files SET needs_reextract = 1 WHERE path = 'src/b.ts'`).run();
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return 3; }\n`);

    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: ALL });
    const union = changedFileUnion(snap, ALL);
    expect(union.has('src/a.ts')).toBe(true);
    expect(union.has('src/b.ts')).toBe(true);
    expect(union.has('src/c.ts')).toBe(true);
  });

  it('changedFileUnion honours a subset of facets', () => {
    cg.queries.db.prepare(`UPDATE files SET needs_reextract = 1 WHERE path = 'src/b.ts'`).run();
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return 3; }\n`);
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: ALL });
    // Caller asks only for gitDiff: heal-flag b.ts should not leak in.
    const justGit = changedFileUnion(snap, new Set(['gitDiff']));
    expect(justGit.has('src/c.ts')).toBe(true);
    expect(justGit.has('src/b.ts')).toBe(false);
  });

  it('gitDiff is null on a non-git directory', () => {
    // Move HEAD out of reach by removing the .git directory entirely.
    fs.rmSync(path.join(dir, '.git'), { recursive: true, force: true });
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['gitDiff']) });
    expect(snap.gitDiff).toBeNull();
    // changedFileUnion must not throw on a null gitDiff slot.
    const u = changedFileUnion(snap, new Set(['gitDiff']));
    expect(u.size).toBe(0);
  });
});

// ── Cross-tool invariants — the load-bearing contract ───────────────
// These tests are the structural defense: if a tool ever computes
// "what's changed" some other way and starts disagreeing with the
// Oracle, one of these invariants breaks and a future maintainer sees
// the disagreement explicitly. Adding a new tool that asks "is X
// changed?" should add an invariant here too.
describe('ChangeOracle — cross-tool invariants', () => {
  let dir: string;
  let cg: Cartograph;

  function git(...argv: string[]): void {
    execFileSync('git', argv, { cwd: dir, stdio: 'pipe' });
  }

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-oracle-inv-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 1; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'b.ts'), `export function beta(): number { return 2; }\n`);
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    git('init', '-q', '-b', 'main');
    git('config', 'user.email', 'test@example.com');
    git('config', 'user.name', 'Test');
    git('add', '.');
    git('commit', '-q', '-m', 'initial');
    cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    // init creates a project .gitignore that excludes .cartograph/. Commit
    // it BEFORE indexAll so indexedSha matches the post-init HEAD — the
    // freshness primitive only computes `contentDriftedFiles` when
    // `currentSha === indexedSha`, and our cross-tool invariant test
    // depends on that path being live.
    git('add', '.');
    if (execFileSync('git', ['status', '--porcelain'], { cwd: dir, encoding: 'utf-8' }).trim().length > 0) {
      git('commit', '-q', '-m', 'init gitignore');
    }
    await cg.indexAll({ summarize: false });
  });

  afterEach(() => {
    if (cg) cg.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('invariant — ChangeOracle.contentDrift.size === getFreshnessInfo().contentDriftedFiles', () => {
    // Inject drift, then assert the Oracle and the freshness primitive
    // freshness.ts uses for the status banner agree on the count.
    cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale' WHERE path = 'src/a.ts'`).run();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    cg.stats.invalidateFreshness();

    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['contentDrift']) });
    const fr = getFreshnessInfo(cg.queries, cg.projectRoot);
    // freshness only reports contentDriftedFiles when index is at HEAD;
    // we just committed and indexed so this should be a number, not null.
    expect(fr?.contentDriftedFiles).not.toBeNull();
    expect(snap.contentDrift.size).toBe(fr!.contentDriftedFiles!);
  });

  it('invariant — ChangeOracle.gitDiff.paths === listChangedFilesSince("HEAD") on a dirty tree', () => {
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), `export function alpha(): number { return 99; }\n`);
    fs.writeFileSync(path.join(dir, 'src', 'c.ts'), `export function gamma(): number { return 3; }\n`);
    const direct = new Set(listChangedFilesSince(cg.projectRoot, 'HEAD') ?? []);
    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['gitDiff']) });
    expect(snap.gitDiff!.paths).toEqual(direct);
  });

  it('invariant — sync resolves content-drift the Oracle flags', async () => {
    // The bug class #7 closes: if Oracle reports content drift for X,
    // running sync must clear it. Without #7's union, sync's git
    // fast-path stayed silent and the drift persisted across syncs.
    cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale' WHERE path = 'src/a.ts'`).run();
    const future = new Date(Date.now() + 60_000);
    fs.utimesSync(path.join(dir, 'src', 'a.ts'), future, future);
    cg.stats.invalidateFreshness();

    const before = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['contentDrift']) });
    expect(before.contentDrift.has('src/a.ts')).toBe(true);

    await cg.sync();
    cg.stats.invalidateFreshness();

    const after = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['contentDrift']) });
    expect(after.contentDrift.has('src/a.ts')).toBe(false);
  });

  it('invariant — ChangeOracle.vanished === findVanishedFiles(rootDir, getAllFiles(...))', async () => {
    // Both code paths (Oracle and extraction-side `eoFindVanishedFiles`)
    // now delegate to the same `findVanishedFiles` primitive in
    // freshness.ts. This invariant pins that equivalence: a fork in
    // either implementation would surface as a count mismatch here
    // before any production behaviour diverges.
    //
    // Note: this assertion is tautological given the current shared-
    // primitive wiring, so a bug INSIDE `findVanishedFiles` (path-join
    // vs path-resolve, missing platform separator handling, etc.)
    // wouldn't be caught here. The end-to-end "vanished facet reports
    // indexed files that no longer exist on disk" unit test above is
    // the primitive's own test — this invariant's load-bearing job is
    // strictly fork-detection between the two consumers.
    fs.unlinkSync(path.join(dir, 'src', 'b.ts'));
    const { findVanishedFiles } = await import('../src/freshness.js');
    const { getAllFiles } = await import('../src/db/queries-files.js');
    const direct = new Set(findVanishedFiles(cg.projectRoot, getAllFiles(cg.queries)));

    const snap = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['vanished']) });
    expect(snap.vanished).toEqual(direct);
  });

  it('invariant — vanished files are removed from the index after sync', async () => {
    // Oracle reports a file as vanished iff its row stays in the index
    // and the path is gone on disk. Sync should reap it; after sync
    // the row is gone and the vanished set is empty.
    fs.unlinkSync(path.join(dir, 'src', 'b.ts'));
    const before = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['vanished']) });
    expect(before.vanished.has('src/b.ts')).toBe(true);

    await cg.sync();

    const after = whatChanged(cg.projectRoot, cg.queries, { facets: new Set(['vanished']) });
    expect(after.vanished.has('src/b.ts')).toBe(false);
  });
});
