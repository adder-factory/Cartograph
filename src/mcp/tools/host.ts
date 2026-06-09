import { z } from 'zod';
import { lowTokensField } from './_common-fields.js';
import { defineTool } from './_define-tool.js';
import { handleDiscover, DEFAULT_DISCOVER_MAX_DEPTH, MAX_DISCOVER_MAX_DEPTH } from './discover.js';
import { handleHostDiagnostics } from './host-diagnostics.js';
import type { ToolCtx } from './types.js';
import type { ToolOutcome } from './_outcome.js';

const hostSchema = z.object({
  mode: z
    .enum(['diagnostics', 'discover'])
    .default('diagnostics')
    .describe(
      '`diagnostics` (default) reports active MCP profile/tool visibility and installer target config detection; `discover` scans for `.cartograph/` indexes under a parent path.',
    ),
  path: z
    .string()
    .optional()
    .describe('(mode=discover) Root directory to scan from. Defaults to the current project root when omitted.'),
  maxDepth: z
    .number()
    .int()
    .min(1)
    .max(MAX_DISCOVER_MAX_DEPTH)
    .default(DEFAULT_DISCOVER_MAX_DEPTH)
    .describe(
      `(mode=discover) Max directory depth to scan; integer in [1, ${MAX_DISCOVER_MAX_DEPTH}] (default ${DEFAULT_DISCOVER_MAX_DEPTH}).`,
    ),
  location: z
    .enum(['global', 'local', 'both'])
    .default('both')
    .describe('(mode=diagnostics) Installer target locations to inspect: global, local, or both. Default both.'),
  includeInstallTargets: z
    .boolean()
    .default(true)
    .describe(
      '(mode=diagnostics) When false, skip filesystem config detection and report only active MCP profile/tool metadata.',
    ),
  lowTokens: lowTokensField,
});

type HostArgs = z.infer<typeof hostSchema>;

async function handleHost(ctx: ToolCtx, args: HostArgs): Promise<ToolOutcome> {
  if (args.mode === 'discover') {
    return handleDiscover(ctx, { path: args.path, maxDepth: args.maxDepth });
  }
  return handleHostDiagnostics(ctx, {
    location: args.location,
    includeInstallTargets: args.includeInstallTargets,
    lowTokens: args.lowTokens,
  });
}

export const HOST_TOOL = defineTool({
  name: 'cartograph_host',
  description:
    "Host and environment diagnostics family. `mode: 'diagnostics'` reports active MCP profile/tool visibility plus local installer-target config detection. `mode: 'discover'` finds `.cartograph/` indexes under a parent path.",
  schema: hostSchema,
  handle: handleHost,
  // Project-agnostic operational diagnostics. The discover branch may
  // use the default project root as a starting point, but it never
  // answers from indexed source data, so staleness is irrelevant.
  bypassFreshnessGate: true,
});
