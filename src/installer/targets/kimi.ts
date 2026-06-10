/**
 * Kimi Code target.
 *
 *   - MCP server entry to `<KIMI_CODE_HOME | ~/.kimi-code>/mcp.json`
 *     (global) or `./.kimi-code/mcp.json` (local), via the standard
 *     `mcpServers` JSON wrapper. No instructions file, no permissions.
 *
 * A plain JSON-`mcpServers` target — see `defineJsonMcpTarget`.
 *
 * Docs: https://moonshotai.github.io/kimi-code/en/customization/mcp.html
 */

import type { AgentTarget } from './types.js';
import { defineJsonMcpTarget } from './define-json-mcp-target.js';

export const kimiTarget: AgentTarget = defineJsonMcpTarget({
  id: 'kimi',
  displayName: 'Kimi Code',
  docsUrl: 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html',
  configDirName: '.kimi-code',
  globalHomeEnvVar: 'KIMI_CODE_HOME',
  notes: ['Run /mcp-config or start a new Kimi Code session if the server list is already loaded.'],
});
