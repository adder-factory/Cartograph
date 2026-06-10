/**
 * MCP tool registry.
 *
 * Adding a new MCP tool is:
 *
 *   1. Create `src/mcp/tools/<name>.ts` exporting both
 *      `export async function handle<Name>(ctx, args): Promise<ToolOutcome>`
 *      and `<NAME>_TOOL: ToolModule` (definition + `handle: handle<Name>`).
 *      Use `ctx.getCartograph(args['projectPath'])` to resolve the project,
 *      and import `textResult` / `validateStringOutcome` / `truncateOutput`
 *      from `./shared.js`; signal errors with the `err(...)` arm from
 *      `./_outcome.js` (`errorResult` is dispatch-layer-only, not
 *      handler-reachable).
 *   2. Add **one** import line and **one** array entry to this file.
 *
 * Adding a tool no longer touches `ToolHandler` in `../tools.ts` — the
 * body lives in the per-tool file and dispatches through the `handle`
 * field. `ToolHandler.execute()` looks up the module by name and calls
 * `mod.handle(ctx, args)` directly. There is no legacy `handlerKey`
 * field, no `HandlerKey` union, and no dispatch-fallback branch.
 *
 * Naming convention: files prefixed with `_` (e.g. `_summaries-pending.ts`,
 * `_summaries-save.ts`, `_coverage-load.ts`, `_search-fuzzy.ts`,
 * `_search-semantic.ts`, `_search.ts`, `_grep.ts`, `_string_refs.ts`,
 * `_callers.ts`, `_callees.ts`, `_walk.ts`, `_impact.ts`) are private
 * per-action / per-axis helpers used exclusively by the consolidated
 * family handler (agentic-backlog #7 / 2026-05-11 graph + find merges).
 * They export only `handle<Action>` and never a `<NAME>_TOOL` — the
 * tool registration lives in the family file (e.g. `summaries.ts`,
 * `coverage.ts`, `find.ts`, `graph.ts`).
 */

import type { ToolDefinition } from '../tool-types.js';
import { allowStaleProperty } from '../tool-types.js';
import type { ToolModule } from './types.js';
import { registerToolModule } from './_tool-lookup.js';
import { getZodSchema, reattachZodSchema } from './_define-tool.js';
import { getToolContract, reattachToolContract } from './_tool-contract.js';

import { ADMIN_TOOL } from './admin.js';
import { AT_RANGE_TOOL } from './at-range.js';
import { AFFECTED_TOOL } from './affected.js';
import { ASK_TOOL } from './ask.js';
import { BIOMARKERS_TOOL } from './biomarkers.js';
import { BLAME_TOOL } from './blame.js';
import { CHANGED_SINCE_TOOL } from './changed-since.js';
import { COMPARE_TO_REF_TOOL } from './compare.js';
import { CONTEXT_TOOL } from './context.js';
import { COVERAGE_TOOL } from './coverage.js';
import { DEAD_CODE_TOOL } from './dead-code.js';
import { DEPS_TOOL } from './deps.js';
import { DIGEST_TOOL } from './digest.js';
import { ENTRY_POINTS_TOOL } from './entry-points.js';
import { EXPLORE_TOOL } from './explore.js';
import { FILES_TOOL } from './files.js';
// cartograph_find subsumes the pre-merge cartograph_search /
// cartograph_grep / cartograph_string_refs tools (2026-05-11). The three
// implementations now live as private helper modules
// (`_search.ts` / `_grep.ts` / `_string_refs.ts`) reachable only through
// `find.ts`'s dispatcher.
import { FIND_TOOL } from './find.js';
// cartograph_graph subsumes the pre-merge cartograph_callers /
// cartograph_callees / cartograph_walk / cartograph_impact tools
// (2026-05-11). The four implementations now live as private helper
// modules (`_callers.ts` / `_callees.ts` / `_walk.ts` / `_impact.ts`)
// reachable only through `graph.ts`'s dispatcher.
import { GRAPH_TOOL } from './graph.js';
import { HISTORY_TOOL } from './history.js';
import { HOST_TOOL } from './host.js';
import { HOTSPOTS_TOOL } from './hotspots.js';
import { IMPORTS_TOOL } from './imports.js';
import { NODE_TOOL } from './node.js';
import { NOTE_TOOL } from './note.js';
import { PLAYBOOK_TOOL } from './playbook.js';
import { PROPOSE_RENAME_TOOL } from './propose-rename.js';
import { REVIEW_TOOL } from './review.js';
import { ROLE_TOOL } from './role.js';
import { SESSION_TOOL } from './session.js';
import { SQL_TOOL } from './sql.js';
import { STATUS_TOOL } from './status.js';
import { SUMMARIES_TOOL } from './summaries.js';
import { TESTS_FOR_TOOL } from './tests-for.js';
import { TRACE_TO_CULPRITS_TOOL } from './trace-to-culprits.js';

