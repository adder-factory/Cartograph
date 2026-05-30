/**
 * Gemini CLI target.
 *
 *   - MCP server entry to `~/.gemini/settings.json` (global) or
 *     `./.gemini/settings.json` (local). Standard JSON
 *     `mcpServers.cartograph` shape.
 *   - Instructions to `~/.gemini/GEMINI.md` (global) or `./GEMINI.md`
 *     (local, project-root — that's where Gemini CLI's hierarchical
 *     context loader looks for it, NOT under `.gemini/`).
 *
 * No permissions concept. `autoAllow` is silently ignored.
 *
 * Docs: https://geminicli.com/docs/tools/mcp-server/
 */

import * as fs from 'fs';
import * as path from 'path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  getHomeDir,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.gemini') : path.join(process.cwd(), '.gemini');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  // Global GEMINI.md lives under ~/.gemini/; project-local GEMINI.md
  // lives at the project root (NOT under .gemini/), matching Gemini
  // CLI's hierarchical context loader.
  return loc === 'global' ? path.join(configDir('global'), 'GEMINI.md') : path.join(process.cwd(), 'GEMINI.md');
}

class GeminiTarget implements AgentTarget {
  readonly id = 'gemini' as const;
  readonly displayName = 'Gemini CLI';
  readonly docsUrl = 'https://geminicli.com/docs/tools/mcp-server/';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    const alreadyConfigured = !!config['mcpServers']?.cartograph;
    const installed =
      loc === 'global'
        ? fs.existsSync(configDir('global')) || fs.existsSync(file)
        : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, _opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc));
    files.push(writeInstructionsEntry(loc));
    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (config['mcpServers']?.cartograph) {
      delete config['mcpServers'].cartograph;
      if (Object.keys(config['mcpServers']).length === 0) {
        delete config['mcpServers'];
      }
      // Leave the file in place even if now `{}` — other top-level
      // Gemini settings the user might add later can share the file.
      writeJsonFile(file, config);
      files.push({ path: file, action: 'removed' });
    } else {
      files.push({ path: file, action: 'not-found' });
    }

    const instr = instructionsPath(loc);
    const action = removeMarkedSection(instr, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
    files.push({ path: instr, action });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [settingsJsonPath(loc), instructionsPath(loc)];
  }
}

function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
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

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const action = replaceOrAppendMarkedSection({
    filePath: file,
    body: INSTRUCTIONS_TEMPLATE,
    startMarker: CARTOGRAPH_SECTION_START,
    endMarker: CARTOGRAPH_SECTION_END,
  });
  const mapped: 'created' | 'updated' | 'unchanged' =
    action === 'created' ? 'created' : action === 'unchanged' ? 'unchanged' : 'updated';
  return { path: file, action: mapped };
}

export const geminiTarget: AgentTarget = new GeminiTarget();
