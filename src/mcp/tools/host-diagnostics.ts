import { z } from 'zod';
import { detectAll } from '../../installer/targets/registry.js';
import type { Location } from '../../installer/targets/types.js';
import {
  buildHostDiagnostics,
  renderHostDiagnostics,
  renderHostDiagnosticsCompact,
  toHostDiagnosticTarget,
} from '../../features/host-diagnostics/index.js';
import { mcpServerProfileToolSet, resolveMcpServerProfile } from '../profiles.js';
import { defineTool } from './_define-tool.js';
import { type ToolOutcome, ok } from './_outcome.js';
import { renderToolResponse } from './_response.js';
import { lowTokensField } from './_common-fields.js';
import type { ToolCtx } from './types.js';

const hostDiagnosticsSchema = z.object({
  location: z
    .enum(['global', 'local', 'both'])
    .default('both')
    .describe('Installer target locations to inspect: global, local, or both. Default both.'),
  includeInstallTargets: z
    .boolean()
    .default(true)
    .describe('When false, skip filesystem config detection and report only active MCP profile/tool metadata.'),
  lowTokens: lowTokensField,
});

type HostDiagnosticsArgs = z.infer<typeof hostDiagnosticsSchema>;

function activeToolNames(ctx: ToolCtx): string[] {
  const profile = resolveMcpServerProfile(ctx.options.profile);
  const profileSet = mcpServerProfileToolSet(profile);
  if (profileSet) return [...profileSet];
  return ['cartograph_context', 'cartograph_explore', 'cartograph_session'];
}

function collectTargets(location: 'global' | 'local' | 'both') {
  const locations: Location[] = location === 'both' ? ['global', 'local'] : [location];
  return locations.flatMap((loc) =>
    detectAll(loc)
      .filter(({ target }) => target.supportsLocation(loc))
      .map(({ target, detection }) =>
        toHostDiagnosticTarget({
          id: target.id,
          displayName: target.displayName,
          location: loc,
          detection,
        }),
      ),
  );
}

function handleHostDiagnostics(ctx: ToolCtx, args: HostDiagnosticsArgs): ToolOutcome {
  const profile = resolveMcpServerProfile(ctx.options.profile);
  const report = buildHostDiagnostics({
    profile,
    writeToolsEnabled: ctx.options.disableWriteTools !== true && profile !== 'read-only',
    lowTokensDefault: ctx.options.lowTokensDefault === true,
    allRegisteredToolsAdvertised: profile === 'full',
    advertisedTools: activeToolNames(ctx),
    targets: args.includeInstallTargets ? collectTargets(args.location) : [],
  });
  const body = args.lowTokens === true ? renderHostDiagnosticsCompact(report) : renderHostDiagnostics(report);
  return ok(renderToolResponse({ body }));
}

export const HOST_DIAGNOSTICS_TOOL = defineTool({
  name: 'cartograph_host_diagnostics',
  description:
    'Host adoption diagnostics — active MCP profile/tool visibility plus best-effort installer target config detection. Reports what can be verified locally; sub-agent visibility remains host-specific.',
  schema: hostDiagnosticsSchema,
  handle: handleHostDiagnostics,
  bypassFreshnessGate: true,
});
