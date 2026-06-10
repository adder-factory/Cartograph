/**
 * Antigravity IDE target.
 *
 * Writes the MCP entry to Antigravity's unified config at
 * `~/.gemini/config/mcp_config.json` when post-migration (signalled by
 * the `.migrated` marker Antigravity itself drops, OR by the unified
 * file already existing). Falls back to the legacy
 * `~/.gemini/antigravity/mcp_config.json` on pre-migration builds. On
 * install, a stale cartograph entry in the legacy path is migrated to
 * the new file automatically. Uninstall sweeps both.
 *
 * Two Antigravity-specific quirks:
 *
 *   1. The entry OMITS the `type: "stdio"` field other targets use —
 *      Antigravity's MCP scanner rejects entries that carry it.
 *
 *   2. On macOS the entry resolves `cartograph` to its absolute path at
 *      install time. macOS GUI apps launched from Dock/Finder get a
 *      stripped PATH that doesn't include nvm-installed shims, so a
 *      bare command name fails to spawn even when `which cartograph`
 *      works in your shell. Linux GUI apps inherit user PATH and
 *      Windows uses env PATH directly, so both keep the bare command.
 *
 * Antigravity shares GEMINI.md with the Gemini CLI target — the
 * Antigravity target deliberately does NOT touch GEMINI.md so
 * uninstalling Antigravity alone leaves CLI instructions intact.
 *
 * Location: `supportsLocation('local')` returns false — Antigravity
 * has no project-scoped config concept as of 2026-05.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { execSync } from 'node:child_process';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import { getHomeDir, jsonDeepEqual, readJsonFile, writeJsonFile, type McpCommandOptions } from './shared.js';

function unifiedConfigDir(): string {
  return path.join(getHomeDir(), '.gemini', 'config');
}
function unifiedMcpConfigPath(): string {
  return path.join(unifiedConfigDir(), 'mcp_config.json');
}
function legacyConfigDir(): string {
  return path.join(getHomeDir(), '.gemini', 'antigravity');
}
function legacyMcpConfigPath(): string {
  return path.join(legacyConfigDir(), 'mcp_config.json');
}
function migratedMarkerPath(): string {
  return path.join(unifiedConfigDir(), '.migrated');
}

/**
 * Pick the right MCP config path to write to. Prefers the unified
 * path when Antigravity has signalled migration (marker present OR
 * the file already exists — Antigravity creates it on first launch
 * post-migration). Falls back to the legacy path for pre-migration
 * Antigravity builds.
 */
function preferredMcpConfigPath(): string {
  if (fs.existsSync(migratedMarkerPath())) return unifiedMcpConfigPath();
  if (fs.existsSync(unifiedMcpConfigPath())) return unifiedMcpConfigPath();
  return legacyMcpConfigPath();
}

/**
 * Resolve the on-disk path of the `cartograph` binary so a macOS GUI
 * app launched from Dock/Finder (with a stripped PATH) can find it.
 * Falls back to the bare `cartograph` name when:
 *   - we're not on macOS (Linux/Windows GUI apps inherit user PATH), OR
 *   - the lookup fails (preserve install in restricted environments).
 *
 * `command -v` is preferred (built-in, no PATH manipulation); `which`
 * is a fallback. Both run through `/bin/bash` so the user's
 * interactive shell PATH is consulted — that's the right PATH for
 * finding nvm-managed installs.
 */
function resolveCartographCommand(options: McpCommandOptions = {}): string {
  if (options.command) return options.command;
  if (process.platform !== 'darwin') return 'cartograph';
  try {
    const resolved = execSync('command -v cartograph || which cartograph', {
      encoding: 'utf-8',
      stdio: ['ignore', 'pipe', 'ignore'],
      shell: '/bin/bash',
    }).trim();
    if (resolved && fs.existsSync(resolved)) return resolved;
  } catch {
    /* fall through to bare name */
  }
  return 'cartograph';
}

