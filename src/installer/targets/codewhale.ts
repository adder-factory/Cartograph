/**
 * CodeWhale target.
 *
 *   - MCP server entry to `~/.codewhale/mcp.json` (global) or
 *     `./.codewhale/mcp.json` (local/project). CodeWhale documents
 *     both the user config directory and optional project-scoped
 *     `.codewhale/` directory; MCP servers use the standard
 *     `mcpServers` JSON wrapper.
 *   - No instructions file. CodeWhale has skills, but there is no
 *     documented persistent agent-instructions file shape to own here.
 *   - No permissions concept in the MCP file. `autoAllow` is ignored.
 *
 * Docs: https://codewhale.net/en/install, https://www.codewhale.ai/docs.html
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import { getHomeDir, getMcpCommand, type McpCommandOptions } from './shared.js';
import {
  detectMcpEntryJson,
  removeMcpEntryJson,
  writeMcpEntryJson,
  type WriteMcpEntryJsonArgs,
} from './write-mcp-entry-json.js';

const CODEWHALE_DOCS_URL = 'https://codewhale.net/en/install';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.codewhale') : path.join(process.cwd(), '.codewhale');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function getCodeWhaleServerEntry(options: McpCommandOptions = {}): { command: string; args: string[] } {
  return {
    command: getMcpCommand(options),
    args: ['serve', '--mcp'],
  };
}

function codeWhaleMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getCodeWhaleServerEntry, command };
}

class CodeWhaleTarget implements AgentTarget {
  readonly id = 'codewhale' as const;
  readonly displayName = 'CodeWhale';
  readonly docsUrl = CODEWHALE_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, codeWhaleMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Start a new CodeWhale session for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getCodeWhaleServerEntry(opts) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, codeWhaleMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, codeWhaleMcpConfig());
}

export const codeWhaleTarget: AgentTarget = new CodeWhaleTarget();
