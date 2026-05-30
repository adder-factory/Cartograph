/**
 * Structural fix C — single-schema MCP/CLI codegen (coverage gate).
 *
 * `src/mcp/tools/_zod-to-cli.ts` derives Commander option specs from
 * each MCP tool's Zod schema; `src/bin/_command-generator.ts` turns
 * those specs into a live commander `Command`. Most tools register
 * via `registerGeneratedCommand` in `src/bin/commands/generated.ts` —
 * the SINGLE-SCHEMA path that makes CLI ↔ MCP drift impossible.
 *
 * A NEW tool that hand-rolls its CLI surface defeats the structural
 * guarantee. This test enforces the gate by maintaining an explicit
 * `EXPECTED_HAND_BUILT_TOOLS` allowlist of tools whose CLI shape is
 * legitimately hand-built (family routers, atypical positionals,
 * pre-generator legacies). Every other MCP tool MUST register via
 * the generator. Adding a new tool with `defineTool` and forgetting
 * to register via `registerGeneratedCommand` will fail this test in
 * CI, prompting the author to either:
 *
 *   1. Add `registerGeneratedCommand('cartograph_X', { … })` to
 *      `generated.ts` — the default and preferred path.
 *   2. Hand-build the command AND add `'cartograph_X'` to
 *      `EXPECTED_HAND_BUILT_TOOLS` below with a `// reason: …` line
 *      so the next reviewer knows why the generator wasn't enough.
 *
 * Closes the open-ended "future tools could drift" concern raised by
 * structural fix C. The codegen infrastructure (`_zod-to-cli` +
 * `_command-generator`) is already in place; this test ensures the
 * default path is taken.
 */

import { describe, it, expect } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import { getToolModules } from '../src/mcp/tools/registry.js';

const GENERATED_FILE = path.join(__dirname, '..', 'src', 'bin', 'commands', 'generated.ts');

/**
 * Tools that intentionally do NOT use `registerGeneratedCommand`. Each
 * entry must be justified — silent hand-rolling is the failure mode
 * this test exists to prevent. Add to this set ONLY with a `reason`
 * comment in the same diff.
 */
const EXPECTED_HAND_BUILT_TOOLS: ReadonlySet<string> = new Set<string>([
  // Family routers — the CLI shape is `<family> <subcommand>` (e.g.
  // `cartograph admin sync`), not a single command with `--action`. The
  // generator's `discriminatorAsPositional: true` covers single-axis
  // family tools (notes), but multi-subcommand families with per-action
  // unique args are hand-routed today. Future work to extend the
  // generator with multi-subcommand discriminators would let these
  // migrate, but the migration is its own refactor.
  'cartograph_admin', // reason: family router with per-action arg subsets
  'cartograph_summaries', // reason: agent-bridge family (pending / save subcommands)
  'cartograph_session', // reason: cross-call agent-state family
  'cartograph_review', // reason: mode-router with diff-based / files-based / no-input modes
  'cartograph_find', // reason: axis router (by:name/content/env/sql) with per-axis arg subsets
  // Standalone tools whose CLI surface predates the generator and
  // would benefit from migration. Tracked separately from family
  // routers because their migration is straightforward — see the
  // structural-fix-C followup tasks.
  'cartograph_status', // reason: hand-built; pre-generator
  'cartograph_files', // reason: hand-built; pre-generator
  'cartograph_at_range', // reason: hand-built; pre-generator
  'cartograph_ask', // reason: hand-built; pre-generator
  'cartograph_affected', // reason: hand-built; pre-generator
  'cartograph_digest', // reason: hand-built; pre-generator
  'cartograph_trace_to_culprits', // reason: hand-built; pre-generator
  // CLI-omitted by design — playbook is project-agnostic (no
  // projectPath shape) and not surfaced as a CLI command. The
  // cli-mcp-alignment test allowlists it separately.
  'cartograph_playbook', // reason: CLI-omitted (project-agnostic, MCP-only)
]);

describe('CLI generator coverage (structural fix C gate)', () => {
  it('every MCP tool is either generator-registered or in the hand-built allowlist', () => {
    const generatedSource = fs.readFileSync(GENERATED_FILE, 'utf-8');
    const registeredNames = new Set<string>();
    for (const match of generatedSource.matchAll(/registerGeneratedCommand\(\s*'(cartograph_[a-z_]+)'/g)) {
      registeredNames.add(match[1]!);
    }
    const orphans: string[] = [];
    for (const mod of getToolModules()) {
      const name = mod.definition.name;
      if (registeredNames.has(name)) continue;
      if (EXPECTED_HAND_BUILT_TOOLS.has(name)) continue;
      orphans.push(name);
    }
    if (orphans.length > 0) {
      throw new Error(
        `MCP tool(s) missing a CLI mirror — neither in generated.ts nor in the hand-built allowlist:\n  ${orphans.join('\n  ')}\n\n` +
          `Add \`registerGeneratedCommand('cartograph_X', ...)\` to src/bin/commands/generated.ts (preferred), ` +
          `or add to EXPECTED_HAND_BUILT_TOOLS in this test with a reason comment.`,
      );
    }
    expect(orphans).toEqual([]);
  });

  it('every entry in EXPECTED_HAND_BUILT_TOOLS resolves to a real tool', () => {
    const known = new Set(getToolModules().map((m) => m.definition.name));
    const stale: string[] = [];
    for (const name of EXPECTED_HAND_BUILT_TOOLS) {
      if (!known.has(name)) stale.push(name);
    }
    if (stale.length > 0) {
      throw new Error(
        `EXPECTED_HAND_BUILT_TOOLS lists tool(s) that no longer exist: ${stale.join(', ')}. ` +
          `Remove the dead entry — the structural-fix-C gate exists to track real migration debt, not stale references.`,
      );
    }
    expect(stale).toEqual([]);
  });
});
