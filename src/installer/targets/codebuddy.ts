/**
 * CodeBuddy target.
 *
 *   - MCP server entry to CodeBuddy's JSONC MCP config files:
 *     user scope `~/.codebuddy/.mcp.json` (falling back to the first
 *     documented existing legacy user path) or project scope `.mcp.json`
 *     (falling back to existing `mcp.json`).
 *   - Uses the JSONC-preserving writer because CodeBuddy explicitly allows
 *     comments and trailing commas in MCP config files.
 *   - No instructions file. CodeBuddy loads CODEBUDDY.md separately; the MCP
 *     target only owns MCP wiring.
 *   - `autoAllow` is intentionally ignored here. CodeBuddy's project-server
 *     approval and tool permissions live in settings files, not the MCP file,
 *     and the installer should not rewrite those user/team policies.
 *
 * Docs: https://www.codebuddy.ai/docs/cli/mcp
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
  detectMcpEntryJsonc,
  removeMcpEntryJsonc,
  writeMcpEntryJsonc,
  type WriteMcpEntryJsoncArgs,
} from './write-mcp-entry-jsonc.js';

const CODEBUDDY_DOCS_URL = 'https://www.codebuddy.ai/docs/cli/mcp';

function userMcpCandidates(): string[] {
  const dir = path.join(getHomeDir(), '.codebuddy');
  return [path.join(dir, '.mcp.json'), path.join(dir, 'mcp.json'), path.join(getHomeDir(), '.codebuddy.json')];
}

function projectMcpCandidates(): string[] {
  return [path.join(process.cwd(), '.mcp.json'), path.join(process.cwd(), 'mcp.json')];
}

function mcpJsoncPath(loc: Location): string {
  const candidates = loc === 'global' ? userMcpCandidates() : projectMcpCandidates();
  return candidates.find((file) => fs.existsSync(file)) ?? candidates[0]!;
}

function getCodeBuddyServerEntry(options: McpCommandOptions = {}): { type: string; command: string; args: string[] } {
  return {
    type: 'stdio',
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
  };
}

function codeBuddyMcpConfig(command?: string): WriteMcpEntryJsoncArgs {
  return { resolvePath: mcpJsoncPath, entry: getCodeBuddyServerEntry, command };
}

class CodeBuddyTarget implements AgentTarget {
  readonly id = 'codebuddy' as const;
  readonly displayName = 'CodeBuddy';
  readonly docsUrl = CODEBUDDY_DOCS_URL;

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsoncPath(loc);
    const installed =
      fs.existsSync(file) ||
      (loc === 'global'
        ? fs.existsSync(path.join(getHomeDir(), '.codebuddy'))
        : fs.existsSync(path.join(process.cwd(), '.codebuddy')));
    return detectMcpEntryJsonc(loc, codeBuddyMcpConfig(), installed);
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    return {
      files: [writeMcpEntry(loc, opts)],
      notes: ['Restart CodeBuddy, or run its MCP reload command if an active session supports it.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    return { files: [removeMcpEntry(loc)] };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = mcpJsoncPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getCodeBuddyServerEntry(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsoncPath(loc)];
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJsonc(loc, codeBuddyMcpConfig(opts.command));
}

function removeMcpEntry(loc: Location): WriteResult['files'][number] {
  return removeMcpEntryJsonc(loc, codeBuddyMcpConfig());
}

export const codeBuddyTarget: AgentTarget = new CodeBuddyTarget();
