/**
 * Sync Module Tests
 *
 * Tests for sync functionality (incremental updates).
 * Note: Git hooks functionality has been removed in favor of cartograph's
 * Claude Code hooks integration.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { searchNodes } from '../src/db/queries-search.js';

function runSyncGit(cwd: string, ...args: string[]): void {
  execFileSync('git', args, { cwd, stdio: 'pipe' });
}

describe('Sync Module', () => {
  describe('Sync Functionality', () => {
    let testDir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-sync-func-'));

      // Create initial source files
      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), `export function hello() { return 'world'; }`);

      // Initialize and index
      cg = Cartograph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.close();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    describe('getChangedFiles()', () => {
      it('should detect added files', () => {
        // Add a new file
        fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), `export function newFunc() { return 42; }`);

        const changes = cg.internals.orchestrator.getChangedFiles();

        expect(changes.added).toContain('src/new.ts');
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect modified files', () => {
        // Modify existing file
        fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function hello() { return 'modified'; }`);

        const changes = cg.internals.orchestrator.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toContain('src/index.ts');
        expect(changes.removed).toHaveLength(0);
      });

      it('should detect removed files', () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const changes = cg.internals.orchestrator.getChangedFiles();

        expect(changes.added).toHaveLength(0);
        expect(changes.modified).toHaveLength(0);
        expect(changes.removed).toContain('src/index.ts');
      });
    });

    describe('sync()', () => {
      it('should reindex added files', async () => {
        // Add a new file
        fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), `export function newFunc() { return 42; }`);

        const result = await cg.sync();

        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        // Verify new function is in the graph
        const nodes = searchNodes(cg.queries, 'newFunc');
        expect(nodes.length).toBeGreaterThan(0);
      });

      it('should reindex modified files', async () => {
        // Modify existing file
        fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function goodbye() { return 'farewell'; }`);

        const result = await cg.sync();

        expect(result.filesModified).toBe(1);

        // Verify new function is in the graph
        const nodes = searchNodes(cg.queries, 'goodbye');
        expect(nodes.length).toBeGreaterThan(0);

        // Verify old function is gone
        const oldNodes = searchNodes(cg.queries, 'hello');
        expect(oldNodes.length).toBe(0);
      });

      it('should remove nodes from deleted files', async () => {
        // Remove file
        fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

        const result = await cg.sync();

        expect(result.filesRemoved).toBe(1);

        // Verify function is gone
        const nodes = searchNodes(cg.queries, 'hello');
        expect(nodes.length).toBe(0);
      });

      it('should report no changes when nothing changed', async () => {
        const result = await cg.sync();

        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(result.filesChecked).toBeGreaterThan(0);
      });

      it('runs DB maintenance (reclaims freelist) even on a no-op sync', async () => {
        // dbRunMaintenance must run on EVERY sync, not only when files
        // changed — otherwise a bloated DB can never self-heal on a
        // clean tree, since there may never be a file change to gate on.
        const db = cg.queries.db;
        const freelist = (): number =>
          (db.prepare('PRAGMA freelist_count').get() as { freelist_count: number }).freelist_count;

        // Push ~3 MB of pages onto the freelist: insert a blob table, drop it.
        db.exec('CREATE TABLE _bloat (b BLOB)');
        const insert = db.prepare('INSERT INTO _bloat VALUES (?)');
        const chunk = Buffer.alloc(64 * 1024);
        for (let i = 0; i < 48; i++) insert.run(chunk);
        db.exec('DROP TABLE _bloat');
        const bloated = freelist();
        expect(bloated).toBeGreaterThan(0);

        const result = await cg.sync();
        expect(result.filesAdded + result.filesModified + result.filesRemoved).toBe(0);

        // Incremental auto-vacuum DB → maintenance's incremental_vacuum
        // returned the free pages. Before the fix this stayed at `bloated`.
        expect(freelist()).toBeLessThan(bloated);
      });

      it('re-resolves cross-file unresolved refs when the defining file lands in a later sync (pass B)', async () => {
        // Setup: caller.ts references `lateExport` before any file
        // defines it. After the initial sync the ref sits in
        // unresolved_refs because the symbol doesn't exist yet. Add
        // callee.ts (with the symbol) WITHOUT touching caller.ts; the
        // sync's pass-A resolves only refs FROM changed files, so
        // before pass B existed, caller.ts's stale ref would never be
        // re-attempted — leaving the call edge silently missing.
        fs.writeFileSync(
          path.join(testDir, 'src', 'caller.ts'),
          `import { lateExport } from './callee.js';
export function callsIt(): number { return lateExport(); }
`,
        );
        await cg.sync();

        // Sanity: caller indexed, ref unresolved, no call edge yet.
        const callsItNode = searchNodes(cg.queries, 'callsIt').find((r) => r.node.kind === 'function')?.node;
        expect(callsItNode).toBeDefined();
        const unresolvedBefore = cg.queries.db
          .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name = 'lateExport'`)
          .get() as { c: number };
        expect(unresolvedBefore.c).toBeGreaterThan(0);

        // Define the symbol in a NEW file. caller.ts is untouched.
        fs.writeFileSync(
          path.join(testDir, 'src', 'callee.ts'),
          `export function lateExport(): number { return 1; }\n`,
        );
        const result = await cg.sync();
        expect(result.filesAdded).toBe(1);
        expect(result.filesModified).toBe(0); // caller.ts not modified

        // Pass B should sweep caller.ts's unresolved ref to lateExport
        // because lateExport is now defined in a file (callee.ts) that
        // was just added.
        const newNode = searchNodes(cg.queries, 'lateExport').find((r) => r.node.kind === 'function')?.node;
        expect(newNode).toBeDefined();

        const callEdges = cg.queries.db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges
             WHERE source = ? AND target = ? AND kind = 'calls'`,
          )
          .get(callsItNode!.id, newNode!.id) as { c: number };
        expect(callEdges.c).toBeGreaterThan(0);
      });

      it('preserves cross-file references edges when a target file is re-extracted (#18)', async () => {
        // Originally closed friction #18: unused_export FPs from a
        // resolved-then-pruned-from-unresolved_refs lifecycle, where a
        // line shift gave the target symbol a fresh node ID, the
        // file-A → file-B edge cascade-deleted, and Pass B had no
        // unresolved_ref to rebind to. That world is gone — migration
        // 066 (G7) made the node id line-independent, so a pure line
        // shift keeps the id stable AND the format-only fast path
        // skips the cascade-evict entirely. The edge stays put because
        // both endpoints stayed put.
        //
        // The test still asserts the end-to-end invariant — references
        // edge alive across re-extract — but with the post-G7 premise
        // (id stable rather than re-emit-and-resolve). A future change
        // that reintroduces id churn would surface as the edge-count
        // assertion failing (the unresolved_ref reconstruction path
        // is still wired up; it just no longer needs to fire here).
        fs.writeFileSync(path.join(testDir, 'src', 'target.ts'), `export const TARGET_SYMBOL = 42;\n`);
        fs.writeFileSync(
          path.join(testDir, 'src', 'consumer.ts'),
          `import { TARGET_SYMBOL } from './target.js';\nexport const v = TARGET_SYMBOL;\n`,
        );
        await cg.sync();

        // Sanity: the references edge from consumer.ts to TARGET_SYMBOL exists.
        const targetBefore = searchNodes(cg.queries, 'TARGET_SYMBOL').find((r) => r.node.kind === 'constant')?.node;
        expect(targetBefore).toBeDefined();
        const refEdgesBefore = cg.queries.db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges
             WHERE source = 'file:src/consumer.ts'
               AND target = ?
               AND kind = 'references'`,
          )
          .get(targetBefore!.id) as { c: number };
        expect(refEdgesBefore.c).toBeGreaterThan(0);

        // Modify target.ts so the line shifts → the symbol gets a new
        // node ID after re-extraction. consumer.ts is untouched.
        fs.writeFileSync(
          path.join(testDir, 'src', 'target.ts'),
          `// shift symbol to a new line so its content-hash-based id changes\nexport const TARGET_SYMBOL = 42;\n`,
        );
        const result = await cg.sync();
        expect(result.filesModified).toBe(1);

        // Pre-fix: the edge would be gone forever (cascade-deleted with
        // no unresolved_ref to re-resolve). Post-fix: reconstruct
        // re-emits an unresolved_ref before the delete; Pass A/B
        // re-binds it to the freshly-extracted node.
        const targetAfter = searchNodes(cg.queries, 'TARGET_SYMBOL').find((r) => r.node.kind === 'constant')?.node;
        expect(targetAfter).toBeDefined();
        // Guard the G7 stable-id premise: a line shift on the target
        // file leaves the symbol's node id unchanged. (Pre-G7 the
        // assertion was `.not.toBe(...)` — under the line-baked id
        // formula a shift produced a fresh id.) Combined with the
        // edge-count check below, this proves the format-only fast
        // path kept the references edge intact in place.
        expect(targetAfter!.id).toBe(targetBefore!.id);
        const refEdgesAfter = cg.queries.db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges
             WHERE source = 'file:src/consumer.ts'
               AND target = ?
               AND kind = 'references'`,
          )
          .get(targetAfter!.id) as { c: number };
        expect(refEdgesAfter.c).toBeGreaterThan(0);
      });

      it('clears the resolver cache on a deletion-only sync (no add/modify)', async () => {
        // #53 — deletion-only syncs early-returned BEFORE clearCaches()
        // ran, so a removed file's symbol names lingered in the
        // resolver's `knownNames` cache. The fix widened the early-
        // return guard to fire only when ALL three counters are zero,
        // so a removal triggers cache invalidation but not the
        // (pointless) resolution work.
        fs.writeFileSync(path.join(testDir, 'src', 'doomed.ts'), `export function doomedFn(): number { return 0; }\n`);
        await cg.sync();

        // Spy on clearCaches and run a deletion-only sync.
        const clearSpy = vi.spyOn(cg.internals.resolver, 'clearCaches');
        fs.unlinkSync(path.join(testDir, 'src', 'doomed.ts'));
        const result = await cg.sync();
        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(1);
        expect(clearSpy).toHaveBeenCalled();
        clearSpy.mockRestore();
      });

      it('skips clearCaches when nothing changed (no work, no churn)', async () => {
        const clearSpy = vi.spyOn(cg.internals.resolver, 'clearCaches');
        const result = await cg.sync();
        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);
        expect(clearSpy).not.toHaveBeenCalled();
        clearSpy.mockRestore();
      });

      it('drains stranded unresolved_refs on a no-op sync when edges are degenerate', async () => {
        // Regression: a prior incomplete sync (deletion-driven, partial
        // bulk-pool failure, etc.) can leave `unresolved_refs` populated
        // while `edges` of kind `calls` / `imports` are zero. Pass A/B
        // is scoped to changedFilePaths, so a *subsequent* clean-tree
        // sync used to return immediately, leaving the index in a "🟢 in
        // sync" state with no resolved-reference edges. Live bug
        // reproduced 2026-05-19 on this repo: edges 46128 → 14193, calls/
        // imports edges at zero, `cartograph_graph direction:callers`
        // returned "no callers" for every symbol. Verify the safety-net
        // drain catches it.

        // Seed: a lib with a target helper and a caller that uses it,
        // so the index has a real `calls` edge in its steady state.
        fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), `export function helper(): number { return 42; }\n`);
        fs.writeFileSync(
          path.join(testDir, 'src', 'caller.ts'),
          `import { helper } from './lib.js';\nexport function caller() { return helper(); }\n`,
        );
        await cg.sync();
        const callsBefore = cg.queries.db.prepare(`SELECT COUNT(*) AS c FROM edges WHERE kind = 'calls'`).get() as {
          c: number;
        };
        expect(callsBefore.c).toBeGreaterThan(0);

        // Simulate the bug state: blow away the resolved edges and
        // seed a synthetic heavy unresolved_refs tail (above the
        // DEGENERATE_EDGE_UREF_FLOOR=1000 threshold the safety net uses
        // to distinguish corruption from "small project with pending
        // refs"). Each row points to `helper`, which is resolvable —
        // the drain should both create the calls edge AND empty the
        // table.
        const callerNode = cg.queries.db.prepare(`SELECT id FROM nodes WHERE name = 'caller' LIMIT 1`).get() as
          | { id: string }
          | undefined;
        expect(callerNode).toBeDefined();
        cg.queries.db.transaction(() => {
          cg.queries.db.exec(`DELETE FROM edges WHERE kind IN ('calls', 'imports')`);
          const insertRef = cg.queries.db.prepare(
            `INSERT INTO unresolved_refs (from_node_id, reference_name, reference_kind, line, col, file_path, language)
             VALUES (?, 'helper', 'calls', ?, 0, 'src/caller.ts', 'typescript')`,
          );
          for (let i = 0; i < 1100; i++) insertRef.run(callerNode!.id, i);
        })();

        // Confirm we're in the degenerate state: calls=0,
        // unresolved_refs over the floor.
        const afterCorruption = cg.queries.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM edges WHERE kind = 'calls') AS calls,
               (SELECT COUNT(*) FROM unresolved_refs) AS uref`,
          )
          .get() as { calls: number; uref: number };
        expect(afterCorruption.calls).toBe(0);
        expect(afterCorruption.uref).toBeGreaterThanOrEqual(1000);

        // Clean-tree sync: filesAdded/Modified/Removed all 0. The
        // safety net should still drain the stranded refs.
        const result = await cg.sync();
        expect(result.filesAdded).toBe(0);
        expect(result.filesModified).toBe(0);
        expect(result.filesRemoved).toBe(0);

        const afterDrain = cg.queries.db
          .prepare(
            `SELECT
               (SELECT COUNT(*) FROM edges WHERE kind = 'calls') AS calls,
               (SELECT COUNT(*) FROM unresolved_refs) AS uref`,
          )
          .get() as { calls: number; uref: number };
        expect(afterDrain.calls).toBeGreaterThan(0);
        expect(afterDrain.uref).toBe(0);
      });

      it('resolves unresolved refs to NEW exports added to a MODIFIED file (no caller-side import — closes #16/#29/#47/#51)', async () => {
        // Closes #51 — incremental-sync resolver cache invalidation gap.
        // The pass-B test above is rescued by the local-import-alias
        // pre-filter: caller.ts imports `lateExport`, so the membership
        // check is bypassed even with stale `knownNames`. This case has
        // NO import on the caller side — `caller()` references `newFn`
        // by bare name, so resolution is gated entirely on the cached
        // `knownNames` set. Without `clearCaches()` in the sync resolver,
        // refs to symbols added by the sync remain unresolved until a
        // full reindex.
        fs.writeFileSync(path.join(testDir, 'src', 'lib.ts'), `export function existingFn(): number { return 0; }\n`);
        fs.writeFileSync(
          path.join(testDir, 'src', 'caller.ts'),
          `export function caller(): number { return newFn(); }\n`,
        );
        await cg.sync();

        // Sanity: caller indexed; unresolved_refs holds `newFn`.
        const callerNode = searchNodes(cg.queries, 'caller').find((r) => r.node.kind === 'function')?.node;
        expect(callerNode).toBeDefined();
        const unresolvedBefore = cg.queries.db
          .prepare(`SELECT COUNT(*) AS c FROM unresolved_refs WHERE reference_name = 'newFn'`)
          .get() as { c: number };
        expect(unresolvedBefore.c).toBeGreaterThan(0);

        // Add `newFn` to lib.ts (modify, not add a new file). caller.ts
        // is untouched and has no import line referring to newFn.
        fs.writeFileSync(
          path.join(testDir, 'src', 'lib.ts'),
          `export function existingFn(): number { return 0; }
export function newFn(): number { return 42; }
`,
        );
        const result = await cg.sync();
        expect(result.filesModified).toBe(1);
        expect(result.filesAdded).toBe(0);

        const newFnNode = searchNodes(cg.queries, 'newFn').find((r) => r.node.kind === 'function')?.node;
        expect(newFnNode).toBeDefined();

        const callEdges = cg.queries.db
          .prepare(
            `SELECT COUNT(*) AS c FROM edges
             WHERE source = ? AND target = ? AND kind = 'calls'`,
          )
          .get(callerNode!.id, newFnNode!.id) as { c: number };
        expect(callEdges.c).toBeGreaterThan(0);
      });
    });
  });

  describe('Git-based sync', () => {
    let testDir: string;
    let cg: Cartograph;
    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-git-sync-'));

      // Initialize a git repo with an initial commit
      runSyncGit(testDir, 'init');
      runSyncGit(testDir, 'config', 'user.email', 'test@test.com');
      runSyncGit(testDir, 'config', 'user.name', 'Test');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), `export function hello() { return 'world'; }`);

      runSyncGit(testDir, 'add', '-A');
      runSyncGit(testDir, 'commit', '-m', 'initial');

      // Initialize Cartograph and index
      cg = Cartograph.initSync(testDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
      await cg.indexAll();
    });

    afterEach(() => {
      if (cg) {
        cg.close();
      }
      if (fs.existsSync(testDir)) {
        fs.rmSync(testDir, { recursive: true, force: true });
      }
    });

    it('should detect modified files via git', async () => {
      fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function hello() { return 'modified'; }`);

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('src/index.ts');
    });

    it('should detect new untracked files via git', async () => {
      fs.writeFileSync(path.join(testDir, 'src', 'new.ts'), `export function newFunc() { return 42; }`);

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('src/new.ts');

      // Verify the function was indexed
      const nodes = searchNodes(cg.queries, 'newFunc');
      expect(nodes.length).toBeGreaterThan(0);
    });

    it('should detect deleted files via git', async () => {
      fs.unlinkSync(path.join(testDir, 'src', 'index.ts'));

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);

      // Verify function is gone
      const nodes = searchNodes(cg.queries, 'hello');
      expect(nodes.length).toBe(0);
    });

    it('should reap an untracked file that was indexed then deleted (ghost-file reap)', async () => {
      // An untracked scratch file: created, picked up by sync, then deleted.
      // `git status` never reports it (git never tracked it, and it no
      // longer exists), so the git fast path's deletion list is empty —
      // the disk-reconcile pass is the only thing that can reap it.
      const scratch = path.join(testDir, 'src', 'scratch.ts');
      fs.writeFileSync(scratch, `export function ghostFunc() { return 1; }`);

      const added = await cg.sync();
      expect(added.filesAdded).toBe(1);
      expect(searchNodes(cg.queries, 'ghostFunc').length).toBeGreaterThan(0);

      fs.unlinkSync(scratch);

      const reaped = await cg.sync();
      expect(reaped.filesRemoved).toBe(1);
      expect(searchNodes(cg.queries, 'ghostFunc').length).toBe(0);
    });

    it('should skip files not matching config', async () => {
      // Pick an extension that no language def registers — `.qqq`
      // matches nothing in the registry, so it's filtered out
      // regardless of the include union semantic (G14). Using `.js`
      // here would not work post-G14: persisted `include` is unioned
      // with registry-derived globs (which include `**/*.js`), so
      // a `.js` file would slip in via the union.
      fs.writeFileSync(path.join(testDir, 'src', 'ignored.qqq'), `function ignored() {}`);

      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
    });

    it('should report no changes on clean working tree', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
      expect(result.changedFilePaths).toBeUndefined();
    });

    it('content-drift union — re-extracts files whose on-disk content_hash drifted while git stays quiet', async () => {
      // Repro: index reports a content_hash for src/index.ts that no
      // longer matches disk (real-world cause: watcher missed the edit,
      // an auto-formatter rewrote the file after indexing, or a partial
      // sync left the row stale). git status is clean — no commits
      // ahead, no working-tree dirt — so the git fast-path returns no
      // changes. Pre-fix, `cg.sync()` reported "0 files scanned" and
      // `cartograph_status` kept saying "🟡 N files drifted — run `admin
      // sync` to refresh" indefinitely.
      //
      // Simulate the drift directly: corrupt the indexed content_hash
      // for src/index.ts AND bump its mtime so `isFileStale`'s mtime
      // fast-path doesn't short-circuit "fresh" before the hash check
      // can run.
      cg.queries.db.prepare(`UPDATE files SET content_hash = 'pretend-stale-hash' WHERE path = 'src/index.ts'`).run();
      const future = new Date(Date.now() + 60_000);
      fs.utimesSync(path.join(testDir, 'src', 'index.ts'), future, future);

      const result = await cg.sync();

      // The content-drift union should have picked it up — sync now
      // re-extracts the file, the row's content_hash gets refreshed,
      // and the drift count goes to zero on the next status check.
      expect(result.filesChecked).toBeGreaterThanOrEqual(1);
      const updated = cg.queries.db.prepare(`SELECT content_hash FROM files WHERE path = 'src/index.ts'`).get() as {
        content_hash: string;
      };
      expect(updated.content_hash).not.toBe('pretend-stale-hash');
    });
  });

  // Regression tests for the "stale index after HEAD-moving git operation"
  // bug. `git status` only reports working-tree dirtiness vs HEAD, so a
  // merge / pull / checkout / rebase / reset (and even post-commit) leaves
  // a clean tree and used to trick sync into reporting "up to date" while
  // the DB still held pre-operation content hashes. The fix detects HEAD
  // movement by comparing current HEAD against a stored last-synced HEAD
  // and unioning `git diff` output into the changed-file set.
  describe('HEAD-moving git operations', () => {
    let testDir: string;
    let cg: Cartograph;
    beforeEach(async () => {
      testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-head-move-'));

      runSyncGit(testDir, 'init');
      runSyncGit(testDir, 'config', 'user.email', 'test@test.com');
      runSyncGit(testDir, 'config', 'user.name', 'Test');
      runSyncGit(testDir, 'symbolic-ref', 'HEAD', 'refs/heads/main');

      const srcDir = path.join(testDir, 'src');
      fs.mkdirSync(srcDir);
      fs.writeFileSync(path.join(srcDir, 'index.ts'), `export function hello() { return 'world'; }`);

      runSyncGit(testDir, 'add', '-A');
      runSyncGit(testDir, 'commit', '-m', 'initial');

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

    it('should detect changes brought in by `git merge`', async () => {
      runSyncGit(testDir, 'checkout', '-b', 'feature');
      fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function merged() { return 'from-branch'; }`);
      fs.writeFileSync(path.join(testDir, 'src', 'added.ts'), `export function fromBranch() { return 1; }`);
      runSyncGit(testDir, 'add', '-A');
      runSyncGit(testDir, 'commit', '-m', 'feature work');
      runSyncGit(testDir, 'checkout', 'main');
      runSyncGit(testDir, 'merge', '--no-ff', 'feature', '-m', 'merge feature');

      const result = await cg.sync();

      expect(result.filesModified + result.filesAdded).toBeGreaterThanOrEqual(2);
      expect(searchNodes(cg.queries, 'merged').length).toBeGreaterThan(0);
      expect(searchNodes(cg.queries, 'fromBranch').length).toBeGreaterThan(0);
      expect(searchNodes(cg.queries, 'hello').length).toBe(0);
    });

    it('should detect changes after `git checkout` to a different branch', async () => {
      runSyncGit(testDir, 'checkout', '-b', 'other');
      fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function onOther() { return 'other'; }`);
      runSyncGit(testDir, 'add', '-A');
      runSyncGit(testDir, 'commit', '-m', 'other work');
      runSyncGit(testDir, 'checkout', 'main');
      runSyncGit(testDir, 'checkout', 'other');

      const result = await cg.sync();

      expect(result.filesModified).toBeGreaterThanOrEqual(1);
      expect(searchNodes(cg.queries, 'onOther').length).toBeGreaterThan(0);
      expect(searchNodes(cg.queries, 'hello').length).toBe(0);
    });

    it('should detect file deletion brought in by a committed change', async () => {
      runSyncGit(testDir, 'rm', path.join('src', 'index.ts'));
      runSyncGit(testDir, 'commit', '-m', 'remove index');

      const result = await cg.sync();

      expect(result.filesRemoved).toBe(1);
      expect(searchNodes(cg.queries, 'hello').length).toBe(0);
    });

    it('should fall back to full scan when last-synced HEAD is unreachable', async () => {
      fs.writeFileSync(path.join(testDir, 'src', 'index.ts'), `export function rewritten() { return 'rewritten'; }`);
      runSyncGit(testDir, 'add', '-A');
      runSyncGit(testDir, 'commit', '--amend', '-m', 'rewritten');
      const result = await cg.sync();

      expect(result.filesModified + result.filesAdded).toBeGreaterThanOrEqual(1);
      expect(searchNodes(cg.queries, 'rewritten').length).toBeGreaterThan(0);
      expect(searchNodes(cg.queries, 'hello').length).toBe(0);
    });

    it('should still no-op when HEAD has not moved and tree is clean', async () => {
      const result = await cg.sync();

      expect(result.filesAdded).toBe(0);
      expect(result.filesModified).toBe(0);
      expect(result.filesRemoved).toBe(0);
    });
  });

  describe('Git submodule support', () => {
    let parentDir: string;
    let submoduleSrc: string;
    let cg: Cartograph;

    beforeEach(async () => {
      parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-submod-parent-'));
      submoduleSrc = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-submod-src-'));

      runSyncGit(submoduleSrc, 'init');
      runSyncGit(submoduleSrc, 'config', 'user.email', 'test@test.com');
      runSyncGit(submoduleSrc, 'config', 'user.name', 'Test');
      fs.writeFileSync(path.join(submoduleSrc, 'lib.ts'), `export function fromSubmodule() { return 'sub'; }`);
      runSyncGit(submoduleSrc, 'add', '-A');
      runSyncGit(submoduleSrc, 'commit', '-m', 'submodule initial');

      runSyncGit(parentDir, 'init');
      runSyncGit(parentDir, 'config', 'user.email', 'test@test.com');
      runSyncGit(parentDir, 'config', 'user.name', 'Test');

      const parentSrc = path.join(parentDir, 'src');
      fs.mkdirSync(parentSrc);
      fs.writeFileSync(path.join(parentSrc, 'main.ts'), `export function fromParent() { return 'parent'; }`);

      runSyncGit(parentDir, '-c', 'protocol.file.allow=always', 'submodule', 'add', submoduleSrc, 'vendor/sub');
      runSyncGit(parentDir, 'add', '-A');
      runSyncGit(parentDir, 'commit', '-m', 'parent initial with submodule');

      cg = Cartograph.initSync(parentDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
        },
      });
    });

    afterEach(() => {
      if (cg) cg.close();
      if (fs.existsSync(parentDir)) fs.rmSync(parentDir, { recursive: true, force: true });
      if (fs.existsSync(submoduleSrc)) fs.rmSync(submoduleSrc, { recursive: true, force: true });
    });

    it('should index files inside a submodule on full index', async () => {
      const result = await cg.indexAll();

      expect(result.filesIndexed).toBeGreaterThanOrEqual(2);
      const subNodes = searchNodes(cg.queries, 'fromSubmodule');
      const parentNodes = searchNodes(cg.queries, 'fromParent');
      expect(subNodes.length).toBeGreaterThan(0);
      expect(parentNodes.length).toBeGreaterThan(0);
      expect(subNodes.some((r) => r.node.filePath.startsWith('vendor/sub/'))).toBe(true);
    });

    it('should detect modifications to files inside a submodule via sync', async () => {
      await cg.indexAll();

      fs.writeFileSync(
        path.join(parentDir, 'vendor/sub/lib.ts'),
        `export function fromSubmodule() { return 'changed'; }`,
      );

      const result = await cg.sync();

      expect(result.filesModified).toBe(1);
      expect(result.changedFilePaths).toContain('vendor/sub/lib.ts');
    });

    it('should detect new untracked files inside a submodule via sync', async () => {
      await cg.indexAll();

      fs.writeFileSync(path.join(parentDir, 'vendor/sub/newfile.ts'), `export function added() { return 1; }`);

      const result = await cg.sync();

      expect(result.filesAdded).toBe(1);
      expect(result.changedFilePaths).toContain('vendor/sub/newfile.ts');
    });

    it('should not break when a submodule directory is missing or empty', async () => {
      fs.rmSync(path.join(parentDir, 'vendor/sub'), { recursive: true, force: true });
      fs.mkdirSync(path.join(parentDir, 'vendor/sub'));

      const result = await cg.indexAll();
      expect(result.errors.filter((e) => e.severity === 'error').length).toBe(0);
      expect(searchNodes(cg.queries, 'fromParent').length).toBeGreaterThan(0);
    });

    it('should skip submodule contents when indexSubmodules is false', async () => {
      cg.close();
      fs.rmSync(path.join(parentDir, '.cartograph'), { recursive: true, force: true });
      cg = Cartograph.initSync(parentDir, {
        config: {
          include: ['**/*.ts'],
          exclude: [],
          indexSubmodules: false,
        },
      });

      const result = await cg.indexAll();
      expect(searchNodes(cg.queries, 'fromParent').length).toBeGreaterThan(0);
      expect(searchNodes(cg.queries, 'fromSubmodule').length).toBe(0);
      expect(result.filesIndexed).toBe(1);
    });
  });

  // Large queued sets (chiefly the EXTRACTION_LOGIC_VERSION heal, which
  // re-flags every file) route through the parse-worker pool path
  // instead of the serial in-process loop. This exercises that branch.
  describe('Bulk re-extract routing (large queued set)', () => {
    let bulkDir: string;
    let bulkCg: Cartograph;
    const FILE_COUNT = 220; // > BULK_REEXTRACT_THRESHOLD (200)

    beforeEach(async () => {
      bulkDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-sync-bulk-'));
      const srcDir = path.join(bulkDir, 'src');
      fs.mkdirSync(srcDir);
      for (let i = 0; i < FILE_COUNT; i++) {
        fs.writeFileSync(path.join(srcDir, `mod${i}.ts`), `export function fn${i}() { return ${i}; }\n`);
      }
      bulkCg = Cartograph.initSync(bulkDir, {
        config: { include: ['**/*.ts'], exclude: [] },
      });
      await bulkCg.indexAll();
    });

    afterEach(() => {
      if (bulkCg) bulkCg.close();
      if (fs.existsSync(bulkDir)) {
        fs.rmSync(bulkDir, { recursive: true, force: true });
      }
    });

    it('re-extracts every file when the queued set exceeds the pool threshold', async () => {
      // Modify every file so the sync queues > 200 files — crossing
      // BULK_REEXTRACT_THRESHOLD and taking the worker-pool path.
      for (let i = 0; i < FILE_COUNT; i++) {
        fs.writeFileSync(
          path.join(bulkDir, 'src', `mod${i}.ts`),
          `export function renamed${i}() { return ${i + 1}; }\n`,
        );
      }

      const result = await bulkCg.sync();

      expect(result.filesModified).toBe(FILE_COUNT);
      expect(result.nodesUpdated).toBeGreaterThan(0);

      // New symbols present, old symbols gone — proves the pool path
      // ran the same delete → insert store as the serial loop.
      expect(searchNodes(bulkCg.queries, 'renamed0').length).toBeGreaterThan(0);
      expect(searchNodes(bulkCg.queries, `renamed${FILE_COUNT - 1}`).length).toBeGreaterThan(0);
      expect(searchNodes(bulkCg.queries, 'fn0').length).toBe(0);
    });
  });
});
