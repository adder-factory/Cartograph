/**
 * @internal — pending-summaries action handler for the consolidated
 * `cartograph_summaries({action: 'pending'})` family. Lives in its own
 * file (prefixed `_` to discourage external import) to keep the
 * family handler small. Logic preserved verbatim from the prior
 * `pending-summaries.ts` so eval baseline is unchanged.
 */

import { pendingSummariesBatch } from '../../llm/agent-bridge.js';
import { clamp, numArg } from '../../utils.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok } from './_outcome.js';

/**
 * Upper bound on the batch size. A measured run at limit=200 emitted
 * ~241KB of JSON (≈1.2KB per item, dominated by each item's full
 * source `body`) — far past a normal MCP token budget. Capping at 40
 * keeps a full batch inside a sane budget; the caller pages via
 * `remaining` for the rest.
 */
const MAX_PENDING_LIMIT = 40;

/**
 * Per-item `body` character cap. Long function bodies dominate the
 * payload but the agent only needs enough to write a one-line summary.
 * Truncated bodies are marked so the agent knows the tail was elided.
 */
const MAX_BODY_CHARS = 2000;

function clampBody(body: string): string {
  if (body.length <= MAX_BODY_CHARS) return body;
  return body.slice(0, MAX_BODY_CHARS) + `\n… (${body.length - MAX_BODY_CHARS} more chars truncated)`;
}

export async function handlePendingSummaries(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const limit = clamp(numArg(args['limit'], 20), 1, MAX_PENDING_LIMIT);
  const modelHint = (args['modelHint'] as string | undefined) ?? 'agent-mcp';
  // Honour the configured body-line floor (falls back to the bridge's
  // default 3 when unset), keeping the agent-bridge in lock-step.
  const minBodyLines = cg.config.llm?.minBodyLines;
  const minBodyLinesByKind = cg.config.llm?.minBodyLinesByKind;
  const batch = pendingSummariesBatch(cg.projectRoot, cg.queries, {
    limit,
    modelHint,
    ...(minBodyLines === undefined ? {} : { minBodyLines }),
    ...(minBodyLinesByKind === undefined ? {} : { minBodyLinesByKind }),
  });

  if (batch.items.length === 0) {
    return ok(
      textResult(
        `No pending summaries (${batch.total} total candidates, all have current cache entries for model "${modelHint}").`,
      ),
    );
  }

  const items = batch.items.map((it) => ({ ...it, body: clampBody(it.body) }));

  return ok(
    textResult(
      JSON.stringify(
        {
          items,
          remaining: batch.remaining,
          total: batch.total,
          // Bug #16: surface the two-bucket breakdown so the agent isn't
          // misled by a single `total` that mixes drift-stale entries
          // (e.g. 3 from cartograph_status) with the long tail of
          // never-summarised symbols (the other ~1666). `total` is
          // preserved for back-compat; `staleCount + neverSummarisedCount
          // === total`.
          staleCount: batch.staleCount,
          neverSummarisedCount: batch.neverSummarisedCount,
          modelHint: batch.modelHint,
          instructions:
            'Summarise each item.body in ONE LINE (max 200 chars), starting with an action verb. No "This function..." preamble. Then call cartograph_summaries with action="save" and [{nodeId, contentHash, summary}, ...] echoing each item\'s contentHash unchanged. Use the same modelHint as the model arg. ' +
            'Scope note: `total` is the FULL candidate pool, split into `staleCount` (symbols whose cached summary drifted from disk — matches `cartograph_status` out-of-date count) and `neverSummarisedCount` (symbols that have never been summarised by any path). The batch returned mixes both; prioritise stale entries when they appear.',
        },
        null,
        2,
      ),
    ),
  );
}
