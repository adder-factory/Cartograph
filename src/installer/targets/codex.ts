/**
 * OpenAI Codex CLI target.
 *
 *   - MCP server entry to `~/.codex/config.toml` as the dotted-key
 *     table `[mcp_servers.cartograph]`. TOML — not JSON — handled by
 *     the narrow serializer in `./toml.ts`.
 *   - Instructions to `~/.codex/AGENTS.md`.
 *
 * Codex CLI as of 2026-05 has no project-local config concept —
 * everything lives under `~/.codex/`. `supportsLocation('local')`
 * returns false; the orchestrator skips Codex when the user picks
 * the local install location.
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
  writeMarkedInstructionsFile,
} from './shared.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START } from '../instructions-template.js';
import { buildTomlTable, removeTomlTable, upsertTomlTable } from './toml.js';

const TOML_HEADER = 'mcp_servers.cartograph';

function configDir(): string {
  return path.join(getHomeDir(), '.codex');
}
function tomlConfigPath(): string {
  return path.join(configDir(), 'config.toml');
}
function instructionsPath(): string {
  return path.join(configDir(), 'AGENTS.md');
}

class CodexTarget implements AgentTarget {
  readonly id = 'codex' as const;
  readonly displayName = 'Codex CLI';
  readonly docsUrl = 'https://github.com/openai/codex';

  supportsLocation(loc: Location): boolean {
    return loc === 'global';
  }

  detect(loc: Location): DetectionResult {
    if (loc !== 'global') {
      return { installed: false, alreadyConfigured: false };
    }
    const tomlPath = tomlConfigPath();
    let alreadyConfigured = false;
    if (fs.existsSync(tomlPath)) {
      try {
        const content = fs.readFileSync(tomlPath, 'utf-8');
        alreadyConfigured = content.includes(`[${TOML_HEADER}]`);
      } catch {
        /* ignore */
      }
    }
    const installed = fs.existsSync(configDir());
    return { installed, alreadyConfigured, configPath: tomlPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    if (loc !== 'global') {
      return {
        files: [],
        notes: ['Codex CLI has no project-local config — re-run with --location=global to install.'],
      };
    }
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(opts), writeInstructionsEntry());

    return { files };
  }

  uninstall(loc: Location): WriteResult {
    if (loc !== 'global') return { files: [] };
    const files: WriteResult['files'] = [];

    files.push(removeTomlConfigEntry(tomlConfigPath()));

    const instr = instructionsPath();
    const instrAction = removeMarkedSection(instr, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
    files.push({ path: instr, action: instrAction });

    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    if (loc !== 'global') {
      return '# Codex CLI has no project-local config — use --location=global.\n';
    }
    const block = buildCartographBlock(opts);
    return `# Add to ${tomlConfigPath()}\n\n${block}\n`;
  }

  describePaths(loc: Location): string[] {
    if (loc !== 'global') return [];
    return [tomlConfigPath(), instructionsPath()];
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

function buildCartographBlock(opts: Pick<InstallOptions, 'command'> = {}): string {
  const mcp = getMcpServerConfig(opts);
  return buildTomlTable(TOML_HEADER, {
    command: mcp.command,
    args: mcp.args,
  });
}

function writeMcpEntry(opts: InstallOptions): WriteResult['files'][number] {
  const file = tomlConfigPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const block = buildCartographBlock(opts);
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
