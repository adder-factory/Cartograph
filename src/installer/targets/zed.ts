/**
 * Zed target.
 *
 *   - MCP context-server entry to `~/.config/zed/settings.json`
 *     (global) or `./.zed/settings.json` (local/project).
 *   - Zed uses `context_servers`, not `mcpServers`.
 *   - No instructions file; Zed has Agent Settings and profiles for
 *     MCP tool selection/permissions.
 *
 * Docs: https://zed.dev/docs/assistant/model-context-protocol
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  getHomeDir,
  getMcpCommand,
  jsonDeepEqual,
  readJsonFile,
  removeNestedJsonEntry,
  writeJsonFile,
  type McpCommandOptions,
} from './shared.js';

const ZED_DOCS_URL = 'https://zed.dev/docs/assistant/model-context-protocol';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(globalConfigBaseDir(), 'zed') : path.join(process.cwd(), '.zed');
}

function globalConfigBaseDir(): string {
  return process.env['XDG_CONFIG_HOME'] || path.join(getHomeDir(), '.config');
}

function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}

function getZedContextServerEntry(options: McpCommandOptions = {}): { command: string; args: string[] } {
  return {
    command: getMcpCommand(options),
    args: ['serve', '--mcp'],
  };
}

class ZedTarget implements AgentTarget {
  readonly id = 'zed' as const;
  readonly displayName = 'Zed';
  readonly docsUrl = ZED_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return { installed, alreadyConfigured: !!config['context_servers']?.cartograph, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeContextServerEntry(loc, opts)],
      notes: ['Open Zed Agent Settings to verify the cartograph context server is active.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeContextServerEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ context_servers: { cartograph: getZedContextServerEntry(opts) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc)];
  }
}

function writeContextServerEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const existing = readJsonFile(file);
  const before = existing['context_servers']?.cartograph;
  const after = getZedContextServerEntry(opts);

  if (jsonDeepEqual(before, after)) return { path: file, action: 'unchanged' };

  const action = before || fs.existsSync(file) ? 'updated' : 'created';
  if (!existing['context_servers']) existing['context_servers'] = {};
  existing['context_servers'].cartograph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeContextServerEntry(loc: Location): WriteResult['files'][number] {
  return removeNestedJsonEntry(settingsJsonPath(loc), 'context_servers', 'cartograph');
}

export const zedTarget: AgentTarget = new ZedTarget();
