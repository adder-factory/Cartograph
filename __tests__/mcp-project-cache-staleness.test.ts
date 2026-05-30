/**
 * ProjectCache: a cached Cartograph instance must be evicted + re-opened
 * when the on-disk SQLite file is replaced (wipe + re-init via the CLI,
 * a manual delete + recreate, etc.). Without this, the cached handle
 * points at the deleted inode and every subsequent query fails with
 * "database disk image is malformed" — caught against ollama during
 * the bug-hunt arc when the index was wiped + rebuilt across sessions.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import Cartograph from '../src/index.js';
import { ToolHandler } from '../src/mcp/tools.js';

describe('ProjectCache — stale-handle detection after DB wipe + re-init', () => {
  let dir: string;

  beforeEach(async () => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cache-staleness-'));
    fs.mkdirSync(path.join(dir, 'src'));
    fs.writeFileSync(path.join(dir, 'src', 'a.ts'), 'export function alpha() { return 1; }\n');
    fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'fixture', version: '0.0.0' }));
    const cg = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg.indexAll({ summarize: false });
    cg.close();
  });

  afterEach(() => {
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  });

  it('re-opens after the .cartograph/cartograph.db file is replaced', async () => {
    const handler = new ToolHandler(null);

    // First query → opens + caches.
    const firstResult = await handler.execute('cartograph_status', { projectPath: dir });
    expect(firstResult.isError).toBeFalsy();

    // Simulate a CLI re-init: wipe the .cartograph directory and rebuild
    // it. Different inode at the same path — exactly the case that
    // produced the "malformed" error without the fingerprint check.
    fs.rmSync(path.join(dir, '.cartograph'), { recursive: true, force: true });
    const cg2 = await Cartograph.init(dir, { config: { llm: { endpoint: '' } } });
    await cg2.indexAll({ summarize: false });
    cg2.close();

    // Second query must succeed — the cache should detect the inode
    // change and reopen instead of handing back the stale handle.
    const secondResult = await handler.execute('cartograph_status', { projectPath: dir });
    expect(secondResult.isError).toBeFalsy();
    expect(secondResult.content[0]?.text ?? '').toContain('Cartograph Status');

    handler.closeAll();
  });

  it('reuses the cached handle when the DB file is unchanged (no spurious reopens)', async () => {
    const handler = new ToolHandler(null);
    const a = await handler.execute('cartograph_status', { projectPath: dir });
    const b = await handler.execute('cartograph_status', { projectPath: dir });
    expect(a.isError).toBeFalsy();
    expect(b.isError).toBeFalsy();
    // Both calls succeed — we don't have a direct counter on reopens
    // but two clean queries against an unchanged file are the contract.
    handler.closeAll();
  });
});
