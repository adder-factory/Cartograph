/**
 * Review Context Tests
 *
 * Verifies:
 *   - parseDiff handles standard git unified-diff shapes (modified,
 *     added, deleted, renamed, multiple hunks).
 *   - symbolsTouchedByHunks correctly maps line ranges to symbols.
 *   - buildReviewContext attaches callers, callees, impact, tests
 *     for affected symbols.
 *   - Co-change warnings surface when a changed file's historical
 *     co-changers were NOT touched.
 *   - Graceful degrade: pre-#105 install (no co_changes table) and
 *     pre-#106 install (no `tests` edges) — return empty rather than
 *     throwing.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { parseDiff, symbolsTouchedByHunks } from '../src/review/diff-parser.js';
import { buildReviewContext } from '../src/review/index.js';
import { renderReviewContextMarkdown, type MdReviewContext } from '../src/mcp/tools/review-context.js';
import Cartograph from '../src/index.js';
import { getToolModules } from '../src/mcp/tools/registry.js';
import type { ToolCtx } from '../src/mcp/tool-types.js';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { insertEdges } from '../src/db/queries-edges.js';
import { GraphTraverser } from '../src/graph/traversal.js';
import type { Node, Edge } from '../src/types.js';

function modifyDoFooDiff(): string {
  return `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,4 @@
 ctx
-old impl
+new impl
+plus one
 ctx`;
}

/** Get the unified `cartograph_review` tool from the registry. */
function getReviewTool() {
  const tool = getToolModules().find((t) => t.definition.name === 'cartograph_review');
  if (!tool) throw new Error('cartograph_review tool not registered');
  return tool;
}

function makeReviewToolCtx(cg: InstanceType<typeof Cartograph>): ToolCtx {
  return { getCartograph: () => cg } as unknown as ToolCtx;
}

/** Run git in `dir`, swallowing output. */
function runReviewGit(dir: string, ...gitArgs: string[]): void {
  execFileSync('git', gitArgs, { cwd: dir, stdio: ['pipe', 'pipe', 'pipe'] });
}

// =============================================================================
// parseDiff
// =============================================================================

