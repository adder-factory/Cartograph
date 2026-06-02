/**
 * Tests for the explicit-project file-watcher fix (auto-incremental
 * staleness fix, 2026-05-03). Without this, an MCP server queried
 * via `projectPath` for a project that wasn't its default would
 * never start a watcher on that project — the index froze at open
 * time and only the (heuristic, small-drift-only) freshness gate's
 * auto-sync could catch up.
 *
 * After the fix, `ToolHandler.getCartograph(projectPath)` calls
 * `cg.watcher.start(...)` for newly-cached projects, soft-capped
 * at 16 simultaneously-watched roots to bound fs.watch quota.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe('explicit-project watcher (auto-incremental fix)', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cross-watch-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(dir, '.gitignore'), '.cartograph/\n');
    git(dir, 'init', '-q');
    git(dir, 'config', 'user.email', 't@t');
    git(dir, 'config', 'user.name', 't');
    git(dir, 'config', 'commit.gpgsign', 'false');
    git(dir, 'add', '.');
    git(dir, 'commit', '-q', '-m', 'init');
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('starts a file watcher when a project is loaded via projectPath', async () => {
    // ToolHandler with NO default cg — every query must go through
    // the explicit-project getCartograph(projectPath) path.
    const handler = new ToolHandler(null);
    // First query opens the project + caches it + (NEW) starts the watcher.
    const result = await handler.execute('cartograph_status', { projectPath: dir });
    expect(result.isError).toBeFalsy();
    expect(result.content[0]?.text ?? '').toContain('Cartograph Status');

    // Verify the watcher is recorded — accessing the private set is
    // OK in tests (vitest doesn't enforce private). Without the fix
    // this would be an empty set.
    const { watchedRoots } = handler.getProjectCacheSnapshot();
    expect(watchedRoots.length).toBe(1);

    handler.closeAll();
  });

  it('does not double-start the watcher when the same project is re-queried', async () => {
    const handler = new ToolHandler(null);
    await handler.execute('cartograph_status', { projectPath: dir });
    await handler.execute('cartograph_status', { projectPath: dir });
    await handler.execute('cartograph_status', { projectPath: dir });
    const { watchedRoots } = handler.getProjectCacheSnapshot();
    expect(watchedRoots.length).toBe(1); // dedup by resolved root
    handler.closeAll();
  });

  // Note: the soft-cap (MAX_WATCHED_PROJECTS = 16) and watcher
  // failure-tolerance are exercised in the production code's unit
  // tests; covering them via filesystem fixtures (16+ separate
  // cartograph projects) is overkill for what is fundamentally a
  // size-bounded Set guard.
});

describe('LRU eviction (10K-project parent-dir scenario)', () => {
  let parentDir: string;
  const PROJECT_COUNT = 18; // exceeds MAX_CACHED_PROJECTS=16 by 2

  beforeEach(async () => {
    parentDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-lru-'));
    // Build PROJECT_COUNT minimal cartograph projects.
    for (let i = 0; i < PROJECT_COUNT; i++) {
      const sub = path.join(parentDir, `p${i}`);
      fs.mkdirSync(path.join(sub, 'src'), { recursive: true });
      fs.writeFileSync(path.join(sub, 'src', 'a.ts'), `export function f${i}() { return ${i}; }\n`);
      fs.writeFileSync(path.join(sub, '.gitignore'), '.cartograph/\n');
      git(sub, 'init', '-q');
      git(sub, 'config', 'user.email', 't@t');
      git(sub, 'config', 'user.name', 't');
      git(sub, 'config', 'commit.gpgsign', 'false');
      git(sub, 'add', '.');
      git(sub, 'commit', '-q', '-m', 'init');
      const cg = await Cartograph.init(sub, { config: { llm: { endpoint: '' } } });
      await cg.indexAll({ summarize: false });
      cg.close();
    }
  });

  afterEach(() => {
    if (fs.existsSync(parentDir)) fs.rmSync(parentDir, { recursive: true, force: true });
  });

  it("doesn't crash + caps the cache at MAX_CACHED_PROJECTS when N > cap", async () => {
    const handler = new ToolHandler(null);
    // Query every project sequentially. Without LRU eviction, all 18
    // CG instances would stay open (18 SQLite handles, 18 watchers).
    for (let i = 0; i < PROJECT_COUNT; i++) {
      const result = await handler.execute('cartograph_status', {
        projectPath: path.join(parentDir, `p${i}`),
      });
      expect(result.isError).toBeFalsy();
    }
    const { cachedRoots, watchedRoots } = handler.getProjectCacheSnapshot();
    expect(cachedRoots.length).toBeLessThanOrEqual(16);
    expect(watchedRoots.length).toBeLessThanOrEqual(16);
    handler.closeAll();
  });

  it('most-recently-used project survives eviction', async () => {
    const handler = new ToolHandler(null);
    // Open p0 first, then 17 others. p0 should evict.
    await handler.execute('cartograph_status', { projectPath: path.join(parentDir, 'p0') });
    for (let i = 1; i < PROJECT_COUNT; i++) {
      await handler.execute('cartograph_status', { projectPath: path.join(parentDir, `p${i}`) });
    }
    const { cachedRoots } = handler.getProjectCacheSnapshot();
    // p0 evicted; the most recent 16 (p2..p17) should be in the cache.
    const roots = [...cachedRoots];
    expect(roots.some((r) => r.endsWith('/p0'))).toBe(false);
    expect(roots.some((r) => r.endsWith(`/p${PROJECT_COUNT - 1}`))).toBe(true);
    handler.closeAll();
  });
});
