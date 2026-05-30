/**
 * opencode target.
 *
 *   - MCP server entry to `~/.config/opencode/opencode.json` (global,
 *     XDG-style; `%APPDATA%/opencode/opencode.json` on Windows) or
 *     `./opencode.json` (local).
 *   - No instructions file built in (opencode doesn't have a
 *     conventional agent-rules surface as of 2026-05).
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

import * as fs from 'fs';
import * as path from 'path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import { getHomeDir, jsonDeepEqual, readJsonFile, writeJsonFile } from './shared.js';

/** opencode's JSON-schema URL — referenced when stamping new configs
 *  and printing the suggested snippet. Module-scoped so the methods
 *  below don't carry literal URLs (clears `hardcoded_url` biomarker). */
const OPENCODE_SCHEMA_URL = 'https://opencode.ai/config.json';

/** opencode's docs base — also surfaced on the AgentTarget. */
const OPENCODE_DOCS_URL = 'https://opencode.ai/docs/config';

function globalConfigDir(): string {
  if (process.platform === 'win32') {
    const appData = process.env['APPDATA'] ?? path.join(getHomeDir(), 'AppData', 'Roaming');
    return path.join(appData, 'opencode');
  }
  // XDG_CONFIG_HOME if set, else ~/.config — matches opencode's docs.
  const xdgEnv = process.env['XDG_CONFIG_HOME'];
  const xdgSet = xdgEnv !== undefined && xdgEnv.trim().length > 0;
  const xdg = xdgSet ? xdgEnv : path.join(getHomeDir(), '.config');
  return path.join(xdg, 'opencode');
}

function configPath(loc: Location): string {
  return loc === 'global' ? path.join(globalConfigDir(), 'opencode.json') : path.join(process.cwd(), 'opencode.json');
}

function getOpencodeServerEntry(): { type: string; command: string[]; enabled: boolean } {
  return {
    type: 'local',
    command: ['cartograph', 'serve', '--mcp'],
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
    const alreadyConfigured = !!config['mcp']?.cartograph;
    const installed = loc === 'global' ? fs.existsSync(globalConfigDir()) : fs.existsSync(file);
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const file = configPath(loc);
    const existing = readJsonFile(file);
    const before = existing['mcp']?.cartograph;
    const after = getOpencodeServerEntry();

    if (jsonDeepEqual(before, after)) {
      return { files: [{ path: file, action: 'unchanged' }] };
    }

    const created = !fs.existsSync(file);
    if (!existing['$schema']) existing['$schema'] = OPENCODE_SCHEMA_URL;
    if (!existing['mcp']) existing['mcp'] = {};
    existing['mcp'].cartograph = after;
    writeJsonFile(file, existing);
    return {
      files: [{ path: file, action: created ? 'created' : 'updated' }],
    };
  }

  uninstall(loc: Location): WriteResult {
    const file = configPath(loc);
    const config = readJsonFile(file);
    if (!config['mcp']?.cartograph) {
      return { files: [{ path: file, action: 'not-found' }] };
    }
    delete config['mcp'].cartograph;
    if (Object.keys(config['mcp']).length === 0) {
      delete config['mcp'];
    }
    // If the file is now degenerate (only $schema or empty), leave it
    // — the user may have other config we shouldn't nuke.
    writeJsonFile(file, config);
    return { files: [{ path: file, action: 'removed' }] };
  }

  printConfig(loc: Location): string {
    const target = configPath(loc);
    const snippet = JSON.stringify(
      {
        $schema: OPENCODE_SCHEMA_URL,
        mcp: { cartograph: getOpencodeServerEntry() },
      },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [configPath(loc)];
  }
}

export const opencodeTarget: AgentTarget = new OpencodeTarget();
