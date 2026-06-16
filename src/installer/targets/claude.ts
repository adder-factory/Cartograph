/**
 * Claude Code target — the historical default. Writes:
 *
 *   - MCP server entry to `~/.claude.json`; for local installs the entry is
 *     nested under `projects[<cwd>]`.
 *   - Permissions to `~/.claude/settings.json` (global) or
 *     `./.claude/settings.local.json` (local), gated on `autoAllow`.
 *   - Instructions to `~/.claude/CLAUDE.md` (global) or
 *     `./CLAUDE.local.md` (local).
 *   - A `cartograph` skill to `~/.claude/skills/cartograph/SKILL.md`
 *     (global) or `./.claude/skills/cartograph/SKILL.md` (local).
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
  isProjectSourceRunEntry,
  jsonDeepEqual,
  mcpCommandOptionsForLocation,
  readJsonFile,
  removeMarkedSection,
  removeNestedJsonEntry,
  removeOwnedFile,
  replaceOrAppendMarkedSection,
  writePermissionsAllowList,
  writeJsonFile,
  writeOwnedFile,
} from './shared.js';
import { writeProjectGitignoreEntries } from './gitignore.js';
import { writeMcpEntryJson } from './write-mcp-entry-json.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';
import { SKILL_NAME, SKILL_TEMPLATE } from '../skill-template.js';

const CLAUDE_LOCAL_GITIGNORE_ENTRIES = [
  'CLAUDE.local.md',
  '.claude/settings.local.json',
  `.claude/skills/${SKILL_NAME}/SKILL.md`,
] as const;

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
function scopedSkillsDir(loc: Location): string {
  return path.join(configDir(loc), 'skills');
}
function scopedSkillPath(loc: Location): string {
  return path.join(scopedSkillsDir(loc), SKILL_NAME, 'SKILL.md');
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

function objectRecord(value: unknown): Record<string, unknown> | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function ensureObject(parent: Record<string, unknown>, key: string): Record<string, unknown> {
  const current = objectRecord(parent[key]);
  if (current) return current;
  const next: Record<string, unknown> = {};
  parent[key] = next;
  return next;
}

function localProjectConfig(config: Record<string, unknown>): Record<string, unknown> | null {
  const projects = objectRecord(config['projects']);
  if (!projects) return null;
  return objectRecord(projects[projectKey()]);
}

/** True when `record[key]` is a non-null object whose `cartograph` member exists. */
function hasCartographMember(record: Record<string, unknown> | null, key: string): boolean {
  const child = record ? objectRecord(record[key]) : null;
  return !!child && child['cartograph'] !== undefined;
}

function hasScopedMcpEntry(loc: Location, config: Record<string, unknown>): boolean {
  if (loc === 'global') return hasCartographMember(config, 'mcpServers');
  return hasCartographMember(localProjectConfig(config), 'mcpServers');
}

function writeScopedMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  if (loc === 'global') return writeMcpEntryJson(loc, { resolvePath: claudeJsonPath, command: opts.command });

  const file = claudeJsonPath(loc);
  const existing = readJsonFile(file);
  const before = objectRecord(localProjectConfig(existing)?.['mcpServers'])?.['cartograph'];
  const after = getMcpServerConfig(mcpCommandOptionsForLocation(loc, opts));
  if (jsonDeepEqual(before, after)) {
    return { path: file, action: 'unchanged' };
  }
  if (isProjectSourceRunEntry(before, process.cwd())) {
    return { path: file, action: 'kept' };
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
  return removeNestedJsonEntry(claudeJsonPath(loc), 'mcpServers', 'cartograph');
}

function writeScopedPermissionsEntry(loc: Location): WriteResult['files'][number] {
  return writePermissionsAllowList(scopedSettingsJsonPath(loc));
}

function writeScopedInstructionsEntry(loc: Location): WriteResult['files'][number] {
  return writeInstructionsFile(scopedInstructionsPath(loc));
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
    files.push(writeScopedMcpEntry(loc, opts));

    // 2. Permissions (only when autoAllow)
    if (opts.autoAllow) {
      files.push(writeScopedPermissionsEntry(loc));
    }

    // 3. CLAUDE.md instructions + the cartograph skill (on-demand
    //    `/cartograph`, model-invocable via its description)
    files.push(writeScopedInstructionsEntry(loc), writeOwnedFile(scopedSkillPath(loc), SKILL_TEMPLATE));

    if (loc === 'local') {
      files.push(writeProjectGitignoreEntries(CLAUDE_LOCAL_GITIGNORE_ENTRIES));
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
    const permissions = objectRecord(settings['permissions']);
    const allow = permissions?.['allow'];
    if (permissions && Array.isArray(allow)) {
      const before = allow.length;
      const filtered = allow.filter((p: unknown) => typeof p === 'string' && !p.startsWith('mcp__cartograph__'));
      if (filtered.length === before) {
        files.push({ path: settingsPath, action: 'not-found' });
      } else {
        permissions['allow'] = filtered;
        if (filtered.length === 0) {
          delete permissions['allow'];
        }
        if (Object.keys(permissions).length === 0) {
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

    // 4. Skill — prune our skill dir, then `skills/` only when empty
    // (a sibling skill keeps both alive).
    const skill = scopedSkillPath(loc);
    files.push(removeOwnedFile(skill, [path.dirname(skill), scopedSkillsDir(loc)]));

    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const target = claudeJsonPath(loc);
    const snippet =
      loc === 'local'
        ? JSON.stringify(
            {
              projects: {
                [projectKey()]: {
                  mcpServers: { cartograph: getMcpServerConfig(mcpCommandOptionsForLocation(loc, opts)) },
                },
              },
            },
            null,
            2,
          )
        : JSON.stringify({ mcpServers: { cartograph: getMcpServerConfig(opts) } }, null, 2);
    return `# Add to ${target}\n\n${snippet}\n`;
  }

  describePaths(loc: Location): string[] {
    const paths = [claudeJsonPath(loc), scopedSettingsJsonPath(loc), scopedInstructionsPath(loc), scopedSkillPath(loc)];
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