/**
 * Inject `allowStale` into every tool's inputSchema EXCEPT tools
 * that bypass the freshness gate entirely (status, sync). Those
 * tools never see the gate, so advertising `allowStale` on them
 * would be misleading — the agent would assume the flag changes
 * behaviour when it's silently ignored. Done here, once, instead
 * of touching 22 per-tool files.
 */
function withAllowStale(mod: ToolModule): ToolModule {
  if (mod.bypassFreshnessGate === true) return mod;
  // A `defineTool` module carries a NON-enumerable `__zodSchema`
  // marker that the `{ ...mod }` spread below would drop. Capture it
  // first and re-attach it to the clone so the dispatcher still routes
  // the wrapped module through the Zod validation path. Legacy modules
  // return `undefined` here and `reattachZodSchema` is then a no-op.
  const zodSchema = getZodSchema(mod);
  const toolContract = getToolContract(mod);
  const wrapped: ToolModule = {
    ...mod,
    definition: {
      ...mod.definition,
      inputSchema: {
        ...mod.definition.inputSchema,
        properties: {
          ...mod.definition.inputSchema.properties,
          allowStale: allowStaleProperty,
        },
      },
    },
  };
  return reattachToolContract(reattachZodSchema(wrapped, zodSchema), toolContract);
}

const ENTRIES: ToolModule[] = [
  ADMIN_TOOL,
  AFFECTED_TOOL,
  ASK_TOOL,
  AT_RANGE_TOOL,
  BIOMARKERS_TOOL,
  BLAME_TOOL,
  CHANGED_SINCE_TOOL,
  COMPARE_TO_REF_TOOL,
  CONTEXT_TOOL,
  COVERAGE_TOOL,
  DEAD_CODE_TOOL,
  DEPS_TOOL,
  DIGEST_TOOL,
  ENTRY_POINTS_TOOL,
  EXPLORE_TOOL,
  FILES_TOOL,
  FIND_TOOL,
  GRAPH_TOOL,
  HISTORY_TOOL,
  HOST_TOOL,
  HOTSPOTS_TOOL,
  IMPORTS_TOOL,
  NODE_TOOL,
  NOTE_TOOL,
  PLAYBOOK_TOOL,
  PROPOSE_RENAME_TOOL,
  REVIEW_TOOL,
  ROLE_TOOL,
  SESSION_TOOL,
  SQL_TOOL,
  STATUS_TOOL,
  SUMMARIES_TOOL,
  TESTS_FOR_TOOL,
  TRACE_TO_CULPRITS_TOOL,
].map(withAllowStale);

// Populate the leaf name→module lookup. Family tools read it via
// `_tool-lookup.ts` (NOT this registry) so they don't import the registry
// that imports them — see _tool-lookup.ts for the cycle this breaks.
for (const mod of ENTRIES) registerToolModule(mod);

/**
 * The canonical set of MCP tool names — derived from the live
 * registry at module load. Other surfaces (e.g. the write-time
 * stale-name guard below, the static-scan test in
 * `__tests__/tool-name-references.test.ts`) consume this so a tool
 * rename / merge / retirement is a single-source change.
 */
export const KNOWN_TOOL_NAMES: ReadonlySet<string> = new Set(ENTRIES.map((mod) => mod.definition.name));

/**
 * Tool names that were retired by a merge or fold-in. Allowed inside
 * `cartograph_X` references in tool descriptions because migration
 * notes (e.g. "Replaces the pre-merge `cartograph_callers`.") are how
 * an agent learns the new name. The guard below subtracts this set
 * from the "unknown name" classification so legacy disclosures
 * survive while real stale call-to-action hints still fail.
 *
 * Sourced from CLAUDE.md's "Tools merged on 2026-05-11" block and
 * the subsequent fold-ins (2026-05-14):
 *  - `cartograph_search` / `cartograph_grep` / `cartograph_string_refs`
 *    → folded into `cartograph_find`.
 *  - `cartograph_callers` / `cartograph_callees` / `cartograph_impact` /
 *    `cartograph_walk` → folded into `cartograph_graph`.
 *  - `cartograph_similar` → `cartograph_graph({direction: 'similar'})`.
 *  - `cartograph_risk_review` → `cartograph_review({mode: 'risk'})`.
 *
 * Add an entry here when retiring a tool — that's the same edit that
 * removes its registry row, so the disclosure and the removal land
 * in lockstep.
 */
