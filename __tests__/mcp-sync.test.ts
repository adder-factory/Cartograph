/**
 * MCP `cartograph_admin({action: 'sync'})` — incremental index update
 * via the agent surface. Verifies (a) the gate-bypass works (sync
 * runs even when the index is so stale that other tools would
 * block), (b) the sync result is reflected in subsequent freshness
 * reads.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Cartograph } from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf-8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
}

describe("cartograph_admin({action: 'sync'})", () => {
  let testDir: string;
  let cg: Cartograph;
  let handler: ToolHandler;

  beforeEach(async () => {
    testDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-sync-'));
    fs.mkdirSync(path.join(testDir, 'src'));
    fs.writeFileSync(path.join(testDir, 'src', 'a.ts'), `export function alpha(){return 1;}\n`);
    fs.writeFileSync(path.join(testDir, '.gitignore'), '.cartograph/\n');
    git(testDir, 'init', '-q');
    git(testDir, 'config', 'user.email', 't@t');
    git(testDir, 'config', 'user.name', 't');
    git(testDir, 'config', 'commit.gpgsign', 'false');
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'initial');

    cg = await Cartograph.init(testDir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    handler = new ToolHandler(cg);
  });

  afterEach(() => {
    handler?.closeAll();
    if (cg) cg.close();
    if (fs.existsSync(testDir)) fs.rmSync(testDir, { recursive: true, force: true });
  });

  it('reports no-op when the index is already in sync', async () => {
    const result = await handler.execute('cartograph_admin', { action: 'sync' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/Scanned \d+ file/);
    expect(text).toMatch(/already in sync|No changes/i);
  });

  it('picks up new files and surfaces them in the summary', async () => {
    fs.writeFileSync(path.join(testDir, 'src', 'b.ts'), `export function beta(){return 2;}\n`);
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'add b');

    const result = await handler.execute('cartograph_admin', { action: 'sync' });
    const text = result.content[0]?.text ?? '';
    expect(text).toMatch(/added|modified/);
  });

  it('bypasses the freshness hard-block (sync resolves staleness)', async () => {
    // Force heavy drift — enough that other tools would hard-block.
    for (let i = 0; i < 250; i++) {
      fs.writeFileSync(path.join(testDir, 'src', `g${i}.ts`), `export const v${i}=${i};\n`);
    }
    git(testDir, 'add', '.');
    git(testDir, 'commit', '-q', '-m', 'massive drift');

    // Confirm a regular tool IS blocked.
    const blocked = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    expect(blocked.content[0]?.text ?? '').toMatch(/too stale to safely query/i);

    // The sync action should NOT be blocked even at this drift level.
    const result = await handler.execute('cartograph_admin', { action: 'sync' });
    const text = result.content[0]?.text ?? '';
    expect(text).not.toMatch(/too stale to safely query/i);
    expect(text).toMatch(/Scanned \d+ file/);

    // After sync, the previously-blocked search should succeed.
    const after = await handler.execute('cartograph_find', { by: 'name', query: 'alpha' });
    expect(after.content[0]?.text ?? '').not.toMatch(/too stale to safely query/i);
  });
});
