/**
 * CodeWhale target.
 *
 *   - MCP server entry to `~/.codewhale/mcp.json` (global) or
 *     `./.codewhale/mcp.json` (local/project), via the standard
 *     `mcpServers` JSON wrapper.
 *   - No instructions file and no permissions concept (`autoAllow` ignored).
 *
 * A plain JSON-`mcpServers` target — see `defineJsonMcpTarget`.
 *
 * Docs: https://codewhale.net/en/install, https://www.codewhale.ai/docs.html
 */

import type { AgentTarget } from './types.js';
import { defineJsonMcpTarget } from './define-json-mcp-target.js';

export const codeWhaleTarget: AgentTarget = defineJsonMcpTarget({
  id: 'codewhale',
  displayName: 'CodeWhale',
  docsUrl: 'https://codewhale.net/en/install',
  configDirName: '.codewhale',
  notes: ['Start a new CodeWhale session for MCP changes to take effect.'],
});
