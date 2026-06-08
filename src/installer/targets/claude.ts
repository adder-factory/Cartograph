/**
 * Claude Code target — the historical default. Writes:
 *
 *   - MCP server entry to `~/.claude.json`; for local installs the entry is
 *     nested under `projects[<cwd>]`.
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.local.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./CLAUDE.local.md` (local).
 *
 * This follows Claude Code's current user/local/project scope split. The
 * exported writer functions at the bottom intentionally preserve the legacy
 * `config-writer.ts` behavior for downstream callers that still import them.
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
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  writePermissionsAllowList,
  writeJsonFile,
} from './shared.js';
import { writeMcpEntryJson } from './write-mcp-entry-json.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';

const CLAUDE_LOCAL_GITIGNORE_ENTRIES = ['CLAUDE.local.md', '.claude/settings.local.json'] as const;

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.claude') : path.join(process.cwd(), '.claude');
}
function claudeJsonPath(_loc: Location): string {
  return path.join(getHomeDir(), '.claude.json');
}
function scopedSettingsJsonPath(loc: Location): string {
  if (loc === 'local') return path.join(configDir(loc), 'settings.local.json');
  return path.join(configDir(loc), 'settings.json');
}
function scopedInstructionsPath(loc: Location): string {
  if (loc === 'local') return path.join(process.cwd(), 'CLAUDE.local.md');
  return path.join(configDir(loc), 'CLAUDE.md');
}
function legacyMcpJsonPath(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.claude.json') : path.join(process.cwd(), '.claude.json');
}
function legacySettingsJsonPath(loc: Location): string {
  return path.join(configDir(loc), 'settings.json');
}
function legacyInstructionsPath(loc: Location): string {
  return path.join(configDir(loc), 'CLAUDE.md');
}
function projectKey(): string {
  return path.resolve(process.cwd());
}

function objectRecord(value: unknown): Record<string, any> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, any>;
}

function ensureObject(parent: Record<string, any>, key: string): Record<string, any> {
  const current = objectRecord(parent[key]);
  if (current) return current;
  const next: Record<string, any> = {};
  parent[key] = next;
  return next;
}

function localProjectConfig(config: Record<string, any>): Record<string, any> | null {
  const projects = objectRecord(config['projects']);
  if (!projects) return null;
  return objectRecord(projects[projectKey()]);
}

function hasScopedMcpEntry(loc: Location, config: Record<string, any>): boolean {
  if (loc === 'global') return !!config['mcpServers']?.cartograph;
  const projectConfig = localProjectConfig(config);
  return !!projectConfig?.['mcpServers']?.cartograph;
}

function writeScopedMcpEntry(loc: Location): WriteResult['files'][number] {
  if (loc === 'global') return writeMcpEntryJson(loc, { resolvePath: claudeJsonPath });

  const file = claudeJsonPath(loc);
  const existing = readJsonFile(file);
  const before = localProjectConfig(existing)?.['mcpServers']?.cartograph;
  const after = getMcpServerConfig();
  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }

  const existed = fs.existsSync(file);
  const projectConfig = ensureObject(ensureObject(existing, 'projects'), projectKey());
  ensureObject(projectConfig, 'mcpServers')['cartograph'] = after;
  writeJsonFile(file, existing);
  return { path: file, action: before || existed ? 'updated' : 'created' };
}

function removeScopedMcpEntry(loc: Location): WriteResult['files'][number] {
  if (loc === 'global') return removeTopLevelMcpEntry(loc);

  const file = claudeJsonPath(loc);
  const config = readJsonFile(file);
  const projects = objectRecord(config['projects']);
  const projectConfig = projects ? objectRecord(projects[projectKey()]) : null;
  const mcpServers = projectConfig ? objectRecord(projectConfig['mcpServers']) : null;
  if (!mcpServers?.['cartograph']) {
    return { path: file, action: 'not-found' };
  }

  delete mcpServers['cartograph'];
  if (Object.keys(mcpServers).length === 0) {
    delete projectConfig!['mcpServers'];
  }
  if (projectConfig && Object.keys(projectConfig).length === 0) {
    delete projects![projectKey()];
  }
  if (projects && Object.keys(projects).length === 0) {
    delete config['projects'];
  }
  writeJsonFile(file, config);
  return { path: file, action: 'removed' };
}

function removeTopLevelMcpEntry(loc: Location): WriteResult['files'][number] {
  const mcpPath = claudeJsonPath(loc);
  const config = readJsonFile(mcpPath);
  if (!config['mcpServers']?.cartograph) {
    return { path: mcpPath, action: 'not-found' };
  }
  delete config['mcpServers'].cartograph;
  if (Object.keys(config['mcpServers']).length === 0) {
    delete config['mcpServers'];
  }
  writeJsonFile(mcpPath, config);
  return { path: mcpPath, action: 'removed' };
}

function writeScopedPermissionsEntry(loc: Location): WriteResult['files'][number] {
  return writePermissionsAllowList(scopedSettingsJsonPath(loc));
}

function writeScopedInstructionsEntry(loc: Location): WriteResult['files'][number] {
  return writeInstructionsFile(scopedInstructionsPath(loc));
}

function writeLocalGitignoreEntries(): WriteResult['files'][number] {
  const file = path.join(process.cwd(), '.gitignore');
  const created = !fs.existsSync(file);
  const content = created ? '' : fs.readFileSync(file, 'utf-8');
  const lines = new Set(content.split(/\r?\n/).map((line) => line.trim()));
  const missing = CLAUDE_LOCAL_GITIGNORE_ENTRIES.filter((entry) => !lines.has(entry));
  if (missing.length === 0 && !created) {
    return { path: file, action: 'unchanged' };
  }

  const base = content.trimEnd();
  const next = [base, ...missing].filter((part) => part.length > 0).join('\n') + '\n';
  atomicWriteFileSync(file, next);
  return { path: file, action: created ? 'created' : 'updated' };
}

class ClaudeCodeTarget implements AgentTarget {
  readonly id = 'claude' as const;
  readonly displayName = 'Claude Code';
  readonly docsUrl = 'https://code.claude.com/docs/en';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = claudeJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = hasScopedMcpEntry(loc, config);
    // For "installed" we infer from the existence of either the dir
    // (global) or the project marker file (local). Cheap and avoids
    // shelling out to `claude --version`.
    const dirExists = fs.existsSync(configDir('global'));
    const mcpExists = fs.existsSync(mcpPath);
    const installed = dirExists || mcpExists;
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(writeScopedMcpEntry(loc));

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      files.push(writeScopedPermissionsEntry(loc));
    }

    // 3. CLAUDE.md instructions
    files.push(writeScopedInstructionsEntry(loc));

    if (loc === 'local') {
      files.push(writeLocalGitignoreEntries());
    }

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    // 1. MCP server entry
    files.push(removeScopedMcpEntry(loc));

    // 2. Permissions
    const settingsPath = scopedSettingsJsonPath(loc);
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
    const instr = scopedInstructionsPath(loc);
    const action = removeMarkedSection(instr, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
    files.push({ path: instr, action });

    return { files };
  }

  printConfig(loc: Location): string {
    const target = claudeJsonPath(loc);
    const snippet =
      loc === 'local'
        ? JSON.stringify(
            { projects: { [projectKey()]: { mcpServers: { cartograph: getMcpServerConfig() } } } },
            null,
            2,
          )
        : JSON.stringify({ mcpServers: { cartograph: getMcpServerConfig() } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [claudeJsonPath(loc), scopedSettingsJsonPath(loc), scopedInstructionsPath(loc)];
    if (loc === 'local') paths.push(path.join(process.cwd(), '.gitignore'));
    return paths;
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
  return writeMcpEntryJson(loc, { resolvePath: legacyMcpJsonPath });
}

export function writePermissionsEntry(loc: Location): WriteResult['files'][number] {
  return writePermissionsAllowList(legacySettingsJsonPath(loc));
}

/** Where the legacy unmarked Cartograph section ends. Pulled out of
 *  {@link writeInstructionsEntry} so its conditional stays simple. */
function computeSectionEnd(content: string, sectionStart: number, nextHeader: RegExpMatchArray | null): number {
  const nextIdx = nextHeader?.index;
  if (nextIdx === undefined) return content.length;
  return sectionStart + 1 + nextIdx;
}

export function writeInstructionsEntry(loc: Location): WriteResult['files'][number] {
  return writeInstructionsFile(legacyInstructionsPath(loc));
}

function writeInstructionsFile(file: string): WriteResult['files'][number] {
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