describe('parseDiff', () => {
  it('parses a simple modified-file diff', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,3 +10,5 @@
 unchanged
-old line
+new line one
+new line two
 also unchanged`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('src/foo.ts');
    expect(files[0].status).toBe('modified');
    expect(files[0].hunks).toEqual([
      { oldStart: 10, oldCount: 3, newStart: 10, newCount: 5, addedLines: 2, removedLines: 1 },
    ]);
  });

  it('detects file additions via /dev/null in the --- header', () => {
    const diff = `diff --git a/new.ts b/new.ts
new file mode 100644
index 0000000..abc
--- /dev/null
+++ b/new.ts
@@ -0,0 +1,3 @@
+a
+b
+c`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('added');
    expect(files[0].path).toBe('new.ts');
  });

  it('detects file deletions via /dev/null in the +++ header', () => {
    const diff = `diff --git a/gone.ts b/gone.ts
deleted file mode 100644
index abc..0000000
--- a/gone.ts
+++ /dev/null
@@ -1,3 +0,0 @@
-a
-b
-c`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('deleted');
    expect(files[0].path).toBe('gone.ts');
  });

  it('detects renames and exposes oldPath', () => {
    const diff = `diff --git a/old.ts b/new.ts
similarity index 95%
rename from old.ts
rename to new.ts
index abc..def 100644
--- a/old.ts
+++ b/new.ts
@@ -1,2 +1,2 @@
-old name
+new name
 unchanged`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].status).toBe('renamed');
    expect(files[0].path).toBe('new.ts');
    expect(files[0].oldPath).toBe('old.ts');
  });

  it('handles multi-file, multi-hunk diffs', () => {
    const diff = `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 ctx
+added
 ctx
 ctx
@@ -20,2 +21,2 @@
-old
+new
 ctx
diff --git a/b.ts b/b.ts
index 111..222 100644
--- a/b.ts
+++ b/b.ts
@@ -5,1 +5,1 @@
-x
+y`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].path).toBe('a.ts');
    expect(files[0].hunks).toHaveLength(2);
    expect(files[1].path).toBe('b.ts');
    expect(files[1].hunks).toHaveLength(1);
  });

  it('returns [] for empty input', () => {
    expect(parseDiff('')).toEqual([]);
  });

  it('emits a hunk-less rename even when followed by another hunked file', () => {
    // Regression: previously a rename-only file mid-diff was silently
    // dropped because the EOF-only hunk-less flush never fired before
    // the next `diff --git` header arrived.
    const diff = `diff --git a/old.ts b/new.ts
similarity index 100%
rename from old.ts
rename to new.ts
diff --git a/other.ts b/other.ts
index abc..def 100644
--- a/other.ts
+++ b/other.ts
@@ -1,1 +1,1 @@
-x
+y`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(2);
    expect(files[0].status).toBe('renamed');
    expect(files[0].path).toBe('new.ts');
    expect(files[0].oldPath).toBe('old.ts');
    expect(files[1].path).toBe('other.ts');
    expect(files[1].status).toBe('modified');
  });

  it('emits a hunk-less file-mode-change followed by another file', () => {
    const diff = `diff --git a/script.sh b/script.sh
old mode 100644
new mode 100755
diff --git a/foo.ts b/foo.ts
index abc..def 100644
--- a/foo.ts
+++ b/foo.ts
@@ -1,1 +1,1 @@
-a
+b`;
    const files = parseDiff(diff);
    // The mode-change file has no add/delete/rename markers so it
    // doesn't qualify as hunk-less for our purposes — it's silently
    // skipped (current implementation). The hunked file MUST still
    // be emitted, and that's the regression risk.
    expect(files.find((f) => f.path === 'foo.ts')).toBeDefined();
  });

  it('strips C-style quoting from paths with spaces or special chars', () => {
    const diff = `diff --git "a/path with spaces.ts" "b/path with spaces.ts"
index abc..def 100644
--- "a/path with spaces.ts"
+++ "b/path with spaces.ts"
@@ -1,1 +1,1 @@
-a
+b`;
    const files = parseDiff(diff);
    expect(files).toHaveLength(1);
    expect(files[0].path).toBe('path with spaces.ts');
    expect(files[0].path).not.toContain('"');
  });

  it('handles single-line hunk header (no comma)', () => {
    // git emits `@@ -5 +5 @@` for one-line hunks (count of 1 elided).
    const diff = `diff --git a/x.ts b/x.ts
index abc..def 100644
--- a/x.ts
+++ b/x.ts
@@ -5 +5 @@
-old
+new`;
    const files = parseDiff(diff);
    expect(files[0].hunks[0]).toEqual({
      oldStart: 5,
      oldCount: 1,
      newStart: 5,
      newCount: 1,
      addedLines: 1,
      removedLines: 1,
    });
  });

  it('counts +/- body lines per hunk, excluding context lines', () => {
    // A 4-line edit with git's default 3 lines of context: span is
    // 11/11 but only 4 added + 4 removed are real changes.
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
index abc..def 100644
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -71,11 +71,11 @@ class Foo {
 ctx1
 ctx2
 ctx3
-old1
-old2
-old3
-old4
+new1
+new2
+new3
+new4
 ctx4
 ctx5
 ctx6
 ctx7`;
    const files = parseDiff(diff);
    const h = files[0].hunks[0];
    expect(h.oldCount).toBe(11);
    expect(h.newCount).toBe(11);
    expect(h.addedLines).toBe(4);
    expect(h.removedLines).toBe(4);
  });

  it(String.raw`does not count the "\ No newline at end of file" marker as a change`, () => {
    const noNewlineMarker = String.raw`\ No newline at end of file`;
    const diff = `diff --git a/src/x.ts b/src/x.ts
index abc..def 100644
--- a/src/x.ts
+++ b/src/x.ts
@@ -1,1 +1,1 @@
-old
${noNewlineMarker}
+new
${noNewlineMarker}`;
    const h = parseDiff(diff)[0].hunks[0];
    expect(h.addedLines).toBe(1);
    expect(h.removedLines).toBe(1);
  });

  it('tallies +/- counts independently per hunk in a multi-hunk diff', () => {
    const diff = `diff --git a/a.ts b/a.ts
index abc..def 100644
--- a/a.ts
+++ b/a.ts
@@ -10,3 +10,4 @@
 ctx
+added
 ctx
 ctx
@@ -20,2 +21,2 @@
-old
+new
 ctx`;
    const files = parseDiff(diff);
    expect(files[0].hunks[0]).toMatchObject({ addedLines: 1, removedLines: 0 });
    expect(files[0].hunks[1]).toMatchObject({ addedLines: 1, removedLines: 1 });
  });
});

// =============================================================================
// symbolsTouchedByHunks
// =============================================================================

