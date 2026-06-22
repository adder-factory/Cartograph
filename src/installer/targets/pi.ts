/**
 * Pi Agent target.
 *
 *   - MCP server entry to Pi-owned adapter config files:
 *     `~/.pi/agent/mcp.json` (global, or `$PI_CODING_AGENT_DIR/mcp.json`)
 *     and `.pi/mcp.json` (project).
 *   - Uses the JSONC-preserving writer because Pi adapter examples use
 *     commented JSON-style config.
 *   - Pi loads MCP through an installed package (`pi-mcp-adapter` or
 *     `pi-mcp-extension`); writing config alone does not install that package.
 *
 * Docs: https://pi.dev/packages/pi-mcp-adapter,
 *       https://pi.dev/packages/pi-mcp-extension
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  installCommandOption,
  type AgentTarget,
  type DetectionResult,
  type InstallOptions,
  type Location,
  type WriteResult,
} from './types.js';
import {
  getHomeDir,
  getMcpCommand,
  getMcpServerArgs,
  mcpCommandOptionsForLocation,
  type McpCommandOptions,
} from './shared.js';
import {
  detectMcpEntryJsonc,
  removeMcpEntryJsonc,
  writeMcpEntryJsonc,
  type WriteMcpEntryJsoncArgs,
} from './write-mcp-entry-jsonc.js';
import { projectGitignorePath, withLocalGitignoreFileEntries } from './gitignore.js';

const PI_DOCS_URL = 'https://pi.dev/packages/pi-mcp-adapter';

function piAgentDir(): string {
  return process.env['PI_CODING_AGENT_DIR'] ?? path.join(getHomeDir(), '.pi', 'agent');
}

function configDir(loc: Location): string {
  return loc === 'global' ? piAgentDir() : path.join(process.cwd(), '.pi');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function getPiServerEntry(options: McpCommandOptions = {}): { command: string; args: string[]; transport: string } {
  return {
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
    transport: 'stdio',
  };
}

function piMcpConfig(command?: string): WriteMcpEntryJsoncArgs {
  return { resolvePath: mcpJsonPath, entry: getPiServerEntry, command };
}

class PiTarget implements AgentTarget {
  readonly id = 'pi' as const;
  readonly displayName = 'Pi Agent';
  readonly docsUrl = PI_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJsonc(loc, piMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return withLocalGitignoreFileEntries(
      loc,
      {
        files: [writeMcpEntry(loc, opts)],
        notes: [
          'Pi requires `pi install npm:pi-mcp-adapter` or `pi install npm:pi-mcp-extension` before MCP config is loaded.',
        ],
      },
      [mcpJsonPath(loc)],
    );
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getPiServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [mcpJsonPath(loc)];
    if (loc === 'local') paths.push(projectGitignorePath());
    return paths;
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJsonc(loc, piMcpConfig(installCommandOption(opts)));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJsonc(loc, piMcpConfig());
}

export const piTarget: AgentTarget = new PiTarget();
