/**
 * Zed target.
 *
 *   - MCP context-server entry to `~/.config/zed/settings.json`
 *     (global) or `./.zed/settings.json` (local/project).
 *   - Zed uses `context_servers`, not `mcpServers`.
 *   - No instructions file; Zed has Agent Settings and profiles for
 *     MCP tool selection/permissions.
 *
 * Docs: https://zed.dev/docs/ai/mcp
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  getHomeDir,
  getMcpCommand,
  getMcpServerArgs,
  getNestedJsonEntry,
  jsonDeepEqual,
  mcpCommandOptionsForLocation,
  readJsonFile,
  removeNestedJsonEntry,
  setNestedJsonEntry,
  writeJsonFile,
  type McpCommandOptions,
} from './shared.js';
import { projectGitignorePath, withLocalGitignoreFileEntries } from './gitignore.js';

const ZED_DOCS_URL = 'https://zed.dev/docs/ai/mcp';

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
    args: getMcpServerArgs(options),
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
    return {
      installed,
      alreadyConfigured: getNestedJsonEntry(config, 'context_servers', 'cartograph') !== undefined,
      configPath: file,
    };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return withLocalGitignoreFileEntries(
      loc,
      {
        files: [writeContextServerEntry(loc, opts)],
        notes: ['Open Zed Agent Settings to verify the cartograph context server is active.'],
      },
      [settingsJsonPath(loc)],
    );
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeContextServerEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify(
      { context_servers: { cartograph: getZedContextServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [settingsJsonPath(loc)];
    if (loc === 'local') paths.push(projectGitignorePath());
    return paths;
  }
}

function writeContextServerEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const existing = readJsonFile(file);
  const before = getNestedJsonEntry(existing, 'context_servers', 'cartograph');
  const after = getZedContextServerEntry(mcpCommandOptionsForLocation(loc, opts));

  if (jsonDeepEqual(before, after)) return { path: file, action: 'unchanged' };

  const action = before || fs.existsSync(file) ? 'updated' : 'created';
  setNestedJsonEntry({ config: existing, wrapperKey: 'context_servers', entryKey: 'cartograph', value: after });
  writeJsonFile(file, existing);
  return { path: file, action };
}

function removeContextServerEntry(loc: Location): WriteResult['files'][number] {
  return removeNestedJsonEntry(settingsJsonPath(loc), 'context_servers', 'cartograph');
}

export const zedTarget: AgentTarget = new ZedTarget();
