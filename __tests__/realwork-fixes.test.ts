/**
 * Tests for fixes derived from `docs/CARTOGRAPH-REAL-WORK-EVAL.md`:
 *  #1 cartograph_node refuses stale source code
 *  #2 path-shaped queries demote tests + boost route handler dirs
 *  #3 dot-qualified queries scope to their package/module
 *  #5 search hints when kind filter empties an otherwise non-empty result
 *  #6 not-found surfaces did-you-mean suggestions
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { execFileSync } from 'child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import {
  scorePathRelevance,
  isRouteShapedQuery,
  parseDotQualified,
  dotQualifiedBonus,
} from '../src/search/query-utils.js';

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('Real-work fixes', () => {
  describe('#2 path-shaped query helpers (unit)', () => {
    it('isRouteShapedQuery recognises common route shapes', () => {
      expect(isRouteShapedQuery('/api/generate')).toBe(true);
      expect(isRouteShapedQuery('/v1/users')).toBe(true);
      expect(isRouteShapedQuery('/healthz')).toBe(true);
      expect(isRouteShapedQuery('GET /foo')).toBe(true);
      expect(isRouteShapedQuery('POST /bar/baz')).toBe(true);
      // negatives
      expect(isRouteShapedQuery('GenerateHandler')).toBe(false);
      expect(isRouteShapedQuery('foo bar')).toBe(false);
      expect(isRouteShapedQuery('a/b')).toBe(false); // no leading slash
    });

    it('scorePathRelevance heavily penalises tests on route-shaped queries', () => {
      const testFile = scorePathRelevance('integration/api_test.go', '/api/generate');
      const handlerFile = scorePathRelevance('server/routes.go', '/api/generate');
      // handler should outrank test even though the test name has more
      // token overlap with the URL path.
      expect(handlerFile).toBeGreaterThan(testFile);
    });

    it('scorePathRelevance boosts route-handler dirs on route-shaped queries', () => {
      const inHandlers = scorePathRelevance('server/handlers/generate.go', '/api/generate');
      const inLib = scorePathRelevance('lib/util.go', '/api/generate');
      expect(inHandlers).toBeGreaterThan(inLib);
    });
  });

  describe('#3 dot-qualified query helpers (unit)', () => {
    it('parseDotQualified extracts lhs/rhs', () => {
      expect(parseDotQualified('llm.Generate')).toEqual({ lhs: 'llm', rhs: 'Generate' });
      expect(parseDotQualified('os.path')).toEqual({ lhs: 'os', rhs: 'path' });
      // Python private modules (underscore prefix) — supported.
      expect(parseDotQualified('_io.BufferedReader')).toEqual({ lhs: '_io', rhs: 'BufferedReader' });
      // negatives
      expect(parseDotQualified('Foo.Bar')).toBeNull(); // capitalised LHS is class.member, not package
      expect(parseDotQualified('foo bar')).toBeNull();
      expect(parseDotQualified('foo')).toBeNull();
      expect(parseDotQualified('foo.bar.baz')).toBeNull(); // single dot only
    });

    it('dotQualifiedBonus boosts symbols whose package matches LHS', () => {
      // Generate in llm/ → boost
      expect(dotQualifiedBonus('Generate', 'llm/generate.go', 'llm.Generate')).toBeGreaterThan(0);
      // Generate elsewhere → no boost
      expect(dotQualifiedBonus('Generate', 'tests/api_test.go', 'llm.Generate')).toBe(0);
      // Non-dot-qualified query → no boost
      expect(dotQualifiedBonus('Generate', 'llm/generate.go', 'GenerateHandler')).toBe(0);
    });
  });

  describe('integration', () => {
    let dir: string;
    let cg: Cartograph;

    beforeEach(async () => {
      dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-realwork-'));
      // Build a small project that mirrors the patterns from the eval:
      // - a route-handler-like file
      // - a test file with name overlap
      // - a package-scoped function
      fs.mkdirSync(path.join(dir, 'src'));
      fs.mkdirSync(path.join(dir, 'src', 'server'));
      fs.mkdirSync(path.join(dir, 'src', 'llm'));
      fs.mkdirSync(path.join(dir, '__tests__'));

      fs.writeFileSync(
        path.join(dir, 'src', 'server', 'routes.ts'),
        'export function GenerateHandler() { return "/api/generate"; }\n',
      );
      fs.writeFileSync(
        path.join(dir, 'src', 'llm', 'generate.ts'),
        'export function Generate() { return 42; }\n' + 'export function buildGenerateRequest() { return {}; }\n',
      );
      fs.writeFileSync(
        path.join(dir, '__tests__', 'api.test.ts'),
        'export function TestAPIGenerate() { return 0; }\n' +
          'export function TestAPIGenerateLogprobs() { return 0; }\n',
      );
      fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
      git(dir, 'init', '-q');
      git(dir, 'config', 'user.email', 's@e.com');
      git(dir, 'config', 'user.name', 's');
      git(dir, 'config', 'commit.gpgsign', 'false');
      git(dir, 'add', '.');
      git(dir, 'commit', '-q', '-m', 'init');

      cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts'], exclude: [] } });
      await cg.indexAll();
    }, 30000);

    afterEach(() => {
      if (cg) cg.destroy();
      if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
    });

    it('#2 /api/generate ranks GenerateHandler above TestAPIGenerate', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', { by: 'name', query: '/api/generate' });
      const text = (result.content[0] as { text?: string }).text ?? '';
      const generateHandlerIdx = text.indexOf('GenerateHandler');
      const testApiIdx = text.indexOf('TestAPIGenerate');
      expect(generateHandlerIdx).toBeGreaterThan(-1);
      // Handler appears BEFORE any test mention
      if (testApiIdx > -1) {
        expect(generateHandlerIdx).toBeLessThan(testApiIdx);
      }
    });

    it('#3 llm.Generate ranks llm/Generate above out-of-package matches', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', { by: 'name', query: 'llm.Generate' });
      const text = (result.content[0] as { text?: string }).text ?? '';
      // The package-scoped `Generate` should appear in the results.
      expect(text).toContain('Generate');
      expect(text).toContain('llm/generate.ts');
      const llmIdx = text.indexOf('llm/generate.ts');
      const buildIdx = text.indexOf('buildGenerateRequest');
      // Generate (exact name in package) outranks buildGenerateRequest (just contains).
      if (buildIdx > -1) {
        expect(llmIdx).toBeLessThan(buildIdx);
      }
    });

    it('#5 kind:variable on a function symbol surfaces the helpful hint', async () => {
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', {
        by: 'name',
        query: 'GenerateHandler',
        kind: 'variable',
      });
      const text = (result.content[0] as { text?: string }).text ?? '';
      expect(text).toContain('Without the kind filter');
      expect(text).toContain('Drop the kind filter');
    });

    it('#5b inline kind:X token in query string also gets the hint (B2)', async () => {
      // Same as #5 but the kind filter is in the query string instead
      // of the explicit arg. Without the B2 fix, this returned a bare
      // did-you-mean trail because the empty-results path only checked
      // args['kind'] — not the inline qualifier.
      const handler = new ToolHandler(cg);
      const result = await handler.execute('cartograph_find', {
        by: 'name',
        query: 'GenerateHandler kind:variable',
      });
      const text = (result.content[0] as { text?: string }).text ?? '';
      expect(text).toContain('Without the kind filter');
      expect(text).toContain('Drop the kind filter');
      // The hint must name the inline kind in the same `kind=X` shape
      // the explicit-arg path uses, so the agent's eye picks it up.
      expect(text).toContain('kind=variable');
    });

    it('#6 misspelt symbol returns "did you mean…?" with suggestions', async () => {
      const handler = new ToolHandler(cg);
      // Symbol whose name doesn't exist anywhere but is within the
      // permissive suggestion edit-distance bound (~ceil(len/3)). The
      // mirror of the original bug: `GgmlRunner` vs `GGMLRunner` — a
      // misspell the regular fuzzy fallback rejects but a relaxed
      // distance can hint at.
      const result = await handler.execute('cartograph_node', { symbol: 'GenerateHandlerX' });
      const text = (result.content[0] as { text?: string }).text ?? '';
      // If the regular fuzzy resolves, cartograph returns the real symbol;
      // if it doesn't, we should see the suggestion. Either is acceptable
      // (both lead the user to GenerateHandler).
      const resolved = text.includes('## GenerateHandler');
      const suggested = /Did you mean[\s\S]*GenerateHandler/.test(text);
      expect(resolved || suggested).toBe(true);
    });

    it('#1 cartograph_node renders indexed body + freshness warning when file modified on disk', async () => {
      const handler = new ToolHandler(cg);

      // Edit the file in place WITHOUT re-indexing. Indexed line numbers
      // now point to potentially-different code.
      const filePath = path.join(dir, 'src', 'server', 'routes.ts');
      fs.writeFileSync(filePath, '// totally different file content\nexport const X = 1;\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(filePath, future, future);

      cg.stats.invalidateFreshness();
      const result = await handler.execute('cartograph_node', {
        symbol: 'GenerateHandler',
        code: true,
      });
      const text = (result.content[0] as { text?: string }).text ?? '';
      // New contract (2026-05-14): a body fence IS emitted AND a
      // freshness warning is included. Per the actual index shape,
      // `nodes` stores line ranges (not body text), so the fence's
      // content reflects whatever now sits at those lines on disk —
      // potentially the symbol the agent expects, potentially drift.
      // The warning makes that explicit; emitting SOMETHING is still
      // strictly better than omitting the body and forcing a Read
      // fallback (which is the pre-2026-05-14 regression we closed).
      expect(text).toContain('source from indexed snapshot');
      expect(text).toContain('modified since last index');
      expect(text).toContain('line numbers below may not match');
      expect(text).toContain('cartograph admin sync');
      // Sanity: header location + signature still present.
      expect(text).toContain('GenerateHandler');
      // The fenced code block must be present (was missing pre-fix).
      expect(text).toMatch(/```[a-z]*\n[\s\S]+\n```/);
    });

    it('#1b stale-render still emits a fenced code block (not a bare text warning)', async () => {
      const handler = new ToolHandler(cg);
      const filePath = path.join(dir, 'src', 'server', 'routes.ts');
      fs.writeFileSync(filePath, '// drifted\nexport const Y = 2;\n');
      const future = Math.floor(Date.now() / 1000) + 60;
      fs.utimesSync(filePath, future, future);
      cg.stats.invalidateFreshness();

      const result = await handler.execute('cartograph_node', {
        symbol: 'GenerateHandler',
        code: true,
      });
      const text = (result.content[0] as { text?: string }).text ?? '';
      // Fenced code block must be present — the body was rendered
      // (content reflects current disk at the indexed line range; see
      // #1 above for why that's acceptable given the warning).
      expect(text).toMatch(/```[a-z]*\n[\s\S]+\n```/);
      // Warning must appear ABOVE the code fence so the agent sees
      // the staleness caveat before reading the body.
      const warnIdx = text.indexOf('source from indexed snapshot');
      const fenceIdx = text.indexOf('```');
      expect(warnIdx).toBeGreaterThan(-1);
      expect(fenceIdx).toBeGreaterThan(-1);
      expect(warnIdx).toBeLessThan(fenceIdx);
    });
  });
});
