/**
 * Handler-level tests for the MCP tool changes shipped on the
 * `stress-test-fixes` branch. These exercise the user-visible output
 * of each handler so future formatter edits can't silently regress
 * the contracts (warning text, table columns, hint phrasing).
 *
 * Each test sets up the smallest realistic project that triggers the
 * code path, calls the handler directly via `ToolHandler`, and asserts
 * on the rendered text.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { upsertDirectorySummary } from '../src/db/queries-directory-summaries.js';

function textOf(result: { content: Array<{ type: string; text: string }> }): string {
  return result.content[0]!.text;
}

describe('Stress-test-fixes handler outputs', () => {
  let tempDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cartograph-handlers-stress-'));
  });

  afterEach(() => {
    if (cg) cg.close();
    else if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true });
  });

  // -------------------------------------------------------------
  // Fix C — handleImpact rollup + per-file cap + wide-blast warning
  // -------------------------------------------------------------
  describe('handleImpact (Fix C)', () => {
    it('emits wide-blast warning + concentration rollup when impact > threshold', async () => {
      // Build a class that's depended on by many sibling functions in
      // the same file so the impact set goes wide on small input.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      const headerLines = ['export class Hub {', '  ping(): void {}', '}'];
      // 60 functions, each calling `Hub.ping`. Easily blows the 50 threshold.
      const callerLines: string[] = [];
      for (let i = 0; i < 60; i++) {
        callerLines.push(`export function caller${i}(): void { const h = new Hub(); h.ping(); }`);
      }
      fs.writeFileSync(path.join(tempDir, 'src/hub.ts'), [...headerLines, ...callerLines].join('\n'));
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'Hub', hops: 3 });
      const text = textOf(r);

      expect(text).toMatch(/^## Impact: "Hub" \(depth \d+\) affects \d+ symbols/m);
      expect(text).toContain('Wide blast radius');
      expect(text).toContain('Concentration by file');
      expect(text).toContain('`src/hub.ts` —');
    });

    it('caps per-file node list with `(+N more)` overflow notation', async () => {
      // Single class with 50+ methods all "impacted" via contains/calls.
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      const methodLines: string[] = [];
      for (let i = 0; i < 50; i++) methodLines.push(`  m${i}(): void { this.center(); }`);
      fs.writeFileSync(
        path.join(tempDir, 'src/big.ts'),
        ['export class Big {', '  center(): void {}', ...methodLines, '}'].join('\n'),
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'center', hops: 3 });
      const text = textOf(r);

      // IMPACT_PER_FILE_CAP = 25, so we expect the overflow marker.
      expect(text).toMatch(/\(\+\d+ more\)/);
    });

    it('does not emit warning or rollup for narrow impact', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/u.ts'),
        `export function only(): void {}\nexport function caller(): void { only(); }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'impact', start: 'only', hops: 1 });
      const text = textOf(r);
      expect(text).not.toContain('Wide blast radius');
    });
  });

  // -------------------------------------------------------------
  // Fix H — handleCallees on a class returns method-name hint
  // -------------------------------------------------------------
  describe('handleCallees (Fix H)', () => {
    it('hints class methods instead of "No callees"', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/c.ts'),
        `export class MyService {
  start(): void {}
  stop(): void {}
  ping(): void {}
}
`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callees', start: 'MyService' });
      const text = textOf(r);
      expect(text).toContain('"MyService" is a class');
      expect(text).toContain('callees live on its methods');
      expect(text).toMatch(/Methods on MyService:.*start.*stop.*ping/s);
      // Hint must recommend the post-merge tool name, not the retired
      // `cartograph_callees`. Friction #10 (2026-05-19) caught the
      // stale recommendation; the static-scan companion test would
      // catch it again, but pin the new wording here so the round-
      // trip behavior is locked in.
      expect(text).toMatch(/cartograph_graph\(\{start: '[^']+', direction: 'callees'\}\)/);
      expect(text).not.toContain('cartograph_callees');
    });

    it('falls back to bare empty when target is callable but has no callees', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/n.ts'), `export function noCallees(): number { return 1 + 2; }\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_graph', { direction: 'callees', start: 'noCallees' });
      const text = textOf(r);
      expect(text).toContain('No callees found');
      expect(text).not.toContain('is a class');
    });
  });

  // -------------------------------------------------------------
  // Fix J — handleModule actionable empty-state hint
  // -------------------------------------------------------------
  describe('handleModule (Fix J)', () => {
    it('reports N/M summarised + populate action when no dir summary cached', async () => {
      fs.mkdirSync(path.join(tempDir, 'src/feature'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/feature/a.ts'),
        `export function fa(): void {}\nexport function fb(): void {}\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_module', { dirPath: 'src/feature' });
      const text = textOf(r);
      expect(text).toContain('"src/feature"');
      // 0 of N summarised; should report ratio + populate action.
      expect(text).toMatch(/0 \/ \d+ symbols summarised/);
      expect(text).toContain('cartograph_summaries');
    });

    it('reports intra-directory, inbound, and outbound module coupling', async () => {
      fs.mkdirSync(path.join(tempDir, 'src/feature'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/feature/a.ts'),
        [
          "import { b } from './b';",
          "import { outside } from '../outside';",
          'export function a(): number {',
          '  return b() + outside();',
          '}',
        ].join('\n'),
      );
      fs.writeFileSync(path.join(tempDir, 'src/feature/b.ts'), 'export function b(): number { return 1; }\n');
      fs.writeFileSync(path.join(tempDir, 'src/outside.ts'), 'export function outside(): number { return 2; }\n');
      fs.writeFileSync(
        path.join(tempDir, 'src/consumer.ts'),
        "import { a } from './feature/a';\nexport function consume(): number { return a(); }\n",
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_module', { dirPath: 'src/feature' });
      const text = textOf(r);
      expect(text).toContain('Coupling');
      expect(text).toContain('1 intra-dir, 1 inbound, 1 outbound');
    });

    it('replaces a bare mid-sentence "…" in a cached summary with an explicit [summary truncated] marker', async () => {
      fs.mkdirSync(path.join(tempDir, 'src/feature'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/feature/a.ts'),
        `export function fa(): void {}\nexport function fb(): void {}\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      // Simulate a summariser-truncated paragraph: clipped mid-sentence
      // with a dangling " …" — the failure mode the fix targets.
      upsertDirectorySummary({
        qb: cg.queries,
        dirPath: 'src/feature',
        contentHash: 'h1',
        summary: 'This module handles request routing and response shaping for the …',
        model: 'test',
      });

      const r = await handler.runHandler('cartograph_module', { dirPath: 'src/feature' });
      const text = textOf(r);
      // The dangling bare ellipsis must be gone; an explicit marker present.
      expect(text).not.toMatch(/the …/);
      expect(text).toContain('[summary truncated]');
    });

    it('drops a dangling "…" cleanly when the cached summary ends on a complete sentence', async () => {
      fs.mkdirSync(path.join(tempDir, 'src/feature'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/feature/a.ts'),
        `export function fa(): void {}\nexport function fb(): void {}\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      upsertDirectorySummary({
        qb: cg.queries,
        dirPath: 'src/feature',
        contentHash: 'h1',
        summary: 'This module handles request routing. It also shapes responses. …',
        model: 'test',
      });

      const r = await handler.runHandler('cartograph_module', { dirPath: 'src/feature' });
      const text = textOf(r);
      // Clean clip: ellipsis dropped, no truncation marker needed.
      expect(text).toContain('It also shapes responses.');
      expect(text).not.toMatch(/responses\. …/);
      expect(text).not.toContain('[summary truncated]');
    });

    it('reports "no summarisable symbols" when dir has none', async () => {
      // `path.join(tempDir, 'src/empty')` — exists but no source files.
      fs.mkdirSync(path.join(tempDir, 'src/empty'), { recursive: true });
      // Add at least one source file elsewhere so the index has content.
      fs.mkdirSync(path.join(tempDir, 'src/other'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/other/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_module', { dirPath: 'src/empty' });
      const text = textOf(r);
      expect(text).toContain('no summarisable symbols');
    });
  });

  // -------------------------------------------------------------
  // Fix D — handleStatus feature-readiness block
  // -------------------------------------------------------------
  describe('handleStatus (Fix D)', () => {
    it('emits a Feature Readiness block listing tier-3 metrics + actions', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'src/x.ts'), `export function x(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_status', {});
      const text = textOf(r);
      // Section header gained a status-board emoji; assert the
      // semantic part with a regex so future emoji tweaks don't
      // re-break this.
      expect(text).toMatch(/### .*Feature Readiness/);
      // Embeddings / coverage line shapes also gained traffic-light
      // emoji + bold keys; the relevant invariants are the count +
      // enabling-command labels.
      expect(text).toMatch(/Embeddings.*\d+ rows/);
      expect(text).toContain("cartograph_find({by: 'name', mode: 'semantic'})");
      expect(text).toMatch(/Coverage.*\d+ symbols/);
      expect(text).toContain('cartograph coverage --mode load --report-path <lcov>');
    });
  });

  // -------------------------------------------------------------
  // Fix A — handleEnvRefs + handleSqlRefs prod/test split
  // -------------------------------------------------------------
  describe('handleEnvRefs (Fix A)', () => {
    it('renders prod/test split columns and ranks prod keys ahead of test-only', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      // PROD_KEY: read in a prod file. TEST_ONLY_KEY: read only in tests.
      fs.writeFileSync(
        path.join(tempDir, 'src/cfg.ts'),
        `export function load(): string | undefined { return process.env.PROD_KEY; }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, '__tests__/fixture.test.ts'),
        `function setupX(): void { const _x = process.env.TEST_ONLY_KEY; if(_x){} }\nsetupX();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', { by: 'env' });
      const text = textOf(r);
      expect(text).toContain('Reads (prod)');
      expect(text).toContain('Reads (test)');
      // PROD_KEY must be present and appear BEFORE TEST_ONLY_KEY in
      // the table (prod-rank-first).
      const prodIdx = text.indexOf('PROD_KEY');
      const testIdx = text.indexOf('TEST_ONLY_KEY');
      expect(prodIdx).toBeGreaterThanOrEqual(0);
      expect(testIdx).toBeGreaterThanOrEqual(0);
      expect(prodIdx).toBeLessThan(testIdx);
    });

    it('tags individual sites prod vs test in the per-key view', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/cfg.ts'),
        `export function p(): string | undefined { return process.env.MIXED; }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, '__tests__/m.test.ts'),
        `function t(): void { const _x = process.env.MIXED; if(_x){} }\nt();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', { by: 'env', key: 'MIXED' });
      const text = textOf(r);
      expect(text).toContain('[prod]');
      expect(text).toContain('[test]');
      expect(text).toMatch(/1 prod \/ 1 test/);
    });

    // FRICTION-8: env reads from docs/test-beds/ must be classified as
    // test, not prod. isFixturePath now augments isTestPath so fixture
    // directories that happen to have is_test=0 in the DB are still
    // correctly bucketed in the prod/test split.
    it('classifies docs/test-beds/ env reads as test, not prod (FRICTION-8)', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'docs/test-beds/typescript'), { recursive: true });
      // A genuine prod read — should appear as prod.
      fs.writeFileSync(
        path.join(tempDir, 'src/cfg.ts'),
        `export function load(): string | undefined { return process.env.FIXTURE_KEY; }\n`,
      );
      // A read inside docs/test-beds/ — should be classified as test,
      // not prod, even though the file has is_test=0 in the files table
      // (the extractor doesn't set is_test based on docs/ prefix alone).
      fs.writeFileSync(
        path.join(tempDir, 'docs/test-beds/typescript/fixture.ts'),
        `export function example(): void { const _k = process.env.FIXTURE_KEY; if(_k){} }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      // Top-level table view: FIXTURE_KEY must show 1 prod read (from src/)
      // and 1 test read (from docs/test-beds/), not 2 prod reads.
      const tableResult = await handler.runHandler('cartograph_find', { by: 'env' });
      const tableText = textOf(tableResult);
      // The row for FIXTURE_KEY: prod column should be 1, test column 1.
      // Encoded as "| `FIXTURE_KEY` | 1 | 1 |" in the markdown table.
      expect(tableText).toMatch(/FIXTURE_KEY.*\|\s*1\s*\|\s*1\s*\|/);

      // Per-key view: the docs/test-beds/ site should be tagged [test].
      const keyResult = await handler.runHandler('cartograph_find', { by: 'env', key: 'FIXTURE_KEY' });
      const keyText = textOf(keyResult);
      expect(keyText).toContain('[prod]');
      expect(keyText).toContain('[test]');
      expect(keyText).toMatch(/1 prod \/ 1 test/);
    });

    // Handoff item #2: includeTests:false was silently ignored on the
    // per-key path even though it filtered correctly on the no-key path.
    it('honors includeTests:false on the per-key view — filters test sites', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/cfg.ts'),
        `export function p(): string | undefined { return process.env.SPLIT_KEY; }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, '__tests__/m.test.ts'),
        `function t(): void { const _x = process.env.SPLIT_KEY; if(_x){} }\nt();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      // Default (includeTests:true / omitted) shows both sites.
      const allResult = await handler.runHandler('cartograph_find', { by: 'env', key: 'SPLIT_KEY' });
      const allText = textOf(allResult);
      expect(allText).toMatch(/1 prod \/ 1 test/);
      expect(allText).toContain('[test]');

      // includeTests:false drops the test site and notes the hidden count.
      const prodOnlyResult = await handler.runHandler('cartograph_find', {
        by: 'env',
        key: 'SPLIT_KEY',
        includeTests: false,
      });
      const prodOnlyText = textOf(prodOnlyResult);
      expect(prodOnlyText).toMatch(/1 prod \/ 0 test/);
      expect(prodOnlyText).not.toContain('[test]');
      expect(prodOnlyText).toMatch(/1 test-only site hidden/);
    });

    it('per-key includeTests:false with only test sites emits a helpful empty-state message', async () => {
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '__tests__/m.test.ts'),
        `function t(): void { const _x = process.env.TEST_ONLY; if(_x){} }\nt();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', {
        by: 'env',
        key: 'TEST_ONLY',
        includeTests: false,
      });
      const text = textOf(r);
      expect(text).toMatch(/No prod reads found for env var "TEST_ONLY"/);
      expect(text).toMatch(/1 test-only site hidden/);
      expect(text).toContain('includeTests: true');
    });
  });

  // -------------------------------------------------------------
  // Fix K — handleSearch demotes test/fixture paths
  // -------------------------------------------------------------
  describe('handleSearch (Fix K)', () => {
    it('ranks prod hits before fixture/test-bed hits when both exist', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, 'docs/test-beds'), { recursive: true });
      // A prod symbol named `find` and a test-bed symbol with the
      // same prefix. Without re-ranking, FTS prefix-match could put
      // the fixture ahead.
      fs.writeFileSync(path.join(tempDir, 'src/finder.ts'), `export function find(): void {}\n`);
      fs.writeFileSync(path.join(tempDir, 'docs/test-beds/sample.ts'), `export function find(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', { by: 'name', query: 'find' });
      const text = textOf(r);
      const prodIdx = text.indexOf('src/finder.ts');
      const fixtureIdx = text.indexOf('docs/test-beds/sample.ts');
      expect(prodIdx).toBeGreaterThanOrEqual(0);
      expect(fixtureIdx).toBeGreaterThanOrEqual(0);
      expect(prodIdx).toBeLessThan(fixtureIdx);
    });

    it('still surfaces fixtures when no prod hits exist', async () => {
      fs.mkdirSync(path.join(tempDir, 'docs/test-beds'), { recursive: true });
      fs.writeFileSync(path.join(tempDir, 'docs/test-beds/only.ts'), `export function onlyHere(): void {}\n`);
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', { by: 'name', query: 'onlyHere' });
      const text = textOf(r);
      expect(text).toContain('docs/test-beds/only.ts');
      expect(text).not.toContain('No results');
    });
  });

  // SQL split exercises the same code path, so one shape-test is
  // sufficient — the data path is identical to handleEnvRefs.
  describe('handleSqlRefs (Fix A)', () => {
    it('emits prod/test split columns', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/db.ts'),
        `export function q(): string { return "SELECT id FROM widgets"; }\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', { by: 'sql' });
      const text = textOf(r);
      expect(text).toContain('Refs (prod)');
      expect(text).toContain('Refs (test)');
    });

    // Handoff item #2: includeTests:false was silently ignored on the
    // per-table path. Mirror the env-refs filtering semantics.
    it('honors includeTests:false on the per-table view — filters test sites', async () => {
      fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, 'src/db.ts'),
        `export function q(): string { return "SELECT id FROM widgets"; }\n`,
      );
      fs.writeFileSync(
        path.join(tempDir, '__tests__/db.test.ts'),
        `function t(): string { return "SELECT * FROM widgets"; }\nt();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const allResult = await handler.runHandler('cartograph_find', { by: 'sql', key: 'widgets' });
      const allText = textOf(allResult);
      expect(allText).toMatch(/2 sites \(1 prod \/ 1 test\)/);

      const prodOnlyResult = await handler.runHandler('cartograph_find', {
        by: 'sql',
        key: 'widgets',
        includeTests: false,
      });
      const prodOnlyText = textOf(prodOnlyResult);
      expect(prodOnlyText).toMatch(/1 site \(1 prod \/ 0 test\)/);
      expect(prodOnlyText).toMatch(/1 test-only site hidden/);
    });

    it('per-table includeTests:false with only test sites emits a helpful empty-state message', async () => {
      fs.mkdirSync(path.join(tempDir, '__tests__'), { recursive: true });
      fs.writeFileSync(
        path.join(tempDir, '__tests__/db.test.ts'),
        `function t(): string { return "SELECT id FROM ghost_table"; }\nt();\n`,
      );
      cg = await Cartograph.init(tempDir, { index: true });
      handler = new ToolHandler(cg);

      const r = await handler.runHandler('cartograph_find', {
        by: 'sql',
        key: 'ghost_table',
        includeTests: false,
      });
      const text = textOf(r);
      expect(text).toMatch(/No prod refs found for table "ghost_table"/);
      expect(text).toMatch(/1 test-only site hidden/);
      expect(text).toContain('includeTests: true');
    });
  });
});
