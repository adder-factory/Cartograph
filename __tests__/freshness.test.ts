/**
 * Freshness Gate Tests
 *
 * Covers project-level (HEAD drift) and per-file (content drift) staleness.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { getFileByPath } from '../src/db/queries-files.js';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { searchNodes } from '../src/db/queries-search.js';
import {
  describeFreshnessRisk,
  freshnessRecommendedAction,
  freshnessSyncCandidateCount,
  getStaleFiles,
  hasFreshnessRisk,
  isFileStale,
  isHeavyFreshnessRisk,
} from '../src/freshness.js';
import { appendFindings } from '../src/db/queries-findings.js';
import { getStaleArtifactsCount } from '../src/db/queries-metadata.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    stdio: ['pipe', 'pipe', 'pipe'],
  }).trim();
}

function setupGitRepo(dir: string): void {
  git(dir, 'init', '-q');
  git(dir, 'config', 'user.email', 'test@example.com');
  git(dir, 'config', 'user.name', 'Test');
  git(dir, 'config', 'commit.gpgsign', 'false');
}

describe('Freshness Gate', () => {
  describe('Project-level (HEAD drift)', () => {
    let testDir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-freshness-'));
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function alpha() { return 1; }\n`);
      // Mirror real-world setup — .cartograph/ is per-machine, never committed.
      fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');

      setupGitRepo(testDir);
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'initial');

      cg = Cartograph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('stamps freshness metadata after indexAll', () => {
      const f = cg.stats.getFreshness();
      expect(f).not.toBeNull();
      expect(f!.indexedAt).toBeGreaterThan(0);
      expect(f!.indexedSha).toMatch(/^[0-9a-f]{40}$/);
      expect(f!.isStale).toBe(false);
      expect(f!.banner).toBeNull();
    });

    it('reports isStale=true after HEAD advances', async () => {
      fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta() { return 2; }\n`);
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'add b');

      const f = cg.stats.getFreshness();
      expect(f).not.toBeNull();
      expect(f!.isStale).toBe(true);
      expect(f!.banner).toContain('Index out of date');
      expect(f!.banner).toContain('cartograph sync');
    });

    it('counts uncommitted modifications in filesChanged', async () => {
      // Edit existing file in working tree (no commit)
      fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha() { return 999; }\n`);
      // Stage a brand-new file (staged but not committed)
      fs.writeFileSync(path.join(testDir, 'src', 'staged.ts'), `export function staged() {}\n`);
      git(testDir, 'add', 'src/staged.ts');
      // Add an untracked file
      fs.writeFileSync(path.join(testDir, 'src', 'untracked.ts'), `export function untracked() {}\n`);
      // Bump HEAD with an unrelated commit
      fs.writeFileSync(path.join(testDir, 'src', 'committed.ts'), `export const x = 1;\n`);
      git(testDir, 'add', 'src/committed.ts');
      git(testDir, 'commit', '-q', '-m', 'add committed');

      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(true);
      // Exactly: a.ts (unstaged), staged.ts (staged), untracked.ts, committed.ts.
      // Tight equality catches both undercount (broken source) and overcount
      // (e.g. picking up .cartograph or other ignored paths).
      expect(f!.filesChanged).toBe(4);
    });

    it('reports drift breakdown by category (added/modified/deleted)', async () => {
      // Need c.ts to exist at the *indexed* sha so that a later delete
      // shows up as `deleted` in the tree diff. Create it, commit, re-index.
      fs.writeFileSync(path.join(testDir, 'src', 'c.ts'), 'export const c = 3;\n');
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'add c');
      await cg.sync();
      cg.stats.invalidateFreshness();

      // Now: modify a (modified), add b (added), delete c (deleted).
      fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), 'export function alpha() { return 99; }\n');
      fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const b = 2;\n');
      fs.unlinkSync(path.join(testDir, 'src', 'c.ts'));
      git(testDir, 'add', '-A');
      git(testDir, 'commit', '-q', '-m', 'mixed changes');

      cg.stats.invalidateFreshness();
      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(true);
      expect(f!.breakdown).not.toBeNull();
      expect(f!.breakdown!.added).toBe(1); // b.ts
      expect(f!.breakdown!.modified).toBe(1); // a.ts
      expect(f!.breakdown!.deleted).toBe(1); // c.ts
      expect(f!.banner).toContain('+1/~1/-1');
      expect(f!.commitsAhead).toBe(1);
    });

    it('reverts in commits do not count toward filesChanged', async () => {
      const aPath = path.join(testDir, 'src', 'a.ts');
      const original = fs.readFileSync(aPath, 'utf-8');
      // Change → commit → revert → commit. Net tree state == indexed state.
      fs.writeFileSync(aPath, 'export function alpha() { return 999; }\n');
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'change');
      fs.writeFileSync(aPath, original);
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'revert');

      cg.stats.invalidateFreshness();
      const f = cg.stats.getFreshness();
      // HEAD moved → still stale at the project level…
      expect(f!.isStale).toBe(true);
      expect(f!.commitsAhead).toBe(2);
      // …but the file count should NOT include a.ts (tree state matches sha).
      expect(f!.breakdown!.total).toBe(0);
      expect(f!.filesChanged).toBe(0);
    });

    it('attaches structured freshness metadata to MCP tool results', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);

      // Drift HEAD enough to skip the auto-sync threshold (raised
      // from 5 → 50 in 2026-05-03 to absorb a session's worth of
      // edits when the file watcher missed them). 60 files keeps
      // the test below the heavy-drift block (BLOCK_MAX_FILES=100)
      // so freshness metadata still attaches to the tool result.
      for (let i = 0; i < 60; i++) {
        fs.writeFileSync(path.join(testDir, 'src', `f${i}.ts`), `export const v${i} = ${i};\n`);
      }
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'add 60 files');
      cg.stats.invalidateFreshness();

      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      expect(result.metadata?.freshness).toBeDefined();
      expect(result.metadata!.freshness!.isStale).toBe(true);
      expect(result.metadata!.freshness!.commitsAhead).toBe(1);
      expect(result.metadata!.freshness!.filesChanged).toBeGreaterThanOrEqual(60);
      expect(result.metadata!.freshness!.autoSynced).toBeUndefined();
    });

    it('auto-syncs small drift inline (≤50 files) and replaces the banner', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);

      fs.writeFileSync(path.join(testDir, 'src', 'small.ts'), 'export const small = 1;\n');
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'small drift');
      cg.stats.invalidateFreshness();

      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      const text = (result.content[0] as { text?: string }).text ?? '';
      expect(text).toContain('Auto-synced');
      expect(text).not.toContain('Index out of date');
      expect(result.metadata?.freshness?.autoSynced).toBe(true);
      // After sync, the index should reflect the new HEAD.
      expect(cg.stats.getFreshness()!.isStale).toBe(false);
    });

    it('falls back to banner when auto-sync throws', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);

      fs.writeFileSync(path.join(testDir, 'src', 'small.ts'), 'export const small = 1;\n');
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'small');
      cg.stats.invalidateFreshness();

      // Replace cg.sync with a thrower so the auto-sync path errors out.
      const originalSync = cg.sync.bind(cg);
      (cg as unknown as { sync: typeof cg.sync }).sync = (async () => {
        throw new Error('simulated sync failure');
      }) as typeof cg.sync;

      try {
        const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
        const text = (result.content[0] as { text?: string }).text ?? '';
        // Banner shown, NOT the auto-sync confirmation.
        expect(text).toContain('Index out of date');
        expect(text).not.toContain('Auto-synced');
        expect(result.metadata?.freshness?.autoSynced).toBeUndefined();
      } finally {
        (cg as unknown as { sync: typeof cg.sync }).sync = originalSync;
      }
    });

    it('blocks heavy drift (>100 files) with an error', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);

      // Mass-add 105 files in one commit
      for (let i = 0; i < 105; i++) {
        fs.writeFileSync(path.join(testDir, 'src', `big${i}.ts`), `export const b${i} = ${i};\n`);
      }
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'big drift');
      cg.stats.invalidateFreshness();

      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      expect(result.isError).toBe(true);
      expect((result.content[0] as { text?: string }).text).toContain('too stale');
      expect(result.metadata?.freshness?.blocked).toBe(true);
    });

    it('caches freshness within TTL; invalidateFreshnessCache forces a re-read', async () => {
      const f1 = cg.stats.getFreshness();
      // Drift HEAD between calls.
      fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), 'export const b = 1;\n');
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'b');

      // Within TTL — still returns the cached pre-drift value.
      const f2 = cg.stats.getFreshness();
      expect(f2!.isStale).toBe(f1!.isStale);
      expect(f2!.indexedSha).toBe(f1!.indexedSha);

      cg.stats.invalidateFreshness();
      const f3 = cg.stats.getFreshness();
      expect(f3!.isStale).toBe(true);
    });

    it('FileWatcher recognises .git HEAD-moving paths', async () => {
      const { isGitHeadChange } = await import('../src/sync/watcher.js');
      // Bare commit / checkout
      expect(isGitHeadChange('.git/HEAD')).toBe(true);
      expect(isGitHeadChange('.git/refs/heads/main')).toBe(true);
      expect(isGitHeadChange('.git/refs/heads/feature/x')).toBe(true);
      expect(isGitHeadChange('.git/refs/tags/v1')).toBe(true);
      expect(isGitHeadChange('.git/packed-refs')).toBe(true);
      expect(isGitHeadChange('.git/logs/HEAD')).toBe(true);
      // Merge / rebase in progress
      expect(isGitHeadChange('.git/MERGE_HEAD')).toBe(true);
      expect(isGitHeadChange('.git/rebase-merge/HEAD')).toBe(true);
      expect(isGitHeadChange('.git/rebase-apply/HEAD')).toBe(true);
      // Worktrees + submodules
      expect(isGitHeadChange('.git/worktrees/feat/HEAD')).toBe(true);
      expect(isGitHeadChange('.git/modules/sub/HEAD')).toBe(true);
      expect(isGitHeadChange('.git/modules/path/with/slashes/HEAD')).toBe(true);
      // Negatives — paths that look similar but don't move HEAD
      expect(isGitHeadChange('.git/index')).toBe(false);
      expect(isGitHeadChange('.git/config')).toBe(false);
      expect(isGitHeadChange('.git/worktrees/feat/HEADbar')).toBe(false);
      expect(isGitHeadChange('.git/worktrees/feat/index')).toBe(false);
      expect(isGitHeadChange('src/HEAD')).toBe(false);
      expect(isGitHeadChange('src/foo.ts')).toBe(false);
    });

    it('appendStaleFilesNote applies in handleContext (per-file coverage)', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);

      // Make a working-tree edit (no commit) so HEAD matches but per-file drifts.
      const aPath = path.join(testDir, 'src', 'a.ts');
      fs.writeFileSync(aPath, 'export function alpha() { return 42; }\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(aPath, future, future);

      cg.stats.invalidateFreshness();
      const result = await handler.execute('cartograph_context', { task: 'alpha', allowStale: true });
      const text = (result.content[0] as { text?: string }).text ?? '';
      expect(text).toMatch(/Stale results.*src\/a\.ts/);
    });

    it('appendStaleFilesNote distinguishes user edit from index lag (bug #20)', async () => {
      // Bug #20 regression guard: when the index's recorded content_hash
      // drifts from disk WITHOUT a corresponding user edit (`git status
      // --porcelain` is clean for that path), the wording must read
      // "index lags disk … (content_hash drift, no user edit detected
      // — see `cartograph_changed_since`)" — NOT the misleading
      // "file modified" phrasing that implies the user just edited it.
      //
      // Simulating index lag without a user edit: bump the FILE's mtime
      // forward (so `isFileStale`'s mtime fast-path proceeds to the hash
      // check) AND mutate the index's recorded content_hash to a known-
      // bogus value. File content on disk is left unchanged, so
      // `git status --porcelain` reports nothing for the path.
      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);
      const aPath = path.join(testDir, 'src', 'a.ts');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(aPath, future, future); // bump mtime so isFileStale proceeds to hash check
      // Corrupt the stored content_hash so the on-disk content (which we
      // have NOT changed) hashes to something different from the indexed
      // value — index lags disk, but the user never edited.
      cg.queries.db.prepare("UPDATE files SET content_hash = 'forced-drift' WHERE path = ?").run('src/a.ts');
      cg.stats.invalidateFreshness();
      const result = await handler.execute('cartograph_context', { task: 'alpha', allowStale: true });
      const text = (result.content[0] as { text?: string }).text ?? '';
      // New wording — the file is in the porcelain-clean side, so the
      // "index lags disk" branch must fire (not the "user edit" branch).
      expect(text).toMatch(/Stale results.*index lags disk/);
      expect(text).toContain('content_hash drift');
      expect(text).toContain('no user edit detected');
      expect(text).toContain('src/a.ts');
      // The misleading old phrasing without the user-edit qualifier
      // ("file modified since last index: ..." standing alone) must be
      // gone for THIS path. We keep the "user edit" wording for genuine
      // edits, so just assert that THIS rendering is on the index-lag
      // segment.
      expect(text).not.toMatch(/file modified since last index \(user edit\): src\/a\.ts/);
    });

    it('getStaleArtifactsCount detects findings written against an older file hash', async () => {
      // Trigger a tiny biomarker run so we have some findings to age out.
      // Use the queries layer directly to insert a synthetic finding tied
      // to the alpha node, then mutate the file's content_hash so the
      // join detects mismatch.
      const node = searchNodes(cg.queries, 'alpha', { limit: 1 })[0];
      if (!node) {
        // No alpha — skip silently rather than hard-fail (defensive)
        return;
      }
      // Use a synthetic biomarker name to avoid colliding with whatever
      // the biomarker engine already inserted during indexAll.
      appendFindings((cg as unknown as { queries: any }).queries, [
        { nodeId: node.node.id, biomarker: '__test_biomarker__', severity: 'info', metric: 0 },
      ]);

      const before = getStaleArtifactsCount(cg.queries);
      // findings count includes the synthetic finding only when its
      // hash diverges; right after insert, source_content_hash matches
      // current file hash, so it should be 0.
      const baseFindings = before.findings;

      // Mutate the file's content_hash via the live QueryBuilder's raw
      // db handle to simulate a re-index that touched the file. The
      // finding's source_content_hash now diverges.
      const rawDb = (cg as unknown as { queries: { db: { exec: (sql: string) => void } } }).queries.db;
      rawDb.exec(`UPDATE files SET content_hash = 'different-hash' WHERE path = '${node.node.filePath}'`);

      const after = getStaleArtifactsCount(cg.queries);
      // All findings on this file (including the synthetic one and any
      // existing biomarker hits) now mismatch the new file hash.
      expect(after.findings).toBeGreaterThan(baseFindings);
      expect(after.total).toBeGreaterThanOrEqual(1);
    });

    it('getStaleArtifactsCount summary arm tracks nodes.body_hash (Phase 2 / Design A)', () => {
      // Pick a real summarizable node (function / method).
      const rawDb = (
        cg as unknown as {
          queries: { db: { prepare: (sql: string) => { all: () => unknown[]; get: (...args: unknown[]) => unknown } } };
        }
      ).queries.db;
      const node = rawDb
        .prepare("SELECT id, body_hash FROM nodes WHERE kind IN ('function','method') AND body_hash <> '' LIMIT 1")
        .get() as { id: string; body_hash: string } | undefined;
      if (!node) {
        // No function/method extracted by this fixture's source — skip silently.
        return;
      }
      // Insert a synthetic symbol_summaries row whose content_hash MATCHES
      // the node's body_hash. This represents a fresh summary written by
      // the summarizer against the current body.
      (
        rawDb.prepare(
          'INSERT INTO symbol_summaries (node_id, content_hash, summary, model, generated_at) VALUES (?, ?, ?, ?, ?)',
        ) as unknown as { run: (...args: unknown[]) => void }
      ).run(node.id, node.body_hash, 'test summary', 'test-model', Date.now());

      const before = getStaleArtifactsCount(cg.queries);
      const baseSummaries = before.summaries;

      // Mutate nodes.body_hash to simulate a re-extraction where the symbol's
      // body actually changed. The summary's content_hash now diverges.
      (
        rawDb.prepare(`UPDATE nodes SET body_hash = 'simulated-new-hash' WHERE id = ?`) as unknown as {
          run: (...args: unknown[]) => void;
        }
      ).run(node.id);

      const after = getStaleArtifactsCount(cg.queries);
      expect(after.summaries).toBeGreaterThan(baseSummaries);
    });

    it('clears stale state after re-running indexAll', async () => {
      fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta() { return 2; }\n`);
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'add b');

      expect(cg.stats.getFreshness()!.isStale).toBe(true);

      await cg.sync();

      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(false);
      expect(f!.banner).toBeNull();
    });
  });

  describe('Non-git project', () => {
    let testDir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-freshness-nogit-'));
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function alpha() { return 1; }\n`);

      cg = Cartograph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('does not crash and reports no banner', () => {
      const f = cg.stats.getFreshness();
      expect(f).not.toBeNull();
      expect(f!.indexedAt).toBeGreaterThan(0);
      expect(f!.indexedSha).toBeNull();
      expect(f!.isStale).toBe(false);
      expect(f!.banner).toBeNull();
    });
  });

  describe('Per-file content drift', () => {
    let testDir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-freshness-file-'));
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), `export function alpha() { return 1; }\n`);
      fs.writeFileSync(path.join(srcDir, 'b.ts'), `export function beta() { return 2; }\n`);

      cg = Cartograph.initSync(testDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('isFileStale returns false for unchanged file', () => {
      const rec = getFileByPath(cg.queries, 'src/a.ts')!;
      expect(rec).toBeTruthy();
      expect(isFileStale(testDir, rec)).toBe(false);
    });

    it('isFileStale returns true after on-disk content change', () => {
      // Move mtime forward by writing new content with a future mtime
      const filePath = path.join(testDir, 'src', 'a.ts');
      fs.writeFileSync(filePath, `export function alpha() { return 99; }\n`);
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(filePath, future, future);

      const rec = getFileByPath(cg.queries, 'src/a.ts')!;
      expect(isFileStale(testDir, rec)).toBe(true);
    });

    it('isFileStale returns false when only mtime changes (touch)', () => {
      const filePath = path.join(testDir, 'src', 'a.ts');
      const future = Math.floor(Date.now() / 1000) + 120;
      fs.utimesSync(filePath, future, future);

      const rec = getFileByPath(cg.queries, 'src/a.ts')!;
      // mtime moved but content unchanged → hash matches, not stale
      expect(isFileStale(testDir, rec)).toBe(false);
    });

    it('getStaleFiles returns drifted files only', () => {
      const filePath = path.join(testDir, 'src', 'b.ts');
      fs.writeFileSync(filePath, `export function beta() { return 999; }\n`);
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(filePath, future, future);

      const recs = [getFileByPath(cg.queries, 'src/a.ts')!, getFileByPath(cg.queries, 'src/b.ts')!];
      const stale = getStaleFiles(testDir, recs);
      expect(stale).toEqual(['src/b.ts']);
    });

    it('isFileStale returns false for missing file (defer to indexer)', () => {
      const rec = getFileByPath(cg.queries, 'src/a.ts')!;
      fs.unlinkSync(path.join(testDir, 'src', 'a.ts'));
      expect(isFileStale(testDir, rec)).toBe(false);
    });
  });

  // Task #9 — cartograph_status must not render a false "🟢 in sync"
  // verdict when the index lags disk in a way `git status` cannot see.
  describe('Git-invisible per-file content drift (Task #9)', () => {
    let testDir: string;
    let cg: Cartograph;

    function forceCleanGitContentDrift(paths: string[]): void {
      const future = Math.floor(Date.now() / 1000) + 60;
      const update = cg.queries.db.prepare('UPDATE files SET content_hash = ? WHERE path = ?');
      for (const rel of paths) {
        fs.utimesSync(path.join(testDir, rel), future, future);
        update.run(`forced-drift-${rel}`, rel);
      }
      cg.stats.invalidateFreshness();
    }

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-freshness-drift-'));
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'a.ts'), 'export function alpha() { return 1; }\n');
      fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
      setupGitRepo(testDir);
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'initial');
      cg = Cartograph.initSync(testDir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
    });

    it('a clean, freshly-indexed repo reports 0 content-drifted files', () => {
      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(false);
      expect(f!.contentDriftedFiles).toBe(0);
    });

    it('content drift is reported via contentDriftedFiles while HEAD still matches', () => {
      // Edit a.ts on disk (content + mtime move) without committing.
      // HEAD has not advanced, so the project-level freshness verdict
      // is not-stale; the false "🟢 in sync" the pre-fix renderer
      // produced relied on there being NO per-file drift signal here.
      const aPath = path.join(testDir, 'src', 'a.ts');
      fs.writeFileSync(aPath, 'export function alpha() { return 99; }\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(aPath, future, future);
      cg.stats.invalidateFreshness();
      const f = cg.stats.getFreshness();
      // HEAD unchanged — project-level verdict stays not-stale.
      expect(f!.isStale).toBe(false);
      // ...but the git-independent per-file re-hash flags the drift, so
      // getFreshnessInfo no longer hands status a clean bill of health.
      expect(f!.contentDriftedFiles).toBe(1);
    });

    it('shared freshness-risk helpers treat clean-git content drift as sync risk', () => {
      forceCleanGitContentDrift(['src/a.ts']);

      const f = cg.stats.getFreshness()!;
      expect(f.isStale).toBe(false);
      expect(hasFreshnessRisk(f)).toBe(true);
      expect(freshnessSyncCandidateCount(f)).toBe(1);
      expect(isHeavyFreshnessRisk(f)).toBe(false);
      expect(freshnessRecommendedAction(f)).toBe('sync');
      expect(describeFreshnessRisk(f)).toBe('1 content-drifted file');
    });

    it('empty-result freshness hint warns on clean-git content drift', async () => {
      // Simulate the index lagging disk while git stays clean: the file
      // content is unchanged, but the indexed content_hash is wrong and the
      // mtime moved far enough for isFileStale's hash check to run.
      const { ToolHandler } = await import('../src/mcp/tools.js');
      forceCleanGitContentDrift(['src/a.ts']);

      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(false);
      expect(f!.contentDriftedFiles).toBe(1);

      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', {
        by: 'name',
        query: 'definitelyNoSuchSymbol',
        allowStale: true,
      });
      const text = result.content[0]?.text ?? '';
      expect(text).toContain('Index content drift');
      expect(text).toContain('cartograph_changed_since');
      expect(text).not.toContain('true negative');
      expect(result.metadata?.freshness?.contentDriftedFiles).toBe(1);
      expect(result.metadata?.freshness?.recommendedAction).toBe('sync');
    });

    it('auto-syncs clean-git content drift on normal read tools', async () => {
      const { ToolHandler } = await import('../src/mcp/tools.js');
      forceCleanGitContentDrift(['src/a.ts']);

      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      const text = result.content[0]?.text ?? '';
      expect(result.isError).toBeFalsy();
      expect(text).toContain('Auto-synced 1 file');
      expect(text).toContain('alpha');
      expect(result.metadata?.freshness?.autoSynced).toBe(true);
      expect(result.metadata?.freshness?.contentDriftedFiles).toBe(0);
      expect(result.metadata?.freshness?.recommendedAction).toBe('none');
      expect(cg.stats.getFreshness()!.contentDriftedFiles).toBe(0);
    });

    it('blocks very large clean-git content drift unless allowStale is explicit', async () => {
      const extraPaths: string[] = [];
      for (let i = 0; i < 101; i++) {
        const rel = `src/drift${i}.ts`;
        extraPaths.push(rel);
        fs.writeFileSync(path.join(testDir, rel), `export const drift${i} = ${i};\n`);
      }
      git(testDir, 'add', '.');
      git(testDir, 'commit', '-q', '-m', 'add drift corpus');
      await cg.indexAll({ summarize: false });
      forceCleanGitContentDrift(['src/a.ts', ...extraPaths]);

      const f = cg.stats.getFreshness();
      expect(f!.isStale).toBe(false);
      expect(f!.contentDriftedFiles).toBe(102);
      expect(hasFreshnessRisk(f!)).toBe(true);
      expect(freshnessSyncCandidateCount(f!)).toBe(102);
      expect(isHeavyFreshnessRisk(f!)).toBe(true);
      expect(freshnessRecommendedAction(f!)).toBe('sync_required');

      const { ToolHandler } = await import('../src/mcp/tools.js');
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
      const text = result.content[0]?.text ?? '';
      expect(result.isError).toBe(true);
      expect(text).toContain('too stale');
      expect(text).toContain('102 content-drifted files');
      expect(result.metadata?.freshness?.blocked).toBe(true);
      expect(result.metadata?.freshness?.contentDriftedFiles).toBe(102);
      expect(result.metadata?.freshness?.recommendedAction).toBe('sync_required');
    });
  });
});
