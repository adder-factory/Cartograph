/**
 * Factory Droid target.
 *
 *   - MCP server entry to `~/.factory/mcp.json` (global) or
 *     `./.factory/mcp.json` (local/project). Droid loads MCP servers
 *     from `mcpServers` at both levels, with user-level config taking
 *     priority over project-level config.
 *   - No instructions file; Factory has its own droid/skill surfaces,
 *     but MCP server wiring is the only installer responsibility here.
 *   - No permissions concept in the MCP file. `autoAllow` is ignored.
 *
 * Docs: https://docs.factory.ai/cli/configuration/mcp
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import { getHomeDir, getMcpServerConfig, mcpCommandOptionsForLocation, type McpCommandOptions } from './shared.js';
import {
  detectMcpEntryJson,
  removeMcpEntryJson,
  writeMcpEntryJson,
  type WriteMcpEntryJsonArgs,
} from './write-mcp-entry-json.js';

const FACTORY_DOCS_URL = 'https://docs.factory.ai/cli/configuration/mcp';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.factory') : path.join(process.cwd(), '.factory');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function getFactoryServerEntry(options: McpCommandOptions = {}): {
  type: string;
  command: string;
  args: string[];
  disabled: boolean;
} {
  const base = getMcpServerConfig(options);
  return {
    ...base,
    disabled: false,
  };
}

function factoryMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getFactoryServerEntry, command };
}

class FactoryDroidTarget implements AgentTarget {
  readonly id = 'factory' as const;
  readonly displayName = 'Factory Droid';
  readonly docsUrl = FACTORY_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, factoryMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Droid reloads MCP config changes automatically; restart the session if tools do not appear.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getFactoryServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
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
  return writeMcpEntryJson(loc, factoryMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, factoryMcpConfig());
}

export const factoryTarget: AgentTarget = new FactoryDroidTarget();
