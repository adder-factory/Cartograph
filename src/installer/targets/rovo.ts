/**
 * Rovo Dev CLI target.
 *
 *   - MCP server entry to `~/.rovodev/mcp.json` (global) or
 *     `./.rovodev/mcp.json` (local/project). When a Rovo config file
 *     already declares `mcp.mcpConfigPath`, we honor that configured
 *     path instead of forcing the default.
 *   - No instructions file.
 *   - No MCP auto-allow entry; Rovo's permission model lives in
 *     `config.yml` and is intentionally left to the user.
 *
 * Docs: https://support.atlassian.com/rovo/docs/connect-to-an-mcp-server-in-rovo-dev-cli/
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

const ROVO_DOCS_URL = 'https://support.atlassian.com/rovo/docs/connect-to-an-mcp-server-in-rovo-dev-cli/';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.rovodev') : path.join(process.cwd(), '.rovodev');
}

function configYamlPath(loc: Location): string {
  return path.join(configDir(loc), 'config.yml');
}

function defaultMcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'mcp.json');
}

function mcpJsonPath(loc: Location): string {
  return configuredMcpPath(loc) ?? defaultMcpJsonPath(loc);
}

function getRovoServerEntry(options: McpCommandOptions = {}): { command: string; args: string[]; transport: string } {
  return {
    command: getMcpCommand(options),
    args: ['serve', '--mcp'],
    transport: 'stdio',
  };
}

function rovoMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getRovoServerEntry, command };
}

class RovoDevTarget implements AgentTarget {
  readonly id = 'rovo' as const;
  readonly displayName = 'Rovo Dev';
  readonly docsUrl = ROVO_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, rovoMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const notes =
      loc === 'local'
        ? ['Point Rovo Dev config at .rovodev/mcp.json if your local profile does not already load it.']
        : ['Restart Rovo Dev or use /mcp to reload server changes.'];
    return { files: [writeMcpEntry(loc, opts)], notes };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getRovoServerEntry(opts) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

function configuredMcpPath(loc: Location): string | null {
  const configPath = configYamlPath(loc);
  if (!fs.existsSync(configPath)) return null;

  let content = '';
  try {
    content = fs.readFileSync(configPath, 'utf-8');
  } catch {
    return null;
  }

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith('#')) continue;
    const value = mcpConfigPathValue(line);
    if (!value) continue;
    return resolveConfigPath(value);
  }
  return null;
}

function mcpConfigPathValue(line: string): string | null {
  const key = 'mcpConfigPath:';
  if (!line.startsWith(key)) return null;
  const value = line.slice(key.length).trim();
  return value || null;
}

function resolveConfigPath(rawValue: string): string {
  const trimmed = stripTrailingYamlComment(rawValue);
  const unquoted = stripMatchingQuotes(trimmed);
  if (unquoted === '~') return getHomeDir();
  if (unquoted.startsWith('~/')) return path.join(getHomeDir(), unquoted.slice(2));
  if (path.isAbsolute(unquoted)) return unquoted;
  return path.resolve(process.cwd(), unquoted);
}

function stripTrailingYamlComment(value: string): string {
  const hash = value.indexOf('#');
  if (hash <= 0) return value.trim();
  const beforeHash = value.slice(0, hash);
  const charBeforeHash = beforeHash.at(-1);
  if (charBeforeHash !== ' ' && charBeforeHash !== '\t') return value.trim();
  return beforeHash.trim();
}

function stripMatchingQuotes(value: string): string {
  const first = value[0];
  if (first !== value.at(-1)) return value;
  if (first !== '"' && first !== "'") return value;
  return value.slice(1, -1);
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, rovoMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, rovoMcpConfig());
}

export const rovoTarget: AgentTarget = new RovoDevTarget();
