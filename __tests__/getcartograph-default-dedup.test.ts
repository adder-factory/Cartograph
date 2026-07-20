/**
 * Regression test for the default-CG vs same-root cache dedup.
 *
 * `ToolHandler.getCartograph(projectPath)` used to delegate UNCONDITIONALLY to
 * the explicit-project cache, so a tool call whose `projectPath` resolved to the
 * default project's own root opened a SECOND Cartograph on the same `.cartograph/`
 * — a second in-process writer + watcher that the per-CG mutexes cannot
 * serialize. The fix dedups any alias/subdir of the default root back to the
 * default CG. A genuinely different project still routes to the cache.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPServer } from '../src/mcp/index.js';
import { waitForProjectCacheWatcherStops } from '../src/mcp/tools/_project-cache.js';
import Cartograph from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe('getCartograph — default-CG vs same-root cache dedup', () => {
  it('reuses the default CG for its own root and subdirs (no second instance)', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-dedup-'));
    dirs.push(dir);
    (await Cartograph.init(dir, { index: false })).close();

    const server = new MCPServer({ disableStartupSync: true });
    try {
      await server.tryInitializeDefault(dir);
      const def = server.st.cg;
      if (!def) throw new Error('expected an open default Cartograph');

      // Explicit projectPath == default root → the SAME instance.
      expect(server.toolHandler.getCartograph(dir)).toBe(def);

      // A subdir of the default project also dedups to the default CG.
      const sub = join(dir, 'src', 'nested');
      mkdirSync(sub, { recursive: true });
      expect(server.toolHandler.getCartograph(sub)).toBe(def);

      // The cache stayed empty — no second instance/watcher was ever opened.
      expect(server.toolHandler.getProjectCacheSnapshot().cachedRoots).toHaveLength(0);
    } finally {
      await server.st.cg?.watcher.stopAndWait();
      server.toolHandler.closeAll();
      await waitForProjectCacheWatcherStops();
      server.st.cg?.close();
    }
  });

  it('still routes a genuinely different project to the cache as a separate instance', async () => {
    const dirA = mkdtempSync(join(tmpdir(), 'cg-dedupA-'));
    const dirB = mkdtempSync(join(tmpdir(), 'cg-dedupB-'));
    dirs.push(dirA, dirB);
    for (const d of [dirA, dirB]) (await Cartograph.init(d, { index: false })).close();

    const server = new MCPServer({ disableStartupSync: true });
    try {
      await server.tryInitializeDefault(dirA);
      const def = server.st.cg;
      const other = server.toolHandler.getCartograph(dirB);
      expect(other).not.toBe(def);
      // B is held by the cache; A (the default) is not.
      expect(server.toolHandler.getProjectCacheSnapshot().cachedRoots).toHaveLength(1);
    } finally {
      await server.st.cg?.watcher.stopAndWait();
      server.toolHandler.closeAll();
      await waitForProjectCacheWatcherStops();
      server.st.cg?.close();
    }
  });
});
