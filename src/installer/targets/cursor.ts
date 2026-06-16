/**
 * Cursor target.
 *
 *   - MCP server entry to `~/.cursor/mcp.json` (global) or
 *     `./.cursor/mcp.json` (local). Same `{mcpServers: {...}}` shape
 *     as Claude.
 *   - Instructions to `./.cursor/rules/cartograph.mdc` (project-local
 *     ONLY). Cursor's rules system is a project-scoped surface;
 *     global cursor rules aren't a stable convention as of 2026-05.
 *     For `--location=global`, only mcp.json is written.
 *
 * No permissions concept — Cursor doesn't have an auto-allow list
 * the installer can populate. `autoAllow` is silently ignored.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import type { AgentTarget, DetectionResult, InstallOptions, Location, WriteResult } from './types.js';
import {
  atomicWriteFileSync,
  deleteNestedJsonEntry,
  getHomeDir,
  getNestedJsonEntry,
  readJsonFile,
  removeMarkedSection,
  replaceOrAppendMarkedSection,
  renderMcpServersPrintConfig,
  writeJsonFile,
} from './shared.js';
import { writeMcpEntryJson } from './write-mcp-entry-json.js';
import { CARTOGRAPH_SECTION_END, CARTOGRAPH_SECTION_START, INSTRUCTIONS_TEMPLATE } from '../instructions-template.js';
import { projectGitignorePath, writeProjectGitignoreFileEntries } from './gitignore.js';

function mcpJsonPath(loc: Location): string {
  return loc === 'global'
    ? path.join(getHomeDir(), '.cursor', 'mcp.json')
    : path.join(process.cwd(), '.cursor', 'mcp.json');
}
/**
 * Cursor "rules" file. Only meaningful for the project-local
 * location — Cursor reads `.cursor/rules/*.mdc` from the workspace
 * root. There is no global equivalent.
 */
function rulesPath(): string {
  return path.join(process.cwd(), '.cursor', 'rules', 'cartograph.mdc');
}

/**
 * Cursor `.mdc` rules use YAML-ish frontmatter. `alwaysApply: true`
 * makes the rule load on every conversation regardless of file
 * patterns — appropriate for a tool-usage guide that's relevant
 * whenever the user is asking the agent to navigate code.
 */
const MDC_FRONTMATTER = [
  '---',
  'description: Cartograph MCP usage guide — when to use which tool',
  'alwaysApply: true',
  '---',
  '',
].join('\n');

class CursorTarget implements AgentTarget {
  readonly id = 'cursor' as const;
  readonly displayName = 'Cursor';
  readonly docsUrl = 'https://docs.cursor.com/context/model-context-protocol';

  supportsLocation(_loc: Location): boolean {
    // Both supported, but `local` writes more files (mcp.json + rules);
    // `global` writes only mcp.json. The orchestrator surfaces the
    // difference via describePaths.
    return true;
  }

  detect(loc: Location): DetectionResult {
    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    const alreadyConfigured = getNestedJsonEntry(config, 'mcpServers', 'cartograph') !== undefined;
    // "Installed" heuristic: does ~/.cursor exist (global) or has the
    // user opted into a project-local cursor config dir?
    const installed =
      loc === 'global'
        ? fs.existsSync(path.join(getHomeDir(), '.cursor'))
        : fs.existsSync(path.join(process.cwd(), '.cursor'));
    return { installed, alreadyConfigured, configPath: mcpPath };
  }

  install(loc: Location, opts: InstallOptions): WriteResult {
    const files: WriteResult['files'] = [];

    files.push(writeMcpEntry(loc, opts));

    if (loc === 'local') {
      files.push(writeRulesEntry(), writeProjectGitignoreFileEntries([mcpJsonPath(loc), rulesPath()]));
    }

    return {
      files,
      notes: ['Restart Cursor for MCP changes to take effect.'],
    };
  }

  uninstall(loc: Location): WriteResult {
    const files: WriteResult['files'] = [];

    const mcpPath = mcpJsonPath(loc);
    const config = readJsonFile(mcpPath);
    if (deleteNestedJsonEntry(config, 'mcpServers', 'cartograph')) {
      writeJsonFile(mcpPath, config);
      files.push({ path: mcpPath, action: 'removed' });
    } else {
      files.push({ path: mcpPath, action: 'not-found' });
    }

    if (loc === 'local') {
      const rules = rulesPath();
      const action = removeMarkedSection(rules, CARTOGRAPH_SECTION_START, CARTOGRAPH_SECTION_END);
      files.push({ path: rules, action });
    }

    return { files };
  }

  printConfig(loc: Location, opts: Pick<InstallOptions, 'command'> = {}): string {
    return renderMcpServersPrintConfig(mcpJsonPath(loc), loc, opts);
  }

  describePaths(loc: Location): string[] {
    const paths = [mcpJsonPath(loc)];
    if (loc === 'local') paths.push(rulesPath());
    if (loc === 'local') paths.push(projectGitignorePath());
    return paths;
  }
}

function writeMcpEntry(loc: Location, opts: InstallOptions): WriteResult['files'][number] {
  return writeMcpEntryJson(loc, { resolvePath: mcpJsonPath, command: opts.command });
}

function writeRulesEntry(): WriteResult['files'][number] {
  const file = rulesPath();
  const dir = path.dirname(file);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  // Body is frontmatter + the shared instructions block. The
  // marker-based replacement targets only the marker block, so the
  // frontmatter is preserved across re-runs.
  const body = MDC_FRONTMATTER + INSTRUCTIONS_TEMPLATE;

  if (!fs.existsSync(file)) {
    atomicWriteFileSync(file, body + '\n');
    return { path: file, action: 'created' };
  }

  // For .mdc files we own outright, do byte-equality first.
  const existing = fs.readFileSync(file, 'utf-8');
  const wantWithNL = body + '\n';
  if (existing === wantWithNL) {
    return { path: file, action: 'unchanged' };
  }

  // Otherwise, marker-based section swap (preserves any user-added
  // content outside the markers).
  const action = replaceOrAppendMarkedSection({
    filePath: file,
    body: INSTRUCTIONS_TEMPLATE,
    startMarker: CARTOGRAPH_SECTION_START,
    endMarker: CARTOGRAPH_SECTION_END,
  });
  let mapped: 'created' | 'updated' | 'unchanged' = 'updated';
  if (action === 'created') {
    mapped = 'created';
  } else if (action === 'unchanged') {
    mapped = 'unchanged';
  }
  return { path: file, action: mapped };
}

export const cursorTarget: AgentTarget = new CursorTarget();
