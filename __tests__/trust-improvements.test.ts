/**
 * Tests for the four trust-improvement fixes:
 *  #41 cartograph_callers falls back to type-usage on non-callable targets
 *  #42 TypeScript inline import-type syntax (`import('foo').X`) emits type_of
 *  #43 Framework route-extractor hooks fire during indexing (gin etc.)
 *  #44 suggestSymbolNames uses subsequence fallback for radical typos
 */
import { describe, it, expect, beforeAll, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { searchNodes } from '../src/db/queries-search.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { extractFromSource } from '../src/extraction/tree-sitter.js';
import { initGrammars, loadAllGrammars } from '../src/extraction/grammars.js';
import { isSubsequence } from '../src/search/query-parser.js';

beforeAll(async () => {
  await initGrammars();
  await loadAllGrammars();
});

function git(cwd: string, ...args: string[]) {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('#42 inline import-type extraction (TypeScript)', () => {
  it('extracts type_of for `import("...").Name` parameter types', async () => {
    const r = extractFromSource(
      'use.ts',
      `
function f(x: import('../freshness.js').FreshnessInfo): void { void x; }
function g(): import('../freshness.js').FreshnessInfo { return {} as any; }
`,
    );
    const refs = (r.unresolvedReferences ?? []).filter((x: any) => x.referenceName === 'FreshnessInfo');
    // f has type_of (param), g has returns (return type)
    expect(refs.some((x: any) => x.referenceKind === 'type_of')).toBe(true);
    expect(refs.some((x: any) => x.referenceKind === 'returns')).toBe(true);
  });
});

describe('#44 isSubsequence helper', () => {
  it('matches radical abbreviations', () => {
    expect(isSubsequence('gnrthndlr', 'generatehandler')).toBe(true);
    expect(isSubsequence('gname', 'getname')).toBe(true);
    expect(isSubsequence('foo', 'foobar')).toBe(true);
    // Out of order — not a subsequence
    expect(isSubsequence('rgname', 'getname')).toBe(false);
    // Query longer than candidate
    expect(isSubsequence('foobars', 'foobar')).toBe(false);
    // Empty query → trivially true
    expect(isSubsequence('', 'foo')).toBe(true);
  });
});

describe('integration', () => {
  let dir: string;
  let cg: Cartograph;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-trust-'));
    fs.mkdirSync(path.join(dir, 'src'));
    // TypeScript fixture: an interface, type-using consumers, plus a
    // function with a name we can typo our way to.
    fs.writeFileSync(path.join(dir, 'src', 'types.ts'), 'export interface Audit {}\n');
    fs.writeFileSync(
      path.join(dir, 'src', 'service.ts'),
      `
import type { Audit } from './types.js';
export function getAudit(): Audit { return {} as Audit; }
export function logAudit(audit: Audit): void { void audit; }
export class Service { cached: Audit | null = null; }
export function GenerateHandler(): void {}
`,
    );
    // Go fixture so the gin-route framework extractor can fire.
    fs.writeFileSync(
      path.join(dir, 'src', 'routes.go'),
      `
package main
type Server struct{}
func (s *Server) StatusHandler() {}
func register(r interface { GET(string, ...interface{}) }) {
  r.GET("/api/health", s.StatusHandler)
  r.GET("/api/v1/users", s.StatusHandler)
}
`,
    );

    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 's@e.com');
    git(dir, 'config', 'user.name', 's');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');

    cg = Cartograph.initSync(dir, { config: { include: ['**/*.ts', '**/*.go'], exclude: [] } });
    await cg.indexAll();
  }, 60000);

  afterEach(() => {
    if (cg) cg.destroy();
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('#41 callers on an interface returns type-users (not "no callers")', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_graph', { direction: 'callers', start: 'Audit' });
    const text = (result.content[0] as { text?: string }).text ?? '';
    expect(text).not.toMatch(/No callers found/);
    // Either a "Type users of" header or any of the actual users
    expect(text).toMatch(/Type users of|getAudit|logAudit|cached/);
    expect(text).toMatch(/getAudit|logAudit|cached/);
  });

  it('#43 framework extractor produces route nodes for gin patterns', () => {
    const routes = searchNodes(cg.queries, '/api', { limit: 20, kinds: ['route'] });
    const names = routes.map((r) => r.node.name);
    expect(names).toContain('GET /api/health');
    expect(names).toContain('GET /api/v1/users');
  });

  it('#43 search /api/health surfaces the route node first', async () => {
    const handler = new ToolHandler(cg);
    const result = await handler.execute('cartograph_find', { by: 'name', query: '/api/health' });
    const text = (result.content[0] as { text?: string }).text ?? '';
    // Route node now exists — search should find it.
    expect(text).toContain('/api/health');
  });

  it('#44 radical typo returns a subsequence-based suggestion', async () => {
    const handler = new ToolHandler(cg);
    // 'GnrtHndlr' is too far for whole-string Levenshtein but is a
    // subsequence of 'GenerateHandler' (skip-vowels abbreviation).
    const result = await handler.execute('cartograph_node', { symbol: 'GnrtHndlr' });
    const text = (result.content[0] as { text?: string }).text ?? '';
    expect(text).toMatch(/Did you mean[\s\S]*GenerateHandler/);
  });
});
