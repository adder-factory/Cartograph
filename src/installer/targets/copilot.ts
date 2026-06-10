/**
 * GitHub Copilot CLI target.
 *
 *   - User-level config: `~/.copilot/mcp-config.json`.
 *   - Project-level config: `.mcp.json` by default, or `.github/mcp.json`
 *     when the project already has that file.
 *   - Copilot CLI requires an explicit `tools` allowlist on MCP server
 *     entries; `["*"]` keeps Cartograph's own profile selection in charge.
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
import { projectGitignorePath, withLocalGitignoreFileEntries } from './gitignore.js';

const COPILOT_DOCS_URL = 'https://docs.github.com/copilot/how-tos/copilot-cli/customize-copilot/add-mcp-servers';

function userConfigDir(): string {
  const override = process.env['COPILOT_HOME'];
  if (override) return path.resolve(override);
  return path.join(getHomeDir(), '.copilot');
}

function projectMcpJsonPath(): string {
  const direct = path.join(process.cwd(), '.mcp.json');
  const github = path.join(process.cwd(), '.github', 'mcp.json');
  return fs.existsSync(github) && !fs.existsSync(direct) ? github : direct;
}

function mcpJsonPath(loc: Location): string {
  return loc === 'global' ? path.join(userConfigDir(), 'mcp-config.json') : projectMcpJsonPath();
}

function getCopilotServerEntry(options: McpCommandOptions = {}): {
  type: string;
  command: string;
  args: string[];
  tools: string[];
} {
  const base = getMcpServerConfig(options);
  return {
    ...base,
    tools: ['*'],
  };
}

function copilotMcpConfig(command?: string): WriteMcpEntryJsonArgs {
  return { resolvePath: mcpJsonPath, entry: getCopilotServerEntry, command };
}

class CopilotTarget implements AgentTarget {
  readonly id = 'copilot' as const;
  readonly displayName = 'GitHub Copilot CLI';
  readonly docsUrl = COPILOT_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const installed =
      loc === 'global'
        ? fs.existsSync(userConfigDir()) || fs.existsSync(file)
        : fs.existsSync(path.join(process.cwd(), '.mcp.json')) ||
          fs.existsSync(path.join(process.cwd(), '.github', 'mcp.json'));
    return detectMcpEntryJson(loc, copilotMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return withLocalGitignoreFileEntries(
      loc,
      {
        files: [writeMcpEntryJson(loc, copilotMcpConfig(opts.command))],
        notes: ['Run /mcp reload in Copilot CLI, or start a new session.'],
      },
      [mcpJsonPath(loc)],
    );
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntryJson(loc, copilotMcpConfig())] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getCopilotServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
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

export const copilotTarget: AgentTarget = new CopilotTarget();
