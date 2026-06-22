/**
 * Tooling-gaps item #2 (was item #5 in the doc): `--allow-stale` /
 * `allowStale: true` flag opts into querying a stale index.
 *
 * Today: when freshness drift exceeds the hard-block threshold,
 * tools.ts wraps every call in a pre-flight that returns an error
 * "Index too stale to safely query". Useful default. But during a
 * rapid refactor session the user-agent KNOWS the index is stale and
 * just wants to query the cached view anyway. There is no opt-in.
 *
 * Expected: each tool's input schema accepts an optional
 * `allowStale: boolean`. When true, the pre-flight gate is suppressed
 * and the tool runs against the stale index. The freshness banner
 * should still appear in metadata so the agent sees the warning, just
 * not be hard-blocked.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler, type ToolResult } from '../src/mcp/tools.js';
import type { FreshnessMetadata } from '../src/mcp/tool-types.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

function requireFreshness(result: ToolResult): FreshnessMetadata {
  const freshness = result.metadata?.freshness;
  if (!freshness) throw new Error('expected freshness metadata');
  return freshness;
}

describe('Tooling-gaps #2: --allow-stale opt-in', () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-allowstale-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function a(){return 1;}\n`);
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'init');

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });

    // Induce hard-block-level staleness: 200+ new files post-index.
    for (let i = 0; i < 250; i++) {
      fs.writeFileSync(path.join(testDir, 'src', `g${i}.ts`), `export const x${i}=${i};\n`);
    }
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'massive drift');

    handler = new ToolHandler(cg, { profile: 'full' });
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('hard-blocks by default when index is very stale', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'a' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/too stale|stale to safely query/i);
  });

  it('runs the tool when allowStale: true is passed', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'a', allowStale: true });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/too stale to safely query/i);
    // Should return a real result against the cached index.
    expect(text.length).toBeGreaterThan(0);
  });

  it('still surfaces freshness metadata when allowStale bypasses the gate', async () => {
    const result = await handler.execute('cartograph_find', { by: 'name', query: 'a', allowStale: true });
    // Discriminator: when allowStale is honored, the metadata exists,
    // isStale is true, but `blocked` must NOT be set (the call was
    // dispatched, not refused). The pre-flight error path also attaches
    // freshness metadata, so isStale alone is not enough.
    const freshness = requireFreshness(result);
    expect(freshness.isStale).toBe(true);
    expect(freshness.severity).toBe('very_stale');
    expect(freshness.recommendedAction).toBe('sync_required');
    expect(freshness.contentDriftedFiles).toBe(null);
    expect(freshness.blocked).not.toBe(true);
    expect(result.isError).not.toBe(true);
  });

  it('fresh-required tools block any stale result unless allowStale is explicit', async () => {
    const blocked = await handler.execute('cartograph_dead_code', { via: 'rule' });
    const blockedText = blocked.content[0]?.text ?? '';
    expect(blockedText).toMatch(/requires a fresh index/i);
    expect(requireFreshness(blocked).blocked).toBe(true);

    const bypassed = await handler.execute('cartograph_dead_code', { via: 'rule', allowStale: true });
    const bypassedText = bypassed.content[0]?.text ?? '';
    expect(bypassedText).not.toMatch(/requires a fresh index/i);
    expect(requireFreshness(bypassed).blocked).not.toBe(true);
  });
});
