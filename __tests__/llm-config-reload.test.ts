/**
 * Out-of-band `.cartograph/config.json` reload (issue #14).
 *
 * A running `serve --mcp` process used to cache `config.llm` for its
 * lifetime, so a config change by a SEPARATE process (`cartograph admin
 * llm-apply`, `llm setup`, or a hand-edit) was invisible until restart —
 * MCP LLM tools kept failing with "No … provider configured". The fix:
 * `LlmConfigManager.resolveLlmConfig` watches the config file's mtime and
 * re-reads + re-resolves when it changes, while still serving the cache
 * when it hasn't.
 */

import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { LlmConfigManager } from '../src/llm/config-manager.js';
import { loadConfig } from '../src/config.js';
import type { Cartograph } from '../src/index.js';

const dirs: string[] = [];

function makeProject(model: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfgreload-'));
  dirs.push(dir);
  fs.mkdirSync(path.join(dir, '.cartograph'));
  writeConfig(dir, model);
  return dir;
}

function writeConfig(dir: string, model: string): void {
  const cfg = {
    version: 1,
    llm: { summarizeLlm: { provider: 'openai-compat', endpoint: 'http://localhost:8081', model } },
  };
  fs.writeFileSync(path.join(dir, '.cartograph', 'config.json'), JSON.stringify(cfg, null, 2));
}

function managerFor(dir: string): LlmConfigManager {
  const config = loadConfig(dir);
  const cg = { projectRoot: dir, config } as unknown as Cartograph;
  return new LlmConfigManager(cg);
}

describe('LlmConfigManager — out-of-band config.json reload (issue #14)', () => {
  afterEach(() => {
    for (const d of dirs) {
      try {
        fs.rmSync(d, { recursive: true, force: true });
      } catch {
        // best-effort cleanup
      }
    }
    dirs.length = 0;
  });

  it('re-resolves when config.json changes on disk between resolves (no forceReload)', async () => {
    const dir = makeProject('/models/a.gguf');
    const mgr = managerFor(dir);

    const first = await mgr.resolveLlmConfig();
    expect(first?.summarizeLlm?.model).toBe('/models/a.gguf');

    // Simulate a separate process editing the config (CLI llm-apply / hand-edit).
    // Bump mtime explicitly so the change is detectable even within the same ms.
    writeConfig(dir, '/models/b.gguf');
    const future = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, '.cartograph', 'config.json'), future, future);

    const second = await mgr.resolveLlmConfig();
    expect(second?.summarizeLlm?.model).toBe('/models/b.gguf');
  });

  it('serves the cached resolution when config.json is unchanged', async () => {
    const dir = makeProject('/models/a.gguf');
    const mgr = managerFor(dir);

    const first = await mgr.resolveLlmConfig();
    // Mutate the in-memory config WITHOUT touching the file — the mtime is
    // unchanged, so the cached resolution must still win (proves it isn't
    // re-reading + re-resolving on every call).
    (first as unknown as { _ignore?: boolean })._ignore = true; // keep `first` referenced
    const second = await mgr.resolveLlmConfig();
    expect(second?.summarizeLlm?.model).toBe('/models/a.gguf');
    expect(second).toBe(first); // same cached object instance
  });

  it('keeps the last-good resolution when a changed config fails to load, then retries once valid', async () => {
    const dir = makeProject('/models/a.gguf');
    const mgr = managerFor(dir);
    expect((await mgr.resolveLlmConfig())?.summarizeLlm?.model).toBe('/models/a.gguf');

    // Half-written / corrupt save: loadConfig throws. mtime changed.
    fs.writeFileSync(path.join(dir, '.cartograph', 'config.json'), '{ not valid json');
    const t1 = new Date(Date.now() + 2000);
    fs.utimesSync(path.join(dir, '.cartograph', 'config.json'), t1, t1);
    // Must NOT get stuck on a cleared cache / stale config — keep last-good.
    expect((await mgr.resolveLlmConfig())?.summarizeLlm?.model).toBe('/models/a.gguf');

    // Once the file is valid again, the next resolve picks it up (the failed
    // reload did not advance the mtime baseline, so the change is still seen).
    writeConfig(dir, '/models/c.gguf');
    const t2 = new Date(Date.now() + 4000);
    fs.utimesSync(path.join(dir, '.cartograph', 'config.json'), t2, t2);
    expect((await mgr.resolveLlmConfig())?.summarizeLlm?.model).toBe('/models/c.gguf');
  });

  it('does not throw when config.json is missing (pre-init)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cg-cfgreload-'));
    dirs.push(dir);
    fs.mkdirSync(path.join(dir, '.cartograph'));
    // No config.json on disk — configFileMtimeMs returns undefined.
    const cg = { projectRoot: dir, config: { version: 1 } } as unknown as Cartograph;
    const mgr = new LlmConfigManager(cg);
    expect(await mgr.resolveLlmConfig()).toBeNull(); // no llm configured, no crash
  });
});
