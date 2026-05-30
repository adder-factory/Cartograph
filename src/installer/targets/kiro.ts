/**
 * Kiro CLI / IDE target.
 *
 *   - MCP server entry to `~/.kiro/settings/mcp.json` (global) or
 *     `./.kiro/settings/mcp.json` (local). Standard `mcpServers.cartograph`
 *     JSON shape — same as Claude / Cursor.
 *   - Instructions to `~/.kiro/steering/cartograph.md` (global) or
 *     `./.kiro/steering/cartograph.md` (local). Kiro's "steering" system
 *     loads every `*.md` in the steering dir as agent context, so a
 *     dedicated `cartograph.md` is the natural surface — we own the
 *     whole file outright (no marker-based merge needed) and delete it
 *     on uninstall.
 *
 * No permissions concept — Kiro gates tool invocations via its own UI.
 * `autoAllow` is silently ignored.
 *
 * Docs: https://kiro.dev/docs/cli/mcp/, https://kiro.dev/docs/cli/steering/
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  atomicWriteFileSync,
  getHomeDir,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  writeJsonFile,
} from './shared.js';
import { INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.kiro') : path.join(process.cwd(), '.kiro');
}
function mcpJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings', 'mcp.json');
}
function steeringPath(loc: Location): string {
  return path.join(configDir(loc), 'steering', 'cartograph.md');
}

class KiroTarget implements AgentTarget {
  readonly id = 'kiro' as const;
  readonly displayName = 'Kiro';
  readonly docsUrl = 'https://kiro.dev/docs/cli/mcp/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config['mcpServers']?.cartograph;
    const installed =
      loc === 'global'
        ? fs.existsSync(configDir('global')) || fs.existsSync(file)
        : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(_loc: Location, _opts: InstallOptions): WriteResult {
    const loc = _loc;
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc), writeSteeringEntry(loc));
    return {
      files,
      notes: ['Restart Kiro for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = mcpJsonPath(loc);
    const config = readJsonFile(file);
    if (config['mcpServers']?.cartograph) {
      delete config['mcpServers'].cartograph;
      if (Object.keys(config['mcpServers']).length === 0) {
        delete config['mcpServers'];
      }
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    files.push(removeSteeringEntry(loc));

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), steeringPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = mcpJsonPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const existing = readJsonFile(file);
  const before = existing['mcpServers']?.cartograph;
  const after = getMcpServerConfig();

  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  const action: 'created' | 'updated' = before ? 'updated' : fs.existsSync(file) ? 'updated' : 'created';
  if (!existing['mcpServers']) existing['mcpServers'] = {};
  existing['mcpServers'].cartograph = after;
  writeJsonFile(file, existing);
  return { path: file, action };
}

/**
 * Write the dedicated steering file. Unlike CLAUDE.md / GEMINI.md
 * (shared files where cartograph owns a marker-delimited section),
 * Kiro's steering dir loads every `*.md` as a discrete document — so
 * `cartograph.md` is ours outright. Byte-equality short-circuits
 * idempotent re-runs; mismatched content gets a clean rewrite.
 */
function writeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const body = INSTRUCTIONS_TEMPLATE + '\n';

  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, body);
    return { path: file, action: 'created' };
  }
  const existing = fs.readFileSync(file, 'utf-8');
  if (existing === body) {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, body);
  return { path: file, action: 'updated' };
}

/**
 * Delete the steering file we own. If a user has hand-edited the file
 * out of recognition we still remove it — cartograph.md is a name we
 * claim, and a partial install leaving the file behind is worse than
 * a clean delete.
 */
function removeSteeringEntry(loc: Location): WriteResult['files'][number] {
  const file = steeringPath(loc);
  if (!fs.existsSync(file)) return { path: file, action: 'not-found' };
  try {
    fs.unlinkSync(file);
  } catch {
    /* ignore */
  }
  return { path: file, action: 'removed' };
}

export const kiroTarget: AgentTarget = new KiroTarget();
