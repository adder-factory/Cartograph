/**
 * MCP tool registry: structural invariants.
 *
 * Guards against the failure mode where a future PR adds a
 * ToolModule but forgets to set its `handle` function (or sets one
 * with the wrong shape).
 */
import { describe, it, expect } from 'vitest';
import { getLanguageDefs } from '../src/extraction/languages/registry.js';
import { MCP_LOAD_BUDGET_LIMITS, MCP_LOAD_BUDGET_TARGETS } from '../src/mcp/load-budget.js';
import { FULL_PLAYBOOK, SERVER_INSTRUCTIONS } from '../src/mcp/server-instructions.js';
import { getToolModules, tools as registryTools } from '../src/mcp/tools/registry.js';
import { ToolHandler, tools } from '../src/mcp/tools.js';
import { MCP_SERVER_PROFILE_NAMES, MCP_SERVER_PROFILE_TOOL_NAMES } from '../src/mcp/profiles.js';

const byName = (a: string, b: string): number => a.localeCompare(b);

describe('MCP tool registry — single source of truth', () => {
  it('every tool module has a non-empty name and description', () => {
    for (const m of getToolModules()) {
      expect(m.definition.name).toMatch(/^cartograph_[a-z_]+$/);
      expect(m.definition.description.length).toBeGreaterThan(20);
    }
  });

  it('every tool module ships a callable `handle` function', () => {
    for (const m of getToolModules()) {
      expect(typeof m.handle).toBe('function');
    }
  });

  it('exported `tools` array exactly mirrors the registry', () => {
    const fromRegistry = registryTools.map((t) => t.name).sort(byName);
    const fromExport = tools.map((t) => t.name).sort(byName);
    expect(fromExport).toEqual(fromRegistry);
  });

  it('keeps advertised MCP tool count and schema payload under budget', () => {
    const handler = new ToolHandler(null);
    const advertised = handler.getTools();
    const payloadChars = JSON.stringify({ tools: advertised }).length;
    const loadContextChars = payloadChars + JSON.stringify({ instructions: SERVER_INSTRUCTIONS }).length;
    const fullAdvertised = new ToolHandler(null, { profile: 'full' }).getTools();
    const fullPayloadChars = JSON.stringify({ tools: fullAdvertised }).length;
    const fullLoadContextChars = fullPayloadChars + JSON.stringify({ instructions: SERVER_INSTRUCTIONS }).length;

    expect(advertised.length).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.toolCount);
    expect(payloadChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.toolsListChars);
    expect(loadContextChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.combinedChars);
    expect(payloadChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_TARGETS.toolsListChars);
    expect(loadContextChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_TARGETS.combinedChars);
    expect(fullAdvertised.length).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.toolCount);
    expect(fullPayloadChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.toolsListChars);
    expect(fullLoadContextChars).toBeLessThanOrEqual(MCP_LOAD_BUDGET_LIMITS.combinedChars);

    const readOnlyAdvertised = new ToolHandler(null, { profile: 'full', disableWriteTools: true }).getTools();
    expect(readOnlyAdvertised.length).toBeLessThan(fullAdvertised.length);

    for (const profile of MCP_SERVER_PROFILE_NAMES) {
      const profiled = new ToolHandler(null, { profile }).getTools();
      const profiledPayloadChars = JSON.stringify({ tools: profiled }).length;
      expect(profiledPayloadChars).toBeLessThanOrEqual(fullPayloadChars);
      if (profile !== 'full') expect(profiled.length).toBeLessThan(fullAdvertised.length);
    }
  });

  it('all main-line tools are registered (regression guard)', () => {
    const expected = [
      'cartograph_admin',
      'cartograph_affected',
      'cartograph_ask',
      'cartograph_at_range',
      'cartograph_biomarkers',
      'cartograph_blame',
      'cartograph_changed_since',
      'cartograph_compare_to_ref',
      'cartograph_context',
      'cartograph_coverage',
      'cartograph_dead_code',
      'cartograph_deps',
      'cartograph_digest',
      'cartograph_discover',
      'cartograph_entry_points',
      'cartograph_explore',
      'cartograph_files',
      // cartograph_find subsumes the pre-merge cartograph_search /
      // cartograph_grep / cartograph_string_refs tools (2026-05-11
      // three-tool merge).
      'cartograph_find',
      // cartograph_graph subsumes the pre-merge cartograph_callers /
      // cartograph_callees / cartograph_walk / cartograph_impact tools
      // (2026-05-11 four-tool merge).
      'cartograph_graph',
      'cartograph_history',
      'cartograph_hotspots',
      'cartograph_imports',
      'cartograph_local_chat',
      'cartograph_module',
      'cartograph_node',
      'cartograph_note',
      'cartograph_playbook',
      'cartograph_propose_rename',
      'cartograph_review',
      'cartograph_role',
      'cartograph_session',
      'cartograph_sql',
      'cartograph_status',
      'cartograph_summaries',
      'cartograph_tests_for',
      'cartograph_trace_to_culprits',
    ];
    const actual = getToolModules()
      .map((m) => m.definition.name)
      .sort(byName);
    expect(actual).toEqual(expected);
  });

  it('profile allowlists only reference registered tools', () => {
    const known = new Set(getToolModules().map((m) => m.definition.name));
    for (const profile of MCP_SERVER_PROFILE_NAMES) {
      const names = MCP_SERVER_PROFILE_TOOL_NAMES[profile];
      if (!names) continue;
      const unknown = names.filter((name) => !known.has(name));
      expect(unknown, `${profile} profile has unknown tool name(s)`).toEqual([]);
      expect(new Set(names).size, `${profile} profile has duplicate tool name(s)`).toBe(names.length);
    }
  });

  it('cartograph_playbook returns the full playbook while initialize stays compact', async () => {
    // Playbook is the one tool that needs no project bound — agents
    // calling it before opening a Cartograph (or in tests/scripts that
    // want more than the compact MCP `initialize` guide) should still
    // see the complete playbook. The body must be byte-identical to
    // what the public `Cartograph.getInstructions()` API returns, so
    // consumers don't get drift between those two full-guide surfaces.
    const Cartograph = (await import('../src/index.js')).default;
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_playbook', {});
    expect(result.isError).toBeFalsy();
    const text = result.content[0]?.text ?? '';
    expect(text).toBe(Cartograph.getInstructions());
    expect(text).toBe(FULL_PLAYBOOK);
    expect(text).not.toBe(SERVER_INSTRUCTIONS);
    expect(SERVER_INSTRUCTIONS.length).toBeLessThan(FULL_PLAYBOOK.length / 4);
    expect(text.length).toBeGreaterThan(1000);
    expect(text).toMatch(/cartograph_context/);
    expect(text).toMatch(/cartograph_playbook/);
    expect(SERVER_INSTRUCTIONS).toMatch(/compact startup guide/);
    expect(SERVER_INSTRUCTIONS).toMatch(/cartograph_playbook/);
    expect(SERVER_INSTRUCTIONS).toContain(`${getLanguageDefs().length} language modes`);
  });

  it('execute() reports unknown-tool errors', async () => {
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_does_not_exist', {});
    expect(result.isError).toBe(true);
    expect(result.content[0]?.text).toMatch(/Unknown tool/);
  });

  it('execute() actually dispatches to the registered handler', async () => {
    // No Cartograph instance is bound, so handlers that call
    // `getCartograph()` will throw — the dispatch should catch it
    // and return an error result. The point of this test is to
    // confirm the registry lookup + `mod.handle(ctx, args)` chain
    // reaches an actual handler body, not that the body succeeds.
    const handler = new ToolHandler(null);
    const result = await handler.execute('cartograph_status', {});
    expect(result.isError).toBe(true);
    // Generic tool-execution-failed envelope from execute()'s catch block.
    expect(result.content[0]?.text).toMatch(/Tool execution failed/);
    // Specifically because no Cartograph was bound — the message
    // should point the agent at `projectPath` as a remediation since
    // the MCP server has no default project.
    expect(result.content[0]?.text).toMatch(/No default cartograph project/);
    expect(result.content[0]?.text).toMatch(/projectPath/);
  });

  // Structural fix D — the live-registry name guard surfaces both
  // `KNOWN_TOOL_NAMES` (every registered tool) and `RETIRED_TOOL_NAMES`
  // (documented merge / fold-in targets) as ReadonlySet<string>. These
  // are consumed by the write-time guard at the bottom of registry.ts
  // AND by the static-scan test in tool-name-references.test.ts; both
  // need both sets, so they must stay exported.
  it('exports KNOWN_TOOL_NAMES with every registered tool, and RETIRED_TOOL_NAMES with the documented retirees', async () => {
    const { KNOWN_TOOL_NAMES, RETIRED_TOOL_NAMES, getToolModules } = await import('../src/mcp/tools/registry.js');
    const known = new Set(getToolModules().map((m) => m.definition.name));
    expect(KNOWN_TOOL_NAMES).toEqual(known);
    // Disjoint: a retired name must not also appear in the live set.
    for (const r of RETIRED_TOOL_NAMES) expect(KNOWN_TOOL_NAMES.has(r)).toBe(false);
    // Canonical members (sanity — drift here means someone removed a
    // documented retirement from the allow-list; check the migration).
    expect(RETIRED_TOOL_NAMES.has('cartograph_callers')).toBe(true);
    expect(RETIRED_TOOL_NAMES.has('cartograph_callees')).toBe(true);
    expect(RETIRED_TOOL_NAMES.has('cartograph_search')).toBe(true);
  });
});