/**
 * Build the cartograph MCP-server entry for Antigravity. Distinct from
 * the shared `getMcpServerConfig()` because Antigravity (a) rejects
 * the `type` field and (b) needs an absolute command path on macOS.
 */
function buildAntigravityEntry(options: McpCommandOptions = {}): { command: string; args: string[] } {
  return {
    command: resolveCartographCommand(options),
    args: ['serve', '--mcp'],
  };
}

class AntigravityTarget implements AgentTarget {
  readonly id = 'antigravity' as const;
  readonly displayName = 'Antigravity IDE';
  readonly docsUrl = 'https://antigravity.google/docs/mcp';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const file = preferredMcpConfigPath();
    const config = readJsonFile(file);
    const alreadyConfigured = !!config['mcpServers']?.cartograph;
    // "Installed" heuristic: either dir or one of the config files
    // exists. Antigravity creates ~/.gemini/ on first launch before MCP.
    const installed = fs.existsSync(unifiedConfigDir()) || fs.existsSync(legacyConfigDir()) || fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Antigravity IDE has no project-local config — re-run with --location=global.'],
      };
    }
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(opts));
    // Migrate a stale legacy entry to the unified file if both exist —
    // prevents two competing cartograph configs.
    const legacyCleanup = cleanupLegacyEntry();
    if (legacyCleanup) files.push(legacyCleanup);
    return {
      files,
      notes: ['Restart Antigravity for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    const preferred = preferredMcpConfigPath();
    files.push(removeCartographFromFile(preferred));

    // Also sweep the OTHER path (handles the migration-half-state where
    // we wrote to one file but Antigravity now reads from the other).
    const other = preferred === unifiedMcpConfigPath() ? legacyMcpConfigPath() : unifiedMcpConfigPath();
    if (preferred !== other) {
      const otherResult = removeCartographFromFile(other);
      if (otherResult.action === 'removed') files.push(otherResult);
    }

    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    if (loc !== 'global') {
      return '# Antigravity IDE has no project-local config — use --location=global.\n';
    }
    const file = preferredMcpConfigPath();
    const snippet = JSON.stringify({ mcpServers: { cartograph: buildAntigravityEntry(opts) } }, null, 2);
    return `# Add to ${file}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [preferredMcpConfigPath()];
  }
}

function writeMcpEntry(opts: InstallOptions): WriteResult['files'][number] {
  const file = preferredMcpConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing['mcpServers']?.cartograph;
  const after = buildAntigravityEntry(opts);

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  let action: 'created' | 'updated' = 'created';
  if (before || fs.existsSync(file)) {
    action = 'updated';
  }
  if (!existing['mcpServers']) existing['mcpServers'] = {};
  existing['mcpServers'].cartograph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

function cleanupLegacyEntry(): WriteResult['files'][number] | null {
  if (preferredMcpConfigPath() !== unifiedMcpConfigPath()) return null;
  const legacy = legacyMcpConfigPath();
  if (!fs.existsSync(legacy)) return null;
  const config = readJsonFile(legacy);
  if (!config['mcpServers']?.cartograph) return null;
  delete config['mcpServers'].cartograph;
  if (Object.keys(config['mcpServers']).length === 0) {
    delete config['mcpServers'];
  }
  writeJsonFile(legacy, config);
  return { path: legacy, action: 'removed' };
}

function removeCartographFromFile(file: string): WriteResult['files'][number] {
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  const config = readJsonFile(file);
  if (!config['mcpServers']?.cartograph) return { path: file, action: 'not-found' };
  delete config['mcpServers'].cartograph;
  if (Object.keys(config['mcpServers']).length === 0) {
    delete config['mcpServers'];
  }
  // Leave a now-empty `{}` — Antigravity manages this file and a
  // stray empty file is less surprising than a deletion.
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

export const antigravityTarget: AgentTarget = new AntigravityTarget();
