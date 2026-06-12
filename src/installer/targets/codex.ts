/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `~/.codex/config.toml` as the dotted-key
 *     table `[mcp_servers.cartograph]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `~/.codex/AGENTS.md`.
 *   - A `cartograph` skill to `~/.codex/skills/cartograph/SKILL.md`
 *     (global) or `./.codex/skills/cartograph/SKILL.md` (local) —
 *     Codex reads the same SKILL.md format Claude Code does.
 *
 * Codex supports project-scoped `.codex/config.toml` in trusted
 * projects. For local installs we write only that project config and
 * pin the Cartograph server to the current project via `--project-path`;
 * project guidance stays in the repository's normal AGENTS.md files.
 *
 * No permissions concept.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  atomicWriteFileSync,
  getHomeDir,
  getMcpServerConfig,
  removeMarkedSection,
  removeOwnedFile,
  writeMarkedInstructionsFile,
  writeOwnedFile,
} from './shared.js';
import { writeProjectGitignoreEntries } from './gitignore.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START } from '../instructions-template.js';
import { SKILL_NAME, SKILL_TEMPLATE } from '../skill-template.js';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml.js';
import { mcpCommandOptionsForLocation } from './mcp-config.js';

const TOML_HEADER = 'mcp_servers.cartograph';
const CODEX_LOCAL_GITIGNORE_ENTRIES = ['.codex/config.toml', `.codex/skills/${SKILL_NAME}/SKILL.md`];

function configDir(loc: Location): string {
  return loc === 'global' ? path.join(getHomeDir(), '.codex') : path.join(process.cwd(), '.codex');
}
function tomlConfigPath(loc: Location): string {
  return path.join(configDir(loc), 'config.toml');
}
function instructionsPath(): string {
  return path.join(configDir('global'), 'AGENTS.md');
}
function skillsDir(loc: Location): string {
  return path.join(configDir(loc), 'skills');
}
function skillPath(loc: Location): string {
  return path.join(skillsDir(loc), SKILL_NAME, 'SKILL.md');
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(_loc: Location): boolean {
    return true;
  }

  detect(loc: Location): DetectionResult {
    const tomlPath = tomlConfigPath(loc);
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch {
        /* ignore */
      }
    }
    const installed = fs.existsSync(configDir('global')) || (loc === 'local' && fs.existsSync(configDir('local')));
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc, opts));
    if (loc === 'global') {
      files.push(writeInstructionsEntry());
    }
    files.push(writeOwnedFile(skillPath(loc), SKILL_TEMPLATE));
    if (loc === 'local') {
      files.push(writeProjectGitignoreEntries(CODEX_LOCAL_GITIGNORE_ENTRIES));
    }

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(removeTomlConfigEntry(tomlConfigPath(loc)));
    if (loc === 'global') {
      const instr = instructionsPath();
      const instrAction = removeMarkedSection(instr, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
      files.push({ path: instr, action: instrAction });
    }
    const skill = skillPath(loc);
    files.push(removeOwnedFile(skill, [path.dirname(skill), skillsDir(loc)]));

    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    const block = buildCartographBlock(loc, opts);
    return `# Add to ${tomlConfigPath(loc)}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc === 'global') return [tomlConfigPath(loc), instructionsPath(), skillPath(loc)];
    return [tomlConfigPath(loc), skillPath(loc), path.join(process.cwd(), '.gitignore')];
  }
}

/** Strip the cartograph TOML table from the Codex config and report
 *  what happened. Pulled out of {@link CodexTarget.uninstall} so the
 *  outer `if exists / if removed / if empty / try unlink` chain
 *  doesn't sit 4-deep around the unlink. */
function removeTomlConfigEntry(tomlPath: string): WriteResult['files'][number] {
  if (!fs.existsSync(tomlPath)) return { path: tomlPath, action: 'not-found' };
  const content = fs.readFileSync(tomlPath, 'utf-8');
  const { content: nextContent, action } = removeTomlTable(content, TOML_HEADER);
  if (action !== 'removed') return { path: tomlPath, action: 'not-found' };
  if (nextContent.trim() === '') {
    try {
      fs.unlinkSync(tomlPath);
    } catch {
      /* ignore */
    }
  } else {
    atomicWriteFileSync(tomlPath, nextContent.trimEnd() + '\n');
  }
  return { path: tomlPath, action: 'removed' };
}

function buildCartographBlock(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
  const mcp = getMcpServerConfig(mcpCommandOptionsForLocation(loc, opts));
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  const file = tomlConfigPath(loc);
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCartographBlock(loc, opts);
  // Single read — `existing === ''` derives both "is the file empty
  // or absent" and "what was its content," avoiding a TOCTOU window
  // between two `fs.existsSync` calls.
  const existing = fs.existsSync(file) ? fs.readFileSync(file, 'utf-8') : '';
  const created = existing.length === 0;
  const { content: nextContent, action } = upsertTomlTable(existing, TOML_HEADER, block);

  if (action === 'unchanged') {
    return { path: file, action: 'unchanged' };
  }
  atomicWriteFileSync(file, nextContent);
  return { path: file, action: created ? 'created' : 'updated' };
}

function writeInstructionsEntry(): WriteResult['files'][number] {
  const file = instructionsPath();
  return { path: file, action: writeMarkedInstructionsFile(file) };
}

export const codexTarget: AgentTarget = new CodexTarget();