describe('symbolsTouchedByHunks', () => {
  const sym = (startLine: number, endLine: number, name = 'sym') => ({ startLine, endLine, name });

  it('returns symbols whose range overlaps any hunk', () => {
    const symbols = [sym(1, 5, 'a'), sym(10, 20, 'b'), sym(50, 60, 'c')];
    const hunks = [{ oldStart: 12, oldCount: 3, newStart: 12, newCount: 3 }];
    const out = symbolsTouchedByHunks(hunks, symbols);
    expect(out.map((s) => s.name)).toEqual(['b']);
  });

  it('matches a symbol that fully contains the hunk', () => {
    const symbols = [sym(1, 100, 'big')];
    const hunks = [{ oldStart: 50, oldCount: 1, newStart: 50, newCount: 1 }];
    expect(symbolsTouchedByHunks(hunks, symbols).map((s) => s.name)).toEqual(['big']);
  });

  it('matches a symbol fully contained by the hunk', () => {
    const symbols = [sym(50, 55, 'small')];
    const hunks = [{ oldStart: 10, oldCount: 100, newStart: 10, newCount: 100 }];
    expect(symbolsTouchedByHunks(hunks, symbols).map((s) => s.name)).toEqual(['small']);
  });

  it('does not match symbols outside any hunk', () => {
    const symbols = [sym(1, 5, 'before'), sym(50, 60, 'after')];
    const hunks = [{ oldStart: 20, oldCount: 5, newStart: 20, newCount: 5 }];
    expect(symbolsTouchedByHunks(hunks, symbols)).toEqual([]);
  });

  it('returns [] when hunks or symbols are empty', () => {
    expect(symbolsTouchedByHunks([], [sym(1, 5)])).toEqual([]);
    expect(symbolsTouchedByHunks([{ oldStart: 1, oldCount: 1, newStart: 1, newCount: 1 }], [])).toEqual([]);
  });
});

// =============================================================================
// buildReviewContext (integration)
// =============================================================================

function makeNode(
  id: string,
  name: string,
  kind: Node['kind'],
  filePath: string,
  startLine: number,
  endLine: number,
): Node {
  return {
    id,
    kind,
    name,
    qualifiedName: `${filePath}::${name}`,
    filePath,
    language: 'typescript',
    startLine,
    endLine,
    startColumn: 0,
    endColumn: 0,
    updatedAt: Date.now(),
  };
}

