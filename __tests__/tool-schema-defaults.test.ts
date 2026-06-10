/**
 * Regression guard for the advertised MCP tool schemas.
 *
 * `z.toJSONSchema` defaults to `io: 'output'`, where a `.default()`
 * field always exists post-parse and is therefore emitted in
 * `required`. That wrongly advertised every defaulted param (e.g.
 * `cartograph_node`'s `code`/`includeCallers`, `cartograph_graph`'s
 * `hops`/`limit`) as required to strict MCP clients that validate
 * input schemas, contradicting the tools' own "Default: …" docs.
 *
 * `toJsonSchema` (src/mcp/tools/_define-tool.ts) now passes
 * `io: 'input'`, so a defaulted field is optional-with-default in the
 * advertised surface. This test pins that invariant across the whole
 * registry: no published `required` entry may carry a `default`.
 */

import { describe, it, expect } from 'vitest';
import { getToolModules } from '../src/mcp/tools/registry.js';

describe('MCP tool schemas — defaulted params are not advertised as required', () => {
  const mods = getToolModules();

  it('has tools to check', () => {
    expect(mods.length).toBeGreaterThan(0);
  });

  for (const mod of mods) {
    const name = mod.definition.name;
    it(`${name}: no defaulted property appears in required`, () => {
      const required = mod.definition.inputSchema?.required ?? [];
      const props = mod.definition.inputSchema?.properties ?? {};
      const offenders = required.filter((key) => {
        const prop = props[key] as Record<string, unknown> | undefined;
        return prop != null && typeof prop === 'object' && 'default' in prop;
      });
      expect(offenders).toEqual([]);
    });
  }
});
