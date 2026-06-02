import { describe, expect, it } from 'bun:test';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Cartograph } from '../src/index.js';
import { MCPServer, parseDebounceEnv } from '../src/mcp/index.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'cg-mcp-index-'));
}

function cleanup(dir: string): void {
  if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
}

async function withCapturedStderr<T>(fn: () => Promise<T>): Promise<{ value: T; stderr: string }> {
  const original = process.stderr.write.bind(process.stderr);
  let stderr = '';
  (process.stderr.write as unknown as (chunk: string | Uint8Array) => boolean) = (chunk: string | Uint8Array) => {
    stderr += chunk.toString();
    return true;
  };
  try {
    return { value: await fn(), stderr };
  } finally {
    process.stderr.write = original;
  }
}

describe('MCP server startup helpers', () => {
  it('accepts integer debounce overrides within the watcher range', () => {
    expect(parseDebounceEnv('100')).toBe(100);
    expect(parseDebounceEnv('2000')).toBe(2000);
    expect(parseDebounceEnv('60000')).toBe(60_000);
    expect(parseDebounceEnv(' 1e3 ')).toBe(1000);
  });

  it('rejects missing, fractional, non-finite, and out-of-range debounce overrides', () => {
    for (const raw of [undefined, '', ' ', '99', '60001', '-1', '2.5', 'Infinity', 'NaN', 'abc']) {
      expect(parseDebounceEnv(raw)).toBeUndefined();
    }
  });
});

describe('MCPServer default project initialization', () => {
  it('records a setup warning when no default cartograph project exists', async () => {
    const dir = tempDir();
    try {
      const server = new MCPServer({ projectPath: dir, disableStartupSync: true });
      const { stderr } = await withCapturedStderr(() => server.tryInitializeDefault(dir));

      expect(server.st.cg).toBeNull();
      expect(server.st.projectPath).toBe(dir);
      expect(server.st.noDefaultProjectPreamble).toContain('Cartograph setup warning');
      expect(stderr).toContain('server has no default project');
      server.toolHandler.closeAll();
    } finally {
      cleanup(dir);
    }
  });

  it('points at a single indexed sub-project when launched from its parent', async () => {
    const dir = tempDir();
    try {
      const child = path.join(dir, 'child');
      fs.mkdirSync(child, { recursive: true });
      fs.writeFileSync(path.join(child, 'package.json'), JSON.stringify({ name: 'child', version: '0.0.0' }));
      const cg = Cartograph.initSync(child, { config: { enableWatcher: false } });
      cg.close();

      const server = new MCPServer({ projectPath: dir, disableStartupSync: true });
      const { stderr } = await withCapturedStderr(() => server.tryInitializeDefault(dir));

      expect(server.st.cg).toBeNull();
      expect(server.st.noDefaultProjectPreamble).toContain(child);
      expect(stderr).toContain('Did you mean to use');
      server.toolHandler.closeAll();
    } finally {
      cleanup(dir);
    }
  });

  it('opens an indexed project and retries initialization after a late init', async () => {
    const dir = tempDir();
    try {
      fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ name: 'mcp-index', version: '0.0.0' }));
      const server = new MCPServer({ projectPath: dir, disableStartupSync: true });
      await withCapturedStderr(() => server.tryInitializeDefault(dir));
      expect(server.toolHandler.hasDefaultCartograph()).toBe(false);

      const cg = Cartograph.initSync(dir, { config: { enableWatcher: false } });
      cg.close();

      await withCapturedStderr(() => server.retryInitIfNeeded());
      expect(server.toolHandler.hasDefaultCartograph()).toBe(true);
      expect(server.st.cg?.projectRoot).toBe(path.resolve(dir));

      server.toolHandler.closeAll();
      server.st.cg?.close();
      server.st.cg = null;
    } finally {
      cleanup(dir);
    }
  });
});
