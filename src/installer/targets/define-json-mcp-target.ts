/**
 * Factory for the JSON-`mcpServers`-wrapper agent targets.
 *
 * A family of agents (CodeWhale, Kimi, Copilot CLI, Factory Droid, IBM
 * Bob, …) configure MCP identically: a `<configDir>/mcp.json` carrying the
 * standard `{ mcpServers: { cartograph: { command, args } } }` wrapper,
 * with no instructions file and no permissions surface. Each was a ~110-
 * line near-clone differing only in the directory name, display name, docs
 * URL, and the post-install note — the cost was visible when one
 * cross-cutting change (the local-gitignore threading) had to be applied
 * to every one of them by hand.
 *
 * `defineJsonMcpTarget` collapses that family to a ~10-line spec. Targets
 * with genuinely different behavior (Claude permissions, Codex TOML, Zed
 * settings JSONC, Qoder permissions, opencode, Kiro instructions) keep
 * their bespoke classes.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, TargetId, WriteResult } from './types.js';
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
import { projectGitignorePath, withLocalGitignoreFileEntries } from './gitignore.js';

export interface JsonMcpTargetSpec {
  /** Registry id (also the `--target` value). */
  id: TargetId;
  /** Human-readable name for prompts / docs. */
  displayName: string;
  /** Docs URL surfaced in help / config output. */
  docsUrl: string;
  /** Config directory name under the home dir (global) or cwd (local),
   *  e.g. `.codewhale` (may be nested, e.g. `.pi/agent`). */
  configDirName: string;
  /** Env var whose value, when set, overrides the GLOBAL config dir
   *  entirely (e.g. `KIMI_CODE_HOME`, `PI_CODING_AGENT_DIR`). */
  globalHomeEnvVar?: string;
  /** MCP config file name within `configDirName`. Defaults to `mcp.json`. */
  mcpFileName?: string;
  /** Post-install note(s), e.g. "Start a new <Agent> session …". */
  notes: string[];
}

/** Build a JSON-`mcpServers`-wrapper {@link AgentTarget} from a spec. */
export function defineJsonMcpTarget(spec: JsonMcpTargetSpec): AgentTarget {
  const mcpFileName = spec.mcpFileName ?? 'mcp.json';

  const configDir = (loc: Location): string => {
    if (loc === 'global') {
      const envOverride = spec.globalHomeEnvVar ? process.env[spec.globalHomeEnvVar] : undefined;
      return envOverride ?? path.join(getHomeDir(), spec.configDirName);
    }
    return path.join(process.cwd(), spec.configDirName);
  };
  const mcpJsonPath = (loc: Location): string => path.join(configDir(loc), mcpFileName);

  const serverEntry = (options: McpCommandOptions = {}): { command: string; args: string[] } => ({
    command: getMcpCommand(options),
    args: getMcpServerArgs(options),
  });
  const mcpConfig = (command?: string): WriteMcpEntryJsonArgs => ({
    resolvePath: mcpJsonPath,
    entry: serverEntry,
    command,
  });

  return {
    id: spec.id,
    displayName: spec.displayName,
    docsUrl: spec.docsUrl,

    supportsLocation(_loc: Location): boolean {
      return true;
    },

    detect(loc: Location): DetectionResult {
      const file = mcpJsonPath(loc);
      const installed = fs.existsSync(configDir(loc)) || fs.existsSync(file);
      return detectMcpEntryJson(loc, mcpConfig(), installed);
    },

    install(loc: Location, opts: InstallOptions): WriteResult {
      return withLocalGitignoreFileEntries(
        loc,
        { files: [writeMcpEntryJson(loc, mcpConfig(opts.command))], notes: [...spec.notes] },
        [mcpJsonPath(loc)],
      );
    },

    uninstall(loc: Location): WriteResult {
      return { files: [removeMcpEntryJson(loc, mcpConfig())] };
    },

    printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
      const target = mcpJsonPath(loc);
      const snippet = JSON.stringify(
        { mcpServers: { cartograph: serverEntry(mcpCommandOptionsForLocation(loc, opts)) } },
        null,
        2,
      );
      return `# Add to ${target}\n\n${snippet}\n`;
    },

    describePaths(loc: Location): string[] {
      const paths = [mcpJsonPath(loc)];
      if (loc === 'local') paths.push(projectGitignorePath());
      return paths;
    },
  };
}
