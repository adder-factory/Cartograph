/**
 * Regression tests for the daemon-default PR review (P1 #2 + #3).
 *
 *  - policyFingerprint must distinguish differing tool policies so clients with
 *    different --profile / --no-write-tools / --disable-tool do NOT share a
 *    daemon (whose single ToolHandler reflects the first client).
 *  - tryInitializeDefault must reuse an already-open project so the daemon
 *    (which fans many `initialize`s through one server) does not leak a second
 *    Cartograph + watcher per client attach.
 */
import { describe, it, expect, afterEach } from 'vitest';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { MCPServer } from '../src/mcp/index.js';
import { policyFingerprint } from '../src/mcp/daemon.js';
import Cartograph from '../src/index.js';

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe('policyFingerprint (P1 #2 — no cross-policy daemon sharing)', () => {
  it('is stable for equal policies and differs for any tool-surface change', () => {
    const base = policyFingerprint({});
    expect(policyFingerprint({})).toBe(base);

    expect(policyFingerprint({ profile: 'full' })).not.toBe(base);
    expect(policyFingerprint({ disableWriteTools: true })).not.toBe(base);
    expect(policyFingerprint({ disabledTools: new Set(['cartograph_ask']) })).not.toBe(base);
    expect(policyFingerprint({ allowStaleDefault: true })).not.toBe(base);
    expect(policyFingerprint({ lowTokensDefault: true })).not.toBe(base);

    // Disabled-tool set is order-insensitive.
    expect(policyFingerprint({ disabledTools: new Set(['a', 'b']) })).toBe(
      policyFingerprint({ disabledTools: new Set(['b', 'a']) }),
    );
    // disableStartupSync is a sync-timing knob, not a tool-surface change.
    expect(policyFingerprint({ disableStartupSync: true })).toBe(base);
  });
});

describe('MCPServer.tryInitializeDefault (P1 #3 — no re-open leak)', () => {
  it('reuses the open Cartograph when re-initialized for the same project root', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'cg-daemon-reuse-'));
    dirs.push(dir);
    const seed = await Cartograph.init(dir, { index: false });
    seed.close(); // the server opens its own handle below

    const server = new MCPServer({ disableStartupSync: true });
    try {
      await server.tryInitializeDefault(dir);
      const first = server.st.cg;
      expect(first).not.toBeNull();

      await server.tryInitializeDefault(dir); // a second client's initialize
      // Same instance — not re-opened (which would leak the prior connection +
      // watcher and create a second writer).
      expect(server.st.cg).toBe(first);
    } finally {
      server.toolHandler.closeAll();
      server.st.cg?.close();
    }
  });
});
