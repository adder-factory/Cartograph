/**
 * @internal — save-summaries action handler. See `_summaries-pending.ts`
 * for the rationale on the file split. Logic preserved verbatim from
 * the prior `save-summaries.ts`.
 */

import { saveAgentSummaries } from '../../llm/agent-bridge.js';
import { summarySaveItemsSchema } from '../../features/summaries/runtime.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { type ToolOutcome, ok, err } from './_outcome.js';

/**
 * Cap on individual `Skipped:` reasons echoed back to the agent. Above
 * this we summarise the remainder as `... and N more` to keep the
 * tool reply scannable.
 */
const SKIPPED_REASONS_RENDER_LIMIT = 20;

export async function handleSaveSummaries(ctx: ToolCtx, args: Record<string, unknown>): Promise<ToolOutcome> {
  const cg = ctx.getCartograph(args['projectPath'] as string | undefined);
  const rawItems = args['items'];
  if (!Array.isArray(rawItems)) {
    return err('items must be an array of { nodeId, contentHash, summary }');
  }
  // An empty `items` array is almost always a caller mistake — a bad
  // jq filter, an empty pipeline, or a forgotten batch. A cheerful
  // "Saved 0" hides that; surface the no-op explicitly (audit-4 #9).
  if (rawItems.length === 0) {
    return ok(
      textResult('No summaries to save — items array was empty. (Did the pending batch / pipeline produce no rows?)'),
    );
  }
  const parsedItems = summarySaveItemsSchema.safeParse(rawItems);
  if (!parsedItems.success) {
    return err('each item requires non-empty string nodeId, contentHash, and summary');
  }
  const model = (args['model'] as string | undefined) ?? 'agent-mcp';
  const result = saveAgentSummaries({
    projectRoot: cg.projectRoot,
    queries: cg.queries,
    items: parsedItems.data,
    modelLabel: model,
  });
  const lines: string[] = [`Saved ${result.saved} summaries (model: ${model}); skipped ${result.skipped}.`];
  if (result.errors.length > 0) {
    lines.push('', 'Skipped:');
    for (const e of result.errors.slice(0, SKIPPED_REASONS_RENDER_LIMIT)) lines.push(`  - ${e}`);
    if (result.errors.length > SKIPPED_REASONS_RENDER_LIMIT) {
      lines.push(`  ... and ${result.errors.length - SKIPPED_REASONS_RENDER_LIMIT} more`);
    }
  }
  return ok(textResult(lines.join('\n')));
}
