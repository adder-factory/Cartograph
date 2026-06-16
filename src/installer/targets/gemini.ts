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

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  deleteNestedJsonEntry,
  getHomeDir,
  getMcpServerConfig,
  getNestedJsonEntry,
  mcpCommandOptionsForLocation,
  readJsonFile,
  removeMarkedSection,
  writeMarkedInstructionsFile,
  writeJsonFile,
} from './shared.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START } from '../instructions-template.js';
import { writeMcpEntryJson } from './write-mcp-entry-json.js';
import { projectGitignorePath, writeProjectGitignoreFileEntries } from './gitignore.js';

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
    const alreadyConfigured = getNestedJsonEntry(config, 'mcpServers', 'cartograph') !== undefined;
    const installed =
      loc === 'global'
        ? fs.existsSync(configDir('global')) || fs.existsSync(file)
        : fs.existsSync(file) || fs.existsSync(configDir('local'));
    return { installed, alreadyConfigured, configPath: file };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];
    files.push(writeMcpEntry(loc, opts), writeInstructionsEntry(loc));
    if (loc === 'local') {
      files.push(writeProjectGitignoreFileEntries([settingsJsonPath(loc), instructionsPath(loc)]));
    }
    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const file = settingsJsonPath(loc);
    const config = readJsonFile(file);
    if (deleteNestedJsonEntry(config, 'mcpServers', 'cartograph')) {
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

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = settingsJsonPath(loc);
    const snippet = JSON.stringify(
      { mcpServers: { cartograph: getMcpServerConfig(mcpCommandOptionsForLocation(loc, opts)) } },
      null,
      2,
    );
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [settingsJsonPath(loc), instructionsPath(loc)];
    if (loc === 'local') paths.push(projectGitignorePath());
    return paths;
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, { resolvePath: settingsJsonPath, command: opts.command });
}

function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  return { path: file, action: writeMarkedInstructionsFile(file) };
}

export const geminiTarget: AgentTarget = new GeminiTarget();
