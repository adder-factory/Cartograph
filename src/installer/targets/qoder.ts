/**
 * Qoder CLI target.
 *
 *   - MCP server entry to `~/.qoder/settings.json` (global) or
 *     `./.qoder/settings.local.json` (local). Qoder also supports a
 *     committed project-level `.mcp.json`, but the installer uses the
 *     local settings file so `--location=local` stays private to the
 *     current checkout and does not collide with other clients.
 *   - Optional permissions allow-list in the same settings file when
 *     `autoAllow` is true.
 *   - No instructions file.
 *
 * Docs: https://docs.qoder.com/en/cli/mcp-servers
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  asJsonObject,
  getHomeDir,
  getMcpCommand,
  getMcpServerArgs,
  getNestedStringArray,
  mcpCommandOptionsForLocation,
  readJsonFile,
  writeJsonFile,
  writePermissionsAllowList,
  type McpCommandOptions,
} from './shared.js';
import {
  detectMcpEntryJson,
  removeMcpEntryJson,
  writeMcpEntryJson,
  type WriteMcpEntryJsonArgs,
} from './write-mcp-entry-json.js';
import { projectGitignorePath, writeProjectGitignoreFileEntries } from './gitignore.js';

const QODER_DOCS_URL = 'https://docs.qoder.com/en/cli/mcp-servers';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.qoder') : path.join(process.cwd(), '.qoder');
}

function settingsJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(configDir(loc), 'settings.json')
    : path.join(configDir(loc), 'settings.local.json');
}

function getQoderServerEntry(options: McpCommandOptions = {}): { command: string; args: string[] } {
  return {
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
  };
}

function qoderMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: settingsJsonPath, entry: getQoderServerEntry, command };
}

class QoderTarget implements AgentTarget {
  readonly id = 'qoder' as const;
  readonly displayName = 'Qoder CLI';
  readonly docsUrl = QODER_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
    return detectMcpEntryJson(loc, qoderMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [writeMcpEntry(loc, opts)];
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }
    if (loc === 'local') {
      files.push(writeProjectGitignoreFileEntries([settingsJsonPath(loc)]));
    }
    return {
      files,
      notes: ['Run /mcp reload in an active Qoder session, or start a new session.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc), removePermissionsEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getQoderServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
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

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, qoderMcpConfig(opts.command));
}

function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  return writePermissionsAllowList(settingsJsonPath(loc));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJson(loc, qoderMcpConfig());
}

function removePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const permissions = asJsonObject(settings['permissions']);
  const allow = getNestedStringArray(settings, 'permissions', 'allow');
  if (!permissions || allow === null) {
    return { path: file, action: 'not-found' };
  }

  const filtered = allow.filter((permission) => !permission.startsWith('mcp__cartograph__'));
  if (filtered.length === allow.length) {
    return { path: file, action: 'not-found' };
  }

  if (filtered.length === 0) {
    delete permissions['allow'];
  } else {
    permissions['allow'] = filtered;
  }
  if (Object.keys(permissions).length === 0) {
    delete settings['permissions'];
  }
  writeJsonFile(file, settings);
  return { path: file, action: 'removed' };
}

export const qoderTarget: AgentTarget = new QoderTarget();
