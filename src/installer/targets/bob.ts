/**
 * IBM Bob target.
 *
 *   - MCP server entry to `~/.bob/mcp_settings.json` (global) or
 *     `./.bob/mcp.json` (local/project). Bob documents both scopes
 *     with the standard `mcpServers` JSON wrapper.
 *   - No instructions file.
 *   - No permission writer; Bob manages MCP auto-approval per tool in
 *     its UI, so `autoAllow` is ignored.
 *
 * Docs: https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  getHomeDir,
  getMcpCommand,
  getMcpServerArgs,
  mcpCommandOptionsForLocation,
  type McpCommandOptions,
} from './shared.js';
import {
  detectMcpEntryJson,
  removeMcpEntryJson,
  writeMcpEntryJson,
  type WriteMcpEntryJsonArgs,
} from './write-mcp-entry-json.js';

const BOB_DOCS_URL = 'https://bob.ibm.com/docs/ide/configuration/mcp/mcp-in-bob';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.bob') : path.join(process.cwd(), '.bob');
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global' ? path.join(configDir(loc), 'mcp_settings.json') : path.join(configDir(loc), 'mcp.json');
}

function getBobServerEntry(options: McpCommandOptions = {}): {
  command: string;
  args: string[];
  disabled: boolean;
} {
  return {
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
    disabled: false,
  };
}

function bobMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getBobServerEntry, command };
}

class BobTarget implements AgentTarget {
  readonly id = 'bob' as const;
  readonly displayName = 'IBM Bob';
  readonly docsUrl = BOB_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, bobMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Enable MCP servers in Bob settings if this is the first MCP server for the workspace.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getBobServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, bobMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, bobMcpConfig());
}

export const bobTarget: AgentTarget = new BobTarget();
