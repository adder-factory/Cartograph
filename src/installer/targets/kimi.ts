/**
 * Kimi Code target.
 *
 *   - MCP server entry to `~/.kimi-code/mcp.json` (global) or
 *     `./.kimi-code/mcp.json` (local/project). Kimi Code also honors
 *     `$KIMI_CODE_HOME/mcp.json` for the user-level file; the
 *     installer mirrors that when the env var is set.
 *   - No instructions file.
 *   - No permission writer; Kimi Code's persistent allow/deny rules
 *     live in `config.toml`, not the MCP JSON file.
 *
 * Docs: https://moonshotai.github.io/kimi-code/en/customization/mcp.html
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

const KIMI_DOCS_URL = 'https://moonshotai.github.io/kimi-code/en/customization/mcp.html';

function globalConfigDir(): string {
  return process.env['KIMI_CODE_HOME'] ?? path.join(getHomeDir(), '.kimi-code');
}

function configDir(loc: Location): string {
  return loc === 'global' ? globalConfigDir() : path.join(process.cwd(), '.kimi-code');
}

function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function getKimiServerEntry(options: McpCommandOptions = {}): { command: string; args: string[] } {
  return {
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
  };
}

function kimiMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getKimiServerEntry, command };
}

class KimiTarget implements AgentTarget {
  readonly id = 'kimi' as const;
  readonly displayName = 'Kimi Code';
  readonly docsUrl = KIMI_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, kimiMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Run /mcp-config or start a new Kimi Code session if the server list is already loaded.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getKimiServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
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
  return writeMcpEntryJson(loc, kimiMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, kimiMcpConfig());
}

export const kimiTarget: AgentTarget = new KimiTarget();
