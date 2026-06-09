/**
 * Round-two stress-test fixes.
 *
 * Each test locks in a contract surfaced by re-running the stress test
 * against the cartograph + ollama codebases on top of the round-one
 * landings. Mapping:
 *   C-residue → handleImpact emits a hard cap on detail-level files
 *   N1       → callers/callees group by source when name aggregates
 *   N3       → review_context anchorRatio OR-gate exposes asymmetric pairs
 *   N4       → review_context file-level callees drop `imports` edges
 *   N5       → searchHybrid (FTS-only branch) caps per-name to diversify
 *   G        → named imports emit `references` refs the resolver can edge
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { DatabaseConnection } from '../src/db/index.js';
import { QueryBuilder } from '../src/db/queries.js';
import { searchNodes } from '../src/db/queries-search.js';
import { getIncomingEdges } from '../src/db/queries-edges.js';
import { applyCoChangeDeltas, getCoChangedFiles } from '../src/db/queries-history.js';
import { GraphTraverser } from '../src/graph/traversal.js';
import { buildReviewContext } from '../src/review/index.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('Round-two stress-test fixes', () => {
  let tempDir: string;
  let cg: Cartograph;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-r2-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  // ---------------------------------------------------------------
  // Fix C-residue: hard global cap on per-file detail listings
  // ---------------------------------------------------------------
  describe('handleImpact (C-residue)', () => {
    it('elides per-file detail beyond IMPACT_DETAIL_FILES_CAP and explains', async () => {
      // 30 files each calling a hub function. Without a file-count cap
      // the per-file detail loop dumps all 30 sections, which on real
      // monorepos blew through the MCP response budget. Cap is 20.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/hub.ts'), 'export function hub(): void {}\n');
      for (let i = 0; i < 30; i++) {
        fs.writeFileSync(
          path.join(tempDir, `src/c${i}.ts`),
          `import { hub } from './hub.js';\nexport function call${i}(): void { hub(); }\n`,
        );
      }
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'hub', hops: 3 });
      const text = textOf(r);
      // The footnote names how many files were elided so the agent can
      // narrow the query instead of guessing the volume.
      expect(text).toMatch(/Detail elided for \d+ more file/);
      expect(text).toContain('Lower `hops`');
    });

    it('emits per-source file rollup when a name resolves to multiple sources', async () => {
      // Two `Encode` methods on different classes, each impacting
      // disjoint downstream files. Pre-fix: the merged "Concentration
      // by file" loses attribution — `userA.ts — 1` and `userB.ts — 1`
      // read as siblings even though they trace to different sources.
      // Post-fix: a per-source rollup section attaches each source's
      // top-N files back to its definition.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export class JsonCodec {\n  Encode(x: unknown): string { return JSON.stringify(x); }\n}\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `export class TokenCodec {\n  Encode(s: string): string[] { return s.split(''); }\n}\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/userA.ts'),
        `import { JsonCodec } from './a.js';\nexport function useA(): string { const c = new JsonCodec(); return c.Encode({}); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/userB.ts'),
        `import { TokenCodec } from './b.js';\nexport function useB(): string[] { const c = new TokenCodec(); return c.Encode('x'); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'Encode', hops: 5 });
      const text = textOf(r);
      // Per-source size attribution.
      expect(text).toContain('### Source symbols');
      // New per-source rollup keeps each source's files under its heading.
      expect(text).toContain('### Concentration by file per source');
      expect(text).toMatch(/\*\*`src\/a\.ts:\d+`:\*\*/);
      expect(text).toMatch(/\*\*`src\/b\.ts:\d+`:\*\*/);
      // Each source's downstream file should appear under its own block,
      // not co-mingled. Cheap heuristic: split by per-source headings and
      // confirm userA only shows up under a.ts's block, userB under b.ts's.
      const aBlockMatch = /\*\*`src\/a\.ts:\d+`:\*\*([\s\S]*?)(?=\*\*`src\/|###|$)/.exec(text);
      const bBlockMatch = /\*\*`src\/b\.ts:\d+`:\*\*([\s\S]*?)(?=\*\*`src\/|###|$)/.exec(text);
      expect(aBlockMatch?.[1]).toContain('userA.ts');
      expect(aBlockMatch?.[1]).not.toContain('userB.ts');
      expect(bBlockMatch?.[1]).toContain('userB.ts');
      expect(bBlockMatch?.[1]).not.toContain('userA.ts');
    });

    it('skips per-source rollup when only one source matches', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/u.ts'),
        `export function unique(): void {}\nexport function caller(): void { unique(); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'unique', hops: 3 });
      const text = textOf(r);
      expect(text).not.toContain('### Source symbols');
      expect(text).not.toContain('Concentration by file per source');
    });
  });

  // ---------------------------------------------------------------
  // Fix N1: per-source grouping when name aggregates across symbols
  // ---------------------------------------------------------------
  describe('handleCallers (N1)', () => {
    it('groups callers under per-source headings when name resolves to >1 symbol', async () => {
      // Two distinct `Encode` methods on different classes, each with
      // its own callers. Pre-fix: a flat list would mix them. Post-fix:
      // grouped output names each source and lists its callers under it.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `export class JsonCodec {\n  Encode(x: unknown): string { return JSON.stringify(x); }\n}\n` +
          `export function useA(): string { const c = new JsonCodec(); return c.Encode({}); }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, 'src/b.ts'),
        `export class TokenCodec {\n  Encode(s: string): string[] { return s.split(''); }\n}\n` +
          `export function useB(): string[] { const c = new TokenCodec(); return c.Encode('x'); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'Encode' });
      const text = textOf(r);
      expect(text).toContain('source definitions');
      expect(text).toContain('Callers are grouped per source');
      // Each source's location appears as a section header.
      expect(text).toMatch(/### Encode \(method\) — src\/a\.ts:/);
      expect(text).toMatch(/### Encode \(method\) — src\/b\.ts:/);
    });

    it('keeps the flat output when only one match exists', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/u.ts'),
        `export function unique(): void {}\nexport function caller(): void { unique(); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'unique' });
      const text = textOf(r);
      // Old single-match heading shape, no per-source grouping.
      expect(text).toMatch(/^## Callers of unique \(\d+ found\)/m);
      expect(text).not.toContain('source definitions');
    });

    // -------------------------------------------------------------
    // Gap 3 (round-3): preserve call-site multiplicity through dedup
    //
    // The extractor collapses N call sites of (caller, callee, kind)
    // to one unresolved ref to bound DB churn. Pre-fix the count was
    // lost — callers output looked like `main calls foo` with no hint
    // that `foo` was actually called 15 times. Post-fix the dedup
    // tracks siteCount + a sample of extra lines; the resolver stamps
    // them onto edge metadata; cartograph_callers surfaces them.
    // -------------------------------------------------------------
    it('surfaces siteCount when the same caller calls a function multiple times', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/util.ts'), 'export function foo(): void {}\n');
      // `main` calls `foo` 4 times, mimicking the bin/cartograph.ts
      // pattern of many .action() callbacks each calling the same
      // imported helper.
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { foo } from './util.js';\nexport function main(): void {\n` +
          `  foo();\n` +
          `  foo();\n` +
          `  foo();\n` +
          `  foo();\n` +
          `}\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'foo' });
      const text = textOf(r);
      // The single caller (main) annotates "(4 call sites: ...)".
      expect(text).toMatch(/main \(function\).*\(4 call sites:/);
    });

    it('omits the site annotation when there is only one call site', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/util.ts'), 'export function once(): void {}\n');
      fs.writeFileSync(
        path.join(tempDir, 'src/main.ts'),
        `import { once } from './util.js';\nexport function main(): void { once(); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      const handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callers', start: 'once' });
      const text = textOf(r);
      expect(text).not.toContain('call sites:');
    });
  });

  // ---------------------------------------------------------------
  // Fix N3: anchorRatio OR-gate surfaces asymmetric high-churn pairs
  // ---------------------------------------------------------------
  describe('getCoChangedFiles (N3)', () => {
    it('returns anchorRatio per partner and OR-gates with jaccard', () => {
      const dbPath = path.join(tempDir, 'cg.db');
      const db = DatabaseConnection.initialize(dbPath);
      const q = new QueryBuilder(db.getDb());
      const insertFile = db.getDb().prepare(`
        INSERT INTO files (path, content_hash, language, size, modified_at, indexed_at, commit_count)
        VALUES (?, '', 'typescript', 0, 0, 0, ?)
      `);
      // anchor=16 commits (think sched.go); hub=52 commits (routes.go).
      // 7 co-changes. Jaccard = 7/(16+52-7) = 0.115. AnchorRatio = 7/16 = 0.4375.
      insertFile.run('anchor.ts', 16);
      insertFile.run('hub.ts', 52);
      applyCoChangeDeltas(q, [['anchor.ts', 'hub.ts', 7]]);

      // High Jaccard threshold rejects, but anchorRatio gate surfaces.
      const got = getCoChangedFiles(q, 'anchor.ts', { minJaccard: 0.4, minAnchorRatio: 0.3 });
      expect(got.length).toBe(1);
      expect(got[0].path).toBe('hub.ts');
      expect(got[0].anchorRatio).toBeGreaterThan(0.4);
      expect(got[0].jaccard).toBeLessThan(0.2);

      // Both gates strict → still surfaced through anchorRatio.
      const both = getCoChangedFiles(q, 'anchor.ts', { minJaccard: 0.9, minAnchorRatio: 0.4 });
      expect(both.length).toBe(1);

      // Both gates relaxed → returned (sanity).
      const lax = getCoChangedFiles(q, 'anchor.ts', { minJaccard: 0, minAnchorRatio: 0 });
      expect(lax.length).toBe(1);

      // Both gates above the values → dropped.
      const none = getCoChangedFiles(q, 'anchor.ts', { minJaccard: 0.9, minAnchorRatio: 0.9 });
      expect(none.length).toBe(0);

      db.close();
    });

    it('buildReviewContext applies DEFAULTS when MCP forwards undefined args', async () => {
      // Regression: callers like the MCP handler always include keys
      // (with `undefined` when unset) in the options object. A naive
      // spread `{ ...DEFAULTS, ...options }` lets undefined override the
      // default — the loop guard fails and coChangeWarnings is silently
      // empty. Exercise the full path with a real index.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/a.ts'), 'export function a(): void {}\n');
      fs.writeFileSync(path.join(tempDir, 'src/b.ts'), 'export function b(): void {}\n');
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['add', '-A'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
        cwd: tempDir,
        stdio: 'pipe',
      });
      cg = await Cartograph.init(tempDir, { index: true });
      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      const traverser = new GraphTraverser(queries);

      // Seed enough co-change history that the OR-gate has something to
      // surface for src/a.ts. anchor=10 commits, partner=40, count=4 →
      // jaccard 4/(10+40-4)=0.087, anchorRatio 4/10=0.4. Default jaccard
      // (0.4) rejects, default anchorRatio (0.3) accepts.
      const rawDb = (
        queries as unknown as { db: { prepare: (sql: string) => { run: (...args: unknown[]) => unknown } } }
      ).db;
      const setCommits = rawDb.prepare('UPDATE files SET commit_count = ? WHERE path = ?');
      setCommits.run(10, 'src/a.ts');
      setCommits.run(40, 'src/b.ts');
      applyCoChangeDeltas(queries, [['src/a.ts', 'src/b.ts', 4]]);

      const diff = `diff --git a/src/a.ts b/src/a.ts
@@ -1 +1,2 @@
 export function a(): void {}
+// touch
`;

      // Simulate the MCP handler shape: every key present, all undefined.
      // `minDiffMagnitude: 0` opts out of the friction-29 text-only-diff
      // gate; this test is about the undefined-handling contract on the
      // OTHER options, not the new gate (which has its own tests in
      // review-context.test.ts).
      const optsLikeMCP = {
        maxCallersPerSymbol: undefined,
        maxCalleesPerSymbol: undefined,
        maxCoChangeWarnings: undefined,
        minCoChangeJaccard: undefined,
        minDiffMagnitude: 0,
      };
      const ctx = buildReviewContext(diff, { queries, traverser }, optsLikeMCP);
      // Must surface b.ts via the anchorRatio OR-gate.
      expect(ctx.coChangeWarnings.length).toBeGreaterThan(0);
      expect(ctx.coChangeWarnings.some((w) => w.expectedToChange === 'src/b.ts')).toBe(true);
    });
  });

  // ---------------------------------------------------------------
  // Fix N4: review_context strips `imports` edges from file callees
  // ---------------------------------------------------------------
  describe('buildReviewContext (N4)', () => {
    it('does not list package imports as file-level callees', () => {
      // Set up a one-file project, give it imports, then run a diff
      // against it. The file-symbol's `callees` must not include the
      // imported module names (context, errors, fmt-style noise).
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/a.ts'),
        `import * as fs from 'fs';\nimport * as path from 'path';\nexport function read(p: string): string { return fs.readFileSync(p, 'utf-8'); }\n`,
      );
      // Need a git repo so review-context's diff tools work.
      execFileSync('git', ['init'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['add', '-A'], { cwd: tempDir, stdio: 'pipe' });
      execFileSync('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-m', 'init'], {
        cwd: tempDir,
        stdio: 'pipe',
      });

      // Init cartograph, then build review-context for a synthetic diff
      // touching the file. We don't care about hunk content — only
      // about which symbols come back as affected and what their
      // callees list looks like.
      // Index synchronously via Cartograph.init.
      // (Using Cartograph here just so the index exists.)
      // We'll call buildReviewContext directly with the queries.
      return Cartograph.init(tempDir, { index: true }).then((created) => {
        cg = created;
        const queries = (cg as unknown as { queries: QueryBuilder }).queries;
        const traverser = new GraphTraverser(queries);
        const diff = `diff --git a/src/a.ts b/src/a.ts
@@ -1,3 +1,3 @@
-import * as fs from 'fs';
+import * as fs from 'fs';
 import * as path from 'path';
 export function read(p: string): string { return fs.readFileSync(p, 'utf-8'); }
`;
        const ctx = buildReviewContext(diff, { queries, traverser });
        const file = ctx.files[0];
        expect(file).toBeDefined();
        const fileSym = file!.affectedSymbols.find((s) => s.kind === 'file');
        if (fileSym) {
          // No imported-package name should appear as a callee. Concrete
          // negatives: `fs`, `path` are imports, not function calls.
          for (const c of fileSym.callees) {
            expect(c.name).not.toBe('fs');
            expect(c.name).not.toBe('path');
          }
        }
      });
    });
  });

  // ---------------------------------------------------------------
  // Fix N5: searchHybrid FTS-only fallback diversifies by name
  // ---------------------------------------------------------------
  describe('searchHybrid (N5)', () => {
    it('caps same-name candidates so retrieval is not flooded', async () => {
      // 6 files each with a function called `Encode` plus one diverse
      // `tokenize`. With FTS-only retrieval and a 12-result budget,
      // the pre-fix output would return all 6 Encodes; post-fix the
      // per-name cap of 3 leaves space for `tokenize` to surface too.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      for (let i = 0; i < 6; i++) {
        fs.writeFileSync(
          path.join(tempDir, `src/codec${i}.ts`),
          `export function Encode(s: string): string { return s + '${i}'; }\n`,
        );
      }
      fs.writeFileSync(
        path.join(tempDir, 'src/tokenize.ts'),
        'export function tokenize(s: string): string[] { return s.split(""); }\n',
      );
      cg = await Cartograph.init(tempDir, { index: true });

      const results = await cg.llm.searchHybrid('Encode tokenize', { limit: 12 });
      // Among results, no name should appear more than 3 times.
      const counts = new Map<string, number>();
      for (const r of results) counts.set(r.node.name, (counts.get(r.node.name) ?? 0) + 1);
      const maxPerName = Math.max(...counts.values());
      expect(maxPerName).toBeLessThanOrEqual(3);
    });

    it('diversifies the FTS fallback when embeddings are configured but unpopulated', async () => {
      // Same shape as the no-embeddings case, but the LLM config
      // declares an embeddings backend. With 0 cached embedding rows
      // (the common "summarize:false / never embedded" state), the
      // hybrid path used to return ftsResults.slice unchanged → 6
      // `Encode`s flooded the result. Post-fix the empty-cache fallback
      // also runs diversifyByName.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      for (let i = 0; i < 6; i++) {
        fs.writeFileSync(
          path.join(tempDir, `src/codec${i}.ts`),
          `export function Encode(s: string): string { return s + '${i}'; }\n`,
        );
      }
      fs.writeFileSync(
        path.join(tempDir, 'src/tokenize.ts'),
        'export function tokenize(s: string): string[] { return s.split(""); }\n',
      );
      // Hand-craft a config with embeddings declared but never populated.
      fs.mkdirSync(path.join(tempDir, '.cartograph'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '.cartograph/config.json'),
        JSON.stringify({
          version: 1,
          include: ['**/*.ts'],
          exclude: [],
          llm: {
            enabled: true,
            embeddings: {
              provider: 'openai-compat',
              endpoint: 'http://localhost:1/v1', // unreachable
              model: 'fake',
            },
          },
        }),
      );
      cg = await Cartograph.init(tempDir, { index: true });

      const results = await cg.llm.searchHybrid('Encode tokenize', { limit: 12 });
      const counts = new Map<string, number>();
      for (const r of results) counts.set(r.node.name, (counts.get(r.node.name) ?? 0) + 1);
      const maxPerName = Math.max(...counts.values());
      expect(maxPerName).toBeLessThanOrEqual(3);
    });
  });

  // ---------------------------------------------------------------
  // Fix G: named imports produce a `references` edge to the export
  // ---------------------------------------------------------------
  describe('Named-import references (G)', () => {
    it('emits a cross-file references edge for each named import', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/util.ts'),
        'export function bytesToVector(b: Uint8Array): number[] { return Array.from(b); }\n',
      );
      // Importer in a different directory; never *calls* bytesToVector,
      // only imports it. Pre-fix: no cross-file edge → unused_export.
      // Post-fix: a `references` edge from the importer's file node.
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '__tests__/util.test.ts'),
        `import { bytesToVector } from '../src/util.js';\n` +
          `// Note: not invoked; only imported. The N3-fix means imports still count.\n` +
          `void bytesToVector;\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });

      const queries = (cg as unknown as { queries: QueryBuilder }).queries;
      // Locate the bytesToVector node.
      const target = searchNodes(queries, 'bytesToVector', { limit: 5 }).find(
        (r) => r.node.name === 'bytesToVector' && r.node.filePath === 'src/util.ts',
      );
      expect(target, 'bytesToVector node exists').toBeDefined();

      const incoming = getIncomingEdges(queries, target!.node.id);
      // After the fix there should be at least one cross-file edge that
      // is NOT `contains` (which is just file-ownership).
      const crossFile = incoming.filter((e) => {
        const src = queries.getNodeById(e.source);
        return src && src.filePath !== target!.node.filePath && e.kind !== 'contains';
      });
      expect(crossFile.length).toBeGreaterThan(0);
    });
  });
});
