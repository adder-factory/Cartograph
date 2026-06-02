/**
 * Tests for the consolidated `cartograph_admin({action})` family
 * (agentic-backlog #7-4). Action dispatch coverage:
 *  - registry surfaces cartograph_admin; the 5 legacy tool names
 *    (cartograph_init / _uninit / _unlock / _sync / _index) are gone
 *  - missing/invalid `action` returns a discoverable error
 *  - `action='init'` validates `path` (mirrors prior cartograph_init)
 *  - `action='uninit'` requires `confirm: true` (safety guard)
 *  - `action='sync'` runs without bypassing the freshness gate (the
 *    family-level bypassFreshnessGate covers it)
 *
 * Per-action behavior depth (init creating .cartograph/, sync seeing
 * new files, index force-clearing, etc.) is covered by the existing
 * mcp-init-uninit-unlock / mcp-sync / mcp-reindex tests, which were
 * updated to call the family tool with the right action arg.
 */
import { describe, it, expect } from 'vitest';
import { ToolHandler } from '../src/mcp/tools.js';
import { getToolModules } from '../src/mcp/tools/registry.js';

describe('cartograph_admin family (#7-4)', () => {
  it('registry surfaces cartograph_admin; the 5 legacy lifecycle names are gone', () => {
    const names = getToolModules().map((m) => m.definition.name);
    expect(names).toContain('cartograph_admin');
    expect(names).not.toContain('cartograph_init');
    expect(names).not.toContain('cartograph_uninit');
    expect(names).not.toContain('cartograph_unlock');
    expect(names).not.toContain('cartograph_sync');
    expect(names).not.toContain('cartograph_index');
  });

  it('errors with a helpful message when `action` is missing or invalid', async () => {
    const handler = new ToolHandler(null);
    // Source of truth: the registered tool's input schema enum. Tests
    // used to hand-roll the expected list and drifted from the
    // dispatch table; the test now reads from the same place the
    // schema does, so adding a new action only edits ADMIN_ACTIONS.
    // Since the P4 Zod migration, dispatch validation rejects via
    // `safeParse`: a missing `action` surfaces as `action: required`,
    // and an out-of-enum value lists EVERY enum value plus the
    // received value — the human-readable separator is not part of
    // the contract.
    const adminTool = getToolModules().find((m) => m.definition.name === 'cartograph_admin');
    const enumValues = adminTool?.definition.inputSchema.properties?.['action']?.['enum'];
    expect(enumValues).toBeDefined();

    const missing = await handler.execute('cartograph_admin', {});
    expect(missing.content[0]?.text ?? '').toContain('action: required');

    const bogus = await handler.execute('cartograph_admin', { action: 'banana' });
    for (const name of enumValues!) {
      expect(bogus.content[0]?.text ?? '').toContain(`'${name}'`);
    }
    expect(bogus.content[0]?.text ?? '').toContain('"banana"');
    handler.closeAll();
  });

  it("action='init' validates `path`", async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_admin', { action: 'init' });
    expect(result.content[0]?.text ?? '').toMatch(/action=init: `path` must be/);
    handler.closeAll();
  });

  it("action='uninit' requires confirm:true", async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_admin', {
      action: 'uninit',
      path: '/tmp/cg-some-fake-path',
    });
    expect(result.content[0]?.text ?? '').toMatch(/`confirm: true` is required/);
    handler.closeAll();
  });

  it('family carries bypassFreshnessGate (admin actions never blocked by stale-index gate)', () => {
    const adminMod = getToolModules().find((m) => m.definition.name === 'cartograph_admin');
    expect(adminMod).toBeDefined();
    expect(adminMod?.bypassFreshnessGate).toBe(true);
    expect(adminMod?.isWriteTool).toBe(true);
    // Every admin action mutates state — no read-only carve-out
    // exists today (the prior `pool-recommend` / `pool-status`
    // carve-outs were dropped with the HTTP-pool stack).
    expect(adminMod?.readOnlyActions).toBeUndefined();
  });

  it("'reload-modules' is NOT in the action enum — retired 2026-05-20 under bun (ESM cache-bust is a no-op)", () => {
    const adminTool = getToolModules().find((m) => m.definition.name === 'cartograph_admin');
    const enumValues = adminTool?.definition.inputSchema.properties?.['action']?.['enum'];
    expect(enumValues).not.toContain('reload-modules');
  });
});
