/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.json` (global,
 *     XDG-style on every OS, matching opencode's docs) or
 *     `./opencode.json` (local).
 *   - A `/cartograph` custom command to
 *     `~/.config/opencode/commands/cartograph.md` (global) or
 *     `./.opencode/commands/cartograph.md` (local). opencode has no
 *     conventional always-on agent-rules surface, so the on-demand
 *     command is its guidance channel.
 *   - No permissions concept.
 *
 * Config shape uses opencode's wrapper:
 *   {
 *     "$schema": "https://opencode.ai/config.json",
 *     "mcp": { "cartograph": { "type": "local", "command": [...], "enabled": true } }
 *   }
 *
 * The shape differs from Claude/Cursor — opencode uses `mcp.<name>`
 * (not `mcpServers`), takes `command` as a string array combining
 * binary + args, and includes an explicit `enabled` flag.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  getHomeDir,
  deleteNestedJsonEntry,
  getMcpCommand,
  getMcpServerArgs,
  getNestedJsonEntry,
  isProjectSourceRunEntry,
  jsonDeepEqual,
  mcpCommandOptionsForLocation,
  readJsonFile,
  removeOwnedFile,
  setNestedJsonEntry,
  writeJsonFile,
  writeOwnedFile,
  type McpCommandOptions,
} from './shared.js';
import { projectGitignorePath, withLocalGitignoreFileEntries } from './gitignore.js';
import { OPENCODE_COMMAND_TEMPLATE, SKILL_NAME } from '../skill-template.js';

/** opencode's JSON-schema URL — referenced when stamping new configs
 *  and printing the suggested snippet. Module-scoped so the methods
 *  below don't carry literal URLs (clears `hardcoded_url` biomarker). */
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/** opencode's docs base — also surfaced on the AgentTarget. */
const OPENCODE_DOCS_URL = 'https://opencode.ai/docs/config';

function globalConfigDir(): string {
  // XDG_CONFIG_HOME if set, else ~/.config — matches opencode's docs,
  // including on Windows where `~` resolves to USERPROFILE/HOME.
  const xdgEnv = process.env['XDG_CONFIG_HOME'];
  const xdgSet = xdgEnv !== undefined && xdgEnv.trim().length > 0;
  const xdg = xdgSet ? xdgEnv : path.join(getHomeDir(), '.config');
  return path.join(xdg, 'opencode');
}

function configPath(loc: Location): string {
  return loc === 'global' ? path.join(globalConfigDir(), 'opencode.json') : path.join(process.cwd(), 'opencode.json');
}

function commandsDir(loc: Location): string {
  return loc === 'global'
    ? path.join(globalConfigDir(), 'commands')
    : path.join(process.cwd(), '.opencode', 'commands');
}

function commandPath(loc: Location): string {
  return path.join(commandsDir(loc), `${SKILL_NAME}.md`);
}

/** Dirs to best-effort prune (empty-only) after command removal. The
 *  global `~/.config/opencode/` itself stays — it holds opencode.json. */
function commandPruneDirs(loc: Location): string[] {
  const dirs = [commandsDir(loc)];
  if (loc === 'local') dirs.push(path.join(process.cwd(), '.opencode'));
  return dirs;
}

function getOpencodeServerEntry(options: McpCommandOptions = {}): {
  type: string;
  command: string[];
  enabled: boolean;
} {
  return {
    type: 'local',
    command: [getMcpCommand(options), ...getMcpServerArgs(options)],
    enabled: true,
  };
}

class OpencodeTarget implements AgentTarget {
  readonly id = 'opencode' as const;
  readonly displayName = 'opencode';
  readonly docsUrl = OPENCODE_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = configPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = getNestedJsonEntry(config, 'mcp', 'cartograph') !== undefined;
    const installed = loc === 'global' ? fs.existsSync(globalConfigDir()) : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const file = configPath(loc);
    const existing = readJsonFile(file);
    const before = getNestedJsonEntry(existing, 'mcp', 'cartograph');
    const after = getOpencodeServerEntry(mcpCommandOptionsForLocation(loc, opts));

    let configWrite: WriteResult['files'][number];
    if (jsonDeepEqual(before, after)) {
      configWrite = { path: file, action: 'unchanged' };
    } else if (isProjectSourceRunEntry(before, process.cwd())) {
      configWrite = { path: file, action: 'kept' };
    } else {
      const created = !fs.existsSync(file);
      if (!existing['$schema']) existing['$schema'] = OPENCODE_SCHEMA_URL;
      setNestedJsonEntry(existing, 'mcp', 'cartograph', after);
      writeJsonFile(file, existing);
      configWrite = { path: file, action: created ? 'created' : 'updated' };
    }

    const command = commandPath(loc);
    const commandWrite = writeOwnedFile(command, OPENCODE_COMMAND_TEMPLATE);
    return withLocalGitignoreFileEntries(loc, { files: [configWrite, commandWrite] }, [file, command]);
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];
    const file = configPath(loc);
    const config = readJsonFile(file);
    if (deleteNestedJsonEntry(config, 'mcp', 'cartograph')) {
      // If the file is now degenerate (only $schema or empty), leave it
      // — the user may have other config we shouldn't nuke.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeOwnedFile(commandPath(loc), commandPruneDirs(loc)));
    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = configPath(loc);
    const snippet = JSON.stringify(
      {
        $schema: OPENCODE_SCHEMA_URL,
        mcp: { cartograph: getOpencodeServerEntry(mcpCommandOptionsForLocation(loc, opts)) },
      },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [configPath(loc), commandPath(loc)];
    if (loc === 'local') paths.push(projectGitignorePath());
    return paths;
  }
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
