/**
 * @internal — by='env' / by='sql' handlers for the consolidated
 * `cartograph_find` family tool (formerly the top-level
 * `cartograph_string_refs` tool — itself a 2025-merge of the prior
 * `cartograph_env_refs` + `cartograph_sql_refs` tools). Dispatched from
 * `find.ts` when `by === 'env'` or `by === 'sql'`. No registered
 * ToolModule export — the registry only knows FIND_TOOL.
 *
 * Preserves the pre-merge `cartograph_string_refs` API verbatim:
 *  - `by: 'env'` — environment-variable read sites; `key` filters to
 *    one variable; omit for the top-N keys with read counts.
 *  - `by: 'sql'` — SQL string-literal table refs; `key` filters to
 *    one table; `op: read | write | ddl` narrows by operation.
 *
 * Args common to both axes: `includeTests` (default true), `limit`,
 * `projectPath`. Per-axis quirks live in the underlying handlers
 * (`./env-refs.ts` / `./sql-refs.ts`).
 */

import { type ToolOutcome, ok, err } from './_outcome.js';
import { handleEnvRefs } from './env-refs.js';
import { handleSqlRefs } from './sql-refs.js';
import type { ToolCtx } from './types.js';

/** by='env' delegate — delegates straight to the env-refs handler. */
export async function handleFindByEnv(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  if (args['op'] !== undefined) {
    return err(
      "cartograph_find: `op` filter is only valid with `by: 'sql'`. " + "For by='env', drop the `op` argument.",
    );
  }
  return ok(await handleEnvRefs(ctx, args));
}

/** by='sql' delegate — rewrites `key` → `table` for the SQL handler. */
export async function handleFindBySql(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  // SQL mode wants `table`; the merged tool names both axes' lookup
  // value `key` so the agent has one vocabulary. Rewrite to the
  // underlying handler's expected name when dispatching to SQL.
  const sqlArgs = { ...args };
  if (typeof args['key'] === 'string') sqlArgs['table'] = args['key'];
  return ok(await handleSqlRefs(ctx, sqlArgs));
}
