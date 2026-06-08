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
import { getHomeDir } from './shared.js';
import { detectMcpEntryJson, removeMcpEntryJson, writeMcpEntryJson } from './write-mcp-entry-json.js';

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

function getCopilotServerEntry(): { type: string; command: string; args: string[]; tools: string[] } {
  return {
    type: 'stdio',
    command: 'cartograph',
    args: ['serve', '--mcp'],
    tools: ['*'],
  };
}

const COPILOT_MCP_CONFIG = { resolvePath: mcpJsonPath, entry: getCopilotServerEntry };

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
    return detectMcpEntryJson(loc, COPILOT_MCP_CONFIG, installed);
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntryJson(loc, COPILOT_MCP_CONFIG)],
      notes: ['Run /mcp reload in Copilot CLI, or start a new session.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntryJson(loc, COPILOT_MCP_CONFIG)] };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getCopilotServerEntry() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc)];
  }
}

export const copilotTarget: AgentTarget = new CopilotTarget();