describe('buildReviewContext (integration)', () => {
  let dir: string;
  let db: DatabaseConnection;
  let q: QueryBuilder;
  let traverser: GraphTraverser;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-ctx-'));
    db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    q = new QueryBuilder(db.getDb());
    traverser = new GraphTraverser(q);

    // Set up a small graph:
    //   src/foo.ts contains `doFoo` (lines 5-15)
    //   src/bar.ts contains `useFoo` (lines 1-10) which calls doFoo
    //   src/baz.ts contains `helper` (lines 20-30) which doFoo calls
    const upsertFile = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES (?, '', 'typescript', 0, 0, 0)
    `);
    upsertFile.run('src/foo.ts');
    upsertFile.run('src/bar.ts');
    upsertFile.run('src/baz.ts');

    q.insertNodes([
      makeNode('foo', 'doFoo', 'function', 'src/foo.ts', 5, 15),
      makeNode('bar', 'useFoo', 'function', 'src/bar.ts', 1, 10),
      makeNode('baz', 'helper', 'function', 'src/baz.ts', 20, 30),
    ]);

    // Edges: useFoo -> doFoo (calls), doFoo -> helper (calls)
    const callEdge = (source: string, target: string, line: number): Edge => ({
      source,
      target,
      kind: 'calls',
      line,
    });
    insertEdges(q, [callEdge('bar', 'foo', 5), callEdge('foo', 'baz', 12)]);
  });

  afterEach(() => {
    db.close();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('attaches callers and callees for affected symbols', () => {
    const ctx = buildReviewContext(modifyDoFooDiff(), { queries: q, traverser });
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].affectedSymbols).toHaveLength(1);
    const sym = ctx.files[0].affectedSymbols[0];
    expect(sym.name).toBe('doFoo');
    expect(sym.callers.map((c) => c.name)).toContain('useFoo');
    expect(sym.callees.map((c) => c.name)).toContain('helper');
    const helper = sym.callees.find((c) => c.name === 'helper');
    expect(helper?.filePath).toBe('src/baz.ts');
    expect(helper?.line).toBe(20);
    expect(helper?.line).not.toBe(12);
  });

  it('FRICTION-5: fans out test-file callers to enclosing it/describe block (not file row :1)', () => {
    // Set up a test-file file-row caller with a call-site at line 74, and a
    // test_names entry that gives the enclosing it/describe block description.
    // Without the FRICTION-5 fix the caller name would be just the file name
    // at line 1. With the fix it should be "file::"description"" at line ≤74.
    const upsertFile = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, is_test)
      VALUES (?, '', 'typescript', 0, 0, 0, 1)
    `);
    upsertFile.run('__tests__/foo.test.ts');

    // Insert a file-kind node for the test file (as the index would).
    q.insertNodes([makeNode('foo-test-file', '__tests__/foo.test.ts', 'file', '__tests__/foo.test.ts', 1, 100)]);

    // The test-file file-node calls doFoo at line 74 (with extraLines metadata).
    insertEdges(q, [
      {
        source: 'foo-test-file',
        target: 'foo',
        kind: 'calls',
        line: 74,
        metadata: { siteCount: 1 },
      } as Edge,
    ]);

    // Seed a test_names row so getEnclosingTestName can return the enclosing block.
    db.getDb()
      .prepare('INSERT INTO test_names (file_path, line, description) VALUES (?, ?, ?)')
      .run('__tests__/foo.test.ts', 69, 'doFoo regression test');

    const ctx = buildReviewContext(modifyDoFooDiff(), { queries: q, traverser });
    const sym = ctx.files[0].affectedSymbols[0];
    expect(sym.name).toBe('doFoo');

    // FRICTION-5: the test-file caller should be fanned out to the call-site
    // row (line 74) anchored by the enclosing test description, not at line 1.
    const testCaller = sym.callers.find((c) => c.filePath.includes('foo.test.ts'));
    expect(testCaller).toBeDefined();
    // The caller name must include the test description (fan-out applied).
    expect(testCaller!.name).toContain('doFoo regression test');
    // Line must NOT be 1 (the file-row anchor — the broken pre-fix behavior).
    expect(testCaller!.line).not.toBe(1);
    expect(testCaller!.line).toBeGreaterThanOrEqual(69);
  });

  it('summarizes correctly across an added + modified + deleted set', () => {
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,1 +10,1 @@
-x
+y
diff --git a/src/added.ts b/src/added.ts
new file mode 100644
--- /dev/null
+++ b/src/added.ts
@@ -0,0 +1,1 @@
+content
diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -1,1 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, { queries: q, traverser });
    expect(ctx.summary.filesAdded).toBe(1);
    expect(ctx.summary.filesModified).toBe(1);
    expect(ctx.summary.filesDeleted).toBe(1);
  });

  it('reports broken incoming refs for deleted files', () => {
    const diff = `diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -20,11 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, { queries: q, traverser });
    const baz = ctx.files.find((f) => f.path === 'src/baz.ts')!;
    expect(baz.status).toBe('deleted');
    // doFoo (in foo.ts) calls helper (in baz.ts) — deleting baz.ts breaks foo.
    expect(baz.brokenIncomingRefs?.map((r) => r.name)).toContain('doFoo');
  });

  it('dedupes brokenIncomingRefs when one caller has multiple edge types to the deleted file', () => {
    // Add a second edge from useFoo to helper (e.g., references in
    // addition to the existing call). Without dedup, useFoo would appear
    // twice in brokenIncomingRefs.
    insertEdges(q, [{ source: 'bar', target: 'baz', kind: 'references', line: 7 }]);
    // Note: bar already had a `calls` edge target=foo and now `references` target=baz.
    // For deletion of baz.ts we look at incoming to baz's symbols (helper).
    // We need TWO edges from the same source to helper for dedup to fire.
    insertEdges(q, [{ source: 'bar', target: 'baz', kind: 'imports', line: 7 }]);
    const diff = `diff --git a/src/baz.ts b/src/baz.ts
deleted file mode 100644
--- a/src/baz.ts
+++ /dev/null
@@ -20,11 +0,0 @@
-x`;
    const ctx = buildReviewContext(diff, { queries: q, traverser });
    const baz = ctx.files.find((f) => f.path === 'src/baz.ts')!;
    // useFoo should appear at most once with line=7 (we have two edges
    // both at line 7 from bar to baz with different kinds).
    const fromBar = baz.brokenIncomingRefs?.filter((r) => r.name === 'useFoo' && r.line === 7);
    expect(fromBar?.length).toBe(1);
  });

  it('returns empty co-change warnings on a pre-#105 install (no co_changes table)', () => {
    // Default DatabaseConnection.initialize() runs schema.sql which on
    // upstream/main does NOT include the co_changes table. The helper
    // must gracefully degrade rather than throw.
    const ctx = buildReviewContext(modifyDoFooDiff(), { queries: q, traverser });
    expect(ctx.coChangeWarnings).toEqual([]);
    expect(ctx.summary.coChangeWarnings).toBe(0);
  });

  it('returns empty tests array on a pre-#106 install (no `tests` edges)', () => {
    const ctx = buildReviewContext(modifyDoFooDiff(), { queries: q, traverser });
    expect(ctx.files[0].tests).toEqual([]);
  });

  it('respects maxCallersPerSymbol cap', () => {
    // Add 10 more callers of doFoo to make the cap observable.
    const extraNodes: Node[] = [];
    const extraEdges: Edge[] = [];
    const upsert = db.getDb().prepare(`
      INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at)
      VALUES (?, '', 'typescript', 0, 0, 0)
    `);
    for (let i = 0; i < 10; i++) {
      const fp = `src/caller${i}.ts`;
      upsert.run(fp);
      const id = `caller${i}`;
      extraNodes.push(makeNode(id, `caller${i}`, 'function', fp, 1, 5));
      extraEdges.push({ source: id, target: 'foo', kind: 'calls', line: 1 });
    }
    q.insertNodes(extraNodes);
    insertEdges(q, extraEdges);

    const ctx = buildReviewContext(modifyDoFooDiff(), { queries: q, traverser }, { maxCallersPerSymbol: 3 });
    const sym = ctx.files[0].affectedSymbols[0];
    expect(sym.callers.length).toBeLessThanOrEqual(3);
  });

  it('co-change warning surfaces when a changed file has historical co-changers not in the PR', () => {
    // Manually create the co_changes table + add commit_count + populate.
    // This simulates a post-#105 install. (When PR #105 lands the table
    // exists natively; we simulate it here so the helper has data to
    // surface.)
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL,
        file_b TEXT NOT NULL,
        count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b),
        CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);

    // Re-define getCoChangedFiles via a thin shim (since we don't have
    // PR #105's QueryBuilder method here). Use the same SQL the PR
    // would use.
    (
      q as unknown as {
        getCoChangedFiles: typeof getCoChangedFilesShim;
      }
    ).getCoChangedFiles = getCoChangedFilesShim.bind(null, q);

    // Diff touches src/foo.ts but NOT src/bar.ts → bar.ts should surface
    // as a co-change warning. Pass `minDiffMagnitude: 0` to bypass the
    // friction-29 text-only-diff gate (the test diff is intentionally
    // tiny; we want to verify co-change-on-historical-data, not the
    // gate behaviour which has its own test below).
    const ctx = buildReviewContext(
      modifyDoFooDiff(),
      { queries: q, traverser },
      {
        minCoChangeJaccard: 0.3,
        minDiffMagnitude: 0,
      },
    );
    expect(ctx.coChangeWarnings.length).toBeGreaterThan(0);
    const w = ctx.coChangeWarnings[0];
    expect(w.changedFile).toBe('src/foo.ts');
    expect(w.expectedToChange).toBe('src/bar.ts');
    expect(w.jaccard).toBeGreaterThan(0.3);
  });

  it('does NOT warn about files that ARE in the PR (changedPaths exclusion)', () => {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles =
      getCoChangedFilesShim.bind(null, q);

    // Diff includes BOTH foo and bar → no warning should appear because
    // bar IS in the changed set.
    const diff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,1 +10,1 @@
-x
+y
diff --git a/src/bar.ts b/src/bar.ts
--- a/src/bar.ts
+++ b/src/bar.ts
@@ -3,1 +3,1 @@
-x
+y`;
    const ctx = buildReviewContext(diff, { queries: q, traverser }, { minCoChangeJaccard: 0.3, minDiffMagnitude: 0 });
    expect(ctx.coChangeWarnings).toEqual([]);
  });

  // ===========================================================================
  // FRICTION-29 — minDiffMagnitude gate
  // ===========================================================================

  it('suppresses co-change warnings when the diff is below minDiffMagnitude (default 10)', () => {
    // Seed historical co-change data so warnings WOULD fire on a larger diff.
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles =
      getCoChangedFilesShim.bind(null, q);

    // Tiny 1-line text-only diff: 1 added + 1 removed = 2 < default 10.
    const tinyDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10 +10 @@
-x
+y`;
    const ctx = buildReviewContext(
      tinyDiff,
      { queries: q, traverser },
      {
        minCoChangeJaccard: 0.3,
        // default minDiffMagnitude = 10
      },
    );
    expect(ctx.coChangeWarnings).toEqual([]);
    expect(ctx.summary.coChangeWarnings).toBe(0);
  });

  it('counts +/- body lines, not the hunk span — a context-padded small edit stays gated', () => {
    // Regression for the audit finding: a 4-line edit with default
    // 3-line context has an 11-line span but only 8 changed lines.
    // The gate (default 10) must still suppress co-change warnings.
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles =
      getCoChangedFilesShim.bind(null, q);

    // Span @@ -10,11 +10,11 @@ = 11, but only 4 added + 4 removed = 8.
    const paddedSmallDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,11 +10,11 @@
 ctx1
 ctx2
 ctx3
-old1
-old2
-old3
-old4
+new1
+new2
+new3
+new4
 ctx4`;
    const ctx = buildReviewContext(
      paddedSmallDiff,
      { queries: q, traverser },
      {
        minCoChangeJaccard: 0.3,
        // default minDiffMagnitude = 10
      },
    );
    expect(ctx.coChangeWarnings).toEqual([]);
    expect(ctx.summary.coChangeWarnings).toBe(0);
  });

  it('still emits co-change warnings on the same diff when minDiffMagnitude=0 (gate disabled)', () => {
    // Same fixture as the previous test — only the gate parameter changes.
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles =
      getCoChangedFilesShim.bind(null, q);

    const tinyDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10 +10 @@
-x
+y`;
    const ctx = buildReviewContext(
      tinyDiff,
      { queries: q, traverser },
      {
        minCoChangeJaccard: 0.3,
        minDiffMagnitude: 0,
      },
    );
    expect(ctx.coChangeWarnings.length).toBeGreaterThan(0);
  });

  it('emits co-change warnings on a large diff even with default minDiffMagnitude', () => {
    db.getDb().exec(`
      CREATE TABLE IF NOT EXISTS co_changes (
        file_a TEXT NOT NULL, file_b TEXT NOT NULL, count INTEGER NOT NULL,
        PRIMARY KEY (file_a, file_b), CHECK (file_a < file_b)
      );
    `);
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(10, 'src/foo.ts');
    db.getDb().prepare('UPDATE files SET commit_count = ? WHERE path = ?').run(8, 'src/bar.ts');
    db.getDb()
      .prepare('INSERT INTO co_changes (file_a, file_b, count) VALUES (?, ?, ?)')
      .run('src/bar.ts', 'src/foo.ts', 7);
    (q as unknown as { getCoChangedFiles: typeof getCoChangedFilesShim }).getCoChangedFiles =
      getCoChangedFilesShim.bind(null, q);

    // Large hunk: 6 added + 6 removed = 12 > default 10.
    const bigDiff = `diff --git a/src/foo.ts b/src/foo.ts
--- a/src/foo.ts
+++ b/src/foo.ts
@@ -10,6 +10,6 @@
-a1
-a2
-a3
-a4
-a5
-a6
+b1
+b2
+b3
+b4
+b5
+b6`;
    const ctx = buildReviewContext(
      bigDiff,
      { queries: q, traverser },
      {
        minCoChangeJaccard: 0.3,
      },
    );
    expect(ctx.coChangeWarnings.length).toBeGreaterThan(0);
  });
});

describe('renderReviewContextMarkdown (friction-21: markdown not raw JSON)', () => {
  it('renders a markdown report with a summary line and per-file sections', () => {
    const md = renderReviewContextMarkdown({
      summary: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesRenamed: 0,
        symbolsAffected: 1,
        coChangeWarnings: 0,
      },
      files: [
        {
          path: 'src/foo.ts',
          status: 'modified',
          affectedSymbols: [
            {
              name: 'processPayment',
              kind: 'function',
              qualifiedName: 'processPayment',
              startLine: 10,
              endLine: 20,
              signature: '(amount: number): void',
              callers: [{ name: 'main', filePath: 'src/app.ts', line: 5 }],
              callees: [{ name: 'log', filePath: 'src/log.ts', line: 2 }],
              impactCount: 3,
            },
          ],
          tests: ['__tests__/foo.test.ts'],
        },
      ],
      coChangeWarnings: [],
    });
    // Markdown, not JSON — no opaque symbolId hashes.
    expect(md).not.toContain('"symbolId"');
    expect(md).not.toContain('function:');
    expect(md).toContain('# Review context');
    expect(md).toContain('**1** symbol affected');
    expect(md).toContain('### `src/foo.ts` — modified');
    expect(md).toContain('**processPayment** (function)');
    expect(md).toContain('callers (1): `main` (src/app.ts:5)');
    expect(md).toContain('callees (1): `log` (src/log.ts:2)');
    expect(md).toContain('impact radius: 3 symbols');
    expect(md).toContain('Covering tests: `__tests__/foo.test.ts`');
  });

  it('renders co-change warnings as bullets with jaccard + shared-commit counts', () => {
    const md = renderReviewContextMarkdown({
      summary: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesRenamed: 0,
        symbolsAffected: 0,
        coChangeWarnings: 1,
      },
      files: [],
      coChangeWarnings: [
        {
          changedFile: 'src/a.ts',
          expectedToChange: 'src/b.ts',
          jaccard: 0.75,
          anchorRatio: 0.5,
          historicalCount: 6,
          note: 'historically co-changed',
        },
      ],
    });
    expect(md).toContain('## Co-change warnings');
    expect(md).toContain('`src/b.ts` — co-changes with `src/a.ts`');
    expect(md).toContain('jaccard 0.75');
    expect(md).toContain('anchor-ratio 0.50');
    expect(md).toContain('6 shared commits');
  });

  // Audit #27: "0 symbols affected · 1 modified" reads as a
  // contradiction. The renderer now appends a clarifier explaining the
  // hunks fell outside indexed symbol bodies.
  it('explains the "0 symbols affected" headline when files changed but no symbol overlapped', () => {
    const md = renderReviewContextMarkdown({
      summary: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesRenamed: 0,
        symbolsAffected: 0,
        coChangeWarnings: 0,
      },
      files: [{ path: 'src/utils.ts', status: 'modified', affectedSymbols: [], tests: [] }],
      coChangeWarnings: [],
    });
    expect(md).toContain('**0** symbols affected');
    expect(md).toContain('0 symbols affected despite 1 changed file');
    expect(md).toContain('outside any indexed symbol body');
  });

  // Counterpart: when symbols WERE affected the clarifier must NOT fire.
  it('omits the "0 symbols affected" clarifier when symbols were affected', () => {
    const md = renderReviewContextMarkdown({
      summary: {
        filesAdded: 0,
        filesModified: 1,
        filesDeleted: 0,
        filesRenamed: 0,
        symbolsAffected: 2,
        coChangeWarnings: 0,
      },
      files: [],
      coChangeWarnings: [],
    });
    expect(md).not.toContain('despite');
  });

  // Bug #18 regression — a hunk landing BETWEEN top-level symbol bodies
  // (e.g. a `console.log` injected at module top, an edit to a
  // module-scope `const x = …`, or a comment-only change at the file
  // head) used to surface "0 symbols affected — hunks fall outside any
  // indexed symbol body" and silently drop the file from the review.
  // The fallback now anchors a synthetic `file`-kind entry with a
  // sibling note so the file shows up under "affected" instead of
  // being invisible.
  it('bug #18: module-level edit between symbols surfaces a file-kind fallback entry with sibling note', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-modlevel-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const q = new QueryBuilder(db.getDb());
    const traverser = new GraphTraverser(q);

    db.getDb()
      .prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, '', 'typescript', 0, 0, 0)`,
      )
      .run('src/mod.ts');
    // The file-kind node (extractor always emits one) + two top-level
    // function nodes at lines 10-20 and 30-40 respectively. The hunk
    // below lands at line 2, BETWEEN no symbol body — pre-fix this
    // returned an empty `affectedSymbols` list.
    q.insertNodes([
      makeNode('file:src/mod.ts', 'mod.ts', 'file', 'src/mod.ts', 1, 50),
      makeNode('first', 'firstFn', 'function', 'src/mod.ts', 10, 20),
      makeNode('second', 'secondFn', 'function', 'src/mod.ts', 30, 40),
    ]);

    const diff = `diff --git a/src/mod.ts b/src/mod.ts
index abc..def 100644
--- a/src/mod.ts
+++ b/src/mod.ts
@@ -2,0 +3,1 @@
+console.log('debug');`;

    const ctx = buildReviewContext(diff, { queries: q, traverser });

    // The file shows up under affected, with exactly one fallback entry
    // (the file-kind node). The summary counts it so it surfaces in the
    // headline number too.
    expect(ctx.files).toHaveLength(1);
    expect(ctx.files[0].affectedSymbols).toHaveLength(1);
    expect(ctx.summary.symbolsAffected).toBe(1);

    const entry = ctx.files[0].affectedSymbols[0];
    expect(entry.kind).toBe('file');
    expect(entry.moduleLevelEditNote).toBeDefined();
    expect(entry.moduleLevelEditNote).toMatch(/module-level edit/i);
    // The nearest-sibling note cites `firstFn` (closer to line 2) ahead
    // of `secondFn` — distance-from-anchor ordering, capped at 3.
    expect(entry.moduleLevelEditNote).toMatch(/firstFn/);

    // Rendered markdown surfaces the same note in the per-file section
    // so a reviewer can scan to it directly.
    const md = renderReviewContextMarkdown(ctx as unknown as MdReviewContext);
    expect(md).toMatch(/module-level edit/i);
    expect(md).toMatch(/firstFn/);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('end-to-end: buildReviewContext output renders to markdown without JSON hashes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-md-'));
    const db = DatabaseConnection.initialize(path.join(dir, 'test.db'));
    const q = new QueryBuilder(db.getDb());
    const traverser = new GraphTraverser(q);

    db.getDb()
      .prepare(
        `INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at) VALUES (?, '', 'typescript', 0, 0, 0)`,
      )
      .run('src/big.ts');
    const nodes: Node[] = [];
    for (let i = 0; i < 5; i++) {
      nodes.push(makeNode(`n${i}`, `sym${i}`, 'function', 'src/big.ts', i * 5, i * 5 + 4));
    }
    q.insertNodes(nodes);

    const diff = `diff --git a/src/big.ts b/src/big.ts
--- a/src/big.ts
+++ b/src/big.ts
@@ -1,100 +1,100 @@
-x
+y`;
    const ctx = buildReviewContext(diff, { queries: q, traverser });
    const md = renderReviewContextMarkdown(ctx as unknown as MdReviewContext);
    expect(md).toContain('# Review context');
    expect(md).toContain('### `src/big.ts`');
    expect(md).not.toContain('"symbolId"');

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('cartograph_review mode=context — git-diff derivation (friction-22)', () => {
  it('derives the diff from `git diff HEAD` when `diff` is omitted', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gitderive-'));
    runReviewGit(dir, 'init', '-q');
    runReviewGit(dir, 'config', 'user.email', 't@t.t');
    runReviewGit(dir, 'config', 'user.name', 'test');
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'foo.ts'), 'export function alpha(): number { return 1; }\n');
    runReviewGit(dir, 'add', '-A');
    runReviewGit(dir, 'commit', '-qm', 'init');
    // Make a working-tree change so `git diff HEAD` is non-empty.
    fs.writeFileSync(path.join(srcDir, 'foo.ts'), 'export function alpha(): number { return 2; }\n');

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    try {
      const tool = getReviewTool();
      // No `diff` passed — handler must derive it from git.
      const result = await tool.handle(makeReviewToolCtx(cg), { mode: 'context' });
      const text = result.content[0]?.text ?? '';
      // It should have produced a real review (markdown), not the
      // "diff must be a non-empty string" hard-error.
      expect(text).not.toMatch(/diff must be a non-empty string/i);
      expect(text).toMatch(/Review context|src\/foo\.ts/);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns a friendly "no uncommitted changes" message on a clean tree', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'review-gitclean-'));
    runReviewGit(dir, 'init', '-q');
    runReviewGit(dir, 'config', 'user.email', 't@t.t');
    runReviewGit(dir, 'config', 'user.name', 'test');
    const srcDir = path.join(dir, 'src');
    fs.mkdirSync(srcDir);
    fs.writeFileSync(path.join(srcDir, 'foo.ts'), 'export function alpha(): number { return 1; }\n');
    runReviewGit(dir, 'add', '-A');
    runReviewGit(dir, 'commit', '-qm', 'init');

    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    try {
      const tool = getReviewTool();
      const result = await tool.handle(makeReviewToolCtx(cg), { mode: 'context' });
      const text = result.content[0]?.text ?? '';
      expect(text).toMatch(/no uncommitted changes/i);
      expect(text).not.toMatch(/diff must be a non-empty string/i);
    } finally {
      cg.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/**
 * Shim that mimics PR #105's QueryBuilder.getCoChangedFiles. Used in
 * tests for forward-compatibility — once #105 lands, the real method
 * exists on QueryBuilder and this shim is unnecessary.
 */
function getCoChangedFilesShim(
  q: QueryBuilder,
  filePath: string,
  options: { limit: number; minCount: number; minJaccard: number },
): Array<{ path: string; count: number; jaccard: number }> {
  const { limit, minCount, minJaccard } = options;
  const sql = `
    WITH partners AS (
      SELECT file_b AS path, count FROM co_changes WHERE file_a = ?
      UNION ALL
      SELECT file_a AS path, count FROM co_changes WHERE file_b = ?
    ),
    anchor AS (SELECT commit_count AS c FROM files WHERE path = ?),
    scored AS (
      SELECT
        p.path AS path, p.count AS count,
        CAST(p.count AS REAL) / NULLIF((SELECT c FROM anchor) + f.commit_count - p.count, 0) AS jaccard
      FROM partners p
      JOIN files f ON f.path = p.path
      WHERE p.count >= ?
    )
    SELECT path, count, jaccard FROM scored
    WHERE COALESCE(jaccard, 0) >= ?
    ORDER BY jaccard DESC, count DESC
    LIMIT ?
  `;
  const rows = (
    q as unknown as {
      db: {
        prepare: (sql: string) => {
          all: (...args: unknown[]) => Array<{ path: string; count: number; jaccard: number | null }>;
        };
      };
    }
  ).db
    .prepare(sql)
    .all(filePath, filePath, filePath, minCount, minJaccard, limit);
  return rows.map((r) => ({ path: r.path, count: r.count, jaccard: r.jaccard ?? 0 }));
}
