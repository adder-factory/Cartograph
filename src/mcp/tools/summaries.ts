/**
 * `cartograph_summaries({action})` — consolidated family that subsumes
 * the prior `cartograph_save_summaries` and `cartograph_pending_summaries`
 * tools. Internal dispatch routes to the existing handlers; this file
 * is a thin discriminator + re-export so adding a third action later
 * (e.g. `action: "stats"`) is one file edit, not a new tool registration.
 *
 * The two prior tool names (`cartograph_pending_summaries`,
 * `cartograph_save_summaries`) were retired without a deprecation
 * shim — single-user codebase, hard cut-over per the user's "i don't
 * worry about user complaining api, go ahead" call. Search the diff
 * for shipped commit if you need the migration path.
 *
 * Pattern owner per agentic-backlog #7 (tool family consolidation):
 * use a single `action` discriminator; future Phase-6 memory tools
 * adopt this shape from day 1 instead of being designed as separate-
 * tool-per-action.
 *
 * SCHEMA (structural campaign P4): a FLAT `z.object` where `action` is
 * a `z.enum` and every per-action field is `.optional()` — this mirrors
 * the prior hand-written JSON `inputSchema`, which only required
 * `action` and never enforced per-action requirements. The per-action
 * cross-field validation (e.g. `save` needs `items`) stays in the
 * sub-handlers (`_summaries-pending.ts` / `_summaries-save.ts`) exactly
 * as before.
 */

import { z } from 'zod';
import { projectPathField } from './_common-fields.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import type { ToolOutcome } from './_outcome.js';
import { handlePendingSummaries } from './_summaries-pending.js';
import { handleSaveSummaries } from './_summaries-save.js';

/** Upper bound on the pending-batch `limit` — mirrors `MAX_PENDING_LIMIT`
 *  in `_summaries-pending.ts`. */
const MAX_PENDING_LIMIT = 40;

/**
 * Zod schema for `cartograph_summaries`.
 *
 * `limit` is `.int().min(1).max(40)` — under the locked
 * reject-out-of-range policy a zero / negative / over-cap value is
 * REJECTED at the dispatch boundary instead of clamped. The
 * `_summaries-pending.ts` sub-handler still calls `clamp(numArg(...))`,
 * but on a Zod-validated value that is an idempotent no-op.
 */
const summariesSchema = z.object({
  action: z
    .enum(['pending', 'save'])
    .describe(
      '`pending` returns a batch of symbols needing summaries (uses `limit` / `modelHint`); the response splits the pool into `staleCount` (cached summary drifted from disk) and `neverSummarisedCount` (never processed). `save` persists summaries (uses `items` / `model`).',
    ),
  // pending-mode args
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PENDING_LIMIT)
    .optional()
    .describe('(action=pending) Max symbols per batch (default 20, integer in [1, 40]; out-of-range is rejected).'),
  modelHint: z
    .string()
    .optional()
    .describe(
      '(action=pending) Label recorded with saved summaries (default "agent-mcp"); use your model id for clear provenance.',
    ),
  // save-mode args
  items: z
    .array(
      z.object({
        nodeId: z.string(),
        contentHash: z.string(),
        summary: z.string().describe('One line, max 200 chars. Action verb. No "This function..." preamble.'),
      }),
    )
    .optional()
    .describe(
      '(action=save) Summaries to persist; each item echoes back the contentHash from action=pending unchanged.',
    ),
  model: z
    .string()
    .optional()
    .describe(
      '(action=save) Model label to record (default "agent-mcp"); match the pending batch modelHint for cache hits.',
    ),
  projectPath: projectPathField,
});

type SummariesArgs = z.infer<typeof summariesSchema>;

async function handleSummaries(ctx: ToolCtx, args: SummariesArgs): Promise<ToolOutcome> {
  // `action` is a validated enum — Zod rejected anything outside the
  // set at the dispatch boundary, so no `action`-not-found branch is
  // needed here. The sub-handlers still read the remaining args off the
  // raw record (their `Record<string, unknown>` signature is unchanged).
  if (args.action === 'pending') {
    return handlePendingSummaries(ctx, args as Record<string, unknown>);
  }
  return handleSaveSummaries(ctx, args as Record<string, unknown>);
}

export const SUMMARIES_TOOL = defineTool({
  name: 'cartograph_summaries',
  description:
    'Agent-as-LLM bridge — write symbol summaries yourself when no local LLM is configured.\n\n' +
    "Two-call: `action: 'pending'` pulls a batch (body + contentHash) → you write one-liners → `'save'` persists (echo each contentHash; mid-flight body changes auto-skip). The `pending` response splits the pool into `staleCount` (drifted from disk) and `neverSummarisedCount` (never processed).",
  schema: summariesSchema,
  handle: handleSummaries,
  // Save-action mutates the summaries cache; pending-action is read-only.
  // Marking the family as a write tool is the conservative choice — it
  // gets disabled by `--no-write-tools` along with the other write
  // family members. (The save action would fail anyway, so this just
  // hides the read-only `pending` action too — acceptable trade for
  // the simpler --no-write-tools semantics.)
  isWriteTool: true,
});
