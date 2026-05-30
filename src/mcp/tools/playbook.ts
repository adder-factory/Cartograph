import { z } from 'zod';
import { SERVER_INSTRUCTIONS } from '../server-instructions.js';
import { textResult } from './shared.js';
import type { ToolCtx } from './types.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';

/**
 * `cartograph_playbook` — return the agent-facing tool playbook.
 *
 * Static body, no project lookup, no I/O. Identical to the payload
 * that `initialize` sends but callable on demand for tests, scripts,
 * and agents that bypass the handshake.
 */

/**
 * Zod schema for `cartograph_playbook` — a no-input tool. An empty
 * `z.object({})` still generates the canonical `{ type: 'object',
 * properties: {} }` inputSchema the legacy hand-written shape
 * advertised.
 */
const playbookSchema = z.object({});

type PlaybookArgs = z.infer<typeof playbookSchema>;

// P6: returns a `ToolOutcome`. A no-error handler — the body is
// static, no project lookup, no I/O — so the only arm it ever
// produces is `ok(...)`. The bare-`textResult` payload drops straight
// into the success arm; no envelope spec needed.
async function handlePlaybook(_ctx: ToolCtx, _args: PlaybookArgs): Promise<ToolOutcome> {
  return ok(textResult(SERVER_INSTRUCTIONS));
}

export const PLAYBOOK_TOOL = defineTool({
  name: 'cartograph_playbook',
  description:
    'Return the cartograph tool playbook — which tool for which question, common chains, anti-patterns, tier discipline.\n\n' +
    'Identical to the MCP `initialize` payload but callable on demand. ' +
    "Use when scoping multi-tool work or unsure of a tool's shape. " +
    'For programmatic clients that bypass the handshake, this is how you fetch the same guidance.',
  schema: playbookSchema,
  handle: handlePlaybook,
  // Pure-docs surface — no DB access at all. Always callable, even
  // through the B4 schema-mismatch block.
  bypassSchemaGuard: true,
});