export const RETIRED_TOOL_NAMES: ReadonlySet<string> = new Set([
  // 2026-05-11 find-family merge
  'cartograph_search',
  'cartograph_grep',
  'cartograph_string_refs',
  'cartograph_env_refs',
  'cartograph_sql_refs',
  // 2026-05-11 graph-family merge
  'cartograph_callers',
  'cartograph_callees',
  'cartograph_impact',
  'cartograph_walk',
  // 2026-05-14 single-tool fold-ins
  'cartograph_similar',
  'cartograph_risk_review',
  'cartograph_review_context',
  'cartograph_review_neighbors',
  // admin-family (subsumes earlier lifecycle tools — pre-2026-05-08)
  'cartograph_init',
  'cartograph_uninit',
  'cartograph_unlock',
  'cartograph_sync',
  'cartograph_index',
  // summaries-family (pre-2026-05-08 agent-bridge tools)
  'cartograph_pending_summaries',
  'cartograph_save_summaries',
  // 2026-06-08 files-family consolidation
  'cartograph_file_deps',
  'cartograph_file_symbols',
  'cartograph_module',
  // 2026-06-09 full-profile consolidation
  'cartograph_dependency_coverage',
  'cartograph_discover',
  'cartograph_host_diagnostics',
  'cartograph_local_chat',
]);

/**
 * Scan every registered tool's `description` and each top-level
 * field's `description` for `` `cartograph_X` `` references and reject
 * any name that isn't in the live {@link KNOWN_TOOL_NAMES} set. Throws
 * at module load so a rename / merge that left a stale hint in a
 * sibling tool's docs cannot ship.
 *
 * Caught case (Friction #10, 2026-05-19): `_callees.ts` had
 * `Try \`cartograph_callees symbol=<methodName>\`` baked into a
 * container-method hint string AFTER the pre-merge `cartograph_callees`
 * was retired in favour of `cartograph_graph({direction: 'callees'})`.
 * The hint slipped through review (and a test was even pinning the
 * stale string in place) because no automation was tied to the live
 * registry.
 *
 * Limitations: only the schema-published surface (top-level
 * description + field descriptions) is scanned here, because that's
 * what the registry holds. Stale references buried in handler-body
 * strings need the static-scan companion test in
 * `__tests__/tool-name-references.test.ts` — same predicate, walks
 * the source files instead of the registry.
 */
function validateToolNameReferences(): void {
  const STALE_NAME_RE = /`(cartograph_[a-z_]+)`/g;
  const stale: Array<{ tool: string; field: string; ref: string }> = [];
  for (const mod of ENTRIES) {
    const tool = mod.definition.name;
    const scan = (field: string, text: string | undefined): void => {
      if (!text) return;
      for (const match of text.matchAll(STALE_NAME_RE)) {
        const ref = match[1]!;
        if (KNOWN_TOOL_NAMES.has(ref)) continue;
        if (RETIRED_TOOL_NAMES.has(ref)) continue;
        stale.push({ tool, field, ref });
      }
    };
    scan('description', mod.definition.description);
    const props = mod.definition.inputSchema?.properties ?? {};
    for (const [field, prop] of Object.entries(props)) {
      const desc = (prop as { description?: unknown }).description;
      if (typeof desc === 'string') scan(`properties.${field}`, desc);
    }
  }
  if (stale.length > 0) {
    const list = stale.map(({ tool, field, ref }) => `  ${tool}:${field} → \`${ref}\``).join('\n');
    throw new Error(
      `Tool registry has stale \`cartograph_X\` references — every name in a tool's description must resolve in the live registry (or be listed in RETIRED_TOOL_NAMES for documented migrations):\n${list}\n\nKnown tool names: ${[...KNOWN_TOOL_NAMES].join(', ')}.`,
    );
  }
}
validateToolNameReferences();

export function getToolModules(): readonly ToolModule[] {
  return ENTRIES;
}

// Re-exported from the leaf lookup so existing `registry.getToolModule`
// importers keep working; family tools should import it from
// `./_tool-lookup.js` directly to avoid the registry import cycle.
export { getToolModule } from './_tool-lookup.js';

/**
 * The `tools[]` array advertised in MCP `list_tools`. Built once at
 * module load; sorted alphabetically by tool name for stable output.
 */
export const tools: readonly ToolDefinition[] = ENTRIES.map((mod) => mod.definition).sort((a, b) =>
  a.name.localeCompare(b.name),
);
