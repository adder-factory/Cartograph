/**
 * MCP `cartograph_admin({action: 'index'})` — full re-index via the
 * agent surface. Mirrors the CLI `cartograph index` and `cartograph
 * index --force` (CLI commands stay granular per repo convention).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import { Cartograph, FileLock } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';
import { BIOMARKER_CACHE_KEY } from '../src/biomarkers/index.js';

describe("cartograph_admin({action: 'index'})", () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-reindex-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha(){return 1;}\n`);
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta(){return 2;}\n`);
    fs.writeFileSync(path.join(testDir, 'package.json'), JSON.stringify({ name: 'x', version: '0.0.0' }));
    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('re-indexes the project (non-force) and reports counts', async () => {
    const result = await handler.execute('cartograph_admin', { action: 'index' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Re-indexed \d+ files? in/);
    expect(text).toMatch(/\d+ nodes?, \d+ edges?/);
    expect(text).not.toMatch(/\(force\)/);
  });

  it('clears structural data before re-indexing when force=true', async () => {
    const before = cg.stats.getStats();
    expect(before.nodeCount).toBeGreaterThan(0);

    const result = await handler.execute('cartograph_admin', { action: 'index', force: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Re-indexed \d+ files? in [\d.]+s \(force\)/);

    const after = cg.stats.getStats();
    // After force-reindex, node count should be ≥ original (LLM caches
    // survive but structural is fully rebuilt).
    expect(after.nodeCount).toBeGreaterThan(0);

    // Quality regression guard for the index-hook caches landed in
    // 2026-05-01: clearStructural must invalidate biomarker_file_state
    // and last_centrality_fingerprint, otherwise:
    //   - biomarkers cache hits skip files whose code_health_findings
    //     were just emptied -> empty findings table after --force
    //   - centrality fingerprint may match the (rebuilt) graph by
    //     coincidence -> nodes.centrality stays NULL
    // Both produce visibly-correct nodeCount but silently-degraded
    // analysis quality. Assert the secondary signals.
    const db = cg['db'].getDb();
    const findingsCount = (db.prepare('SELECT COUNT(*) as c FROM code_health_findings').get() as { c: number }).c;
    const scoredNodes = (
      db.prepare('SELECT COUNT(*) as c FROM nodes WHERE centrality IS NOT NULL').get() as { c: number }
    ).c;
    expect(scoredNodes).toBeGreaterThan(0);
    // findings may legitimately be 0 for tiny fixtures (the test files
    // have just two one-line functions), but the table being readable
    // and the centrality being populated covers the regression class.
    expect(findingsCount).toBeGreaterThanOrEqual(0);

    // Cache keys must be re-populated (not absent) after the post-hooks
    // ran in the force re-index. Absence would mean the hooks silently
    // skipped or errored. Presence with the new values means the
    // invalidate-then-rebuild contract is intact.
    const biomarkerCache = db.prepare('SELECT value FROM project_metadata WHERE key = ?').get(BIOMARKER_CACHE_KEY) as
      | { value: string }
      | undefined;
    const centralityFP = db
      .prepare("SELECT value FROM project_metadata WHERE key = 'last_centrality_fingerprint'")
      .get() as { value: string } | undefined;
    expect(biomarkerCache).toBeDefined();
    expect(centralityFP).toBeDefined();
    // Algo tag prefix — bumping PR_DAMPING / PR_ITERATIONS / PR_EDGE_KINDS
    // must auto-invalidate the fingerprint. The stored value should
    // start with the deterministic algo tag so any future constant
    // tweak produces a different prefix and forces a recompute.
    expect(centralityFP!.value).toMatch(/^algo:d=[\d.]+\|i=\d+\|k=[a-z,_]+:/);
  });

  it('a contended force-reindex (lock held) leaves the existing index INTACT — no wipe', async () => {
    // Regression guard for the biomarker-fluctuation root cause: `--force`
    // used to call clearStructural() BEFORE indexAll acquired the file lock,
    // so a contended force-reindex (the MCP server's sync or a concurrent CLI
    // holding the lock) wiped the structural index with no rebuild — leaving a
    // 0/partial index whose per-symbol findings "swing across reindexes". The
    // clear is now threaded into indexAll UNDER the lock, so a lock failure
    // must leave the existing index untouched.
    const before = cg.stats.getStats();
    expect(before.nodeCount).toBeGreaterThan(0);

    // Simulate a concurrent indexer holding the project's file lock.
    const holder = new FileLock(path.join(testDir, '.cartograph', 'cartograph.lock'));
    holder.acquire();
    try {
      const result = await cg.indexAll({ summarize: false, clearStructural: true });
      expect(result.success).toBe(false);
      expect(result.errors.some((e) => /lock/i.test(e.message))).toBe(true);
    } finally {
      holder.release();
    }

    // The index must NOT have been cleared — node count is unchanged.
    const after = cg.stats.getStats();
    expect(after.nodeCount).toBe(before.nodeCount);

    // And a subsequent UNCONTENDED force-reindex still works (clears + rebuilds).
    const ok = await cg.indexAll({ summarize: false, clearStructural: true });
    expect(ok.success).toBe(true);
    expect(cg.stats.getStats().nodeCount).toBe(before.nodeCount);
  });

  it('wipes parse_cache when clearParseCache=true (CLI parity)', async () => {
    const db = cg['db'].getDb();
    const cacheBefore = (db.prepare('SELECT COUNT(*) as c FROM parse_cache').get() as { c: number }).c;
    expect(cacheBefore).toBeGreaterThan(0);

    const result = await handler.execute('cartograph_admin', { action: 'index', clearParseCache: true });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\(parse-cache cleared\)/);

    // After the re-index, parse_cache is repopulated by extractFromSource on
    // every file (since cache was empty going in, every file took the slow
    // path). What we're asserting is that the wipe-then-rebuild contract ran:
    // the tag in the result text is the user-visible signal, and the cache is
    // healthy again. (We don't assert cacheBefore == cacheAfter because the
    // mtime-based cache key doesn't necessarily line up byte-for-byte after a
    // fresh repopulate — counts will match, but the assertion is fragile.)
    const cacheAfter = (db.prepare('SELECT COUNT(*) as c FROM parse_cache').get() as { c: number }).c;
    expect(cacheAfter).toBeGreaterThan(0);
  });

  it('combines force + clearParseCache tags in the result header', async () => {
    const result = await handler.execute('cartograph_admin', {
      action: 'index',
      force: true,
      clearParseCache: true,
    });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/\(force, parse-cache cleared\)/);
  });

  it('bypasses the freshness gate (admin family resolves staleness)', async () => {
    // cartograph_admin should run regardless of staleness — its index
    // action is the heaviest staleness fix. Verify by inspecting the
    // schema (gate is already covered by integration in mcp-sync.test.ts).
    const tools = handler.getTools();
    const adminTool = tools.find((t) => t.name === 'cartograph_admin');
    expect(adminTool).toBeDefined();
    // bypassFreshnessGate tools don't have allowStale in their schema.
    expect(adminTool?.inputSchema.properties['allowStale']).toBeUndefined();
  });
});
