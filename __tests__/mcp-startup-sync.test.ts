/**
 * MCP server startup catch-up sync (B1).
 *
 * The watcher only fires on LIVE filesystem events, so without this
 * helper any drift accumulated while the server was down stays in
 * the index until manual `admin sync`. The helper runs one
 * incremental sync between `open` and `startWatching` to close that
 * gap.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { Cartograph } from '../src/index.js';
import { runStartupSync } from '../src/mcp/startup-sync.js';

describe('runStartupSync (B1)', () => {
  let tempDir: string;
  let cg: Cartograph;
  let logged: string[];

  beforeEach(async () => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-startup-sync-'));
    fs.mkdirSync(path.join(tempDir, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'src/initial.ts'), 'export function alpha() {}\n');
    cg = await Cartograph.init(tempDir, { index: true });
    logged = [];
  });

  afterEach(() => {
    try {
      if (cg) cg.close();
    } catch {
      /* tolerate double-close in error cases */
    }
    if (fs.existsSync(tempDir)) fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('catches up on files added while the index was idle', async () => {
    const before = cg.stats.getStats().fileCount;
    fs.writeFileSync(path.join(tempDir, 'src/added.ts'), 'export function added() {}\n');

    await runStartupSync(cg, { log: (m) => logged.push(m) });

    const after = cg.stats.getStats().fileCount;
    expect(after).toBe(before + 1);
    // Stderr line surfaces the catch-up so the operator can see what happened.
    expect(logged.join('')).toMatch(/Startup sync caught up 1 file/);
    expect(logged.join('')).toMatch(/\+1 ~0 -0/);
  });

  it('catches up on files modified while the index was idle', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/initial.ts'), 'export function alpha() {}\nexport function beta() {}\n');

    await runStartupSync(cg, { log: (m) => logged.push(m) });

    expect(logged.join('')).toMatch(/~1/);
  });

  it('emits no log line when nothing has drifted', async () => {
    await runStartupSync(cg, { log: (m) => logged.push(m) });
    expect(logged).toEqual([]);
  });

  it('skips entirely when disabled=true (op-out via --no-startup-sync)', async () => {
    fs.writeFileSync(path.join(tempDir, 'src/added.ts'), 'export function added() {}\n');
    const before = cg.stats.getStats().fileCount;

    await runStartupSync(cg, { disabled: true, log: (m) => logged.push(m) });

    // No sync ran → file count unchanged → no log line.
    expect(cg.stats.getStats().fileCount).toBe(before);
    expect(logged).toEqual([]);
  });

  it('survives a sync error without throwing', async () => {
    // Inject a failing sync by stubbing on the instance.
    const original = cg.sync.bind(cg);
    (cg as unknown as { sync: () => Promise<unknown> }).sync = async () => {
      throw new Error('forced failure for test');
    };
    await expect(runStartupSync(cg, { log: (m) => logged.push(m) })).resolves.toBeUndefined();
    expect(logged.join('')).toMatch(/Startup sync error: forced failure for test/);
    (cg as unknown as { sync: typeof original }).sync = original;
  });

  it('reports lock contention without trying to wait', async () => {
    const original = cg.sync.bind(cg);
    (cg as unknown as { sync: () => Promise<unknown> }).sync = async () => ({
      filesChecked: 0,
      filesAdded: 0,
      filesModified: 0,
      filesRemoved: 0,
      nodesUpdated: 0,
      durationMs: 0,
      lockContention: true,
    });
    await runStartupSync(cg, { log: (m) => logged.push(m) });
    expect(logged.join('')).toMatch(/Startup sync skipped \(another process holds the index lock\)/);
    (cg as unknown as { sync: typeof original }).sync = original;
  });
});
