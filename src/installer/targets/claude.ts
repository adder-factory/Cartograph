/**
 * Claude Code target — the historical default. Writes:
 *
 *   - MCP server entry to `~/.claude.json` (global) or
 *     `./.claude.json` (local).
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./.claude/CLAUDE.md` (local).
 *
 * All paths and shapes ported verbatim from the original
 * `config-writer.ts` so existing Claude Code installs upgrade in
 * place — no migration on disk required.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  atomicWriteFileSync,
  getCartographPermissions,
  getHomeDir,
  getMcpServerConfig,
  jsonDeepEqual,
  readJsonFile,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writeJsonFile,
} from './shared.js';
import { writeMcpEntryJson } from './write-mcp-entry-json.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.claude') : path.join(process.cwd(), '.claude');
}
function mcpJsonPath(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.claude.json') : path.join(process.cwd(), '.claude.json');
}
function settingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function instructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://docs.claude.com/en/docs/claude-code';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = !!config['mcpServers']?.cartograph;
    // For "installed" we infer from the existence of either the dir
    // (global) or the project marker file (local). Cheap and avoids
    // shelling out to `claude --version`.
    const dirExists = fs.existsSync(configDir(loc));
    const mcpExists = fs.existsSync(mcpPath);
    const installed = dirExists || mcpExists;
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeMcpEntry(loc));

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      files.push(writePermissionsEntry(loc));
    }

    // 3. CLAUDE.md instructions
    files.push(writeInstructionsEntry(loc));

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (config['mcpServers']?.cartograph) {
      delete config['mcpServers'].cartograph;
      if (Object.keys(config['mcpServers']).length === 0) {
        delete config['mcpServers'];
      }
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    // 2. Permissions
    const settingsPath = settingsJsonPath(loc);
    const settings = readJsonFile(settingsPath);
    if (Array.isArray(settings['permissions']?.allow)) {
      const before = settings['permissions'].allow.length;
      settings['permissions'].allow = settings['permissions'].allow.filter(
        (p: string) => !p.startsWith('mcp__cartograph__'),
      );
      if (settings['permissions'].allow.length === before) {
        files.push({ path: settingsPath, action: 'not-found' });
      } else {
        if (settings['permissions'].allow.length === 0) {
          delete settings['permissions'].allow;
        }
        if (Object.keys(settings['permissions']).length === 0) {
          delete settings['permissions'];
        }
        writeJsonFile(settingsPath, settings);
        files.push({ path: settingsPath, action: 'removed' });
      }
    } else {
      files.push({ path: settingsPath, action: 'not-found' });
    }

    // 3. Instructions
    const instr = instructionsPath(loc);
    const action = removeMarkedSection(instr, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
    files.push({ path: instr, action });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = mcpJsonPath(loc);
    const snippet = JSON.stringify({ mcpServers: { cartograph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    return [mcpJsonPath(loc), settingsJsonPath(loc), instructionsPath(loc)];
  }
}

/**
 * Per-file write helpers, exported so the legacy `config-writer.ts`
 * shim can call only the named operation (writeMcpConfig writes ONLY
 * the MCP entry, etc.) instead of `claudeTarget.install()` which
 * writes all three files. Without this split the shims silently
 * cause side effects callers don't expect.
 */
export function writeMcpEntry(loc: Location): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, { resolvePath: mcpJsonPath });
}

export function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  const file = settingsJsonPath(loc);
  const settings = readJsonFile(file);
  const created = !fs.existsSync(file);

  if (!settings['permissions']) settings['permissions'] = {};
  if (!Array.isArray(settings['permissions'].allow)) settings['permissions'].allow = [];

  const want = getCartographPermissions();
  const before = [...settings['permissions'].allow];
  for (const perm of want) {
    if (!settings['permissions'].allow.includes(perm)) {
      settings['permissions'].allow.push(perm);
    }
  }
  if (jsonDeepEqual(before, settings['permissions'].allow) && !created) {
    return { path: file, action: 'unchanged' };
  }
  writeJsonFile(file, settings);
  return { path: file, action: created ? 'created' : 'updated' };
}

/** Where the legacy unmarked Cartograph section ends. Pulled out of
 *  {@link writeInstructionsEntry} so its conditional stays simple. */
function computeSectionEnd(content: string, sectionStart: number, nextHeader: RegExpMatchArray | null): number {
  const nextIdx = nextHeader?.index;
  if (nextIdx === undefined) return content.length;
  return sectionStart + 1 + nextIdx;
}

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  const file = instructionsPath(loc);
  // Ensure config dir exists (for global ~/.claude/).
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Honor the legacy "unmarked ## Cartograph" rewrite path that the
  // original installer supported (some users hand-pasted a section
  // before markers existed). Detect first and migrate inline.
  if (fs.existsSync(file)) {
    const content = fs.readFileSync(file, 'utf-8');
    if (!content.includes(CARTOGRAPH_SECTION_START)) {
      const headerMatch = /\n## Cartograph\n/.exec(content);
      if (headerMatch?.index !== undefined) {
        const sectionStart = headerMatch.index;
        const after = content.substring(sectionStart + 1);
        const nextHeader = /\n## (?!#)/.exec(after);
        const sectionEnd = computeSectionEnd(content, sectionStart, nextHeader);
        const merged =
          content.substring(0, sectionStart) + '\n' + INSTRUCTIONS_TEMPLATE + content.substring(sectionEnd);
        atomicWriteFileSync(file, merged);
        return { path: file, action: 'updated' };
      }
    }
  }

  const action = replaceOrAppendMarkedSection({
    filePath: file,
    body: INSTRUCTIONS_TEMPLATE,
    startMarker: CARTOGRAPH_SECTION_START,
    endMarker: CARTOGRAPH_SECTION_END,
  });
  // Map the four-state action to WriteResult's action vocabulary.
  let mapped: 'created' | 'updated' | 'unchanged' = 'updated';
  if (action === 'created') {
    mapped = 'created';
  } else if (action === 'unchanged') {
    mapped = 'unchanged';
  }
  return { path: file, action: mapped };
}

export const claudeTarget: AgentTarget = new ClaudeCodeTarget();
