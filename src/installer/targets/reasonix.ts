/**
 * Reasonix target.
 *
 *   - MCP server entry to `~/.reasonix/config.json`. Reasonix uses a
 *     single global config file for MCP servers; project `.reasonix/`
 *     directories are documented for skills, memory, hooks, and
 *     settings overrides rather than MCP server declarations.
 *   - No instructions file.
 *   - No permission writer; Reasonix shell/tool permissions are kept
 *     in separate workspace-specific config keys.
 *
 * Docs: https://esengine.github.io/DeepSeek-Reasonix/configuration.html?lang=en
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

const REASONIX_DOCS_URL = 'https://esengine.github.io/DeepSeek-Reasonix/configuration.html?lang=en';

function configDir(): string {
  return path.join(getHomeDir(), '.reasonix');
}

function configJsonPath(_loc: Location): string {
  return path.join(configDir(), 'config.json');
}

function getReasonixServerEntry(options: McpCommandOptions = {}): {
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

function reasonixMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: configJsonPath, entry: getReasonixServerEntry, command };
}

class ReasonixTarget implements AgentTarget {
  readonly id = 'reasonix' as const;
  readonly displayName = 'Reasonix';
  readonly docsUrl = REASONIX_DOCS_URL;

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    const file = configJsonPath(loc);
    if (!this.supportsLocation(loc)) {
      return { installed: false, alreadyConfigured: false, configPath: file };
    }
    const installed = fs.existsSync(configDir()) || fs.existsSync(file);
    return detectMcpEntryJson(loc, reasonixMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Run `reasonix mcp list` or start a new Reasonix session to verify the server is loaded.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = configJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getReasonixServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configJsonPath(loc)];
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, reasonixMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, reasonixMcpConfig());
}

export const reasonixTarget: AgentTarget = new ReasonixTarget();
